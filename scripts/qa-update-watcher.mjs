// Actual updater supervisor/runner, isolated synthetic state and harmless hidden
// helper processes. No real UAC, installation, GUI, account data or cleanup.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const options=Object.fromEntries(process.argv.slice(2).map((item,index,args)=>item.startsWith('--')?[item.slice(2),args[index+1]]:null).filter(Boolean));
const root=path.resolve(options.root||path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const output=options.output?path.resolve(options.output):await mkdtemp(path.resolve(root,'../Workspace/qa-update-watcher-'));
await mkdir(output,{recursive:true});
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const runner=path.join(root,'desktop','update-runner.ps1');
const launcher=path.join(root,'desktop','update-launcher.cjs');
const report={output,root,scope:'Actual runner body and launcher; synthetic update state; UAC and GUI mocked; actual hidden helper lifetime and detached supervisor checked.',checks:{},scenarios:{},errors:[]};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const jsonFile=async file=>JSON.parse(await readFile(file,'utf8'));
const psEncoded=value=>Buffer.from(JSON.stringify(value),'utf8').toString('base64');
async function until(check,message,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){const value=await check().catch(()=>null);if(value)return value;await sleep(70);}throw Error(message);}
async function command(command,args,{env=process.env,timeout=20000}={}){
  return await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env});let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    const timer=setTimeout(()=>{child.kill();reject(Error(`QA subprocess timed out: ${command}`));},timeout);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
  });
}

const helper=path.join(output,'synthetic-installer.cjs');
await writeFile(helper,`const fs=require('node:fs');const path=require('node:path');const c=JSON.parse(Buffer.from(process.argv[2],'base64'));
fs.writeFileSync(path.join(c.state,'helper-started.json'),JSON.stringify({pid:process.pid,at:Date.now()}));
setTimeout(()=>{
 const value={ok:c.case!=='installer-failed',attemptId:c.case==='mismatched-attempt'?'other-qa-attempt':c.attemptId,buildId:c.case==='mismatched-build'?'other-qa-build':c.buildId,installerPid:c.case==='mismatched-pid'?2147483600:process.pid,installHome:c.home,app:path.join(c.home,'App','Exomina.exe'),verifiedFiles:3};
 if(!value.ok)value.error='Synthetic copy verification failed; previous app preserved.';
 if(c.case!=='missing-report')fs.writeFileSync(path.join(c.state,'install-report.json'),JSON.stringify(value));
 if(value.ok)fs.writeFileSync(path.join(c.home,'App','exomina.build.json'),JSON.stringify({id:c.case==='mismatched-stamp'?'other-qa-build':c.buildId}));
 if(c.canonicalMissing)fs.unlinkSync(path.join(c.home,'App','Exomina.exe'));
 if(c.case==='newer-pending')fs.writeFileSync(path.join(c.state,'pending-update.json'),JSON.stringify({attemptId:'newer-qa-attempt',buildId:'newer-qa-build'}));
 fs.writeFileSync(path.join(c.state,'helper-finished.json'),JSON.stringify({pid:process.pid,at:Date.now()}));
 process.exit(value.ok&&c.case!=='nonzero-valid-report'?0:9);
},1500);
`);

const wrapper=path.join(output,'runner-wrapper.ps1');
await writeFile(wrapper,`param([Parameter(Mandatory)][string]$Config,[int]$LauncherPid=0,[int]$BootstrapPid=0)
$ErrorActionPreference='Stop'
$qa=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Config))|ConvertFrom-Json
$script:qa=$qa
function Start-Process {
 [CmdletBinding()]param([string]$FilePath,[string]$ArgumentList,[string]$Verb,[string]$WindowStyle,[switch]$Wait,[switch]$PassThru,[string]$WorkingDirectory)
 if($Verb -eq 'RunAs'){
  if($Wait){throw 'QA rejects Start-Process -Wait: use explicit installer polling.'}
  if($WindowStyle -ne 'Hidden'){throw 'Installer launch must be hidden.'}
  [IO.File]::WriteAllText((Join-Path $script:qa.state 'installer-launch.json'),(@{arguments=$ArgumentList;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress))
  if($script:qa.case -eq 'launch-declined'){throw [ComponentModel.Win32Exception]::new(1223,'Synthetic UAC cancelled.')}
  if($script:qa.case -eq 'launch-failed'){throw [ComponentModel.Win32Exception]::new(5,'Synthetic installer launch access denied.')}
  $arguments='"'+$script:qa.helper+'" '+$script:qa.encoded
  $native=Microsoft.PowerShell.Management\\Start-Process -FilePath $script:qa.node -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if($script:qa.case -eq 'state-write-failed'){$null=New-Item -ItemType Directory -Path (Join-Path $script:qa.state 'update-watcher.json.runner.tmp')}
  if($script:qa.case -eq 'wait-failed'){
   $handle=[pscustomobject]@{Id=$native.Id;Native=$native}
   $handle|Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {throw 'Synthetic elevated process wait inaccessible.'}
   $handle|Add-Member -MemberType ScriptProperty -Name ExitCode -Value {$this.Native.ExitCode}
   return $handle
  }
  return $native
 }
 $allowed=@($script:qa.exe,(Join-Path $script:qa.home 'App\\Exomina.exe'))
 if(-not ($allowed|Where-Object {[IO.Path]::GetFullPath($_) -eq [IO.Path]::GetFullPath($FilePath)})){throw "Unexpected unmocked process: $FilePath"}
 if($script:qa.launchFailure -eq 'both' -or ($script:qa.launchFailure -eq 'canonical' -and [IO.Path]::GetFullPath($FilePath) -eq [IO.Path]::GetFullPath((Join-Path $script:qa.home 'App\\Exomina.exe')))){throw 'Synthetic Windows launch denied.'}
 if(Test-Path -LiteralPath (Join-Path $script:qa.state 'helper-started.json')){
  $started=Get-Content -LiteralPath (Join-Path $script:qa.state 'helper-started.json') -Raw|ConvertFrom-Json
  if(Get-Process -Id $started.pid -ErrorAction SilentlyContinue){throw 'Exomina reopened while the synthetic installer was alive.'}
 }
 [IO.File]::WriteAllText((Join-Path $script:qa.state 'reopened.json'),(@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();nodeMode=$env:ELECTRON_RUN_AS_NODE;exe=$FilePath;workingDirectory=$WorkingDirectory}|ConvertTo-Json -Compress))
}
$parseErrors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($qa.runner,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw ($parseErrors|Out-String)}
if(-not $ast.ParamBlock){throw 'Actual runner has no ParamBlock.'}
$source=[IO.File]::ReadAllText($qa.runner)
$body=$ast.ParamBlock.Extent.Text+[Environment]::NewLine+$source.Substring($ast.ParamBlock.Extent.EndOffset)
$invoke=@{Installer=$qa.installer;Build=$qa.build;InstallHome=$qa.home;Exe=$qa.exe;State=$qa.state;BuildId=$qa.buildId;AttemptId=$qa.attemptId;LauncherPid=$(if($LauncherPid){$LauncherPid}else{$PID});AppPid=$(if($qa.appPid){$qa.appPid}else{2147483600});BootstrapPid=$BootstrapPid}
& ([scriptblock]::Create($body)) @invoke
`);

async function scenario(name,{recovery=false,installerCase=name,launchFailure='',canonicalMissing=false}={}){
 const directory=path.join(output,name),state=path.join(directory,'state'),home=path.join(directory,'home'),build=path.join(directory,'build'),canonicalExe=path.join(home,'App','Exomina.exe'),exe=recovery?path.join(home,'App-recovery','Exomina.exe'):canonicalExe;
 await Promise.all([mkdir(state,{recursive:true}),mkdir(path.dirname(exe),{recursive:true}),mkdir(path.dirname(canonicalExe),{recursive:true}),mkdir(build,{recursive:true})]);
 await writeFile(exe,'Synthetic placeholder: must never be executed.');
 if(recovery)await writeFile(canonicalExe,'Synthetic canonical placeholder: must never be executed.');
 await writeFile(path.join(home,'App','exomina.build.json'),JSON.stringify({id:'old-qa-build'}));
 const config={case:installerCase,state,home,build,exe,launchFailure,canonicalMissing,buildId:'new-qa-build',attemptId:`qa-${name}`,runner,installer:path.join(directory,'synthetic-install.ps1'),helper,node:process.execPath};
 config.encoded=psEncoded(config);
 await writeFile(config.installer,'# Synthetic placeholder: real installer entry point is never invoked.\n');
 await writeFile(path.join(state,'pending-update.json'),JSON.stringify({buildId:config.buildId,attemptId:config.attemptId,startedAt:new Date().toISOString()}));
 const before=Date.now();
 const execution=await command(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',wrapper,'-Config',psEncoded(config)],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 const value=await jsonFile(path.join(state,'last-update.json'));
 const reopenResult=await jsonFile(path.join(state,'update-reopen.json'));
 const reopened=launchFailure==='both'?null:await jsonFile(path.join(state,'reopened.json'));
 assert.equal(value.buildId,config.buildId);assert.equal(value.attemptId,config.attemptId);assert.ok(value.finishedAt);
 if(reopened){
 assert.equal(reopened.nodeMode,null,'GUI reopen must remove supervisor Electron Node mode');
 const expectedExe=value.status==='installed'&&!launchFailure&&!canonicalMissing?canonicalExe:exe;
 assert.equal(path.resolve(reopened.exe),path.resolve(expectedExe),'Reopen must select the newly activated App on success, or the caller on failure');
 assert.equal(path.resolve(reopened.workingDirectory),path.dirname(path.resolve(expectedExe)));
 }
 assert.equal(reopenResult.status,launchFailure==='both'?'failed':launchFailure||canonicalMissing?'fallback':'launched');
 if(launchFailure||canonicalMissing){assert.ok(reopenResult.error);assert.ok(value.message);}
 if(launchFailure==='both')assert.ok(reopenResult.fallbackError);
 if(!installerCase.startsWith('launch-')){
  const finish=await jsonFile(path.join(state,'helper-finished.json'));
  assert.ok(finish.at-before>=1200,'Hidden helper returned before simulated installer work completed');
  if(reopened)assert.ok(reopened.at>=finish.at,'Exomina must reopen only after installer finishes');
  assert.ok(execution.code===0,`Runner wrapper failed: ${execution.stderr}`);
 }
 if(['success','wait-failed','newer-pending'].includes(installerCase)){assert.equal(value.status,'installed');}
 else if(installerCase==='launch-declined'){assert.equal(value.status,'declined');}
 else {assert.equal(value.status,'failed');assert.ok(value.message,'Failure must include an explanation');}
 if(name==='installer-failed')assert.match(value.message,/Synthetic copy verification failed/);
 if(name==='launch-failed')assert.match(value.message,/access denied/i);
 if(name==='nonzero-valid-report')assert.match(value.message,/code 9/);
 if(name==='newer-pending'){
  assert.equal((await jsonFile(path.join(state,'pending-update.json'))).attemptId,'newer-qa-attempt');
  report.checks.newerPendingAttemptIsPreserved=true;
 }else if(name!=='state-write-failed')assert.equal(await readFile(path.join(state,'pending-update.json'),'utf8').catch(()=>null),null,'Matching pending state must be cleared');
 if(name==='state-write-failed')report.checks.runnerStorageFailureWaitsForInstaller=true;
 report.scenarios[name]={status:value.status,message:value.message,elapsedMs:Date.now()-before,runnerExit:execution.code,diagnostics:value};
}

async function launcherScenario({name,code=0,parentExit=false,installerAlive=false,completed=false,canonicalMissing=false,previousMissing=false}){
 const directory=path.join(output,name),state=path.join(directory,'state'),home=path.join(directory,'home');
 await Promise.all([mkdir(state,{recursive:true}),mkdir(path.join(home,'App'),{recursive:true})]);
 const attemptId=`qa-${name}`,buildId='new-qa-build';
 await writeFile(path.join(state,'pending-update.json'),JSON.stringify({attemptId,buildId,startedAt:new Date().toISOString()}));
 await writeFile(path.join(home,'App','exomina.build.json'),JSON.stringify({id:'old-qa-build'}));
 const reopener=path.join(directory,'observe-reopen.cjs');
 await writeFile(reopener,`if(!process.argv[1]){require('node:fs').writeFileSync(${JSON.stringify(path.join(state,'reopened.json'))},JSON.stringify({at:Date.now(),exe:process.execPath,nodeMode:process.env.ELECTRON_RUN_AS_NODE||null,bootstrap:process.env.EXOMINA_UPDATER_BOOTSTRAP_PID||null}));process.exit(0);}`);
 if(installerAlive&&!canonicalMissing)await copyFile(process.execPath,path.join(home,'App','Exomina.exe'));
 const env={...process.env,NODE_OPTIONS:`--require ${JSON.stringify(reopener)}`};
 delete env.EXOMINA_WINDOWS_INDEPENDENT;delete env.EXOMINA_UPDATER_BOOTSTRAP_PID;
 const helperConfig={case:'success',attemptId,buildId,state,home};
 const harmless=path.join(directory,'harmless-runner.ps1');
 await writeFile(harmless,`param([string]$State,[string]$AttemptId,[string]$BuildId,[int]$LauncherPid,[int]$BootstrapPid,[string]$InstallHome,[string]$Exe)
$ErrorActionPreference='Stop'
[IO.File]::WriteAllText((Join-Path $State 'harmless-started.json'),(@{pid=$PID;launcherPid=$LauncherPid;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress))
${installerAlive?`$arguments='"${helper}" ${psEncoded(helperConfig)}'
$helper=Start-Process -FilePath '${process.execPath}' -ArgumentList $arguments -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText((Join-Path $State 'install-progress.json'),(@{attemptId=$AttemptId;buildId=$BuildId;installerPid=$helper.Id;phase='verifying';updatedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress))
`:'Start-Sleep -Milliseconds 1800'}
[IO.File]::WriteAllText((Join-Path $State 'harmless-finished.json'),(@{pid=$PID;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress))
${parentExit||completed?`[IO.File]::WriteAllText((Join-Path $State 'last-update.json'),(@{attemptId=$AttemptId;buildId=$BuildId;status='declined';message='Synthetic handled result.';finishedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress))
[IO.File]::WriteAllText((Join-Path $State 'update-watcher.json'),(@{attemptId=$AttemptId;buildId=$BuildId;phase='declined';pid=$LauncherPid;runnerPid=$PID;installerPid=0;updatedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress))`:''}
${code?'[Console]::Error.WriteLine("Synthetic watcher stderr retained.")':''}
exit ${code}
`);
 const previousExe=previousMissing?path.join(directory,'missing-previous.exe'):process.execPath;
 const args=[launcher,powershell,'-NoLogo','-NoProfile','-NonInteractive','-File',harmless,'-State',state,'-AttemptId',attemptId,'-BuildId',buildId,'-InstallHome',home,'-Exe',previousExe];
 if(parentExit){
  const parent=path.join(directory,'short-lived-parent.cjs');
  await writeFile(parent,`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,${JSON.stringify(args)},{detached:true,windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(path.join(state,'parent.json'))},JSON.stringify({parentPid:process.pid,launcherPid:child.pid}));child.unref();`);
  const execution=await command(process.execPath,[parent],{env});assert.equal(execution.code,0);
  const parentValue=await jsonFile(path.join(state,'parent.json'));
  const start=await until(()=>jsonFile(path.join(state,'harmless-started.json')),'Detached supervisor did not start its hidden runner');
  assert.ok(start.launcherPid>0);assert.ok(parentValue.launcherPid>0);
  const finish=await until(()=>jsonFile(path.join(state,'harmless-finished.json')),'Supervisor/runner did not survive parent exit');
  assert.ok(finish.at-start.at>=1500);
  report.checks.detachedSupervisorSurvivesParentExit=true;
 }else{
  const execution=await command(process.execPath,args,{env});
  assert.ok(execution.code===0||execution.code===code,`Initial supervisor failed: ${execution.stderr}`);
  if(code){
   const value=await until(()=>jsonFile(path.join(state,'last-update.json')),'Supervisor did not preserve runner outcome');
   assert.equal(value.attemptId,attemptId);assert.equal(value.buildId,buildId);
   if(completed){
    assert.equal(value.status,'declined');await sleep(400);
    assert.equal(await readFile(path.join(state,'reopened.json'),'utf8').catch(()=>null),null,'Supervisor duplicated runner reopen after existing final result');
    report.checks.supervisorDoesNotDuplicateCompletedOutcome=true;
   }else{
    if(previousMissing){
     const reopen=await until(()=>jsonFile(path.join(state,'update-reopen.json')),'Supervisor did not record both launch failures');
     assert.equal(reopen.status,'failed');assert.ok(reopen.error);assert.ok(reopen.fallbackError);assert.equal(value.status,'installed');
     report.checks.supervisorRecordsBothLaunchFailuresWithoutRetry=true;return;
    }
    const reopened=await until(()=>jsonFile(path.join(state,'reopened.json')),'Fallback did not reopen synthetic Node observer');
    assert.equal(reopened.nodeMode,null);assert.equal(reopened.bootstrap,null);
    const finalWatcher=await jsonFile(path.join(state,'update-watcher.json'));
    assert.equal(finalWatcher.attemptId,attemptId);assert.equal(finalWatcher.buildId,buildId);assert.equal(finalWatcher.phase,value.status);
    if(installerAlive){
     const finish=await jsonFile(path.join(state,'helper-finished.json'));
     assert.ok(reopened.at>=finish.at,'Supervisor reopened before live installer finished');
     assert.equal(value.status,'installed');report.checks.supervisorWaitsForInstallerAfterRunnerFailure=true;
     assert.equal(path.resolve(reopened.exe),canonicalMissing?path.resolve(process.execPath):path.join(home,'App','Exomina.exe'),'Supervisor must reopen canonical, falling back to previous only after a spawn error');
     if(canonicalMissing){
      const reopen=await jsonFile(path.join(state,'update-reopen.json'));assert.equal(reopen.status,'fallback');assert.ok(reopen.error);
      report.checks.supervisorSpawnErrorFallsBackOnce=true;
     }else report.checks.supervisorRecoverySuccessReopensCanonicalApp=true;
    }else{
     assert.equal(value.status,'failed');assert.match(JSON.stringify(value),/Synthetic watcher stderr retained/);
     assert.equal(path.resolve(reopened.exe),path.resolve(process.execPath),'Supervisor failure must reopen the previous executable');
     report.checks.supervisorPreservesRunnerFailure=true;
    }
   }
  }
 }
}

async function legacyInstalledHostJob(){
 const directory=path.join(output,'legacy-installed-host-job'),home=path.join(directory,'home'),app=path.join(home,'App'),build=path.join(home,'Source','release','win-unpacked'),state=path.join(directory,'state'),unpacked=path.join(app,'resources','app.asar.unpacked'),desktop=path.join(unpacked,'desktop');
 await Promise.all([mkdir(desktop,{recursive:true}),mkdir(path.join(unpacked,'scripts'),{recursive:true}),mkdir(build,{recursive:true}),mkdir(state,{recursive:true})]);
 await Promise.all([
  copyFile(process.execPath,path.join(build,'Exomina.exe')),
  ...['update-launcher.cjs','app-lifetime.mjs','app-lifetime.ps1'].map(file=>copyFile(path.join(root,'desktop',file),path.join(desktop,file))),
  writeFile(path.join(app,'exomina.build.json'),JSON.stringify({id:'legacy-old-qa-build',version:'0.5.0-beta.4',builtAt:'2026-10-01T00:00:00Z'})),
  writeFile(path.join(build,'exomina.build.json'),JSON.stringify({id:'legacy-new-qa-build',version:'0.5.0-beta.4',builtAt:'2026-10-10T00:00:00Z'})),
  writeFile(path.join(app,'Exomina.exe'),'Synthetic placeholder: GUI reopen is mocked.'),
  writeFile(path.join(unpacked,'scripts','install-windows.ps1'),'# Synthetic installer placeholder; UAC is mocked.\n'),
 ]);
 const config={case:'success',state,home,build,exe:path.join(app,'Exomina.exe'),buildId:'legacy-new-qa-build',attemptId:'runtime-filled-qa-attempt',runner,installer:path.join(unpacked,'scripts','install-windows.ps1'),helper,node:process.execPath};
 await writeFile(path.join(desktop,'update-runner.ps1'),`param([string]$Installer,[string]$Build,[string]$InstallHome,[string]$Exe,[string]$State,[string]$BuildId,[string]$AttemptId,[int]$AppPid,[int]$LauncherPid,[int]$BootstrapPid)
$ErrorActionPreference='Stop'
$qa=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${psEncoded(config)}'))|ConvertFrom-Json
$qa.attemptId=$AttemptId;$qa.buildId=$BuildId
$qa|Add-Member -NotePropertyName appPid -NotePropertyValue $AppPid
$qa|Add-Member -NotePropertyName encoded -NotePropertyValue ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($qa|ConvertTo-Json -Depth 5 -Compress))))
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($qa|ConvertTo-Json -Depth 5 -Compress)))
& '${wrapper.replaceAll("'","''")}' -Config $encoded -LauncherPid $LauncherPid -BootstrapPid $BootstrapPid
`);
 const legacyUpdater=options['legacy-updater']||'C:/Program Files/Exomina/App/resources/app.asar.unpacked/desktop/updates.mjs';
 const host=path.join(directory,'legacy-host.mjs');
 await writeFile(host,`import {Updater} from ${JSON.stringify(new URL('file:///'+path.resolve(legacyUpdater).replaceAll('\\','/')).href)};
import {writeFile,readFile} from 'node:fs/promises';import path from 'node:path';
const state=${JSON.stringify(state)};
try{
 const updater=new Updater({packaged:true,appDir:${JSON.stringify(app)},home:${JSON.stringify(home)},resourcesDir:${JSON.stringify(path.join(app,'resources'))},stateDir:state,exePath:${JSON.stringify(path.join(app,'Exomina.exe'))}});
 await updater.launch({conversationId:'synthetic-old-host-chat'});
 const pending=JSON.parse(await readFile(path.join(state,'pending-update.json'),'utf8'));
 const ready=JSON.parse(await readFile(path.join(state,'update-ready.json'),'utf8'));
 await writeFile(path.join(state,'legacy-host-ready.json'),JSON.stringify({appPid:process.pid,pending,ready,at:Date.now()}));
 setInterval(()=>{},1000);
}catch(error){await writeFile(path.join(state,'legacy-host-error.json'),JSON.stringify({message:error.message,stack:error.stack}));process.exitCode=1;}
`);
 const jobScript=path.join(directory,'hidden-job-fixture.ps1');
 await writeFile(jobScript,`param([string]$Output,[string]$Node,[string]$HostScript)
$ErrorActionPreference='Stop'
$source=@'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class ExominaUpdaterJobFixture {
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct Io {public ulong read,write,other,readBytes,writeBytes,otherBytes;}
 [StructLayout(LayoutKind.Sequential)] struct Extended {public Basic basic;public Io io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Extended limits,int size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static string Quote(string value){var s=new StringBuilder("\\\"");int n=0;foreach(char c in value){if(c=='\\\\'){n++;continue;}s.Append('\\\\',c=='"'?n*2+1:n);s.Append(c);n=0;}s.Append('\\\\',n*2);return s.Append('"').ToString();}
 public static int Main(string[] args){try{
  IntPtr job=CreateJobObject(IntPtr.Zero,null);var limits=new Extended();limits.basic.flags=0x2000|0x800;
  if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits))||!AssignProcessToJobObject(job,Process.GetCurrentProcess().Handle))throw new Win32Exception();
  var start=new ProcessStartInfo(args[0],Quote(args[1]));start.UseShellExecute=false;start.CreateNoWindow=true;Process.Start(start);
  DateTime deadline=DateTime.UtcNow.AddSeconds(15);string ready=Path.Combine(args[2],"legacy-host-ready.json"),error=Path.Combine(args[2],"legacy-host-error.json");
  while(!File.Exists(ready)){if(File.Exists(error))throw new Exception(File.ReadAllText(error));if(DateTime.UtcNow>deadline)throw new Exception("Legacy host readiness timed out.");Thread.Sleep(50);}
  File.WriteAllText(Path.Combine(args[2],"job-parent-closed.json"),"{\\\"at\\\":"+DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+"}");
  CloseHandle(job);return 0;
 }catch(Exception e){File.WriteAllText(Path.Combine(args[2],"job-fixture-error.txt"),e.ToString());return 1;}}
}
'@
$native=Join-Path $Output 'ExominaUpdaterJobFixture.exe'
$null=Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $native -OutputType WindowsApplication
$arguments=@($Node,$HostScript,$Output)|ForEach-Object {'"'+$_.Replace('"','\\"')+'"'}
$child=Start-Process -FilePath $native -ArgumentList ($arguments -join ' ') -WindowStyle Hidden -PassThru
$null=$child.WaitForExit(20000)
if(Test-Path -LiteralPath (Join-Path $Output 'job-fixture-error.txt')){throw (Get-Content -LiteralPath (Join-Path $Output 'job-fixture-error.txt') -Raw)}
`);
 const env={...process.env};delete env.NODE_OPTIONS;delete env.EXOMINA_WINDOWS_INDEPENDENT;delete env.EXOMINA_UPDATER_BOOTSTRAP_PID;
 const execution=await command(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',jobScript,'-Output',state,'-Node',process.execPath,'-HostScript',host],{env,timeout:30000});
 assert.equal(execution.code,0,`Legacy job fixture failed: ${execution.stderr}`);
 const hostReady=await jsonFile(path.join(state,'legacy-host-ready.json'));
 assert.equal(hostReady.pending.ready,true);assert.equal(hostReady.ready.pid,hostReady.pending.pid);
 assert.notEqual(hostReady.ready.supervisorPid,hostReady.ready.pid,'Test must exercise an independent relay rather than direct startup');
 const closed=await jsonFile(path.join(state,'job-parent-closed.json'));
 const final=await until(()=>jsonFile(path.join(state,'last-update.json')),'Independent updater did not finish after closing legacy host job');
 assert.equal(final.status,'installed');assert.equal(final.attemptId,hostReady.pending.attemptId);
 const started=await jsonFile(path.join(state,'helper-started.json'));
 const finished=await jsonFile(path.join(state,'helper-finished.json'));
 const reopened=await jsonFile(path.join(state,'reopened.json'));
 assert.ok(started.at>=closed.at,'Installer started before old host job closed');assert.ok(reopened.at>=finished.at);
 report.checks.installedLegacyUpdaterAcceptsBootstrapReadiness=true;
 report.checks.independentUpdaterSurvivesLegacyHostKillOnCloseJob=true;
 report.legacyHostJob={legacyUpdater,appPid:hostReady.appPid,bootstrapPid:hostReady.ready.pid,supervisorPid:hostReady.ready.supervisorPid,final};
}

try{
 if(options['launcher-only']!=='true'){
 for(const name of ['success','wait-failed','state-write-failed','newer-pending','installer-failed','nonzero-valid-report','mismatched-attempt','mismatched-build','mismatched-pid','mismatched-stamp','missing-report','launch-declined','launch-failed'])await scenario(name);
 for(const installerCase of ['success','launch-declined','installer-failed'])await scenario(`recovery-${installerCase}`,{recovery:true,installerCase});
 await scenario('recovery-launch-denied',{recovery:true,installerCase:'success',launchFailure:'canonical'});
 await scenario('recovery-canonical-missing',{recovery:true,installerCase:'success',canonicalMissing:true});
 await scenario('recovery-both-launches-denied',{recovery:true,installerCase:'success',launchFailure:'both'});
 report.checks.runnerCanonicalLaunchFailureFallsBackOnce=true;
 report.checks.runnerBothLaunchFailuresAreRecorded=true;
 report.checks.recoverySuccessReopensCanonicalApp=true;
 report.checks.recoveryFailureAndDeclineReopenPreviousCopy=true;
 report.checks.runnerWaitsForActualHiddenInstaller=true;
 report.checks.reportAndInstalledStampMustMatchAttempt=true;
 report.checks.declinedAndLaunchFailureAreDistinct=true;
 }
 if(options['runner-only']!=='true'){
 await launcherScenario({name:'launcher-parent-exit',parentExit:true});
 await launcherScenario({name:'launcher-runner-failure',code:7});
 await launcherScenario({name:'launcher-installer-still-alive',code:7,installerAlive:true});
 await launcherScenario({name:'launcher-result-already-written',code:7,completed:true});
 await launcherScenario({name:'launcher-canonical-missing',code:7,installerAlive:true,canonicalMissing:true});
 await launcherScenario({name:'launcher-both-executables-missing',code:7,installerAlive:true,canonicalMissing:true,previousMissing:true});
 if(options['skip-legacy']!=='true')await legacyInstalledHostJob();
 }
 report.passed=true;
}catch(error){report.passed=false;report.errors.push(error.stack);process.exitCode=1;}
await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
