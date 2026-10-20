// Production IPC and compiled renderer; fresh protected synthetic profile.
// The provider and browser responses are fixtures. No personal account or network access.
import {_electron as electron} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {MemoryStore} from '../desktop/memory.mjs';
import {compareChats} from '../desktop/chat-management.mjs';

const root=process.cwd(),fixture=await createProtectedQaProfile('discoveries'),{output,profile}=fixture,workspace=path.join(profile,'workspace');
await mkdir(workspace);
const seed=new Store(profile,{workspace});await seed.init();
Object.assign(seed.state.settings,{autoUpdate:false,quickAccess:false,autoTitle:false,browserEnabled:true,permissionMode:'ask',personalization:{instructions:'PRIVATE_STYLE_SENTINEL'},appearance:{theme:'ink-wash',motion:'reduced'}});
for(const [id,title,pinnedOrder] of [['a','Writing project',0],['b','Software project',1],['c','Theatre project',2]])seed.state.conversations.push({id,title,pinned:true,pinnedOrder,provider:'codex',updatedAt:'2026-10-15T12:00:00Z',sessions:{},messages:[]});
await seed.save();
const memory=new MemoryStore(profile);await memory.note('PRIVATE_NOTE_SENTINEL: Alice Privateberg has a private fantasy novel project.');memory.close();
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(root,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session}=require('electron');(async()=>{
app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qa={requests:[],browser:[],blocked:[],pages:new Map(),waiters:new Map(),slow:false};
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,checking:false,detail:'Synthetic subscription'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];
ProviderManager.prototype.codexUsage=async()=>({rateLimits:{primary:{usedPercent:10,windowDurationMins:300}}});ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused')};ProviderManager.prototype.getCodex=async()=>{throw Error('QA native account access refused')};
ProviderManager.prototype.run=async function(request){
qa.requests.push({prompt:request.prompt,tools:request.toolDefinitions?.map(tool=>tool.name),conversationId:request.conversationId});
try{await this.callTool('workspace_write',{path:'unapproved.txt',text:'No'},request.conversationId)}catch(error){qa.blocked.push(error.message)};
await this.callTool('browser_open',{url:'https://example.org/research'},request.conversationId);
await this.callTool('browser_snapshot',{include_screenshot:false},request.conversationId);
if(qa.slow)await new Promise((resolve,reject)=>qa.waiters.set(request.conversationId,reject));
return {sessionId:'synthetic-'+request.conversationId,text:JSON.stringify({discoveries:[{title:'A useful fiction workshop',url:'https://example.org/research',summary:'A synthetic public workshop with writing exercises.',reason:'Fits your interest in fiction writing.'}],error:''})};};
const originalCancel=ProviderManager.prototype.cancel;ProviderManager.prototype.cancel=function(id){const reject=qa.waiters.get(id);qa.waiters.delete(id);reject?.(Error('Stopped'));return originalCancel.call(this,id)};
const{BrowserChoice}=await import(${moduleUrl('desktop/browser-choice.mjs')});const originalState=BrowserChoice.prototype.state;
BrowserChoice.prototype.state=function(id){return qa.pages.get(id)||originalState.call(this,id)};
BrowserChoice.prototype.call=async function(name,input,id){
qa.browser.push({name,input,id});if(!this.current.isEnabled())throw Error('Browser tools are off');
if(!await this.current.approve({title:'Read public discovery page?',conversationId:id,detail:JSON.stringify(input)}))throw Error('Browser action declined');
if(name==='browser_open'){qa.pages.set(id,{url:input.url,title:'Synthetic source',loading:false});return {content:[{type:'text',text:JSON.stringify(qa.pages.get(id))}]}}
return {content:[{type:'text',text:JSON.stringify({...qa.pages.get(id),text:'A synthetic primary source with more than forty characters of useful workshop information.',pageRead:{available:true}})}]};};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:profile,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={scope:'Production host IPC and renderer with synthetic subscriptions/browser results; no account access, external network or live model requests.',checks:{},errors:[]};
async function waitState(read,accept,label){
 const until=Date.now()+15000;let value;
 do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,80));}while(Date.now()<until);
 throw Error(label+': '+JSON.stringify(value));
}
let app;
try{
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
 await waitState(()=>invoke('bootstrap'),state=>state.connections.some(connection=>connection.id==='codex'&&connection.connected),'Synthetic subscription startup');
 const pins=()=>page.getByRole('region',{name:'Pinned chats'}).locator('.chat-list-entry').evaluateAll(rows=>rows.map(row=>row.dataset.chatId));
 assert.deepEqual(await pins(),['a','b','c']);
 await page.getByRole('button',{name:'More options for Theatre project',exact:true}).click();await page.getByRole('menuitem',{name:'Move up',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.chat-pinned-list .chat-list-entry')].map(row=>row.dataset.chatId).join(',')==='a,c,b');
 await page.getByRole('button',{name:'More options for Writing project',exact:true}).click();assert.equal(await page.getByRole('menuitem',{name:'Move up',exact:true}).isDisabled(),true);
 await page.getByRole('menuitem',{name:'Move down',exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('.chat-pinned-list .chat-list-entry')].map(row=>row.dataset.chatId).join(',')==='c,a,b');assert.deepEqual(await pins(),['c','a','b']);report.checks.pinMenuAndBoundary=true;
 await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption('standard');
 await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('heading',{name:'Worth knowing',exact:true}).waitFor();
 const panel=page.getByRole('region',{name:'Worth knowing',exact:true});
 assert.equal(await panel.isVisible(),true);assert.equal(await page.getByRole('checkbox',{name:'Allow public web research',exact:false}).isChecked(),false);
 assert.equal(await page.getByRole('combobox',{name:'Discovery frequency',exact:true}).inputValue(),'off');assert.equal(await app.evaluate(()=>qa.requests.length),0);
 assert.ok((await panel.locator('.discovery-interests').textContent()).includes('Fiction writing'));
 const team=panel.locator('.discovery-team');assert.equal(await team.getAttribute('open'),null);report.checks.standardViewAndDefaultOff=true;
 await page.getByRole('checkbox',{name:'Allow public web research',exact:false}).check();
 await page.getByRole('combobox',{name:'Discovery frequency',exact:true}).selectOption('weekly');
 await page.getByRole('button',{name:'Find for me',exact:true}).click();
 let view=await waitState(()=>invoke('discoveries.view'),current=>current.last&&current.last.status!=='running','Discovery completion');assert.equal(view.last.status,'complete',JSON.stringify(view));
 await panel.getByRole('heading',{name:'A useful fiction workshop',exact:true}).waitFor();
 assert.equal(view.items.length,1);assert.ok(view.nextRun);assert.equal(view.runsToday,1);
 assert.equal(await panel.locator('.discovery-preferences').getAttribute('open'),null);
 const request=await app.evaluate(()=>qa.requests[0]);for(const secret of ['PRIVATE_NOTE_SENTINEL','PRIVATE_STYLE_SENTINEL','Alice Privateberg'])assert.equal(request.prompt.includes(secret),false);
 assert.deepEqual(request.tools.sort(),['browser_inspect','browser_open','browser_snapshot']);assert.equal(await app.evaluate(()=>qa.blocked.length),1);
 const state=await invoke('bootstrap');assert.equal(state.approvals.length,0);report.checks.researchConsentScopeEvidenceAndPrivacy=true;
 await page.screenshot({path:path.join(output,'populated-feed.png')});
 await panel.getByRole('button',{name:'Save A useful fiction workshop',exact:true}).click();await panel.getByRole('button',{name:/^Saved\s*1$/}).click();
 await panel.getByRole('heading',{name:'A useful fiction workshop',exact:true}).waitFor();
 await panel.getByRole('button',{name:'Dismiss A useful fiction workshop',exact:true}).click();
 view=await invoke('discoveries.view');assert.equal(view.items[0].status,'dismissed');report.checks.savedDismissedFeedback=true;
 await invoke('settings.save',{permissionRules:[{id:'deny-research',tool:'browser_open',match:'',effect:'deny'}]});
 await invoke('discoveries.run');await waitState(()=>invoke('discoveries.view'),current=>current.last.status!=='running','Denied research completion');
 view=await invoke('discoveries.view');assert.equal(view.last.status,'failed');assert.equal(view.items.length,1);const deniedChat=await invoke('conversations.get',{id:view.last.conversationId});assert.ok(JSON.stringify(deniedChat).includes('Blocked by your rule: browser_open'));report.checks.explicitDenyRuleWins=true;
 await invoke('settings.save',{permissionRules:[]});await app.evaluate(()=>{qa.slow=true});await invoke('discoveries.run');
 await waitState(()=>invoke('discoveries.view'),current=>current.last.conversationId&&current.last.status==='running','Research start');
 await panel.locator('.discovery-preferences > summary').click();await page.getByRole('checkbox',{name:'Allow public web research',exact:false}).uncheck();
 await waitState(()=>invoke('bootstrap'),state=>!state.activeRuns.length,'Research cancellation');
 view=await invoke('discoveries.view');assert.equal(view.last.status,'stopped');assert.equal(view.items.length,1);report.checks.activeConsentRevocationStopsSearch=true;
 for(const width of [1440,760,360]){
   await page.setViewportSize({width,height:1000});await panel.scrollIntoViewIfNeeded();
   const geometry=await panel.evaluate(element=>({width:innerWidth,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,contentOverflow:element.scrollWidth>element.clientWidth+1}));
   assert.equal(geometry.documentOverflow,false);assert.equal(geometry.contentOverflow,false);
   (report.checks.layouts ||= []).push(geometry);await page.screenshot({path:path.join(output,'discoveries-'+width+'.png')});
 }
 await invoke('conversations.delete',{id:request.conversationId,deleteMemories:false});view=await invoke('discoveries.view');assert.equal(view.items.length,0);report.checks.chatDeletionClearsDiscoveries=true;
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(output,'failure.png')});report.fixture=await app.evaluate(()=>({requests:qa.requests.map(request=>({tools:request.tools,conversationId:request.conversationId})),browser:qa.browser,blocked:qa.blocked}));}}
finally{await app?.close();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');}
if(report.passed){const restored=new Store(profile,{workspace});await restored.init();assert.deepEqual(restored.state.conversations.filter(chat=>chat.pinned).sort(compareChats).map(chat=>chat.id),['c','a','b']);report.checks.pinOrderPersistedOnDisk=true;await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');}
console.log(JSON.stringify({output,...report},null,2));
