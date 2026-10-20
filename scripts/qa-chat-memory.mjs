// Exact packaged integration uses a test-only launcher with deterministic model
// responses; an independent unmodified EXE smoke uses signed-out metadata only.
import { _electron as electron, chromium } from 'playwright';
import { extractFile, listPackage } from '@electron/asar';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../desktop/store.mjs';
import { ChatMemoryTree } from '../desktop/chat-memory-tree.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const workspaceRoot=path.resolve(process.env.EXOMINA_QA_WORKSPACE||path.join(root,'..'));
const sourceRoot=path.resolve(process.env.EXOMINA_QA_SOURCE_ROOT||path.join(workspaceRoot,'../Source'));
const executable=path.resolve(process.env.EXOMINA_QA_EXE||process.argv[2]||path.join(sourceRoot,'release/win-unpacked/Exomina.exe'));
const packagePath=path.join(path.dirname(executable),'resources/app.asar');
const temp=path.resolve(process.env.TMPDIR||process.env.TMP||process.env.TEMP||path.join(workspaceRoot,'.exomina-qa-temp'));
const tempRelative=path.relative(workspaceRoot,temp);if(tempRelative==='..'||tempRelative.startsWith('..'+path.sep)||path.isAbsolute(tempRelative))throw Error('Set TMPDIR, TMP or TEMP to an isolated directory inside the chosen QA workspace.');
await mkdir(temp,{recursive:true});
process.env.TEMP=process.env.TMP=process.env.TMPDIR=temp;
const digest=value=>createHash('sha256').update(value).digest('hex');
const {createProtectedQaProfile}=await import(pathToFileURL(path.join(sourceRoot,'scripts/qa-profile.mjs')).href);
const fixture=await createProtectedQaProfile('chat-memory');
assert.equal(path.dirname(fixture.output),workspaceRoot);
const {profile,output}=fixture;
const work=path.join(profile,'workspace'),home=path.join(output,'home'),appData=path.join(home,'AppData/Roaming'),localAppData=path.join(home,'AppData/Local');
await Promise.all([work,home,appData,localAppData,...['Documents','Desktop','Downloads'].map(name=>path.join(home,name))].map(folder=>mkdir(folder,{recursive:true})));
const report={executable,packagePath,startedAt:new Date().toISOString(),scope:'Exact packaged host and renderer loaded by a test-only launcher in the matching production Electron runtime, with provider account/model/usage metadata and inference mocked before main loads. Independent unmodified EXE startup checks signed-out provider metadata and settings, without inference. Both use one fresh protected synthetic profile and isolated homes only; no personal profile, account authorization, microphone, speaker or desktop capture/control.',profilePreparation:fixture.report,checks:{},errors:[]};
const packaged=name=>JSON.stringify(pathToFileURL(path.join(packagePath,name)).href);
const launcher=path.join(output,'chat-memory-launcher.cjs');
let launched,page,tree,nativeProcess,nativeBrowser;

function syntheticEnvironment(){
  const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:path.join(profile,'synthetic-accounts'),EXOMINA_WORKSPACE_DIR:work,HOME:home,USERPROFILE:home,APPDATA:appData,LOCALAPPDATA:localAppData,TEMP:temp,TMP:temp,TMPDIR:temp,XDG_CONFIG_HOME:path.join(home,'config'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_DATA_HOME:path.join(home,'data')};
  for(const key of Object.keys(env))if(/^(?:OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_|CLAUDECODE$|AWS_|AZURE_|GOOGLE_|GEMINI_|KIMI_|MOONSHOT_|COPILOT_|GITHUB_|GH_|GROK_|XAI_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|SSLKEYLOGFILE$)/i.test(key))delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
async function start(){
  const env=syntheticEnvironment();
  launched=await electron.launch({args:[launcher],cwd:output,env,timeout:30000});
  page=await launched.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  await page.waitForFunction(async()=>{const data=await window.studio.invoke('bootstrap');return data.connections.some(connection=>connection.id==='codex'&&connection.connected);});
}
async function stopNative(){if(nativeBrowser){await nativeBrowser.close().catch(()=>{});nativeBrowser=null;}if(nativeProcess&&nativeProcess.exitCode===null){const killer=spawn(path.join(process.env.SystemRoot,'System32/taskkill.exe'),['/pid',String(nativeProcess.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});await new Promise(resolve=>{killer.once('close',resolve);killer.once('error',resolve);});}nativeProcess=null;}
async function nativeSignedOutSmoke(){
  nativeProcess=spawn(executable,['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--mute-audio'],{cwd:path.dirname(executable),env:syntheticEnvironment(),windowsHide:true,stdio:['ignore','pipe','pipe']});
  nativeProcess.stdout.resume();let nativeLog='';nativeProcess.stderr.on('data',chunk=>{nativeLog=(nativeLog+chunk.toString()).slice(-16000);});
  const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('The unmodified EXE did not expose its synthetic debugging endpoint. '+nativeLog)),30000);nativeProcess.stderr.on('data',()=>{const match=/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(nativeLog);if(match){clearTimeout(timer);resolve(match[1]);}});nativeProcess.once('error',error=>{clearTimeout(timer);reject(error);});nativeProcess.once('close',code=>{clearTimeout(timer);reject(Error('The unmodified EXE exited '+code+'. '+nativeLog));});});
  nativeBrowser=await chromium.connectOverCDP(endpoint);const deadline=Date.now()+30000;
  while(Date.now()<deadline){page=nativeBrowser.contexts().flatMap(context=>context.pages()).find(item=>item.url().endsWith('/dist/index.html'));if(page)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(page,'The unmodified EXE did not load its app page.');page.setDefaultTimeout(30000);page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  await page.getByRole('button',{name:/^Settings(?:\s+v|$)/}).click();await page.getByRole('button',{name:'Memory & privacy',exact:true}).click();assert.equal(await page.getByRole('checkbox',{name:'Remember the whole chat',exact:true}).isChecked(),true);assert.equal(await page.getByRole('checkbox',{name:'Summarize in the background',exact:true}).isChecked(),false);
  let state;const metadataDeadline=Date.now()+30000;do{state=await page.evaluate(()=>window.studio.invoke('bootstrap'));if(!state.connections.some(connection=>connection.checking))break;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<metadataDeadline);
  assert.equal(state.connections.some(connection=>connection.checking),false);assert.ok(state.tools.some(tool=>tool.name==='conversation_zoom'));assert.ok(state.tools.some(tool=>tool.name==='conversation_date'));assert.equal(state.chatMemory.enabled,true);assert.equal(state.connections.some(connection=>connection.connected),false);assert.equal(state.activeRuns.length,0);assert.equal(state.conversations.some(chat=>chat.id===report.syntheticChatId),false);
  report.checks.unmodifiedExecutableSignedOutSmoke={exactExecutable:true,providerMetadataMocked:false,inferencePerformed:false,accountsIsolated:true,memorySettingsPersisted:true,zoomDateDefinitionsPresent:true,allConnectionsSignedOut:true};await page.screenshot({path:path.join(output,'unmodified-exe-memory-settings.png')});await stopNative();page=null;
}
async function idle(id){const deadline=Date.now()+30000;while(Date.now()<deadline){const state=await page.evaluate(()=>window.studio.invoke('bootstrap'));if(!state.activeRuns.some(run=>run.conversationId===id))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('The synthetic native task did not finish.');}
async function send(id,text){await page.evaluate(({id,text})=>window.studio.invoke('chat.send',{conversationId:id,text,provider:'codex',model:'auto',mode:'tools'}),{id,text});await idle(id);const state=await page.evaluate(()=>window.studio.invoke('bootstrap'));const chat=state.conversations.find(item=>item.id===id);assert.equal(chat.messages.at(-1).error,undefined);return state;}

try{
  const files=listPackage(packagePath).map(file=>file.replaceAll('\\','/'));for(const name of ['chat-memory-tree.mjs','chat-memory-service.mjs','chat-memory-compactor.mjs','chat-memory-context.mjs'])assert.ok(files.some(file=>file.endsWith('/desktop/'+name)),'Required packaged chat-memory module is missing: '+name);
  assert.equal(digest(extractFile(packagePath,'desktop/chat-memory-tree.mjs')),digest(await readFile(path.join(root,'desktop/chat-memory-tree.mjs'))),'Packaged engine differs from the qualified source.');
  report.buildStamp=JSON.parse(await readFile(path.join(path.dirname(executable),'exomina.build.json'),'utf8'));
  const packageHash=createHash('sha256');for await(const chunk of createReadStream(packagePath))packageHash.update(chunk);report.packageSha256=packageHash.digest('hex');
  const store=new Store(profile,{workspace:work});await store.init();Object.assign(store.state.settings,{provider:'codex',model:'auto',autoUpdate:false,autoTitle:false,closeToTray:false,memoryEnabled:false,chatMemoryEnabled:true,chatMemorySummaries:true,desktopEnabled:false,browserEnabled:false,permissionMode:'read-only',routing:'tools'});
  const chat=store.create('codex');chat.title='Synthetic chat memory';chat.titleSource='user';chat.sessions={codex:'qa-old-native-session'};chat.sessionSeen={codex:2};chat.messages=[{id:'qa-seed-user',role:'user',content:'QA_PROJECT_FACT: project code Amber.',createdAt:'2026-01-02T03:04:05.000Z',provider:'codex'},{id:'qa-seed-answer',role:'assistant',content:'I will preserve project code Amber.',provider:'codex'}];await store.save();
  report.syntheticChatId=chat.id;
  await writeFile(launcher,`const {app,BrowserWindow,dialog,shell}=require('electron');
app.commandLine.appendSwitch('mute-audio');BrowserWindow.prototype.show=function(){};
const originalGetPath=app.getPath.bind(app),syntheticPaths={home:process.env.HOME,appData:process.env.APPDATA,userData:process.env.EXOMINA_DATA_DIR,documents:process.env.EXOMINA_WORKSPACE_DIR,temp:process.env.TEMP};
app.getPath=name=>syntheticPaths[name]||originalGetPath(name);
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qaMemory={mainRuns:[],helpers:[],parallel:[],steers:[],forbidden:[],toolChecks:[]};
const qa=globalThis.qaMemory;
shell.openExternal=async()=>{qa.forbidden.push('external navigation');throw Error('Synthetic QA forbids external navigation.')};
globalThis.fetch=async()=>{qa.forbidden.push('HTTP request');throw Error('Synthetic QA forbids network requests.')};
const unwrap=result=>JSON.parse(result.content.find(block=>block.type==='text').text);
(async()=>{
 const {ProviderManager}=await import(${packaged('desktop/providers.mjs')});
 const {PROVIDER_CATALOG}=await import(${packaged('desktop/provider-catalog.mjs')});
 const {ModelAssist}=await import(${packaged('desktop/model-assist.mjs')});
 const {WindowsVoice}=await import(${packaged('desktop/voice.mjs')});
 const models=[{id:'qa-native-model',label:'Synthetic native model',isDefault:true,supportsImages:false,defaultEffort:'low',efforts:[{id:'low',label:'Low'}]}];
 ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(provider=>provider.mode==='subscription').map(provider=>({id:provider.id,installed:true,available:true,checking:false,connected:provider.id==='codex',detail:'Synthetic account metadata.'}));for(const row of rows)onStatus?.(row);return rows;};
 ProviderManager.prototype.subscriptionModels=async()=>({codex:models});ProviderManager.prototype.modelsFor=async id=>id==='codex'?models:[];
 ProviderManager.prototype.codexUsage=async()=>({rateLimits:{planType:'synthetic',primary:{usedPercent:1,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}});ProviderManager.prototype.claudeUsage=async()=>null;
 for(const method of ['connect','getCodex','spawn'])ProviderManager.prototype[method]=async()=>{qa.forbidden.push(method);throw Error('Synthetic QA forbids provider '+method)};
 ProviderManager.prototype.steer=async function(id,request){qa.steers.push({id,messageId:request.messageId});return false};
 ModelAssist.prototype.available=()=>[{provider:'codex',model:'qa-native-model',label:'Synthetic available helper',available:true,efforts:['low'],defaultEffort:'low',supportsImages:false,role:'light'}];
 WindowsVoice.prototype.status=async()=>({available:true,recognizers:[],voices:[]});
 ProviderManager.prototype.run=async function(request){
  if(request.conversationId.startsWith('memory-compaction-')){
   qa.helpers.push({id:request.conversationId,noTools:request.noTools,ephemeral:request.ephemeral,sessionId:request.sessionId||null,toolCount:request.toolDefinitions?.length});
   const start=request.prompt.indexOf('{"notice":'),end=request.prompt.indexOf('\\nTask:\\n',start);const records=JSON.parse(request.prompt.slice(start,end));const raw=(records.source||[]).map(source=>source.text||'').join(' ');const prefix=/Begin with this exact prefix: ([^\\r\\n]+)/.exec(request.prompt)?.[1]||'';
   const summary=raw.length>320?raw.slice(0,150)+' [synthetic summary] '+raw.slice(-150):raw;return {text:(prefix?prefix+' ':'')+summary,sessionId:'qa-ephemeral-helper'};
  }
  if(request.noTools&&request.ephemeral){qa.parallel.push({id:request.conversationId,sessionId:request.sessionId||null});return {text:'Synthetic follow-up answer; the main task must include it.',sessionId:'qa-parallel-session'};}
  const number=qa.mainRuns.length+1,session='qa-native-session-'+number;
  qa.mainRuns.push({number,conversationId:request.conversationId,sessionId:request.sessionId||null,returnedSession:session,priorFact:request.prompt.includes('QA_PROJECT_FACT'),hasChatView:request.prompt.includes('<chat>'),blocksExact:!request.promptBlocks||request.promptBlocks.map(block=>block.text).join('')===request.prompt,cacheMarks:(request.promptBlocks||[]).filter(block=>block.cache).length});
  if(number===1){
   this.emit({type:'chat.delta',conversationId:request.conversationId,text:'QA_RUNTIME_NARRATION_FACT: preserved before the synthetic tool.'});
   this.emit({type:'chat.thinking',conversationId:request.conversationId,id:'qa-hidden',text:'QA_HIDDEN_REASONING_MUST_NOT_ENTER_TREE',start:true,done:true});
   this.emit({type:'chat.tool',conversationId:request.conversationId,id:'qa-native-read',name:'synthetic_native_read',input:{value:'synthetic.txt',api_key:'QA_SYNTHETIC_SECRET',reasoning:'QA_HIDDEN_METADATA'},status:'running'});
   this.emit({type:'chat.tool',conversationId:request.conversationId,id:'qa-native-read',name:'synthetic_native_read',output:'Synthetic display excerpt.',historyOutput:'QA_TOOL_HEAD'+('H'.repeat(26000))+'QA_TOOL_MIDDLE'+('T'.repeat(26000))+'QA_TOOL_TAIL',status:'done'});
   const zoom=unwrap(await this.callTool('conversation_zoom',{id:5,count:1,limit:32000},request.conversationId));
   const known=unwrap(await this.callTool('conversation_date',{id:0},request.conversationId)),unknown=unwrap(await this.callTool('conversation_date',{id:1},request.conversationId));
   qa.toolChecks.push({tail:zoom.text.endsWith('QA_TOOL_TAIL'),head:zoom.text.startsWith('QA_TOOL_HEAD'),clipped:zoom.text.includes('[tool output clipped: middle omitted]'),middleAbsent:!zoom.text.includes('QA_TOOL_MIDDLE'),characters:zoom.text.length,knownDate:known.first,unknownDate:unknown.first});
   await new Promise(resolve=>{qa.releaseFirst=resolve});
  }
  const followups=/Follow-ups:\\n(\\[[\\s\\S]*?\\])\\nVisible work checkpoint:/.exec(request.prompt);
  if(followups)for(const item of JSON.parse(followups[1]))await this.callTool('followup_update',{id:item.id,status:'handled',summary:'The synthetic main task included and verified the follow-up.'},request.conversationId);
  const text='Synthetic native completion '+number+'. QA_COMPLETED_FACT';this.emit({type:'chat.delta',conversationId:request.conversationId,text});return {text,sessionId:session};
 };
 await import(${packaged('desktop/main.mjs')});
})().catch(error=>{console.error(error);app.exit(1)});
`);
  await start();
  await page.getByRole('button',{name:/^Settings(?:\s+v|$)/}).click();await page.getByRole('button',{name:'Memory & privacy',exact:true}).click();
  assert.equal(await page.getByRole('checkbox',{name:'Remember the whole chat',exact:true}).isChecked(),true);assert.equal(await page.getByRole('checkbox',{name:'Summarize in the background',exact:true}).isChecked(),true);report.checks.settingsControls=true;
  await page.evaluate(({id})=>window.studio.invoke('chat.send',{conversationId:id,text:'FIRST_NATIVE_USER_TASK',provider:'codex',model:'auto',mode:'tools'}),{id:chat.id});
  for(let attempts=0;attempts<200;attempts++){if(await launched.evaluate(()=>typeof globalThis.qaMemory.releaseFirst==='function'))break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(await launched.evaluate(()=>typeof globalThis.qaMemory.releaseFirst==='function'),true);
  const followup=await page.evaluate(id=>window.studio.invoke('chat.send',{conversationId:id,text:'SYNTHETIC_ACTIVE_FOLLOWUP',provider:'codex',model:'auto',mode:'tools',followupMode:'live'}),chat.id);assert.ok(followup.followup);
  await page.waitForFunction(async()=>{const state=await window.studio.invoke('bootstrap');return state.conversations.some(item=>item.messages.some(message=>message.followups?.some(followup=>followup.status==='answered')));});
  await launched.evaluate(()=>globalThis.qaMemory.releaseFirst());await idle(chat.id);
  await send(chat.id,'SECOND_NATIVE_USER_TASK');
  const runs=await launched.evaluate(()=>globalThis.qaMemory.mainRuns);assert.equal(runs[0].sessionId,null);assert.equal(runs[1].sessionId,runs[0].returnedSession);assert.equal(runs[2].sessionId,null);assert.equal(runs[2].priorFact,true);assert.equal(runs.every(run=>run.blocksExact&&run.cacheMarks<=2),true);assert.equal(runs.every(run=>run.hasChatView),true);
  report.checks.freshEachUserAndActiveContinuation={runs,liveFollowup:true};
  for(let attempts=0;attempts<100;attempts++){const state=await page.evaluate(()=>window.studio.invoke('bootstrap'));if(!state.chatMemory.background?.running&&!state.chatMemory.background?.active)break;await new Promise(resolve=>setTimeout(resolve,50));}
  await page.getByRole('checkbox',{name:'Summarize in the background',exact:true}).uncheck();await page.waitForFunction(async()=>(await window.studio.invoke('bootstrap')).settings.chatMemorySummaries===false);
  const helpersBefore=await launched.evaluate(()=>globalThis.qaMemory.helpers.length);await send(chat.id,'DISABLED_SUMMARIES_SOURCE '+('long synthetic user source '.repeat(200)));
  assert.equal(await launched.evaluate(()=>globalThis.qaMemory.helpers.length),helpersBefore);report.checks.disabledSummariesKeepOriginals=true;
  const activity=await launched.evaluate(()=>({mainRuns:globalThis.qaMemory.mainRuns,helpers:globalThis.qaMemory.helpers,parallel:globalThis.qaMemory.parallel,steers:globalThis.qaMemory.steers,forbidden:globalThis.qaMemory.forbidden,toolChecks:globalThis.qaMemory.toolChecks}));
  assert.equal(activity.mainRuns[3].sessionId,null);assert.ok(activity.helpers.length>0);assert.equal(activity.helpers.every(helper=>helper.noTools&&helper.ephemeral&&helper.sessionId===null&&helper.toolCount===0),true);
  assert.equal(activity.toolChecks[0].head&&activity.toolChecks[0].tail&&activity.toolChecks[0].clipped&&activity.toolChecks[0].middleAbsent,true);assert.ok(activity.toolChecks[0].characters<=30000);assert.equal(activity.toolChecks[0].knownDate,'2026-01-02T03:04:05.000Z');assert.equal(activity.toolChecks[0].unknownDate,null);assert.deepEqual(activity.forbidden,[]);
  report.checks.sourceZoomDateAndProtectedHelpers=activity;
  await page.screenshot({path:path.join(output,'chat-memory-controls.png')});await launched.close();launched=null;page=null;
  tree=await new ChatMemoryTree(profile).init();const snapshot=await tree.originals(chat.id);let originals=[...snapshot.originals],cursor=snapshot.nextOffset;
  while(cursor!==null){const batch=await tree.originals(chat.id,{offset:cursor,through:snapshot.snapshot});originals.push(...batch.originals);cursor=batch.nextOffset;}
  const combined=originals.map(original=>original.text).join('\n');assert.equal(combined.includes('QA_HIDDEN_REASONING_MUST_NOT_ENTER_TREE'),false);assert.equal(combined.includes('QA_HIDDEN_METADATA'),false);assert.equal(combined.includes('QA_SYNTHETIC_SECRET'),false);assert.equal(combined.includes('[credential redacted]'),true);assert.equal(combined.includes('QA_RUNTIME_NARRATION_FACT'),true);assert.equal(combined.includes('DISABLED_SUMMARIES_SOURCE'),true);assert.equal((await tree.audit(chat.id)).valid,true);report.checks.immutableLogExcludesThinking={total:originals.length,pendingJobs:(await tree.stats(chat.id)).pendingJobs,hiddenReasoningExcluded:true,syntheticCredentialRedacted:true};await tree.close();tree=null;
  await start();const restored=await page.evaluate(()=>window.studio.invoke('bootstrap'));assert.equal(restored.settings.chatMemorySummaries,false);assert.ok(restored.conversations.some(item=>item.id===chat.id));
  await page.evaluate(id=>window.studio.invoke('conversations.delete',{id}),chat.id);assert.equal((await page.evaluate(()=>window.studio.invoke('bootstrap'))).conversations.some(item=>item.id===chat.id),false);await launched.close();launched=null;page=null;
  tree=await new ChatMemoryTree(profile).init();assert.equal((await tree.stats(chat.id)).total,0);assert.equal((await tree.originals(chat.id)).originals.length,0);report.checks.explicitDeletionRemovesTreeAndOriginals=true;
  await tree.close();tree=null;await nativeSignedOutSmoke();
  report.profileProtected=(await fixture.verify()).encrypted;assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure=error.message;report.stack=error.stack;if(page){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});report.visibleText=await page.locator('body').innerText().catch(()=>null);}if(launched)report.mockActivity=await launched.evaluate(()=>globalThis.qaMemory).catch(()=>null);process.exitCode=1;}
finally{await tree?.close().catch(()=>{});await launched?.close().catch(()=>{});await stopNative();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));}
