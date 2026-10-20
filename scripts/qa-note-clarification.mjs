// Real desktop routing and compiled renderer with isolated protected synthetic data.
// No provider accounts, network, model charges, or live file changes are used.
import {_electron as electron} from 'playwright';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {Scratchpad} from '../desktop/scratchpad.mjs';

const root=process.cwd(),packaged=process.argv.includes('--packaged')||process.env.EXOMINA_QA_PACKAGED==='1';
const appRoot=packaged?path.join(root,'release/win-unpacked/resources/app.asar'):root;
const packageInfo=packaged?JSON.parse(await readFile(path.join(root,'release/win-unpacked/exomina.build.json'),'utf8')):null;
const {output,profile}=await createProtectedQaProfile('note-clarification');
const workspace=path.join(profile,'workspace'),accounts=path.join(profile,'accounts');await mkdir(workspace);await mkdir(accounts);
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{provider:'codex',model:'fixture-model',autoTitle:false,autoUpdate:false,quickAccess:false,permissionMode:'read-only',decisionLayer:{enabled:false},appearance:{theme:'ink-wash',motion:'reduced'}});
store.state.conversations.push({id:'clarification-qa',title:'Clarification QA',provider:'codex',updatedAt:new Date().toISOString(),sessions:{},messages:[]});
const pad=new Scratchpad({store,scope:()=>workspace});await pad.configure({...pad.settings(),provider:'codex',onlyWhenIdle:false,dailyBudget:20});
const created=await pad.create(),note=await pad.update({...created,title:'Clarify report',text:'Write a report for the appropriate audience.',allowAI:true}),job=await pad.enqueue({id:note.id,text:note.text});
// Logical archive URLs preserve the packaged main module's preload/vendor resolution.
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(appRoot,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session}=require('electron');(async()=>{
app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qa={requests:[],mode:'clarify',questionRejected:false};
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,detail:'Synthetic subscription'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.subscriptionModels=async()=>({codex:[{id:'fixture-model',label:'Fixture',isDefault:true,efforts:[]}]});ProviderManager.prototype.modelsFor=async()=>[{id:'fixture-model',label:'Fixture',isDefault:true}];
ProviderManager.prototype.codexUsage=async()=>({rateLimits:{primary:{usedPercent:20,windowDurationMins:300}}});ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused')};ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};
ProviderManager.prototype.run=async function(request){
 qa.requests.push({conversationId:request.conversationId,prompt:request.prompt});
 const report=input=>this.callTool('notes_work_update',input,request.conversationId);
 if(qa.mode==='slow'){
  await new Promise(resolve=>{qa.release=resolve;});qa.release=null;
  await report({status:'complete',summary:'The independent task finished.',evidence:['Synthetic independent outcome checked.']});
 }else if(qa.mode==='permission'){
  const denied=await this.callTool('workspace_write',{path:'not-created.txt',text:'Forbidden'},request.conversationId);if(!denied.isError)throw Error('Explicit deny was ignored');
  const question=await report({status:'blocked',summary:'Permission is missing.',question:'May I write this file?'});qa.questionRejected=question.isError===true;
  await report({status:'blocked',summary:'The file action needs a permission change on the computer.'});
 }else if(request.prompt.includes('Existing users')){
  const result=await report({status:'complete',summary:'The requested audience was used and checked.',evidence:['Synthetic report audience checked against saved answer.']});if(result.isError)throw Error(JSON.stringify(result));
 }else{
  const result=await report({status:'blocked',summary:'The intended audience is not specified.',question:'Is this report for existing users or prospective customers?'});if(result.isError)throw Error(JSON.stringify(result));
 }
 return {text:'Synthetic task step recorded.',sessionId:'fixture-'+request.conversationId};
};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={scope:'Real desktop/renderer and on-disk restart with synthetic provider responses. No personal profile, external network, or live model request.',runtime:packaged?'packaged host and renderer':'source host and compiled renderer',...(packageInfo?{version:packageInfo.version,buildId:packageInfo.id}:{}),checks:{},errors:[]};let app,page;
async function launch(){app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();await waitState(()=>invoke('bootstrap'),value=>value.connections.some(item=>item.id==='codex'&&item.connected),'Synthetic startup');}
const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
async function waitState(read,accept,label){const end=Date.now()+15000;let value;do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,80));}while(Date.now()<end);throw Error(label+': '+JSON.stringify(value));}
async function openQueue(){await page.locator('[data-chat-id="clarification-qa"] .chat-open').click();await page.getByRole('button',{name:'Notes',exact:true}).click();const panel=page.getByRole('dialog',{name:'Notes',exact:true});await panel.getByRole('button',{name:/^Work queue/}).click();return panel;}
try{
 await launch();let panel=await openQueue();await panel.getByRole('button',{name:'Start task',exact:true}).click();
 let view=await waitState(()=>invoke('notes.view'),value=>!value.activeId&&value.jobs[0].status==='needs-answer','Question saved');const questionId=view.jobs[0].clarification.id,chatId=view.jobs[0].conversationId;
 assert.equal(view.notes[0].text,note.text);assert.equal(view.jobs[0].goal,note.text);assert.equal((await invoke('bootstrap')).approvals.length,0);await panel.getByText('Needs your answer',{exact:true}).waitFor();
 assert.equal(await panel.getByRole('button',{name:'Resume task',exact:true}).count(),0);assert.equal(await panel.getByRole('button',{name:'Save answer & resume',exact:true}).isDisabled(),true);report.checks.realToolQuestionWaitsWithoutPopupOrAutomaticResume=true;
 await app.close();app=null;await launch();assert.equal(await app.evaluate(()=>qa.requests.length),0);panel=await openQueue();await panel.getByText('Needs your answer',{exact:true}).waitFor();
 view=await invoke('notes.view');assert.equal(view.jobs[0].clarification.id,questionId);assert.equal(view.jobs[0].conversationId,chatId);report.checks.questionAndTaskPersistAcrossRealHostRestart=true;
 const answer=panel.getByRole('textbox',{name:'Your answer for Clarify report',exact:true});await answer.fill('Existing users');
 await panel.getByRole('button',{name:'Close notes',exact:true}).click();await page.getByRole('button',{name:'Notes',exact:true}).click();assert.equal(await answer.inputValue(),'Existing users');assert.equal((await invoke('notes.view')).notes[0].text,note.text);report.checks.unsentAnswerSurvivesNotesCloseWithoutWritingToNote=true;
 for(const width of [1440,760,360]){await page.setViewportSize({width,height:1000});const geometry=await panel.locator('.scratchpad-clarification').evaluate(element=>({overflow:element.scrollWidth>element.clientWidth+1,textareaFits:element.querySelector('textarea').getBoundingClientRect().right<=element.getBoundingClientRect().right+1}));assert.equal(geometry.overflow,false);assert.equal(geometry.textareaFits,true);await page.screenshot({path:path.join(output,'question-'+width+'.png')});}
 report.checks.answerFormFitsDesktopTabletAndPhoneWidths=true;
 await panel.getByRole('button',{name:'Save answer & resume',exact:true}).click();view=await waitState(()=>invoke('notes.view'),value=>!value.activeId&&value.jobs[0].status==='complete','Answer resumes task');
 assert.equal(view.jobs[0].steps,2);assert.equal(view.jobs[0].conversationId,chatId);assert.equal(view.jobs[0].clarifications[0].answer,'Existing users');assert.equal(view.notes[0].text,note.text);assert.equal(await app.evaluate(()=>qa.requests.length),1);assert.ok(await app.evaluate(()=>qa.requests[0].prompt.includes('Existing users')));
 await assert.rejects(invoke('notes.work.answer',{id:job.id,clarificationId:questionId,answer:'Prospects'}),/already answered/);report.checks.answerResumesSameTaskWithContextAndKeepsOriginalNote=true;
 await invoke('settings.save',{permissionRules:[{id:'clarification-deny',tool:'workspace_write',match:'',effect:'deny'}]});await app.evaluate(()=>{qa.mode='permission'});
 const denied=await invoke('notes.enqueue',{id:note.id,text:note.text});await invoke('notes.work.start',{id:denied.id});view=await waitState(()=>invoke('notes.view'),value=>!value.activeId&&value.jobs.find(item=>item.id===denied.id)?.status==='blocked','Permission blocker preserved');
 assert.equal(view.jobs.find(item=>item.id===denied.id).clarification,undefined);assert.equal(await app.evaluate(()=>qa.questionRejected),true);assert.equal((await invoke('bootstrap')).approvals.length,0);assert.equal(await panel.getByRole('button',{name:'Save answer & resume',exact:true}).count(),0);await assert.rejects(readFile(path.join(workspace,'not-created.txt'),'utf8'),{code:'ENOENT'});report.checks.permissionDenyCannotBecomeClarificationApproval=true;
 await page.setViewportSize({width:1440,height:1000});await invoke('settings.save',{permissionRules:[]});await app.evaluate(()=>{qa.mode='clarify'});
 const waiting=await invoke('notes.enqueue',{id:note.id,text:note.text});await invoke('notes.work.start',{id:waiting.id});view=await waitState(()=>invoke('notes.view'),value=>!value.activeId&&value.jobs.find(item=>item.id===waiting.id)?.status==='needs-answer','Second clarification');
 await app.evaluate(()=>{qa.mode='slow'});const independent=await invoke('notes.enqueue',{id:note.id,text:note.text});await invoke('notes.work.start',{id:independent.id});await waitState(()=>app.evaluate(()=>!!qa.release),Boolean,'Independent work started');
 const beforeSave=await app.evaluate(()=>qa.requests.length);await answer.fill('Existing users');await panel.getByRole('button',{name:'Save answer',exact:true}).click();
 view=await waitState(()=>invoke('notes.view'),value=>value.jobs.find(item=>item.id===waiting.id)?.status==='paused','Answer saved beside independent work');assert.equal(view.activeId,independent.id);assert.equal(await app.evaluate(()=>qa.requests.length),beforeSave);assert.match(view.jobs.find(item=>item.id===waiting.id).reason,/current note work finishes/);
 await app.evaluate(()=>qa.release());view=await waitState(()=>invoke('notes.view'),value=>!value.activeId&&value.jobs.find(item=>item.id===independent.id)?.status==='complete','Independent work finished');assert.equal(view.jobs.find(item=>item.id===waiting.id).status,'paused');assert.equal(view.settings.enabled,false);
 await app.evaluate(()=>{qa.mode='clarify'});const waitingArticle=panel.locator('.scratchpad-jobs>article').filter({hasText:'Your answer is saved. Resume this task when the current note work finishes.'});await waitingArticle.getByRole('button',{name:'Resume task',exact:true}).click();view=await waitState(()=>invoke('notes.view'),value=>!value.activeId&&value.jobs.find(item=>item.id===waiting.id)?.status==='complete','Explicit answered task resume');report.checks.answerSavesDuringOtherWorkAndWaitsForExplicitResume=true;
 await invoke('notes.work.settings',{...view.settings,maxSteps:1});const capped=await invoke('notes.enqueue',{id:note.id,text:note.text});await invoke('notes.work.start',{id:capped.id});view=await waitState(()=>invoke('notes.view'),value=>!value.activeId&&value.jobs.find(item=>item.id===capped.id)?.status==='needs-answer','Step-limit clarification');
 const used=view.usedToday;await answer.fill('Existing users');await panel.getByRole('button',{name:'Save answer',exact:true}).click();view=await waitState(()=>invoke('notes.view'),value=>value.jobs.find(item=>item.id===capped.id)?.status==='paused','Step-limit answer saved');assert.equal(view.usedToday,used);assert.match(view.jobs.find(item=>item.id===capped.id).reason,/per-task step limit.*daily limit/);
 const cappedIndex=view.jobs.findIndex(item=>item.id===capped.id);assert.ok(cappedIndex>=0);const cappedArticle=panel.locator('.scratchpad-jobs>article').nth(cappedIndex);
 await cappedArticle.getByRole('button',{name:'Allow 1 more step',exact:true}).click();view=await waitState(()=>invoke('notes.view'),value=>!value.activeId&&value.jobs.find(item=>item.id===capped.id)?.status==='complete','Explicit extra step allowance');assert.equal(view.usedToday,used+1);assert.equal(view.settings.dailyBudget,20);assert.equal(view.notes[0].text,note.text);assert.equal(view.jobs.find(item=>item.id===denied.id)?.status,'blocked');report.checks.stepLimitAndAdditionalAllowanceAreExplicitAndDailyBudgetUnchanged=true;
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{await app?.close();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');}
console.log(JSON.stringify({output,...report},null,2));
