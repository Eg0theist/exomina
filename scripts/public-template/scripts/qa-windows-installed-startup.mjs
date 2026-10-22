// Focused actual NSIS install -> normal installed GUI startup -> own uninstall.
// Run only after other beta installer QA has completely removed its own install.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,lstat,realpath,readdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BETA_INSTALLER_GUID,BETA_APP_ID} from './beta-installer-config.mjs';
import {shippingInstallerPathLimits} from './beta-installer-path-limits.mjs';

if(process.platform!=='win32')throw Error('Installed startup QA requires Windows.');
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const expectedWorkspace=path.resolve(project,'..'),workspace=path.resolve(option('--workspace')||expectedWorkspace);
const qaBase=path.join(workspace,'.exomina-qa-temp');
const forbidden=location=>/(?:^|[\\/])(?:Private|accounts)(?:[\\/]|$)/i.test(location);
assert.equal(workspace.toLowerCase(),expectedWorkspace.toLowerCase(),'QA must remain in this checkout\u2019s explicit parent workspace.');
assert.equal(forbidden(workspace),false,'QA must use the explicit workspace, never an account store.');
process.env.TEMP=process.env.TMP=process.env.TMPDIR=qaBase;
async function assertNoLinks(location){
  for(let ancestor=location;;ancestor=path.dirname(ancestor)){
    let entry;try{entry=await lstat(ancestor);}catch(error){if(error.code!=='ENOENT')throw error;}
    assert.notEqual(entry?.isSymbolicLink(),true,'QA inputs and destinations must not pass through a filesystem link.');
    if(ancestor===path.dirname(ancestor))break;
  }
}
await assertNoLinks(qaBase);await assertNoLinks(project);await mkdir(qaBase,{recursive:true});
const qaReal=await realpath(qaBase),within=(root,value)=>{const relative=path.relative(root,value);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const same=(left,right)=>typeof left==='string'&&typeof right==='string'&&path.resolve(left).toLowerCase()===path.resolve(right).toLowerCase();
const exists=async file=>{try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const metadata=JSON.parse(await readFile(path.join(project,'package.json'),'utf8'));
const installer=path.resolve(option('--installer')||path.join(project,'release',`Exomina-Beta-${metadata.version}-windows-x64-Setup.exe`));
const build=path.resolve(option('--build')||path.join(project,'release','win-unpacked'));
assert.equal(forbidden(installer)||forbidden(build),false,'Only public program artifacts may be used as installer QA inputs.');
assert.ok(within(project,installer)&&within(project,build),'Use only this checkout\u2019s public program artifacts.');
await assertNoLinks(installer);await assertNoLinks(build);
assert.ok(within(await realpath(project),await realpath(installer))&&within(await realpath(project),await realpath(build)),'Program artifacts must remain within the source checkout.');
const output=await mkdtemp(path.join(qaBase,'s'));
assert.ok(within(qaReal,await realpath(output)),'The fresh fixture must stay within the explicit QA root.');
const installDir=path.join(output,'Exomina Beta'),installedExe=path.join(installDir,'Exomina.exe'),uninstaller=path.join(installDir,'Uninstall Exomina.exe');
const externalData=path.join(output,'external-synthetic-data'),sentinel=path.join(externalData,'sentinel.json');
const sentinelBytes=Buffer.from(JSON.stringify({synthetic:true,id:randomUUID()}));
await mkdir(externalData);await writeFile(sentinel,sentinelBytes);
const report={scope:'Actual fresh Windows NSIS install, hash-matched installed app normal GUI startup in its own signed-out standard profile, and matching owned uninstall. No personal accounts, login, model inference, microphone or native desktop actions.',
  installer,build,output,installDir,appId:BETA_APP_ID,installerGuid:BETA_INSTALLER_GUID,checks:{},errors:[],timings:{}};
const reportFile=path.join(output,'installed-startup-report.json');
const native=promisify(execFile),system=path.join(process.env.SystemRoot||'C:\\Windows','System32');
let tempRoot=qaBase,installAttempted=false,ownedInstall=false,uninstalled=false;

async function hash(file){assert.equal((await lstat(file)).isFile(),true,'A verified artifact must be a regular file.');const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);return digest.digest('hex');}
async function readRegistration(hive='HKCU'){
  assert.ok(['HKCU','HKLM'].includes(hive));
  return powershell('read-fixed-beta-registration',`$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.hive -notin @('HKCU','HKLM')) { throw 'Unsupported public installer registry hive' }
$hive = if ($request.hive -eq 'HKCU') { [Microsoft.Win32.RegistryHive]::CurrentUser } else { [Microsoft.Win32.RegistryHive]::LocalMachine }
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,[Microsoft.Win32.RegistryView]::Registry64)
$fields = @{}; $present = $false
try {
  foreach ($path in @('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${BETA_INSTALLER_GUID}','Software\\${BETA_INSTALLER_GUID}')) {
    $key = $base.OpenSubKey($path,$false)
    if ($null -eq $key) { continue }
    $present = $true
    try { foreach ($name in @('InstallLocation','DisplayName','DisplayVersion','UninstallString')) { $value = $key.GetValue($name,$null); if ($null -ne $value) { $fields[$name] = [string]$value } } } finally { $key.Dispose() }
  }
} finally { $base.Dispose() }
if ($present) { $fields | ConvertTo-Json -Compress } else { [Console]::WriteLine('null') }
`,{hive});
}
async function run(file,values,{timeoutMs=600000,verbatim=false}={}){
  return new Promise((resolve,reject)=>{
    const start=Date.now(),child=spawn(file,values,{cwd:output,windowsHide:true,windowsVerbatimArguments:verbatim,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,TEMP:tempRoot,TMP:tempRoot,TMPDIR:tempRoot}});
    let stdout='',stderr='',settled=false,timedOut=false;
    const finish=(failure,value)=>{if(settled)return;settled=true;clearTimeout(timer);failure?reject(failure):resolve(value);};
    const timer=setTimeout(()=>{timedOut=true;native(path.join(system,'taskkill.exe'),['/pid',String(child.pid),'/t','/f'],{windowsHide:true,timeout:10000,env:{...process.env,TEMP:qaBase,TMP:qaBase,TMPDIR:qaBase}}).catch(()=>child.kill()).finally(()=>finish(Error('The owned QA process timed out and was stopped.')));},timeoutMs);
    child.stdout.on('data',bytes=>{stdout=(stdout+bytes.toString()).slice(-8000);});child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-8000);});
    child.on('error',failure=>finish(failure));child.on('close',code=>{if(!timedOut)finish(null,{code,stdout,stderr,durationMs:Date.now()-start});});
  });
}
async function powershell(name,source,input){
  const script=path.join(output,name+'.ps1');await writeFile(script,source);
  return new Promise((resolve,reject)=>{
    const child=spawn(path.join(system,'WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,TEMP:qaBase,TMP:qaBase,TMPDIR:qaBase}});
    let stdout='',stderr='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(Error('The synthetic path/shortcut helper timed out.'));},30000);
    child.stdout.on('data',bytes=>{stdout+=bytes.toString();});child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-4000);});
    child.on('error',error=>finish(error));child.on('close',code=>{try{assert.equal(code,0,stderr||'The synthetic helper failed.');finish(null,JSON.parse(stdout));}catch(error){finish(error);}});child.stdin.on('error',error=>finish(error));child.stdin.end(JSON.stringify(input));
  });
}
async function preparePaths(limits){
  assert.ok(within(output,installDir));assert.ok(installDir.length<=limits.maxInstallRootChars,'Use a shorter explicit workspace path to preserve NSIS native path limits.');
  await mkdir(installDir);assert.deepEqual(await readdir(installDir),[]);
  const prepared=await powershell('prepare-empty-install-and-temp',`$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($request.root).TrimEnd('\\')
$target = [IO.Path]::GetFullPath($request.path).TrimEnd('\\')
if (-not $target.StartsWith($root + '\\',[StringComparison]::OrdinalIgnoreCase)) { throw 'The target escaped its fresh synthetic fixture' }
$item = Get-Item -LiteralPath $target -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or @(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) { throw 'Only an empty real program fixture may be prepared' }
if ((Get-Acl -LiteralPath $target).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'The synthetic program fixture has another owner' }
if (($item.Attributes -band [IO.FileAttributes]::Encrypted) -ne 0) { [IO.File]::Decrypt($target) }
if (([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::Encrypted) -ne 0) { throw 'The empty synthetic program fixture is still encrypted' }
Add-Type -TypeDefinition @'
using System.Text;using System.Runtime.InteropServices;
public static class ExominaInstalledStartupTempQA { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint GetShortPathName(string input,StringBuilder output,uint capacity); }
'@
$buffer = New-Object Text.StringBuilder 32768
if ([ExominaInstalledStartupTempQA]::GetShortPathName($request.temp,$buffer,[uint32]$buffer.Capacity) -eq 0) { throw 'The explicit QA temp short path could not be resolved' }
@{ emptyProgramDirectory = $true; encrypted = $false; tempPath = $buffer.ToString() } | ConvertTo-Json -Compress
`,{root:output,path:installDir,temp:qaBase});
  assert.equal(prepared.emptyProgramDirectory,true);assert.equal(prepared.encrypted,false);
  assert.ok(same(await realpath(prepared.tempPath),qaReal),'The temp alias must resolve to the explicit QA root.');
  assert.ok(prepared.tempPath.length<=limits.maxTempRootChars,'The explicit QA root must have a safe NSIS temp path.');tempRoot=prepared.tempPath;
  report.checks.ordinaryOwnedProgramFixture={emptyBeforeInstall:true,noExistingDataDecrypted:true,tempAliasVerified:true};
}
async function waitUntil(probe,predicate){const deadline=Date.now()+10000;while(Date.now()<deadline){const value=await probe();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('The owned installation outcome did not become ready.');}
const programs=path.join(process.env.APPDATA||'', 'Microsoft','Windows','Start Menu','Programs'),shortcut=path.join(programs,'Exomina Beta.lnk');
assert.ok(process.env.APPDATA&&path.isAbsolute(process.env.APPDATA),'The real public Start Menu folder must be available for ownership checks.');
assert.equal(forbidden(programs),false,'The public Start Menu check must never access an account store.');
async function uninstallOwned(){
  const registration=await readRegistration();
  if(!registration||!same(registration.InstallLocation,installDir))throw Error('Only this fixture\u2019s matching beta registration may be uninstalled.');
  assert.ok(within(qaReal,await realpath(installDir)));assert.equal((await lstat(uninstaller)).isFile(),true);
  const helper=path.join(output,'owned-uninstaller.exe');await copyFile(uninstaller,helper);const uninstallerHash=await hash(uninstaller);assert.equal(await hash(helper),uninstallerHash);report.uninstallerSha256=uninstallerHash;
  // NSIS requires the final _?= argument to be unquoted, with its value confined
  // to the fresh owned fixture. Copying its own verified uninstaller permits
  // removal of the original executable and the entire program directory.
  const result=await run(helper,['/S','/currentuser','_?='+installDir],{verbatim:true});report.timings.uninstallMs=result.durationMs;
  assert.equal(result.code,0,'The matching owned uninstaller must succeed.');
  await waitUntil(()=>readRegistration(),value=>value===null);await waitUntil(()=>exists(installDir),value=>value===false);uninstalled=true;
  assert.equal(await exists(shortcut),false);assert.equal(await readRegistration('HKLM'),null);assert.deepEqual(await readFile(sentinel),sentinelBytes);
  report.checks.uninstall={entireProgramDirectoryRemoved:true,ownRegistrationRemoved:true,ownShortcutRemoved:true,externalSentinelPreserved:true};
}
try{
  assert.equal(await readRegistration(),null,'Existing or partial per-user beta registration must not be modified by QA.');
  assert.equal(await readRegistration('HKLM'),null,'Existing or partial machine beta registration must not be modified by QA.');
  assert.equal(await exists(shortcut),false,'An existing beta shortcut must not be modified by QA.');
  const limits=await shippingInstallerPathLimits(build);report.pathLimits=limits;
  const marker=JSON.parse(await readFile(path.join(build,'exomina.distribution.json'),'utf8')),stamp=JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8'));
  assert.equal(marker.profile,'beta');assert.equal(marker.manualUpdates,true);assert.equal(marker.home,undefined);assert.equal(stamp.version,metadata.version);assert.equal(typeof stamp.id,'string');
  if(option('--expected-build-id'))assert.equal(stamp.id,option('--expected-build-id'),'The exact requested build must be used.');
  report.buildStamp=stamp;
  report.installerSha256=await hash(installer);report.sourceHashes={exe:await hash(path.join(build,'Exomina.exe')),asar:await hash(path.join(build,'resources','app.asar'))};
  await preparePaths(limits);
  assert.equal(await readRegistration(),null,'Another beta installer started; refuse before copying program files.');assert.equal(await readRegistration('HKLM'),null);assert.equal(await exists(shortcut),false);
  console.log('Checking actual fresh NSIS installation before normal installed app startup.');
  installAttempted=true;
  const installed=await run(installer,['/S','/currentuser','/D='+installDir],{verbatim:true});report.timings.installMs=installed.durationMs;
  const registration=await readRegistration();if(registration&&same(registration.InstallLocation,installDir))ownedInstall=true;
  assert.equal(installed.code,0,'The fresh silent install must succeed.');assert.ok(ownedInstall,'The installed beta must register only this owned destination.');assert.equal(registration.DisplayName,'Exomina Beta');
  assert.equal(await hash(installedExe),report.sourceHashes.exe);assert.equal(await hash(path.join(installDir,'resources','app.asar')),report.sourceHashes.asar);
  assert.deepEqual(JSON.parse(await readFile(path.join(installDir,'exomina.distribution.json'),'utf8')),marker);assert.deepEqual(JSON.parse(await readFile(path.join(installDir,'exomina.build.json'),'utf8')),stamp);
  assert.equal(await exists(path.join(installDir,'exomina.paths.json')),false);assert.equal(await exists(uninstaller),true);assert.equal(await exists(shortcut),true);
  const link=await powershell('verify-own-shortcut',`$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($request.path)
@{ target = $link.TargetPath; workingDirectory = $link.WorkingDirectory } | ConvertTo-Json -Compress
`,{path:shortcut});assert.ok(same(link.target,installedExe),'The fresh shortcut must target the owned installed executable.');
  report.checks.freshInstall={exeSha256Matches:true,asarSha256Matches:true,distributionAndBuildMarkersMatch:true,ownShortcutTargetVerified:true,noPersonalHomeMarker:true};
  assert.deepEqual(await readFile(sentinel),sentinelBytes);
  console.log('Checking the actual installed GUI executable using a fresh signed-out standard profile.');
  const nativeOutput=path.join(output,'installed-native-desktop');
  const startup=await run(process.execPath,[path.join(project,'scripts','qa-native-desktop.mjs'),'--executable',installedExe,'--output',nativeOutput],{timeoutMs:180000});report.timings.installedStartupQaMs=startup.durationMs;
  const nativeReport=JSON.parse(await readFile(path.join(nativeOutput,'native-desktop-report.json'),'utf8'));report.nativeDesktopReport=path.join(nativeOutput,'native-desktop-report.json');
  assert.equal(startup.code,0,startup.stderr||nativeReport.failure||'The installed GUI must pass native desktop QA.');assert.equal(nativeReport.passed,true);assert.ok(same(nativeReport.executable,installedExe));assert.equal(nativeReport.buildId,stamp.id);
  assert.deepEqual(nativeReport.checks.standardFirstRun,{ready:true,mode:'standard',folderEncrypted:false,needsRecovery:false});assert.equal(nativeReport.checks.freshRuntimeCatalog.signedOut,true);assert.deepEqual(nativeReport.errors,[]);
  report.checks.installedNormalStartup={exactInstalledExe:true,buildIdMatches:true,freshStandardProfile:true,signedOutNativeRuntimes:true,workspaceBrowserAndSettingsVerified:true};
  console.log('Checking only the owned official uninstaller and the external sentinel.');
  await uninstallOwned();report.ok=true;
}catch(error){report.ok=false;report.errors.push(error.message);process.exitCode=1;}
finally{
  if(installAttempted&&!ownedInstall&&!uninstalled){try{const registration=await readRegistration();ownedInstall=!!registration&&same(registration.InstallLocation,installDir);}catch(error){report.cleanup={ownInstallationRemoved:false,message:'Could not verify installer ownership after failure: '+error.message};}}
  if(ownedInstall&&!uninstalled){try{await uninstallOwned();report.cleanup={ownInstallationRemoved:true};}catch(error){report.cleanup={ownInstallationRemoved:false,message:error.message};}}
  try{assert.deepEqual(await readFile(sentinel),sentinelBytes,'External synthetic data must remain unchanged even when a check fails.');}catch(error){report.ok=false;report.errors.push(error.message);process.exitCode=1;}
  await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({ok:report.ok,report:reportFile,checks:report.checks,errors:report.errors},null,2));
}
