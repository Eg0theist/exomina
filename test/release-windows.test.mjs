import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import configuration from '../scripts/beta-installer-config.mjs';
import {verifyVendorBinaries} from '../scripts/verify-vendor-binaries.mjs';
import {signingPreflight} from '../scripts/release-windows.mjs';
import {terminalShellArguments} from '../desktop/terminal-pty.mjs';
const require=createRequire(import.meta.url);require('app-builder-lib');const {WinPackager}=require('app-builder-lib/out/winPackager.js');
test('public preflight fails closed without a publisher identity and never returns signing secrets',()=>{
 assert.equal(signingPreflight({}).ready,false);
 assert.equal(signingPreflight({WIN_CSC_LINK:'SENSITIVE_CERT_LOCATION'}).ready,false);
 const result=signingPreflight({WIN_CSC_LINK:'SENSITIVE_CERT_LOCATION',WIN_CSC_KEY_PASSWORD:'PRIVATE_PASSWORD',EXOMINA_PUBLISHER_THUMBPRINT:'A'.repeat(40)});
 assert.equal(result.ready,true);assert.doesNotMatch(JSON.stringify(result),/SENSITIVE|PRIVATE_PASSWORD/);
});
test('terminal startup remains readable and correctly quotes literal path characters',()=>{
 const args=terminalShellArguments({systemModule:"C:/Program Files/Modules/It's PSReadLine.psd1",historyPath:'C:/synthetic history'});
 assert.equal(args.at(-2),'-Command');assert.match(args.at(-1),/It''s PSReadLine/);assert.match(args.at(-1),/HistorySaveStyle SaveNothing/);assert.ok(!args.includes('-EncodedCommand'));
});
test('runtime scripts load built interop without C# compilation or a compiler fallback',async()=>{
 for(const file of ['vault-windows.ps1','windows-control.ps1','voice-windows.ps1','decision-busy.mjs']){
  const text=await readFile(new URL('../desktop/'+file,import.meta.url),'utf8');assert.doesNotMatch(text,/Add-Type[^\r\n]*(?:TypeDefinition|MemberDefinition)|csc\.exe/);assert.match(text,/windows-interop/);
 }
});
test('installed builder signs app and both NSIS artifacts while excluding vendor executables',()=>{
 const select=(file,fallback=false)=>WinPackager.prototype.shouldSignFile.call({platformSpecificBuildOptions:configuration.win},file,fallback);
 for(const file of ['C:/release/Exomina.exe','C:/release/Exomina-Beta-1-windows-x64-Setup.exe','C:/release/Exomina-Beta-1-windows-x64-Setup.__uninstaller.exe'])assert.equal(select(file),true,file);
 for(const file of ['C:/release/vendor/codex.exe','C:/release/vendor/claude.exe','C:/release/vendor/node.exe','C:/release/vendor/cua-driver.exe','C:/release/vendor/muse.exe'])assert.equal(select(file,true),false,file);
 assert.equal(select('C:/Source/desktop/windows-interop/Vault.dll',true),true);assert.equal(select('C:/release/desktop/windows-interop/Vault.dll'),false);
 assert.equal(configuration.forceCodeSigning,true);assert.equal(configuration.win.signExecutable,true);
});
test('vendor gate rejects changed packaged binaries without changing their source',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'exomina-vendor-qa-'));t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('exomina-vendor-qa-'));await rm(directory,{recursive:true,force:true});});
 const build=path.join(directory,'build'),source=path.join(directory,'source');
 for(const root of [path.join(build,'resources/app.asar.unpacked'),source])for(const child of ['vendor','node_modules'])await mkdir(path.join(root,child),{recursive:true});
 const original=path.join(source,'vendor','fixture.exe'),packed=path.join(build,'resources/app.asar.unpacked/vendor/fixture.exe');await writeFile(original,'synthetic executable data');await writeFile(packed,'synthetic executable data');
 assert.equal((await verifyVendorBinaries(build,source)).files.length,1);await writeFile(packed,'mutated');await assert.rejects(verifyVendorBinaries(build,source),/bytes differ/);assert.equal(await readFile(original,'utf8'),'synthetic executable data');
});

test('public signature verification rejects unsigned, unpinned and untimestamped artifacts', {skip:process.platform!=='win32'},async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'exomina-signature-qa-'));
 t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('exomina-signature-qa-'));await rm(directory,{recursive:true,force:true});});
 const fixture=path.join(directory,'verify-fixture.ps1');
 await writeFile(fixture,`param([string]$Mode,[string]$Verifier)
$ErrorActionPreference='Stop'
function Get-AuthenticodeSignature([string]$LiteralPath) {
 $isInstaller=[IO.Path]::GetFileName($LiteralPath) -eq 'Setup.exe'
 $timestamp=if($Mode -eq 'missingTimestamp' -or ($Mode -eq 'installerTimestamp' -and $isInstaller)){$null}else{@{Subject='Synthetic timestamp authority'}}
 $publisher=if($Mode -eq 'wrongPublisher'){'B'*40}else{'A'*40}
 $status=if($Mode -eq 'unsigned'){'NotSigned'}else{'Valid'}
 return [pscustomobject]@{Status=$status;SignerCertificate=@{Thumbprint=$publisher};TimeStamperCertificate=$timestamp}
}
function Get-FileHash([string]$LiteralPath,[string]$Algorithm){return @{Hash='synthetic fixture digest'}}
& $Verifier -SingleFile (Join-Path $PSScriptRoot 'Exomina.exe') -Installer (Join-Path $PSScriptRoot 'Setup.exe')
`,'utf8');
 const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const verifier=fileURLToPath(new URL('../scripts/verify-windows-signatures.ps1',import.meta.url));
 const verify=mode=>promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-File',fixture,'-Mode',mode,'-Verifier',verifier],{env:{...process.env,EXOMINA_PUBLISHER_THUMBPRINT:'A'.repeat(40)},windowsHide:true,encoding:'utf8'});
 for(const [mode,message] of [['unsigned',/invalid or missing signature/],['wrongPublisher',/does not match/],['missingTimestamp',/no signing timestamp/],['installerTimestamp',/Installer has no signing timestamp/]]){
  await assert.rejects(verify(mode),error=>{assert.match(error.stderr,message);return true;},mode);
 }
 const result=JSON.parse((await verify('valid')).stdout);assert.equal(result.signatures.length,2);assert.ok(result.signatures.every(file=>file.timestampSigner==='Synthetic timestamp authority'));
});
