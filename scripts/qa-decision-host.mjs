// Production host + compiled renderer with a fresh protected synthetic profile.
// Provider status is replaced with signed-out fixtures; inference and sign-in are refused.
import {_electron as electron} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {MemoryStore} from '../desktop/memory.mjs';
import {DecisionLayer} from '../desktop/decision-layer.mjs';

const root=process.cwd(),runtime=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root);
const fixture=await createProtectedQaProfile('decision-host'),{profile,output}=fixture;
const workspace=path.join(output,'workspace');await mkdir(workspace);await mkdir(path.join(workspace,'reports'));
const store=new Store(profile,{workspace});await store.init();store.state.settings.autoUpdate=false;store.state.settings.quickAccess=false;store.state.settings.autoTitle=false;
const chat=store.create('codex');chat.title='Synthetic cleanup source';chat.messages=[
 {id:'user-message',role:'user',content:'Synthetic user text: café 🌙.'},
 {id:'message',role:'assistant',provider:'codex',content:'Synthetic assistant text.\n\n```js\nconst value = "café 🌙";\n```\n\nFinal paragraph.',activity:[
  {id:'tool-step',kind:'tool',status:'done',title:'Synthetic tool details',input:'Synthetic request only.',output:'Synthetic result only.'},
  {id:'diff-step',kind:'native',status:'done',title:'Synthetic file changes',native:{kind:'diff',text:'--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new\n'}}
 ]}
];
store.state.schedules=[{id:'task',name:'Synthetic task',provider:'codex',prompt:'Synthetic',delivery:'desktop',enabled:false}];await store.save();
const memory=new MemoryStore(profile),sourceIds=[];for(let n=1;n<=83;n++)sourceIds.push((await memory.note(`Synthetic original memory ${n}: café 🌙.`)).id);memory.close();
const file=path.join(profile,'decision-layer.json'),layer=new DecisionLayer({file});await layer.record({gate:'test',kind:'noul',input:'synthetic deleted excerpt',answer:true,source:chat.id});
const url=file=>JSON.stringify(pathToFileURL(path.join(runtime,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session}=require('electron');(async()=>{
app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false);};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1);};globalThis.qaRuns=[];
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${url('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${url('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(x=>x.mode==='subscription').map(x=>({id:x.id,installed:true,connected:false,available:true,checking:false,detail:'Synthetic signed-out status'}));rows.forEach(row=>onStatus?.(row));return rows;};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused');};ProviderManager.prototype.run=async request=>{qaRuns.push(request.provider);throw Error('QA inference refused');};
await import(${url('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1);});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:profile,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const name of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(name))delete env[name];
const report={scope:'Real host IPC, isolated protected synthetic stores; no personal account access or live provider requests.',runtime,checks:{},errors:[]};
let app;
try{
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
 let status=await invoke('decision.status');assert.equal(status.settings.enabled,true);assert.equal(status.agent.settings.enabled,false);assert.equal(status.agent.watching.length,0);assert.equal(status.models.length,2);report.checks.productionStartupAndDefaultOff=true;
 await page.getByRole('button',{name:'Synthetic cleanup source',exact:true}).click();
 const selectOnly=async(region,clickTarget=region)=>{
  await clickTarget.click();await page.keyboard.press('Control+A');
  const selected=await region.evaluate(element=>{const selection=window.getSelection();return{text:selection.toString(),inside:element.contains(selection.anchorNode)&&element.contains(selection.focusNode),focused:document.activeElement===element,focusedTag:document.activeElement?.tagName,focusedClass:document.activeElement?.className};});
  report.lastSelection=selected;
  assert.equal(selected.inside,true);assert.equal(selected.focused,true);return selected.text;
 };
 const userText=page.locator('.message.user .message-content');assert.equal(await selectOnly(userText),'Synthetic user text: café 🌙.');
 const assistantText=page.locator('.message.assistant .message-content');
 const assistantSelected=await selectOnly(assistantText,assistantText.locator('p').first());assert.ok(assistantSelected.includes('Synthetic assistant text.'));assert.equal(assistantSelected.includes('Synthetic user text:'),false);
 const code=assistantText.locator('.code-block pre');assert.equal(await selectOnly(code,code.locator('code')),'const value = "café 🌙";');
 await page.locator('.activity-head').click();
 await page.locator('.activity-work-details .step-head').filter({hasText:'Synthetic tool details'}).click();
 const toolText=page.locator('.activity-step.tool .step-details pre');assert.equal(await selectOnly(toolText.nth(0)),'Synthetic request only.');assert.equal(await selectOnly(toolText.nth(1)),'Synthetic result only.');
 await page.locator('.activity-work-details .step-head').filter({hasText:'Synthetic file changes'}).click();
 const diff=page.getByLabel('Native unified diff',{exact:true});assert.equal((await selectOnly(diff)).trim(),'--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new');
 report.checks.productionScopedSelection={chatProse:true,nestedCode:true,toolRequestAndResult:true,formattedDiff:true,nativeCtrlA:true};
 const first=JSON.parse((await invoke('memory.wake')).text),contextPages=[first];assert.equal(first.total,83);assert.ok(first.nextPart);
 await invoke('memory.add',{text:'Synthetic note added after preview opened.'});
 while(contextPages.at(-1).nextPart){const last=contextPages.at(-1);contextPages.push(JSON.parse((await invoke('memory.wake',{part:last.nextPart,snapshot:first.snapshot,cursor:last.nextCursor})).text));}
 assert.deepEqual(contextPages.flatMap(page=>page.notes.map(note=>note.id)),sourceIds.toReversed());assert.ok(contextPages.every(page=>page.snapshot===83&&page.total===83));report.checks.productionMemoryContextPagination={originalsRead:83,pages:contextPages.length,newArrivalExcluded:true};
 await invoke('memory.reviewAll');assert.equal((await invoke('bootstrap')).memoryReview.unreviewedCount,0);report.checks.productionGlobalViewed=true;
 await invoke('decision.pause');assert.equal((await invoke('decision.status')).status.manualPause,'until-resumed');await invoke('decision.resume');assert.equal((await invoke('decision.status')).status.manualPause,null);report.checks.productionManualPause=true;
 const trigger=await invoke('agent.saveTrigger',{name:'Reports',folder:path.join(workspace,'reports'),taskId:'task',filter:'*.pdf'});assert.ok(trigger.id);assert.equal((await invoke('decision.status')).agent.watching.length,0);
 await assert.rejects(invoke('agent.saveTrigger',{name:'Outside project',folder:path.dirname(workspace),taskId:'task'}),/outside the chosen workspace/);report.checks.triggerValidationAndNoWatchWhileOff=true;
 await invoke('agent.removeTrigger',{id:trigger.id});
 await invoke('conversations.delete',{id:chat.id});const check=new DecisionLayer({file});await check.load();assert.equal(check.gates.get('test').examples.length,0);report.checks.productionChatDecisionCleanup=true;
 await invoke('settings.save',{decisionLayer:{enabled:false,makeWay:false}});assert.equal((await invoke('decision.status')).status,null);
 assert.deepEqual(await app.evaluate(()=>qaRuns),[]);assert.deepEqual(report.errors,[]);await fixture.verify();report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await app?.close();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report},null,2));}
