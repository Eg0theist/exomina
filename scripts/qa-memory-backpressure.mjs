// Real production Electron host, synthetic encrypted profile and fake provider.
// No personal profile, provider credentials, game files or external requests.
import {_electron as electron} from 'playwright';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),fixture=await createProtectedQaProfile('memory-backpressure'),{profile,output}=fixture;
const workspace=path.join(profile,'workspace');await mkdir(workspace,{recursive:true});
const store=new Store(profile,{workspace});await store.init();Object.assign(store.state.settings,{workspace,autoTitle:false,autoUpdate:false,closeToTray:false,memoryEnabled:false,chatMemoryEnabled:false,chatMemorySummaries:false,browserEnabled:false,desktopEnabled:false,permissionMode:'read-only',routing:'tools',appearance:{theme:'erebus-flame',motion:'reduced'}});
const chat=store.create('codex');chat.title='Synthetic heavy-work chat';chat.titleSource='manual';
const content='Synthetic tool output used only to measure chat storage. '.repeat(54);
for(let i=0;i<60;i++){
  chat.messages.push({id:'user-'+i,role:'user',content:'Synthetic game-modding fixture '+i});
  chat.messages.push({id:'reply-'+i,role:'assistant',provider:'codex',content:'Completed synthetic result '+i,activity:Array.from({length:170},(_,j)=>({id:'fixture-'+i+'-'+j,kind:'tool',name:'synthetic_analysis',title:'Synthetic analysis',status:'done',output:content,startedAt:Date.now()-10000,finishedAt:Date.now()-9000})),finishedAt:new Date().toISOString()});
}
await store.save();
const moduleUrl=name=>JSON.stringify(pathToFileURL(path.join(root,name)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,session,dialog}=require('electron');BrowserWindow.prototype.show=function(){};app.commandLine.appendSwitch('mute-audio');dialog.showErrorBox=(a,b)=>{console.error(a,b);app.exit(1)};globalThis.qaMemory={saves:0,samples:[],replyDone:false};
(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
const{Store}=await import(${moduleUrl('desktop/store.mjs')});const originalInit=Store.prototype.init,originalSave=Store.prototype.save;Store.prototype.init=async function(){await originalInit.call(this);globalThis.qaStore=this;const write=this.writeState;this.writeState=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,150));return write(...args);};};Store.prototype.save=function(){globalThis.qaMemory.saves++;return originalSave.call(this);};
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});ProviderManager.prototype.status=async()=>PROVIDER_CATALOG.filter(p=>p.mode==='subscription').map(p=>({id:p.id,installed:true,connected:p.id==='codex',available:true,checking:false,detail:'Synthetic provider'}));ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;ProviderManager.prototype.getCodex=async()=>{throw Error('No account or native runtime access in QA')};
ProviderManager.prototype.run=async function(request){const store=globalThis.qaStore,c=store.conversation(request.conversationId);const sample=label=>{const m=process.memoryUsage();globalThis.qaMemory.samples.push({label,heapMiB:Math.round(m.heapUsed/1048576),rssMiB:Math.round(m.rss/1048576),writes:store.completedWrites,saving:store.saving,pending:store.pendingSave});};sample('before-work');
const first=store.save();await new Promise(resolve=>setTimeout(resolve,25));const waiters=[];let text='';for(let i=0;i<500;i++){c.fixtureRevision=i;const token=' fixture-'+i;text+=token;this.emit({type:'chat.tool',conversationId:request.conversationId,id:'new-fixture-'+i,name:'synthetic_analysis',status:'done',output:'Synthetic result '+i});waiters.push(store.save());if(i%100===0)sample('burst-'+i);}for(let i=0;i<500;i++)this.emit({type:'chat.delta',conversationId:request.conversationId,text:' fixture-'+i});await Promise.all([first,...waiters]);sample('committed-burst');globalThis.qaMemory.emitted=500;globalThis.qaMemory.burstDone=true;await new Promise(resolve=>globalThis.qaMemory.release=resolve);globalThis.qaMemory.replyDone=true;return {text,provider:request.provider};};await import(${moduleUrl('desktop/main.mjs')});})().catch(e=>{console.error(e);app.exit(1)});`);
const env={...process.env,EXOMINA_DATA_DIR:profile,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key))delete env[key];
const report={passed:false,syntheticOnly:true,personalProfileAccessed:false,initialStateBytes:(await stat(path.join(profile,'state.json'))).size,initialActivitySteps:10200,checks:{},errors:[]};let app,page;
try{
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.locator('[data-chat-id="'+chat.id+'"] .chat-open').click();
 await page.evaluate(id=>window.studio.invoke('chat.send',{conversationId:id,provider:'codex',text:'Run the synthetic heavy-work fixture',mode:'tools'}),chat.id);
 await page.waitForFunction(()=>document.querySelector('[data-message-index="121"] .message-content')?.textContent.includes('fixture-499'),{},{timeout:60000});
 assert.equal(await app.evaluate(()=>globalThis.qaMemory.burstDone),true);
 const text=await page.locator('[data-message-index="121"] .message-content').textContent();assert.equal((text.match(/fixture-/g)||[]).length,500);report.checks.allStreamedUpdatesRetained=500;
 await page.locator('.composer textarea').fill('A draft while the heavy task is active');assert.equal(await page.locator('.composer textarea').inputValue(),'A draft while the heavy task is active');report.checks.composerResponsiveDuringWork=true;
 report.metrics=await app.evaluate(()=>globalThis.qaMemory);await app.evaluate(()=>globalThis.qaMemory.release());
 await page.waitForFunction(()=>!document.querySelector('[aria-label="Stop this reply"]'));await page.waitForFunction(()=>!document.querySelector('[aria-label="Stop this reply"]'));await app.evaluate(async()=>{await globalThis.qaStore.queue;});
 const saved=JSON.parse(await readFile(path.join(profile,'state.json'),'utf8')),savedChat=saved.conversations.find(c=>c.id===chat.id);assert.equal(savedChat.fixtureRevision,499);assert.equal((savedChat.messages.at(-1).content.match(/fixture-/g)||[]).length,500);assert.equal(savedChat.messages.length,122);report.checks.latestStateAndCompleteReplyOnDisk=true;
 assert.equal(savedChat.messages.slice(0,120).filter(m=>m.role==='assistant').reduce((n,m)=>n+m.activity.length,0),10200);report.checks.oldToolHistoryPreserved=true;
 report.protection=await fixture.verify();report.checks.realWindowsEfs=true;report.checks.appSurvived=true;assert.deepEqual(report.errors,[]);assert.ok(Math.max(...report.metrics.samples.map(m=>m.heapMiB))<700,'Main process heap unexpectedly large.');
 await page.screenshot({path:path.join(output,'stress.png')});report.passed=true;
}catch(error){report.failure=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}finally{await app?.close().catch(()=>{});await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({...report,output}));
