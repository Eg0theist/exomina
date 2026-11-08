// Exercise the exact package as an installed App with the updater still alive.
// All profile, updater and home paths belong to a fresh synthetic fixture.
import {createProtectedQaProfile} from './qa-profile.mjs';
import {prepareWindowsQaOwner} from './native-qa-windows-owner.mjs';
import {watchStartup} from './native-qa-startup.mjs';
import {Store} from '../desktop/store.mjs';
import {WindowsVault} from '../desktop/vault.mjs';
import {mkdir,readFile,writeFile,readdir,copyFile,symlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

if(process.platform!=='win32')throw Error('Installed update handoff qualification requires Windows.');
await prepareWindowsQaOwner();
const build=path.resolve(process.argv[2]||''),stamp=JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8'));
const fixture=await createProtectedQaProfile('update-handoff'),{profile,output}=fixture;
const home=path.join(output,'install'),appDir=path.join(home,'App'),runtime=path.join(output,'synthetic-runtime'),workspace=path.join(profile,'workspace');
const userHome=path.join(output,'synthetic-home'),stateDir=profile+'.updates';
for(const directory of [appDir,runtime,workspace,stateDir,path.join(userHome,'AppData/Local'),path.join(userHome,'AppData/Roaming'),path.join(userHome,'Documents')])await mkdir(directory,{recursive:true});
// Reuse immutable resource directories without duplicating gigabytes. Top-level
// files are copies: package metadata must retain its single-link invariant.
// Every writable app/profile path is explicitly synthetic.
for(const entry of await readdir(build,{withFileTypes:true})){
  if(entry.name==='exomina-source'||entry.name==='exomina.paths.json')continue;
  const from=path.join(build,entry.name),to=path.join(appDir,entry.name);
  if(entry.isDirectory())await symlink(from,to,'junction');else if(entry.isFile())await copyFile(from,to);else throw Error('Unexpected package link.');
}
await writeFile(path.join(appDir,'exomina.paths.json'),JSON.stringify({home:'..'}),'utf8');
const recovery=await readFile(profile+'.setup/recovery-backup.json');
const vault=new WindowsVault();try{await vault.protect(runtime,{recoveryThumbprint:JSON.parse(recovery).thumbprint});}finally{vault.close();}
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{workspace,autoUpdate:false,autoTitle:false,closeToTray:false,quickAccess:false,attentionNotifications:false,memoryEnabled:false,chatMemoryEnabled:false,chatMemoryBackfill:false,chatMemorySummaries:false,browserEnabled:false,desktopEnabled:false,toolUpdates:{checkAutomatically:false,automatic:false,automaticConnections:false},externalMcpServers:[]});
const chat=store.create('codex');chat.title='Retained handoff test';chat.messages=[{id:'synthetic-handoff-message',role:'user',content:'Retained during live update handoff'}];await store.save();
const attemptId=randomUUID(),createdAt=new Date().toISOString();
const record={attemptId,buildId:stamp.id};
const write=(name,value)=>writeFile(path.join(stateDir,name),JSON.stringify(value),'utf8');
await write('pending-update.json',{...record,pid:process.pid,ready:true,phase:'ready',startedAt:createdAt});
await write('update-ready.json',{attemptId,pid:process.pid,supervisorPid:process.pid});
await write('install-progress.json',{...record,phase:'done',installerPid:0,updatedAt:createdAt});
await write('update-watcher.json',{...record,pid:process.pid,installerPid:process.pid,phase:'verifying-startup',updatedAt:createdAt});
await write('last-update.json',{...record,status:'verifying-startup',finishedAt:createdAt});
// Generate the challenge/control with the shipped PowerShell writer, including
// its native timestamps and serialization. Only helper launch is substituted
// with the live QA supervisor: no installer, recovery or deletion is invoked.
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),installer=path.join(build,'resources/app.asar.unpacked/scripts/install-windows.ps1');
const prepare=path.join(output,'prepare-handoff.ps1');
await writeFile(prepare,`param([string]$Installer,[string]$InstallHome,[string]$State,[string]$Build,[string]$AttemptId,[string]$BuildId,[int]$HelperPid)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$syntax=[Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer parse failure.'}
foreach($definition in $syntax.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){if($definition.Name -in @('Fail','Assert-PlainDirectory','Read-CleanupJson','Write-CleanupJson','Start-ProgramCleanup')){. ([ScriptBlock]::Create($definition.Extent.Text))}}
function Start-Process {param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru) if('-CleanupAfterLaunch' -notin $ArgumentList){throw 'Unexpected helper launch.'};return [pscustomobject]@{Id=$HelperPid}}
$Report=Join-Path $State 'install-report.json';$UpdateLauncherPid=$HelperPid;$CleanupTimeoutSeconds=180
$control=Start-ProgramCleanup $InstallHome (Join-Path $InstallHome ('App.previous-'+('a'*32))) $Build
Write-CleanupJson $Report @{attemptId=$AttemptId;buildId=$BuildId;ok=$true;programCleanup=$control}
`,'utf8');
await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-File',prepare,'-Installer',installer,'-InstallHome',home,'-State',stateDir,'-Build',build,'-AttemptId',attemptId,'-BuildId',stamp.id,'-HelperPid',String(process.pid)],{windowsHide:true,timeout:15000});
const challenge=JSON.parse(await readFile(path.join(stateDir,'program-cleanup-pending.json'),'utf8')),token=challenge.token;
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:runtime,EXOMINA_WORKSPACE_DIR:workspace,HOME:userHome,USERPROFILE:userHome,APPDATA:path.join(userHome,'AppData/Roaming'),LOCALAPPDATA:path.join(userHome,'AppData/Local'),TEMP:output,TMP:output,TMPDIR:output};
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization|^(NODE_OPTIONS|BUN_OPTIONS|ELECTRON_RUN_AS_NODE|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i.test(key)||(/^EXOMINA_/i.test(key)&&!['EXOMINA_DATA_DIR','EXOMINA_ACCOUNTS_DIR','EXOMINA_WORKSPACE_DIR'].includes(key)))delete env[key];
const {_electron}=createRequire(import.meta.url)('playwright');
let app,appMainPid,report={at:new Date().toISOString(),buildId:stamp.id,version:stamp.version,output,passed:false,scope:'Exact immutable package in a synthetic installed App layout with a live handoff supervisor, real Windows EFS and production health predicate. No personal profile, sign-in or inference.'};
try{
  await assert.rejects(readFile(path.join(stateDir,'program-cleanup-health.json')),{code:'ENOENT'});
  const launchedAt=Date.now();
  app=await _electron.launch({executablePath:path.join(appDir,'Exomina.exe'),args:['--mute-audio','--user-data-dir='+profile],cwd:home,env,timeout:30000});
  appMainPid=await app.evaluate(()=>process.pid);
  const guard=watchStartup(app.process()),page=await guard.race(app.firstWindow());page.setDefaultTimeout(20000);
  await guard.race(page.locator('.app-shell').waitFor());
  const state=await page.evaluate(()=>window.studio.invoke('security.status'));assert.equal(state.ready,true);assert.equal(state.mode,'efs');
  const retained=await page.evaluate(id=>window.studio.invoke('conversations.get',{id}),chat.id);assert.equal(retained.messages[0].content,'Retained during live update handoff');
  let health;const deadline=Date.now()+30000;
  while(Date.now()<deadline){guard.check();try{health=JSON.parse(await readFile(path.join(stateDir,'program-cleanup-health.json'),'utf8'));if(health.buildId===stamp.id&&health.token===token&&health.ready)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(health?.buildId,stamp.id,'The installed candidate did not acknowledge workspace health.');assert.equal(health?.token,token);
  const identity=await app.evaluate(({BrowserWindow})=>({pid:process.pid,rendererPid:BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()}));
  assert.equal(health?.pid,identity.pid);assert.equal(health?.rendererPid,identity.rendererPid);assert.ok(Date.now()-launchedAt>=15000,'The stable startup interval was bypassed.');
  // Run the real installer's health predicate against real process paths/PIDs.
  const predicate=path.join(output,'check-health.ps1');
  await writeFile(predicate,`param([string]$Installer,[string]$InstallHome,[string]$State,[string]$BuildId)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$syntax=[Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer parse failure.'}
foreach($definition in $syntax.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){if($definition.Name -in @('Fail','Assert-PlainDirectory','Read-CleanupJson','Test-CleanupHealth')){. ([ScriptBlock]::Create($definition.Extent.Text))}}
$challenge=Read-CleanupJson (Join-Path $State 'program-cleanup-pending.json')
if(Test-CleanupHealth $InstallHome $State ('f'*32) $BuildId){throw 'A wrong health token was accepted.'}
if(-not (Test-CleanupHealth $InstallHome $State $challenge.token $BuildId)){throw 'Production startup-health predicate rejected the candidate.'}
Write-Output 'healthy'
`,'utf8');
  const result=await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-File',predicate,'-Installer',installer,'-InstallHome',home,'-State',stateDir,'-BuildId',stamp.id],{windowsHide:true,timeout:15000});assert.equal(result.stdout.trim(),'healthy');
  const update=await page.evaluate(()=>window.studio.invoke('update.status'));assert.equal(update.inProgress,true);assert.equal(update.verifyingStartup,true);
  await write('last-update.json',{...record,status:'installed',finishedAt:new Date().toISOString()});
  const {rm}=await import('node:fs/promises');await rm(path.join(stateDir,'pending-update.json'));await write('update-watcher.json',{...record,installerPid:0,phase:'installed',updatedAt:new Date().toISOString()});
  const complete=await page.evaluate(()=>window.studio.invoke('update.status'));assert.equal(complete.inProgress,false);assert.equal(complete.lastResult.status,'installed');
  report.checks={workspaceOpensDuringOwnHandoff:true,retainedConversation:true,efsStorage:true,productionHandoffWriter:true,healthAcknowledgedAfterStableInterval:true,productionProcessHealthAccepted:true,wrongHealthTokenRejected:true,handoffRemainsInProgress:true,completedHandoffSettles:true};report.passed=true;
}catch(error){report.error=error.message;}
finally{if(app){
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
  await app.evaluate(({app})=>{setImmediate(()=>app.quit());return true;}).catch(()=>{});
  const deadline=Date.now()+10000;while(appMainPid&&alive(appMainPid)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
  if(appMainPid&&alive(appMainPid)){report.passed=false;report.error='The synthetic app did not stop within the shutdown bound.';}
  // Take the launcher handle before close(): close tears down the driver connection.
  else{report.shutdownConfirmed=true;let launcher=null;try{launcher=app.process();}catch{}app.close().catch(()=>{});if(launcher&&launcher.pid!==appMainPid&&launcher.exitCode===null)launcher.kill();}
}}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');assert.equal(hash(await readFile(profile+'.setup/recovery-backup.json')),hash(recovery));report.recoveryUnchanged=true;
await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2),'utf8');process.stdout.write(JSON.stringify(report)+'\n',()=>process.exit(report.passed?0:1));
