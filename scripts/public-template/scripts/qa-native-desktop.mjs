// Exact packaged app, fresh synthetic OS/profile locations, no login/inference.
// The loopback debugging connection belongs only to the child spawned below.
import {chromium} from 'playwright';
import {listPackage} from '@electron/asar';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,writeFile,chmod,realpath,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {distributionMetadataDirectory} from '../desktop/app-paths.mjs';
import {assertLinuxQaSocketLength} from './native-qa-paths.mjs';
import {probeOwnedBrowser} from './native-qa-cdp.mjs';

const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
if(!option('--executable'))throw Error('Pass the exact native packaged executable with --executable.');
const executable=await realpath(path.resolve(option('--executable')));
const output=path.resolve(option('--output')||path.join(os.tmpdir(),'exomina-native-desktop-report'));
await mkdir(output,{recursive:true});
// Known Folder APIs need a canonical synthetic home even when NSIS uses a
// verified short TEMP alias for its own legacy path-length limits.
let profile,socketLength;
if(process.platform==='linux'){
 const projectRoot=await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
 const temporary=path.join(projectRoot,'.runtime-work');
 try{const info=await lstat(temporary);assert.ok(info.isDirectory()&&!info.isSymbolicLink(),'Owned native QA temp must be a regular checkout directory.');}
 catch(error){if(error.code!=='ENOENT')throw error;await mkdir(temporary,{mode:0o700});}
 assert.equal(await realpath(temporary),temporary);
 profile=await realpath(await mkdtemp(path.join(temporary,'p-')));
 assert.equal(path.dirname(profile),temporary);
 socketLength=assertLinuxQaSocketLength(profile);
}else profile=await realpath(await mkdtemp(path.join(os.tmpdir(),'exomina-native-desktop-profile-')));
if(process.platform==='win32'){
 // The development workspace can inherit EFS. This *empty new fixture* must
 // model a fresh ordinary profile, before it contains any app or account files.
 assert.equal(path.dirname(await realpath(profile)),await realpath(os.tmpdir()));
 assert.deepEqual(await readdir(profile),[]);
 const {WindowsProfileAccess}=await import('../desktop/profile-access.mjs');
 const checker=new WindowsProfileAccess();
 try{
  if((await checker.inspect(profile)).anyEncrypted===true)await promisify(execFile)(path.join(process.env.SystemRoot,'System32','cipher.exe'),['/d',profile],{windowsHide:true});
  assert.equal((await checker.inspect(profile)).anyEncrypted,false,'The empty standard fixture must not inherit EFS.');
 }finally{checker.close();}
}
if(process.platform!=='win32')await chmod(profile,0o700);
const dataDir=path.join(profile,'data'),accountsDir=path.join(profile,'accounts'),workspace=path.join(profile,'workspace');
for(const directory of [dataDir,accountsDir,workspace])await mkdir(directory,{mode:0o700});
const environment={...process.env,HOME:profile,USERPROFILE:profile,APPDATA:path.join(profile,'AppData','Roaming'),LOCALAPPDATA:path.join(profile,'AppData','Local'),
 XDG_CONFIG_HOME:path.join(profile,'config'),XDG_DATA_HOME:path.join(profile,'os-data'),XDG_CACHE_HOME:path.join(profile,'cache'),XDG_RUNTIME_DIR:path.join(profile,'runtime'),
 TEMP:profile,TMP:profile,TMPDIR:profile,EXOMINA_DATA_DIR:dataDir,EXOMINA_ACCOUNTS_DIR:accountsDir,EXOMINA_WORKSPACE_DIR:workspace,EXOMINA_STARTUP_DIAGNOSTICS:'1'};
for(const key of Object.keys(environment)){
 if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key)||/^(?:ELECTRON_RUN_AS_NODE|OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_|AWS_|AZURE_|GOOGLE_|GEMINI_|KIMI_|MOONSHOT_|COPILOT_|GITHUB_|GH_|GROK_|XAI_)/i.test(key))delete environment[key];
}
for(const directory of [environment.APPDATA,environment.LOCALAPPDATA,environment.XDG_CONFIG_HOME,environment.XDG_RUNTIME_DIR,
 path.join(profile,'Documents'),path.join(profile,'Desktop'),path.join(profile,'Downloads'),path.join(profile,'Library','Application Support')])await mkdir(directory,{recursive:true,mode:0o700});
const exeDir=path.dirname(executable);
const resources=process.platform==='darwin'?path.resolve(exeDir,'..','Resources'):path.join(exeDir,'resources');
const packagePath=path.join(resources,'app.asar');
const metadataDir=distributionMetadataDirectory(exeDir);
const marker=JSON.parse(await readFile(path.join(metadataDir,'exomina.distribution.json'),'utf8'));
assert.equal(marker.profile,'beta');assert.equal(marker.manualUpdates,true);
const stamp=JSON.parse(await readFile(path.join(metadataDir,'exomina.build.json'),'utf8'));
const entries=listPackage(packagePath);
assert.ok(!entries.some(name=>/agent-spending|AgentSpending/.test(name)),'Agent spending is excluded from the program archive.');
const packagedMain=await readFile(packagePath+'.unpacked/desktop/main.mjs','utf8');
assert.ok(!/SPENDING_TOOLS|spending_preview|case 'spending\./.test(packagedMain),'No spending tool or IPC is registered.');
for(const module of ['realtime-voice.mjs','realtime-transcript.mjs','app-analysis-native.mjs'])assert.ok((await readFile(packagePath+'.unpacked/desktop/'+module)).length>0,'Retained feature module: '+module);
assert.ok(!entries.some(name=>/^\/(?:Private|accounts|data)\//.test(name)),'Package must contain program files only.');
assert.ok(!entries.some(name=>/(?:theme-art[\/]|voice-previews[\/]|voice-previews-clear[\/]|claude-voice-previews[\/]|voice-preview-clips-personal\.js|theme-catalog-full\.mjs)/i.test(name)),'Beta does not redistribute personal theme/recording assets.');
const report={platform:process.platform,arch:process.arch,executable,version:stamp.version,buildId:stamp.id,
 startedAt:new Date().toISOString(),scope:'Exact native packaged UI, fresh synthetic profile, signed-out runtimes. No account sign-in, model inference, microphone, desktop capture/input or external navigation. OS installer and physical hardware behavior are not covered.',checks:{manualBetaMarker:true,programOnlyArchive:true},errors:[]};
if(socketLength)report.checks.linuxSingletonSocketPathBound=socketLength;
let child,browser,endpoint,childStderr='',childStdout='',childExit=null;
async function stop(){
 if(!child)return;
 const owned=child;child=null;
 if(process.platform==='win32'){
  if(owned.exitCode!==null)return;
  const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/pid',String(owned.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
  await new Promise(resolve=>{killer.once('close',resolve);killer.once('error',()=>{owned.kill();resolve();});});
 }else{try{process.kill(-owned.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
}
try{
 child=spawn(executable,['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--mute-audio'],{cwd:exeDir,env:environment,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>{childStdout=(childStdout+chunk.toString()).slice(-8192);});
 child.stderr.on('data',chunk=>{childStderr=(childStderr+chunk.toString()).slice(-16384);});
 child.once('close',(code,signal)=>{childExit={code,signal};});
 endpoint=await new Promise((resolve,reject)=>{
  let buffer='',finished=false;
  const timer=setTimeout(()=>done(Error('Exact native app did not expose its own debugging endpoint within 30 seconds.')),30000);
  const done=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(value);};
  child.stderr.on('data',chunk=>{buffer=(buffer+chunk.toString()).slice(-16384);const found=/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(buffer);if(found)done(null,found[1]);});
  child.once('error',error=>done(error));child.once('close',code=>done(Error('Exact native app exited during startup: '+code)));
 });
 // Preserve the exact app's download and page settings rather than applying
 // Playwright defaults to an externally launched Electron browser.
 browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});
 if(process.platform==='linux'){
  const argumentsUsed=(await readFile(`/proc/${child.pid}/cmdline`,'utf8')).split('\0').filter(Boolean);
  assert.ok(!argumentsUsed.some(argument=>/^--(?:no-sandbox|disable-setuid-sandbox)(?:=|$)/.test(argument)),'The installed launcher must preserve the Chromium sandbox.');
  report.checks.chromiumSandboxRetained=true;
 }
 let page;const deadline=Date.now()+30000;
 while(Date.now()<deadline){page=browser.contexts().flatMap(context=>context.pages()).find(item=>/\/dist\/index\.html(?:\?|$)/.test(item.url()));if(page)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(page,'Exact packaged renderer must load.');page.setDefaultTimeout(20000);
 page.on('pageerror',error=>report.errors.push(error.message.slice(0,1000)));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 assert.equal(await page.getByRole('combobox',{name:'Interface view',exact:true}).inputValue(),'standard');
 assert.equal(await page.getByRole('button',{name:/Learn Exomina/}).count(),1);
 report.checks.standardFirstUseAndTutorialEntry=true;
 const security=await page.evaluate(()=>window.studio.invoke('security.status'));
 assert.equal(security.ready,true,'Fresh ordinary user must be ready without mandatory EFS/recovery export.');
 assert.equal(security.mode,'standard');assert.equal(security.folderEncrypted,false);
 assert.equal(security.needsRecovery,false);
 if(process.platform==='darwin'){
  assert.equal(security.secretStorageStatus,'unchecked');assert.equal(security.secretStorageAvailable,null);
  report.checks.macKeychainRemainsUncheckedUntilSecretOperation=true;
 }
 let bootstrap;const connectionsDeadline=Date.now()+60000;
 while(Date.now()<connectionsDeadline){
  bootstrap=await page.evaluate(()=>window.studio.invoke('bootstrap'));
  if(['antigravity','codex','grok','muse-code'].every(id=>bootstrap.connections.some(connection=>connection.id===id&&typeof connection.installed==='boolean'&&connection.checking!==true)))break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 report.checks.connectionStatus=bootstrap.connections.map(({id,installed,connected,checking})=>({id,installed,connected,checking}));
 assert.equal(bootstrap.security.mode,security.mode,'Settings must receive the actual profile protection mode.');
 assert.equal(bootstrap.security.ready,security.ready);
 assert.equal(bootstrap.security.folderEncrypted,security.folderEncrypted);
 if(process.platform==='darwin')assert.equal(bootstrap.security.secretStorageStatus,'unchecked','Fresh Mac settings must explain deferred Keychain access.');
 report.checks.storageStatusReachesSettings=true;
 assert.equal(await realpath(bootstrap.settings.workspace),await realpath(workspace));
 assert.equal(bootstrap.conversations.length,0);
 const subscriptions=bootstrap.providers.filter(provider=>provider.mode==='subscription');
 // Claude is an opt-in connection that starts off and needs the user's own Claude Code; it is never part of the packaged runtimes.
 assert.deepEqual(subscriptions.filter(provider=>provider.id==='claude').map(provider=>provider.id),['claude']);
 assert.ok(!bootstrap.connections.some(connection=>connection.id==='claude'&&connection.connected),'Claude must start off and signed out.');
 const native=subscriptions.filter(provider=>provider.id!=='claude');
 assert.deepEqual(native.map(provider=>provider.id).sort(),['antigravity','codex','grok','muse-code']);
 assert.ok((bootstrap.connections||[]).every(connection=>!connection.connected));
 for(const id of ['codex','grok'])assert.equal(bootstrap.connections.find(connection=>connection.id===id)?.installed,true,`The packaged ${id} runtime must initialize as installed.`);
 report.checks.optionalRuntimeStatus=bootstrap.connections.filter(c=>['antigravity','muse-code'].includes(c.id)).map(({id,installed})=>({id,installed}));
 assert.equal(bootstrap.tools.some(tool=>tool.name==='workspace_shell'),true);
 assert.equal(bootstrap.tools.some(tool=>tool.name==='browser_open'),true);
 assert.equal(bootstrap.tools.some(tool=>tool.name==='spending_preview'),false);
 assert.equal(bootstrap.tools.some(tool=>tool.name==='analysis_native'),true);
 const inactiveVoice=await page.evaluate(()=>window.studio.invoke('voice.realtime.transcript',{sessionId:'inactive-beta-qa',event:{type:'transcript',id:'inactive',role:'user',text:'Synthetic inactive voice event',done:true}}));
 assert.deepEqual(inactiveVoice,{accepted:false});
 report.checks.releaseFeatureScope={spendingAbsent:true,nativeAnalysisToolPresent:true,realtimeModulesPresent:true,inactiveVoiceCannotAppendTranscript:true};
 if(process.platform!=='win32')assert.equal(bootstrap.tools.some(tool=>tool.name==='desktop_screenshot'),false);
 report.checks.standardFirstRun={ready:security.ready,mode:security.mode,folderEncrypted:security.folderEncrypted,needsRecovery:security.needsRecovery};
 report.checks.freshRuntimeCatalog={providers:native.map(provider=>provider.id),signedOut:true};
 report.checks.workspaceAndEmbeddedBrowserTools=true;
 await page.getByRole('button',{name:'Connect your AI',exact:true}).click();
 for(const provider of native)await page.locator(`[data-provider="${provider.id}"]`).waitFor();
 await page.getByRole('button',{name:/^Settings(?:\s+v|$)/}).click();
 await page.getByRole('button',{name:'Appearance & audio',exact:true}).click();
 await page.getByRole('button',{name:'Appearance',exact:true}).click();
 const themes=await page.locator('#settings-appearance .theme-card strong').allTextContents();
 for(const standard of ['Graphite','Verdigris','Midnight','Paper','Daylight','High contrast'])assert.ok(themes.includes(standard));
 await page.getByText('Want a different look? Ask Exomina in chat to help design your own theme.',{exact:true}).waitFor();
 report.checks.standardThemesAndDesignHint={names:themes};
 await page.getByRole('button',{name:'Privacy & data',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Agent spending',exact:true}).count(),0);
 await page.getByRole('button',{name:'Memory & privacy',exact:true}).click();
 await page.getByText('Storage on this device',{exact:true}).waitFor();
 await page.getByText(/Keys added in Connections use protected operating-system storage/).waitFor();
 if(process.platform==='darwin')await page.getByText('Credential storage is checked when you add or unlock a key. macOS may ask for Keychain access.',{exact:true}).waitFor();
 assert.equal(await page.getByText('Encrypted on this device',{exact:true}).count(),0);
 assert.equal(await page.getByText('Recovery backup verified.',{exact:true}).count(),0);
 report.checks.honestStandardStorageUi=true;
 await page.getByRole('button',{name:'General',exact:true}).click();
 await page.getByRole('button',{name:'Updates',exact:true}).click();
 await page.getByText('Beta updates',{exact:true}).waitFor();
 assert.equal(await page.getByRole('switch',{name:'Download updates automatically',exact:true}).count(),0);
 report.checks.manualUpdatesUi=true;
 assert.deepEqual(report.errors,[]);
 await page.screenshot({path:path.join(output,'native-beta-settings.png')});
 report.passed=true;
}catch(error){
 report.passed=false;report.failure=String(error.message).slice(0,2000);
 // This is exclusively the child above, with an empty synthetic profile and
 // credential environment removed. Retain bounded diagnostic lines, never
 // provider output or the profile itself, so CI startup failures are reviewable.
 report.startupFailure={exit:childExit||{code:child?.exitCode??null,signal:child?.signalCode??null},
  diagnostics:(childStderr+'\n'+childStdout).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').split(/\r?\n/)
   .filter(line=>/\[exomina-startup\]|error|exception|fatal|warning|dyld|signature|sandbox|reason:|ERR_/i.test(line))
   .slice(-24).map(line=>line.slice(0,500))};
 if(endpoint){
  // Read only the debugging endpoint emitted by this exact synthetic child.
  const ownedEndpoint=new URL(endpoint);assert.equal(ownedEndpoint.hostname,'127.0.0.1');
  try{
   const response=await fetch(`http://127.0.0.1:${ownedEndpoint.port}/json/version`,{signal:AbortSignal.timeout(3000),redirect:'error'});
   const value=await response.json();
   report.startupFailure.debugHttp={reachable:true,status:response.status,browser:typeof value.Browser==='string'?value.Browser.slice(0,100):null};
  }catch(probeError){report.startupFailure.debugHttp={reachable:false,error:String(probeError.message).slice(0,200)};}
  report.startupFailure.browserProtocol={scope:'Post-failure read-only probes of the owned child',...await probeOwnedBrowser(endpoint)};
 }
 console.error(JSON.stringify({failure:report.failure,startupFailure:report.startupFailure}));
 throw error;
}
finally{
 await browser?.close().catch(()=>{});await stop();
 report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'native-desktop-report.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report,null,2));
