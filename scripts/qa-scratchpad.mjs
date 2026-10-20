// Production desktop host and compiled renderer, with isolated synthetic storage.
// Model responses and usage are fixtures; real workspace tools and handover run.
import {_electron as electron} from 'playwright';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';

const root=process.cwd(),fixture=await createProtectedQaProfile('scratchpad'),{output,profile}=fixture;
const workspace=path.join(profile,'workspace'),accounts=path.join(profile,'accounts');
await mkdir(workspace);await mkdir(accounts);
const seed=new Store(profile,{workspace});await seed.init();
Object.assign(seed.state.settings,{provider:'claude',model:'opus',effort:'high',autoTitle:false,autoUpdate:false,quickAccess:false,permissionMode:'ask',appearance:{theme:'ink-wash',motion:'reduced'},modelPreferences:{fallback:{enabled:true,mode:'ordered',targets:[{provider:'codex',model:'gpt-fixture',effort:'high'}]}}});
seed.state.conversations.push({id:'notes-qa',title:'Notes QA',provider:'claude',updatedAt:new Date().toISOString(),sessions:{},messages:[]});await seed.save();
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(root,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session}=require('electron');(async()=>{
app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qa={requests:[],writes:0,clock:Date.now(),mode:'handoff',claudeExhausted:false,exhaustAll:false,cancelled:[],waiters:new Map()};
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)}));
const{Scratchpad}=await import(${moduleUrl('desktop/scratchpad.mjs')});const start=Scratchpad.prototype.start;
Scratchpad.prototype.start=function(){qa.pad=this;this.now=()=>new Date(qa.clock);return start.call(this)};
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
const models={codex:[{id:'gpt-fixture',label:'Fixture GPT',isDefault:true,supportsImages:true,efforts:[{id:'low',label:'Low'},{id:'high',label:'High'}]}],claude:[{id:'opus',label:'Fixture Opus',isDefault:true,supportsImages:true,efforts:[{id:'high',label:'High'}]}]};
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:['codex','claude'].includes(item.id),installed:true,available:true,checking:false,detail:'Synthetic subscription'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.subscriptionModels=async()=>models;ProviderManager.prototype.modelsFor=async id=>models[id]||[];
ProviderManager.prototype.codexUsage=async()=>({rateLimits:{primary:{usedPercent:qa.exhaustAll?100:20,windowDurationMins:300}}});
ProviderManager.prototype.claudeUsage=async()=>({rate_limits:{five_hour:{utilization:qa.exhaustAll||qa.claudeExhausted?100:20,resets_at:new Date(Date.now()+3600000).toISOString()}}});
ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused')};ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};
const unwrap=result=>{if(result?.isError)throw Error(result.content.map(item=>item.text||'').join(''));return result};
ProviderManager.prototype.run=async function(request){
 const item={provider:request.provider,model:request.model,effort:request.effort,conversationId:request.conversationId,prompt:request.prompt,noTools:request.noTools,noPersistence:request.noPersistence,permission:this.getPermissionMode(request.conversationId)};qa.requests.push(item);
 if(request.conversationId.startsWith('note-planner-')){const note=qa.pad.view().notes.find(note=>note.allowAI);return {text:JSON.stringify({noteId:note.id,idea:note.text})};}
 const report=async input=>unwrap(await this.callTool('notes_work_update',input,request.conversationId));
 if(qa.mode==='handoff'){
  if(request.provider==='claude'){
   const visible=unwrap(await this.callTool('notes_read',{id:qa.pad.active.job.noteId},request.conversationId));if(JSON.stringify(visible).includes('PRIVATE_NOT_FOR_PLANNER'))throw Error('Manual queue leaked unrelated note text');
   try{await this.callTool('request_permission',{tool_name:'AskUserQuestion',input:{questions:[]}},request.conversationId);throw Error('Interactive question was allowed')}catch(error){if(!error.message.includes('cannot ask interactive questions'))throw error;qa.questionsBlocked=true;}
   unwrap(await this.callTool('workspace_write',{path:'proof.txt',text:'One successful write.'},request.conversationId));qa.writes++;qa.claudeExhausted=true;throw Error("You've hit your session limit · resets 9:50pm");
  }
  qa.codexSteps=(qa.codexSteps||0)+1;
  if(qa.codexSteps===1){await report({status:'continue',summary:'Created proof.txt; verify its exact content next.',nextStep:'Read proof.txt and verify the completed write.'});}
  else{const read=unwrap(await this.callTool('workspace_read',{path:'proof.txt'},request.conversationId));if(!JSON.stringify(read).includes('One successful write.'))throw Error('Read-back mismatch');await report({status:'complete',summary:'The saved file passed its read-back.',evidence:['proof.txt reads back as One successful write.']});}
 }else if(qa.mode==='denied'){
  const result=await this.callTool('workspace_write',{path:'denied.txt',text:'Must not appear'},request.conversationId);qa.denied=result;return {text:'The write is blocked.'};
 }else if(qa.mode==='slow'){
  await new Promise((resolve,reject)=>qa.waiters.set(request.conversationId,reject));return {text:'Late result'};
 }else{
  const goal=qa.pad.active.job.goal;
  if(qa.mode==='auto'){unwrap(await this.callTool('workspace_write',{path:'automatic.txt',text:goal},request.conversationId));qa.writes++;const read=unwrap(await this.callTool('workspace_read',{path:'automatic.txt'},request.conversationId));if(!JSON.stringify(read).includes(goal))throw Error('Automatic result read-back mismatch');}
  await report({status:'complete',summary:'Requested synthetic task verified.',evidence:[qa.mode==='auto'?'automatic.txt read-back verified by fixture':'Synthetic requested result inspected']});
 }
 return {text:'Synthetic step finished.',sessionId:'fixture-'+request.conversationId};
};
const cancel=ProviderManager.prototype.cancel;ProviderManager.prototype.cancel=function(id){qa.cancelled.push(id);const reject=qa.waiters.get(id);qa.waiters.delete(id);reject?.(Error('Stopped'));return cancel.call(this,id)};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={scope:'Real host/renderer, file tools and fallback; synthetic provider protocol and usage. No personal accounts, external network, paid model requests or resets.',checks:{},errors:[]};
async function waitState(read,accept,label){const until=Date.now()+15000;let value;do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,80));}while(Date.now()<until);throw Error(label+': '+JSON.stringify(value));}
let app;
try{
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
 await waitState(()=>invoke('bootstrap'),state=>state.connections.some(item=>item.id==='claude'&&item.connected)&&state.providerModels.codex?.length,'Synthetic startup');
 await invoke('usage.refresh');await page.locator('[data-chat-id="notes-qa"] .chat-open').click();
 const composer=page.getByRole('textbox',{name:'Message',exact:true});await composer.fill('Already typed');
 await page.getByRole('button',{name:'Notes',exact:true}).click();const panel=page.getByRole('dialog',{name:'Notes',exact:true});
 await panel.getByRole('button',{name:'New note',exact:true}).click();await panel.getByRole('textbox',{name:'Note title',exact:true}).fill('A private draft');
 const text='Create proof.txt and verify its content.\nPRIVATE_NOT_FOR_PLANNER: a later personal idea.';
 const editor=panel.getByRole('textbox',{name:'Note text',exact:true});await editor.fill(text);
 let view=await waitState(()=>invoke('notes.view'),current=>current.notes[0]?.text===text,'Note autosave');const privateId=view.notes[0].id;
 assert.equal(view.notes[0].allowAI,false);assert.equal(view.settings.enabled,false);
 await editor.evaluate((element,end)=>{element.focus();element.setSelectionRange(0,end);element.dispatchEvent(new Event('select',{bubbles:true}));},text.indexOf('\n'));
 await panel.getByRole('button',{name:'Add to next message',exact:true}).click();
 await waitState(()=>composer.inputValue(),value=>value==='Already typed\n\nCreate proof.txt and verify its content.','Draft insertion');
 assert.equal(await app.evaluate(()=>qa.requests.length),0);assert.equal((await invoke('bootstrap')).memories.length,0);
 report.checks.autosavePrivateNotesAndSelectionWithoutSending=true;
 await page.screenshot({path:path.join(output,'notes-draft.png')});
 await panel.getByRole('button',{name:'Queue as task',exact:true}).click();await panel.getByRole('combobox',{name:'Note work AI',exact:true}).selectOption('claude');
 await panel.getByRole('checkbox',{name:'Start work after two minutes away',exact:true}).uncheck();
 await panel.getByRole('combobox',{name:'Note work permissions',exact:true}).selectOption('auto-edit');
 await panel.getByRole('spinbutton',{name:'Daily note work steps',exact:true}).fill('20');await panel.getByRole('spinbutton',{name:'Note work step limit',exact:true}).fill('3');
 await panel.getByRole('button',{name:'Save work settings',exact:true}).click();
 await waitState(()=>invoke('notes.view'),current=>current.settings.provider==='claude'&&current.settings.permissionMode==='auto-edit','Saved work settings');
 await panel.getByRole('button',{name:'Start task',exact:true}).click();
 view=await waitState(()=>invoke('notes.view'),current=>!current.activeId&&current.jobs[0]?.status==='complete','Handover and continued verification');
 const handoff=await app.evaluate(()=>qa.requests.filter(item=>!item.conversationId.startsWith('note-planner-')));
 assert.deepEqual(handoff.map(item=>item.provider),['claude','codex','codex']);assert.equal(handoff[1].model,'gpt-fixture');assert.equal(handoff[1].effort,'high');
 assert.ok(handoff[1].prompt.includes('Handoff checkpoint:'));assert.ok(handoff[1].prompt.includes('proof.txt'));assert.ok(handoff[2].prompt.includes('verify its exact content next'));
 assert.equal(new Set(handoff.map(item=>item.conversationId)).size,1);assert.ok(handoff.every(item=>item.permission==='auto-edit'));
 assert.equal(await app.evaluate(()=>qa.writes),1);assert.equal(await app.evaluate(()=>qa.questionsBlocked),true);assert.equal(view.jobs[0].steps,2);assert.equal(await readFile(path.join(workspace,'proof.txt'),'utf8'),'One successful write.');
 const chat=await invoke('conversations.get',{id:view.jobs[0].conversationId});assert.equal(chat.permissionMode,undefined);assert.equal((await invoke('bootstrap')).approvals.length,0);
 report.checks.realHostUsageFallbackEffortCheckpointAndContinuedTask=true;
 await page.screenshot({path:path.join(output,'completed-work.png')});

 await panel.getByRole('button',{name:'Your notes',exact:true}).click();await panel.getByRole('button',{name:'New note',exact:true}).click();
 await panel.getByRole('textbox',{name:'Note title',exact:true}).fill('Approved ideas');await editor.fill('Write a synthetic automatic work result.');
 await panel.getByRole('checkbox',{name:'Allow AI to read this note',exact:false}).check();
 view=await waitState(()=>invoke('notes.view'),current=>current.notes.some(note=>note.allowAI&&note.title==='Approved ideas'),'Approved note autosave');
 const approved=view.notes.find(note=>note.allowAI);await app.evaluate(()=>{qa.mode='auto'});
 await invoke('notes.work.settings',{...view.settings,enabled:true,onlyWhenIdle:false});await app.evaluate(()=>qa.pad.tick());
 view=await waitState(()=>invoke('notes.view'),current=>!current.scanning&&current.jobs.length===2,'Automatic idea planning');
 await app.evaluate(()=>qa.pad.tick());view=await waitState(()=>invoke('notes.view'),current=>!current.activeId&&current.jobs[1]?.status==='complete','Automatic work completion');
 const planner=await app.evaluate(()=>qa.requests.find(item=>item.conversationId.startsWith('note-planner-')));
 assert.ok(planner.noTools&&planner.noPersistence);assert.equal(planner.prompt.includes('PRIVATE_NOT_FOR_PLANNER'),false);assert.ok(planner.prompt.includes(approved.id));
 assert.equal(await readFile(path.join(workspace,'automatic.txt'),'utf8'),approved.text);report.checks.optInPlannerOnlyApprovedNotesAndAutomaticWork=true;

 await app.evaluate(()=>{qa.exhaustAll=true;qa.mode='recovery'});await invoke('usage.refresh');
 const queued=await invoke('notes.enqueue',{id:privateId,text:'Create proof.txt and verify its content.'}),before=await app.evaluate(()=>qa.requests.length);
 await invoke('notes.work.start',{id:queued.id});view=await invoke('notes.view');assert.equal(view.jobs.find(job=>job.id===queued.id).status,'waiting-usage');assert.equal(await app.evaluate(()=>qa.requests.length),before);
 await app.evaluate(()=>{qa.exhaustAll=false;qa.clock+=300001});await invoke('usage.refresh');await app.evaluate(()=>qa.pad.tick());
 view=await waitState(()=>invoke('notes.view'),current=>current.jobs.find(job=>job.id===queued.id)?.status==='complete','Capacity recovery');report.checks.exhaustedQueueWaitsAndRecovers=true;

 await invoke('notes.work.pause');await invoke('settings.save',{permissionRules:[{id:'deny-notes-write',tool:'workspace_write',match:'',effect:'deny'}]});
 await app.evaluate(()=>{qa.mode='denied'});const denied=await invoke('notes.enqueue',{id:privateId,text:'Create proof.txt and verify its content.'});await invoke('notes.work.start',{id:denied.id});
 view=await waitState(()=>invoke('notes.view'),current=>!current.activeId&&current.jobs.find(job=>job.id===denied.id)?.status==='blocked','Explicit permission blocker');
 assert.equal(await app.evaluate(()=>qa.denied.isError),true);await assert.rejects(readFile(path.join(workspace,'denied.txt'),'utf8'),{code:'ENOENT'});assert.equal((await invoke('bootstrap')).approvals.length,0);report.checks.explicitDenyBlocksWithoutQuestionsOrLoop=true;

 await invoke('settings.save',{permissionRules:[]});await app.evaluate(()=>{qa.mode='slow'});
 const stopped=await invoke('notes.enqueue',{id:approved.id,text:approved.text});await invoke('notes.work.start',{id:stopped.id});
 await waitState(()=>app.evaluate(()=>qa.waiters.size),value=>value===1,'Cancellable runtime starts');await invoke('notes.work.pause');
 await waitState(()=>invoke('bootstrap'),state=>!state.activeRuns.length,'Pause active runtime');view=await invoke('notes.view');assert.equal(view.jobs.find(job=>job.id===stopped.id).status,'paused');report.checks.pauseCancelsActualRuntime=true;
 await panel.getByRole('button',{name:/^Work queue/}).click();
 for(const width of [1440,760,360]){await page.setViewportSize({width,height:1000});const geometry=await panel.evaluate(element=>{const bounds=element.getBoundingClientRect();return {width:innerWidth,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,panelOverflow:element.scrollWidth>element.clientWidth+1,fits:bounds.left>=0&&bounds.right<=innerWidth&&bounds.bottom<=innerHeight};});assert.equal(geometry.documentOverflow,false);assert.equal(geometry.panelOverflow,false);assert.equal(geometry.fits,true);(report.checks.layouts||=[]).push(geometry);await page.screenshot({path:path.join(output,'notes-'+width+'.png')});}
 await page.setViewportSize({width:1440,height:1000});await panel.getByRole('button',{name:'Close notes',exact:true}).click();await page.keyboard.press('Control+,');
 await page.getByRole('combobox',{name:'Interface view',exact:true}).first().selectOption('advanced');
 await page.getByRole('navigation',{name:'Settings categories'}).getByRole('button',{name:'Models & usage',exact:true}).click();const modelSettings=page.locator('#settings-models');
 await modelSettings.getByRole('button',{name:'Remove fallback 1',exact:true}).click();await modelSettings.getByRole('combobox',{name:'Fallback AI',exact:true}).selectOption('codex');await modelSettings.getByRole('combobox',{name:'Fallback model',exact:true}).selectOption('gpt-fixture');await modelSettings.getByRole('combobox',{name:'Fallback effort',exact:true}).selectOption('high');await modelSettings.getByRole('button',{name:'Add fallback',exact:true}).click();
 const state=await waitState(()=>invoke('bootstrap'),state=>state.settings.modelPreferences.fallback.targets[0]?.effort==='high','Fallback effort saved');assert.equal(state.memories.length,0);assert.equal(state.usageResetPending,false);report.checks.fallbackEffortSettingAndNoMemoryOrReset=true;
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(output,'failure.png')});report.fixture=await app.evaluate(()=>({requests:qa.requests.map(({prompt,...item})=>item),pad:qa.pad?.view(),writes:qa.writes}));}}
finally{await app?.close();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');}
if(report.passed){const restored=new Store(profile,{workspace});await restored.init();assert.equal(restored.state.scratchpad.notes.length,2);assert.equal(restored.state.scratchpad.notes.find(note=>note.title==='A private draft').text.includes('PRIVATE_NOT_FOR_PLANNER'),true);assert.equal(restored.state.scratchpad.jobs.filter(job=>job.status==='complete').length,3);report.checks.notesAndTaskProgressPersistedOnDisk=true;await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');}
console.log(JSON.stringify({output,...report},null,2));
