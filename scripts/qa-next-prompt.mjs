// Real host + renderer, synthetic replies only. No personal accounts or model calls.
import {_electron as electron} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';

const root=process.cwd(), runtime=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root);
const fixture=await createProtectedQaProfile('next-prompt'),{output,profile}=fixture;
const workspace=path.join(profile,'workspace'), accounts=path.join(profile,'accounts');
await mkdir(workspace);await mkdir(accounts);
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{provider:'codex',model:'gpt-fixture',autoTitle:false,autoUpdate:false,quickAccess:false,memoryEnabled:false,browserEnabled:false,promptSuggestions:true,permissionMode:'full',appearance:{theme:'ink-wash',motion:'reduced'}});
store.state.conversations.push({id:'suggestion-qa',title:'Suggestion QA',provider:'codex',updatedAt:new Date().toISOString(),sessions:{},messages:[]});await store.save();
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(runtime,file)).href), launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session}=require('electron');(async()=>{
app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qa={mode:'plain',requests:0};
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
const models={codex:[{id:'gpt-fixture',label:'Fixture GPT',isDefault:true,efforts:[]}]};
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,checking:false,detail:'Synthetic subscription'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.subscriptionModels=async()=>models;ProviderManager.prototype.modelsFor=async id=>models[id]||[];
ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused')};ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};
ProviderManager.prototype.run=async request=>{if(request.conversationId!=='suggestion-qa')throw Error('Unexpected provider request');qa.requests++;qa.hasInstructions=request.prompt.includes('<next-prompt>');return{text:'I suggest private phone access next.'+(qa.mode==='tagged'?'\\n\\n<next-prompt>Finish private phone access</next-prompt>':'')}};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={runtime,scope:'Real host and renderer with synthetic protected storage; all provider responses stubbed, external network blocked.',checks:{},errors:[]};let app;
async function waitState(read,accept,label){const until=Date.now()+15000;let value;do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,80));}while(Date.now()<until);throw Error(label+': '+JSON.stringify(value).slice(0,1200));}
try{
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
 await waitState(()=>invoke('bootstrap'),state=>state.connections.some(item=>item.id==='codex'&&item.connected)&&state.providerModels.codex?.length,'Synthetic startup');
 await page.locator('[data-chat-id="suggestion-qa"] .chat-open').click();const composer=page.getByRole('textbox',{name:'Message',exact:true});
 const send=async(text,mode)=>{await app.evaluate((_electron,mode)=>{qa.mode=mode},mode);const before=await app.evaluate(()=>qa.requests);await invoke('chat.send',{conversationId:'suggestion-qa',provider:'codex',model:'gpt-fixture',mode:'tools',text});await waitState(async()=>{const state=await invoke('bootstrap');return{running:state.activeRuns.some(run=>run.conversationId==='suggestion-qa'),message:state.conversations.find(item=>item.id==='suggestion-qa')?.messages.at(-1)}},state=>!state.running&&state.message?.content==='I suggest private phone access next.','Finished synthetic reply');assert.equal(await app.evaluate(()=>qa.requests),before+1);return(await invoke('bootstrap')).conversations.find(item=>item.id==='suggestion-qa').messages.at(-1)};
 const plain=await send('Pick a useful next step.','plain');assert.equal(plain.nextPrompt,undefined);assert.equal(await composer.getAttribute('aria-description'),null);report.checks.proseIdeasAloneProduceNoSuggestion=true;
 const tagged=await send('Choose a concrete next task.','tagged');assert.equal(tagged.nextPrompt,'Finish private phone access');await waitState(()=>composer.getAttribute('placeholder'),value=>value?.includes('Finish private phone access'),'Suggestion visible');assert.equal(await app.evaluate(()=>qa.hasInstructions),true);assert.equal(await page.locator('.message.assistant .message-content').last().innerText(),'I suggest private phone access next.');report.checks.tagExtractedHiddenFromReplyAndShownInComposer=true;
 for(const view of ['standard','advanced']){await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption(view);await page.locator(`.app-frame[data-interface-view="${view}"]`).waitFor();await waitState(()=>composer.getAttribute('placeholder'),value=>value?.includes('Finish private phone access'),view+' suggestion');}report.checks.bothInterfaceViews=true;
 await composer.focus();const before=await app.evaluate(()=>qa.requests);await page.keyboard.press('Tab');assert.equal(await composer.inputValue(),'Finish private phone access');assert.equal(await app.evaluate(()=>qa.requests),before);report.checks.tabInsertsWithoutSending=true;
 await composer.fill('');await invoke('settings.save',{promptSuggestions:false});await waitState(()=>composer.getAttribute('aria-description'),value=>value===null,'Setting disabled');await invoke('settings.save',{promptSuggestions:true});await waitState(()=>composer.getAttribute('placeholder'),value=>value?.includes('Finish private phone access'),'Setting enabled');report.checks.settingRespected=true;
 await composer.focus();await page.keyboard.press('Escape');assert.equal(await composer.getAttribute('aria-description'),null);assert.equal(await composer.inputValue(),'');report.checks.escapeDismissesWithoutSending=true;
 await page.screenshot({path:path.join(output,'composer.png')});assert.deepEqual(report.errors,[]);await fixture.verify();report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await app?.close();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report},null,2));}
