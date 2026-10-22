import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import configuration, { publicDistribution } from '../scripts/public-installer-config.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
async function directory(t) { const dir = await mkdtemp(path.join(tmpdir(), 'exomina-public-compile-')); t.after(() => { assert.equal(path.dirname(dir), path.resolve(tmpdir())); return rm(dir, { recursive: true, force: true }); }); return dir; }

test('public packaging requires valid bundled update trust and uses the canonical Windows identity/layout', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const channel = { channel: 'stable', feedUrl: 'https://example.com/latest.json', trustedKeys: { publisher: publicKey.export({ type: 'spki', format: 'pem' }) } };
  assert.deepEqual(publicDistribution({ homepage: 'https://github.com/example/exomina' }, channel), { profile: 'public', manualUpdates: false, repositoryUrl: 'https://github.com/example/exomina' });
  assert.throws(() => publicDistribution({ homepage: 'https://github.com/example/exomina' }, { ...channel, trustedKeys: {} }), /publisher keys/);
  assert.throws(() => publicDistribution({ homepage: 'https://github.com/example/exomina' }, { ...channel, feedUrl: 'https://user:secret@example.com/feed' }), /credentials/);
  assert.equal(configuration.appId, 'local.exomina.desktop');
  assert.equal(configuration.nsis.perMachine, true); assert.equal(configuration.nsis.allowToChangeInstallationDirectory, false);
  assert.ok(configuration.files.includes('scripts/install-public.ps1')); assert.ok(configuration.asarUnpack.includes('scripts/install-public.ps1'));
});

test('public hooks account for actual builder sequencing, validate before extraction, and release App before removal', async () => {
  const installer = await readFile(new URL('../scripts/public-installer.nsh', import.meta.url), 'utf8');
  const template = await readFile(new URL('../node_modules/app-builder-lib/templates/nsis/installer.nsi', import.meta.url), 'utf8');
  const section = await readFile(new URL('../node_modules/app-builder-lib/templates/nsis/installSection.nsh', import.meta.url), 'utf8');
  assert.ok(template.indexOf('SetOutPath $INSTDIR') < template.indexOf('!insertmacro customInit'), 'builder creates the initial empty directory before the custom hook');
  assert.ok(template.indexOf('!insertmacro customInit') < template.indexOf('!include "installSection.nsh"'));
  assert.ok(section.indexOf('!insertmacro CHECK_APP_RUNNING') < section.indexOf('!insertmacro installApplicationFiles'));
  assert.match(installer, /!macro customCheckAppRunning[\s\S]*!else[\s\S]*publicGuard Preflight/);
  assert.match(section, /\$installMode == "all"[\s\S]*!insertmacro uninstallOldVersion HKEY_CURRENT_USER/);
  assert.match(installer, /StrCpy \$installMode "public-fresh"/);
  assert.match(installer, /!macro customInstall\s+StrCpy \$installMode "all"/);
  assert.match(installer, /!macro customUnInit[\s\S]*publicGuard ValidateRemoval/);
  assert.match(installer, /\$WINDIR\\Sysnative\\WindowsPowerShell/);
  assert.match(installer, /File \/oname=exomina-public-guard\.ps1 "\$\{PROJECT_DIR\}\\scripts\\install-public\.ps1"/);
  assert.match(installer, /ReadRegStr \$R3 HKCU.*UninstallString/);
  const remove = installer.slice(installer.indexOf('!macro customRemoveFiles'));
  assert.ok(remove.indexOf('SetOutPath "$TEMP"') < remove.indexOf('-Mode Remove'));
  assert.doesNotMatch(remove, /RMDir \/r|Private\\|Workspace\\|Source\\/);
});

test('public PowerShell parses and real ACL decision logic rejects ordinary write/owner grants using synthetic state', { skip: process.platform !== 'win32' }, async t => {
  const dir = await directory(t), fixture = path.join(dir, 'acl-fixture.ps1'), target = path.join(dir, 'synthetic-directory'); await mkdir(target);
  await writeFile(fixture, String.raw`param([string]$Source,[string]$Target)
$ErrorActionPreference='Stop'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw ($parseErrors | Out-String)}
if($ast.Find({param($node) $node -is [Management.Automation.Language.VariableExpressionAst] -and $node.VariablePath.UserPath -ieq 'home'},$true)){throw 'Do not repurpose the automatic HOME variable'}
foreach($name in @('Assert-AdminProtected','Assert-Plain')){
  $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if(-not $definition){throw 'Missing guard function'}
  . ([scriptblock]::Create($definition.Extent.Text))
}
function Rule([string]$sid,[Security.AccessControl.FileSystemRights]$rights,[Security.AccessControl.PropagationFlags]$propagation='None'){
  [pscustomobject]@{IdentityReference=[Security.Principal.SecurityIdentifier]::new($sid);FileSystemRights=$rights;AccessControlType=[Security.AccessControl.AccessControlType]::Allow;PropagationFlags=$propagation}
}
function Acl([string]$owner,$rules){
  $value=[pscustomobject]@{OwnerSid=$owner;Rules=@($rules)}
  $value|Add-Member ScriptMethod GetOwner {param($type) [Security.Principal.SecurityIdentifier]::new($this.OwnerSid)}
  $value|Add-Member ScriptMethod GetAccessRules {param($explicit,$inherited,$type) $this.Rules}
  return $value
}
function Get-Acl {param([string]$LiteralPath) return $script:syntheticAcl}
$cases=@(
  @{owner='S-1-5-32-544';rules=@((Rule 'S-1-5-18' 'FullControl'),(Rule 'S-1-5-32-545' 'ReadAndExecute'));allowed=$true},
  @{owner='S-1-5-32-544';rules=@((Rule 'S-1-3-0' 'FullControl' 'InheritOnly'));allowed=$true},
  @{owner='S-1-5-32-544';rules=@((Rule 'S-1-1-0' 'Write'));allowed=$false},
  @{owner='S-1-5-32-544';rules=@((Rule 'S-1-5-21-1-2-3-1001' 'TakeOwnership'));allowed=$false},
  @{owner='S-1-5-21-1-2-3-1001';rules=@((Rule 'S-1-5-18' 'FullControl'));allowed=$false}
)
foreach($case in $cases){
  $script:syntheticAcl=Acl $case.owner $case.rules
  $accepted=$true;try{Assert-AdminProtected $Target}catch{$accepted=$false}
  if($accepted -ne $case.allowed){throw 'ACL guard decision differs from expected policy'}
}
$script:entryAttributes=[IO.FileAttributes]0
function Get-Item {param([string]$LiteralPath) [pscustomobject]@{Attributes=$script:entryAttributes}}
Assert-Plain $Target
$script:entryAttributes=[IO.FileAttributes]::Encrypted
$encryptedRejected=$false;try{Assert-Plain $Target}catch{$encryptedRejected=$true}
if(-not $encryptedRejected){throw 'Encrypted program path was not rejected'}
@{parsed=$true;aclCases=$cases.Count;encryptedRejected=$true;actualInstallExecuted=$false}|ConvertTo-Json -Compress
`, 'utf8');
  const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', fixture, '-Source', path.join(project, 'scripts/install-public.ps1'), '-Target', target], { encoding: 'utf8', windowsHide: true });
  assert.deepEqual(JSON.parse(result.stdout), { parsed: true, aclCases: 5, encryptedRejected: true, actualInstallExecuted: false });
});

test('public NSIS hooks compile for installation and uninstallation without executing setup', { skip: process.platform !== 'win32' || !process.env.EXOMINA_NSIS_COMPILER }, async t => {
  const dir = await directory(t), script = path.join(dir, 'compile-only.nsi'), output = path.join(dir, 'compile-only-never-run.exe');
  const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
  await writeFile(script, `Unicode true\nRequestExecutionLevel admin\n!include "LogicLib.nsh"\nVar installMode\n!define PROJECT_DIR "${quote(project)}"\n!define INSTALL_REGISTRY_KEY "Software\\SyntheticExominaCompile"\n!define UNINSTALL_REGISTRY_KEY "Software\\SyntheticExominaCompileUninstall"\n!define UNINSTALL_FILENAME "Uninstall Exomina.exe"\n!include "${quote(path.join(project, 'scripts/public-installer.nsh'))}"\nName "Synthetic compile only"\nOutFile "${quote(output)}"\nInstallDir "$TEMP\\SyntheticCompileNeverRun"\nFunction .onInit\n!insertmacro customInit\nFunctionEnd\nFunction un.onInit\n!insertmacro customUnInit\nFunctionEnd\nSection\n!insertmacro customCheckAppRunning\n!insertmacro customInstall\nSectionEnd\nSection Uninstall\n!define BUILD_UNINSTALLER\n!insertmacro customCheckAppRunning\n!undef BUILD_UNINSTALLER\n!insertmacro customRemoveFiles\nSectionEnd\n`, 'utf8');
  const compiler = process.env.EXOMINA_NSIS_COMPILER;
  const nsisRoot = path.dirname(path.dirname(compiler));
  const result = await promisify(execFile)(compiler, ['/V2', '/NOCD', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, NSISDIR: nsisRoot } });
  assert.doesNotMatch(result.stdout + result.stderr, /Error:/);
  assert.ok((await readFile(output)).length > 0);
});
