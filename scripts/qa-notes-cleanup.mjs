// Real host and renderer with fresh synthetic encrypted storage and model fixtures.
import {_electron as electron} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {Scratchpad} from '../desktop/scratchpad.mjs';

const root=process.cwd(),fixture=await createProtectedQaProfile('notes-cleanup'),{output,profile}=fixture;
const workspace=path.join(profile,'workspace'),accounts=path.join(profile,'accounts');await mkdir(workspace);await mkdir(accounts);
const seed=new Store(profile,{workspace});await seed.init();
Object.assign(seed.state.settings,{provider:'codex',model:'gpt-fixture',effort:'high',autoTitle:false,autoUpdate:false,quickAccess:false,memoryEnabled:false,browserEnabled:false,permissionMode:'full',appearance:{theme:'ink-wash',motion:'reduced'}});
seed.state.conversations.push({id:'cleanup-qa',title:'Cleanup QA',provider:'codex',updatedAt:new Date().toISOString(),sessions:{},messages:[]});
const pad=new Scratchpad({store:seed}),created=await pad.create(),original='Finished café 🌙\nKeep unfinished phone testing.';
const approved=await pad.update({...created,title:'Update ideas',text:original,allowAI:true}),privateDraft=await pad.create(),privateNote=await pad.update({...privateDraft,title:'Private',text:'PRIVATE_UNRELATED',allowAI:false});
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(root,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session}=require('electron');(async()=>{
app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qa={results:[],mode:'cleanup',id:${JSON.stringify(approved.id)},privateId:${JSON.stringify(privateNote.id)}};
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
const models={codex:[{id:'gpt-fixture',label:'Fixture GPT',isDefault:true,supportsImages:true,efforts:[{id:'high',label:'High'}]}]};
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,checking:false,detail:'Synthetic subscription'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.subscriptionModels=async()=>models;ProviderManager.prototype.modelsFor=async id=>models[id]||[];
ProviderManager.prototype.codexUsage=async()=>({rateLimits:{primary:{usedPercent:20,windowDurationMins:300}}});
ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused')};ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};
ProviderManager.prototype.run=async function(request){
 if(request.conversationId!=='cleanup-qa')throw Error('Unexpected model request');
 const read=await this.callTool('notes_read',{id:qa.id},request.conversationId);let result=read;
 if(!read.isError){const note=JSON.parse(read.content[0].text);result=await this.callTool('notes_remove_completed',{id:qa.id,revision:note.revision,items:[{text:'Finished café 🌙',evidence:'Synthetic completed outcome verified by read-back.'}]},request.conversationId);}
 qa.results.push(result);return {text:result.isError?'The requested cleanup was refused.':'The completed passage was removed.'};
};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={scope:'Real host tool permissions, compiled Notes UI and encrypted synthetic persistence. No personal account stores, external network or real model requests.',checks:{},errors:[]};let app;
async function waitState(read,accept,label){const until=Date.now()+15000;let value;do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,80));}while(Date.now()<until);throw Error(label+': '+JSON.stringify(value).slice(0,1800));}
try{
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
 await waitState(()=>invoke('bootstrap'),state=>state.connections.some(item=>item.id==='codex'&&item.connected)&&state.providerModels.codex?.length,'Synthetic startup');
 await page.locator('[data-chat-id="cleanup-qa"] .chat-open').click();await page.getByRole('button',{name:'Notes',exact:true}).click();const panel=page.getByRole('dialog',{name:'Notes',exact:true});
 await panel.getByRole('combobox',{name:'Choose note',exact:true}).selectOption(approved.id);const editor=panel.getByRole('textbox',{name:'Note text',exact:true});assert.equal(await editor.inputValue(),original);
 const note=async()=>((await invoke('notes.view')).notes.find(item=>item.id===approved.id));
 async function start(){const count=await app.evaluate(()=>qa.results.length);await invoke('chat.send',{conversationId:'cleanup-qa',provider:'codex',model:'gpt-fixture',effort:'high',mode:'tools',text:'Remove only the verified completed passage from my note.'});return count;}
 async function finish(count){await waitState(()=>app.evaluate(()=>qa.results.length),value=>value===count+1,'Tool result');await waitState(()=>invoke('bootstrap'),state=>!state.activeRuns.length,'Turn ended');return app.evaluate(()=>qa.results.at(-1));}
 await invoke('settings.save',{permissionMode:'read-only'});let result=await finish(await start());assert.equal(result.isError,true);assert.match(JSON.stringify(result),/Read only/);assert.equal((await note()).text,original);report.checks.readOnlyRefusesMutation=true;
 await invoke('settings.save',{permissionMode:'full',permissionRules:[{id:'deny-cleanup',tool:'notes_remove_completed',match:'',effect:'deny'}]});result=await finish(await start());assert.equal(result.isError,true);assert.match(JSON.stringify(result),/Blocked by your rule/);assert.equal((await note()).text,original);report.checks.explicitDenyWins=true;
 await invoke('settings.save',{permissionRules:[]});await app.evaluate(()=>{qa.id=qa.privateId});result=await finish(await start());assert.equal(result.isError,true);assert.match(JSON.stringify(result),/private/);await app.evaluate((_electron,id)=>{qa.id=id},approved.id);report.checks.privateNotesUnavailable=true;
 await invoke('settings.save',{permissionMode:'ask'});let count=await start();let state=await waitState(()=>invoke('bootstrap'),state=>state.approvals.length===1,'Cleanup approval');
 assert.equal(state.approvals[0].tool,'notes_remove_completed');assert.match(state.approvals[0].detail,/Finished café 🌙/);assert.match(state.approvals[0].detail,/Synthetic completed outcome/);assert.equal(state.approvals[0].detail.includes('unfinished'),false);await invoke('approval.respond',{id:state.approvals[0].id,decision:'deny'});result=await finish(count);assert.equal(result.isError,true);assert.equal((await note()).text,original);report.checks.exactPassagesAndEvidenceVisibleAndDenialPreservesText=true;
 count=await start();state=await waitState(()=>invoke('bootstrap'),state=>state.approvals.length===1,'Concurrent edit approval');const newer=original+'\nA new idea';await editor.fill(newer);await waitState(note,item=>item.text===newer,'Concurrent editor autosave');await invoke('approval.respond',{id:state.approvals[0].id,decision:'once'});result=await finish(count);assert.equal(result.isError,true);assert.match(JSON.stringify(result),/changed/);assert.equal((await note()).text,newer);assert.equal(await editor.inputValue(),newer);report.checks.approvalRaceCannotOverwriteUserEdits=true;
 count=await start();state=await waitState(()=>invoke('bootstrap'),state=>state.approvals.length===1,'Approved cleanup');await invoke('approval.respond',{id:state.approvals[0].id,decision:'once'});result=await finish(count);assert.ok(!result.isError,JSON.stringify(result));const cleaned=newer.replace('Finished café 🌙','');await waitState(()=>editor.inputValue(),text=>text===cleaned,'Editor follows AI cleanup');
 await panel.getByText('Removed completed items (1)',{exact:true}).click();await panel.getByRole('button',{name:'Undo last cleanup',exact:true}).click();await waitState(()=>editor.inputValue(),text=>text===newer,'Undo restores exact note');assert.equal((await note()).lastCleanup,null);report.checks.successUpdatesOpenEditorAndUndoRestoresExactText=true;
 await invoke('settings.save',{permissionMode:'full'});result=await finish(await start());assert.ok(!result.isError,JSON.stringify(result));await waitState(()=>editor.inputValue(),text=>text===cleaned,'Second cleanup');await panel.getByText('Removed completed items (1)',{exact:true}).click();const final=cleaned+'\nEdited after cleanup';await editor.fill(final);await waitState(note,item=>item.text===final,'Post-cleanup edit saved');assert.equal(await panel.getByRole('button',{name:'Undo last cleanup',exact:true}).isDisabled(),true);const latest=await note();await assert.rejects(invoke('notes.cleanup.restore',{id:latest.id,revision:latest.revision,cleanupId:latest.lastCleanup.id}),/newer edits/);assert.equal((await note()).text,final);report.checks.recoveryKeepsRemovedPassagesWithoutOverwritingLaterEdits=true;
 await page.setViewportSize({width:760,height:1000});await page.screenshot({path:path.join(output,'notes-cleanup.png')});assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(output,'failure.png')});}}
finally{await app?.close();}
if(report.passed){const restored=new Store(profile,{workspace});await restored.init();const saved=restored.state.scratchpad.notes.find(item=>item.id===approved.id);assert.ok(saved.text.includes('Edited after cleanup'));assert.equal(saved.lastCleanup.beforeText,original+'\nA new idea');assert.equal(saved.lastCleanup.items[0].text,'Finished café 🌙');assert.equal(restored.state.scratchpad.notes.find(item=>item.id===privateNote.id).text,'PRIVATE_UNRELATED');report.checks.encryptedPersistenceRetainsRecoveryAndPrivateNote=true;}
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report},null,2));
