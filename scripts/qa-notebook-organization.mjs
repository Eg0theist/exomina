// Real host, renderer and encrypted synthetic persistence. No personal accounts or inference.
import {_electron as electron} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {Scratchpad} from '../desktop/scratchpad.mjs';

const root=process.cwd(),packaged=process.argv.includes('--packaged'),safetyOnly=process.argv.includes('--safety-only'),runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||(packaged?path.join(root,'release/win-unpacked/resources/app.asar'):root));
const fixture=await createProtectedQaProfile(packaged?'notebook-organization-packaged':'notebook-organization'),{output,profile}=fixture;
const workspace=path.join(profile,'workspace'),accounts=path.join(profile,'accounts');await mkdir(workspace);await mkdir(accounts);
const seed=new Store(profile,{workspace});await seed.init();
Object.assign(seed.state.settings,{provider:'codex',model:'gpt-fixture',effort:'high',autoTitle:false,autoUpdate:false,quickAccess:false,closeToTray:false,attentionNotifications:false,memoryEnabled:false,chatMemorySummaries:false,browserEnabled:false,permissionMode:'read-only',appearance:{theme:'ink-wash',motion:'reduced'}});
seed.state.conversations.push({id:'notebook-qa',title:'Notebook QA',provider:'codex',updatedAt:new Date().toISOString(),sessions:{},messages:[]});
const pad=new Scratchpad({store:seed});
async function note(title,text,allowAI){const created=await pad.create();return pad.update({...created,title,text,allowAI});}
const design=await note('Design research','Make the workspace easier to understand.\nKeep research links together: https://example.com/research\nMaybe use a quieter default layout.',true);
const writing=await note('Novel fragments','The harbor scene needs a stronger sense of place.\nKeep the dialogue spare.\nQuestion: what does the reader know at this point?',true);
const secret=await note('Private journal','PRIVATE_NOT_FOR_ORGANIZATION',false);await note('Empty note','',true);
pad.data().settings={...pad.settings(),dailyBudget:50};await pad.save();
const originalNotes=structuredClone(seed.state.scratchpad.notes),moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session,Notification}=require('electron');(async()=>{
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile,'browser-data'))});app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};Notification.prototype.show=function(){};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};globalThis.qa={requests:[],mode:'normal',waiters:new Map(),cancelled:[]};
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
const models={codex:[{id:'gpt-fixture',label:'Fixture GPT',isDefault:true,supportsImages:true,efforts:[{id:'high',label:'High'}]}]};
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,checking:false,detail:'Synthetic subscription'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.subscriptionModels=async()=>models;ProviderManager.prototype.modelsFor=async id=>models[id]||[];
ProviderManager.prototype.codexUsage=async()=>({rateLimits:{primary:{usedPercent:20,windowDurationMins:300}}});
ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused')};ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};
ProviderManager.prototype.cancel=function(id){qa.cancelled.push(id);if(!qa.cancelHold){qa.waiters.get(id)?.({error:'Stopped'});qa.waiters.delete(id);}};
ProviderManager.prototype.run=async function(request){
 if(!request.conversationId.startsWith('note-planner-'))throw Error('Unexpected model request');qa.requests.push(request);
 if(qa.mode==='slow')return new Promise(resolve=>qa.waiters.set(request.conversationId,resolve));
 const group=request.prompt.includes('Overview items: '),records=JSON.parse(request.prompt.split(group?'Overview items: ':'Source parts: ').at(-1));
 if(group)return {text:JSON.stringify({overview:'Research and writing ideas, gathered into one notebook overview.',groups:[{title:'Notebook projects',summary:'Related ideas read from every part of the notebook.',itemIds:records.map(item=>item.id)}]})};
 return {text:JSON.stringify({overview:'Two threads run through these notes: making the workspace clearer and sharpening the next scene.',groups:records.map(part=>({title:part.title==='Design research'?'Product & research':'Writing',summary:part.title==='Design research'?'Keep workspace design ideas and their references together.':'Gather scene observations and unresolved questions.',items:[{sourceId:part.id,title:part.title==='Design research'?'A clearer workspace':'The harbor scene',summary:part.title==='Design research'?'Improve the first-use experience while preserving the research references.':'Strengthen the setting, keep dialogue spare, and track what the reader already knows.',quote:part.text.slice(0,80)}]}))})};
};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={scope:'Real Electron host and compiled renderer, synthetic tool-free AI, protected encrypted profile; HTTP blocked, personal accounts inaccessible.',runtimeRoot,checks:{},errors:[],limitations:['No live model quality, subscription exhaustion, or physical user interaction tested.']};let app,page;
async function until(read,accept,label){const limit=Date.now()+15000;let value;do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,70));}while(Date.now()<limit);throw Error(label+': '+JSON.stringify(value).slice(0,1200));}
try{
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
 await until(()=>invoke('bootstrap'),state=>state.connections.some(item=>item.id==='codex'&&item.connected)&&state.providerModels.codex?.length,'Fixture startup');
 await page.locator('[data-chat-id="notebook-qa"] .chat-open').click();await page.getByRole('button',{name:'Notes',exact:true}).click();const panel=page.getByRole('dialog',{name:'Notes',exact:true});
 if(safetyOnly){
  await panel.getByRole('button',{name:'Organize notebook…',exact:true}).click();await panel.getByRole('button',{name:'Create organization proposal',exact:true}).click();
  let view=await until(()=>invoke('notes.view'),state=>!state.organization.running&&state.organization.proposal,'Reviewable safety proposal');
  assert.equal(await panel.locator('.notebook-setup').getAttribute('open'),null);await panel.getByRole('button',{name:'Apply organization',exact:true}).waitFor();
  const firstTopic=await panel.locator('.notebook-topic').first().boundingBox(),panelBounds=await panel.boundingBox();assert.ok(firstTopic.y<panelBounds.y+panelBounds.height-80,'The generated first topic must be visible without scrolling');
  await page.screenshot({path:path.join(output,'notebook-proposal.png')});report.checks.proposalCollapsesSetupAndShowsGeneratedGroupsAndApplyAboveFold=true;
  await panel.getByRole('button',{name:'Apply organization',exact:true}).click();await until(()=>invoke('notes.view'),state=>state.organization.applied&&!state.organization.proposal,'Safety apply');
  await invoke('notes.save',{...view.notes.find(note=>note.id===writing.id),allowAI:false});view=await invoke('notes.view');assert.equal(view.organization.applied,null);assert.match(view.organization.notice,/previous organization was removed/);assert.ok(!JSON.stringify(view.organization).includes('harbor'));
  await panel.getByText(/Its previous organization was removed/).waitFor();await invoke('notes.save',{...view.notes.find(note=>note.id===writing.id),allowAI:true});view=await invoke('notes.view');assert.equal(view.organization.applied,null);report.checks.revokedContentPurgedWithVisibleReasonAndCannotResurrect=true;
  const longText=design.text+'\n'+'A long notebook ramble. '.repeat(2500)+'LAST_COMPLETE_SOURCE_MARKER';await invoke('notes.save',{...view.notes.find(note=>note.id===design.id),text:longText});
  const start=await app.evaluate(()=>qa.requests.length);await panel.getByRole('button',{name:'Create organization proposal',exact:true}).click();view=await until(()=>invoke('notes.view'),state=>!state.organization.running&&state.organization.proposal,'Semantic long notebook synthesis');
  const generated=await app.evaluate((_electron,start)=>qa.requests.slice(start),start),parts=generated.filter(request=>request.prompt.includes('Source parts: ')).flatMap(request=>JSON.parse(request.prompt.split('Source parts: ').at(-1))),synthesis=JSON.parse(generated.at(-1).prompt.split('Overview items: ').at(-1));
  assert.equal(parts.filter(part=>part.noteId===design.id).map(part=>part.text).join(''),longText);assert.ok(synthesis.every(item=>item.summary&&item.title&&item.id));assert.equal(generated.length,view.organization.requestCount);report.checks.longNotebookFullContentAndSemanticBoundedSynthesis=true;
  await panel.getByRole('button',{name:'Apply organization',exact:true}).click();view=await until(()=>invoke('notes.view'),state=>state.organization.applied&&!state.organization.proposal,'Apply long organization');const appliedId=view.organization.applied.id;
  await app.evaluate(()=>{qa.mode='slow';qa.cancelHold=true});await panel.locator('.notebook-setup>summary').click();await panel.getByRole('button',{name:'Refresh organization',exact:true}).click();await until(()=>app.evaluate(()=>qa.waiters.size),value=>value===1,'Cancellable provider request');await panel.getByRole('button',{name:'Stop organizing',exact:true}).click();
  await panel.getByText('Stopping the previous AI request…',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'Refresh organization',exact:true}).isDisabled(),true);await assert.rejects(invoke('notes.organization.prepare',{provider:'codex'}),/current note work/);
  await app.evaluate(()=>{for(const resolve of qa.waiters.values())resolve({error:'Stopped'});qa.waiters.clear();qa.mode='normal';qa.cancelHold=false});view=await until(()=>invoke('notes.view'),state=>!state.organization.running&&!state.organization.stopping,'Provider cancellation settled');assert.equal(view.organization.applied.id,appliedId);assert.equal(view.organization.proposal,null);report.checks.cancellationShowsStoppingAndBlocksOverlapUntilProviderSettles=true;
  for(const width of [1440,760,360]){await page.setViewportSize({width,height:1000});const bounds=await panel.evaluate(element=>({documentOverflow:document.documentElement.scrollWidth>innerWidth+1,panelOverflow:element.scrollWidth>element.clientWidth+1,right:element.getBoundingClientRect().right,width:innerWidth}));assert.equal(bounds.documentOverflow,false);assert.equal(bounds.panelOverflow,false);assert.ok(bounds.right<=bounds.width);await page.screenshot({path:path.join(output,'notebook-'+width+'.png')});}
  report.checks.narrowAndWideCollapsedOverviewLayouts=true;assert.deepEqual(report.errors,[]);report.passed=true;
 }else{
 await panel.getByRole('button',{name:'Organize notebook…',exact:true}).click();await panel.getByText('2 of 4 notes shared with AI',{exact:true}).waitFor();
 await panel.getByRole('textbox',{name:'Notebook organization preference',exact:true}).fill('Group by project and preserve unresolved questions.');
 await panel.getByRole('button',{name:'Create organization proposal',exact:true}).click();let view=await until(()=>invoke('notes.view'),state=>!state.organization.running&&state.organization.proposal,'Reviewable proposal');
 assert.deepEqual(view.notes,originalNotes);assert.equal(view.jobs.length,0);assert.equal(view.usedToday,0);
 const requests=await app.evaluate(()=>qa.requests);assert.equal(requests.length,1);assert.ok(requests[0].noTools&&requests[0].noPersistence&&requests[0].ephemeral);assert.equal(requests[0].toolDefinitions.length,0);assert.ok(!requests[0].prompt.includes('PRIVATE_NOT_FOR_ORGANIZATION'));assert.ok(!requests[0].prompt.includes(secret.id));assert.ok(requests[0].prompt.includes('https://example.com/research'));report.checks.explicitScopeAllEligibleContentToolFreeAndUnchangedOriginals=true;
 await panel.getByRole('heading',{name:'Review proposal',exact:true}).waitFor();await page.screenshot({path:path.join(output,'notebook-proposal.png')});
 await panel.getByRole('button',{name:'Apply organization',exact:true}).click();view=await until(()=>invoke('notes.view'),state=>state.organization.applied&&!state.organization.proposal,'Apply organization');assert.deepEqual(view.notes,originalNotes);
 await panel.getByRole('button',{name:'Your notes',exact:true}).click();const picker=panel.getByRole('combobox',{name:'Choose note',exact:true});
 assert.deepEqual(await picker.locator('optgroup').evaluateAll(elements=>elements.map(element=>element.label)),['Writing','Product & research','Other notes']);
 const ids=await picker.locator('option').evaluateAll(elements=>elements.map(element=>element.value).filter(Boolean));assert.equal(ids.length,4);assert.equal(new Set(ids).size,4);report.checks.appliedGroupingNavigatesEachNoteExactlyOnceAndPreservesPrivateNotes=true;
 await panel.getByRole('button',{name:'Overview',exact:true}).click();await panel.getByRole('button',{name:/Design research.*open original note/}).click();
 const editor=panel.getByRole('textbox',{name:'Note text',exact:true});await until(()=>editor.inputValue(),value=>value===design.text,'Original note opened');
 const selection=await editor.evaluate(element=>element.value.slice(element.selectionStart,element.selectionEnd));assert.equal(selection,design.text.slice(0,80));
 const edited=design.text+'\nA new idea after organization.';await editor.fill(edited);await until(()=>invoke('notes.view'),state=>state.notes.find(note=>note.id===design.id).text===edited,'New scribble saved');
 await panel.getByRole('button',{name:'Overview',exact:true}).click();await panel.getByText('Your notes changed since this overview. Refresh organization to include the current contents.',{exact:true}).waitFor();
 await panel.getByRole('button',{name:'Undo organization',exact:true}).click();view=await until(()=>invoke('notes.view'),state=>!state.organization.applied,'Undo grouping');assert.equal(view.notes.find(note=>note.id===design.id).text,edited);report.checks.originalSourceSelectionStalenessAndUndoPreserveLaterEdits=true;
 await panel.getByRole('button',{name:'Create organization proposal',exact:true}).click();view=await until(()=>invoke('notes.view'),state=>!state.organization.running&&state.organization.proposal,'Second proposal');
 await panel.getByRole('button',{name:'Apply organization',exact:true}).click();await until(()=>invoke('notes.view'),state=>state.organization.applied&&!state.organization.proposal,'Second apply');
 const currentWriting=(await invoke('notes.view')).notes.find(note=>note.id===writing.id);await invoke('notes.save',{...currentWriting,allowAI:false});view=await invoke('notes.view');assert.equal(view.organization.applied,null);assert.match(view.organization.notice,/previous organization was removed/);assert.equal(JSON.stringify(view.organization).includes('harbor'),false);await panel.getByText(/Its previous organization was removed/).waitFor();report.checks.revocationHidesDerivedOverview=true;
 await invoke('notes.save',{...view.notes.find(note=>note.id===writing.id),allowAI:true});
 view=await invoke('notes.view');const longText=edited+'\n'+'A long notebook ramble. '.repeat(2500)+'LAST_COMPLETE_SOURCE_MARKER';await invoke('notes.save',{...view.notes.find(note=>note.id===design.id),text:longText});
 const beforeCalls=await app.evaluate(()=>qa.requests.length);await panel.getByRole('button',{name:'Create organization proposal',exact:true}).click();view=await until(()=>invoke('notes.view'),state=>!state.organization.running&&state.organization.proposal,'Long notebook proposal');
 const longRequests=await app.evaluate((_electron,start)=>qa.requests.slice(start),beforeCalls),parts=longRequests.filter(request=>request.prompt.includes('Source parts: ')).flatMap(request=>JSON.parse(request.prompt.split('Source parts: ').at(-1)));
 assert.equal(parts.filter(part=>part.noteId===design.id).map(part=>part.text).join(''),longText);assert.ok(longRequests.at(-1).prompt.includes('Overview items: '));assert.equal(longRequests.length,view.organization.requestCount);report.checks.longNotebookHasNoSilentTruncationAndBoundedSynthesis=true;
 await panel.getByRole('button',{name:'Apply organization',exact:true}).click();view=await until(()=>invoke('notes.view'),state=>state.organization.applied&&!state.organization.proposal,'Long organization applied');const appliedId=view.organization.applied.id;
 await app.evaluate(()=>{qa.mode='slow'});await panel.locator('.notebook-setup>summary').click();await panel.getByRole('button',{name:'Refresh organization',exact:true}).click();await until(()=>app.evaluate(()=>qa.waiters.size),count=>count===1,'Cancellable model request');await panel.getByRole('button',{name:'Stop organizing',exact:true}).click();view=await until(()=>invoke('notes.view'),state=>!state.organization.running,'Organization stopped');assert.equal(view.organization.applied.id,appliedId);assert.equal(view.organization.proposal,null);assert.ok((await app.evaluate(()=>qa.cancelled.length))>0);report.checks.stopCancelsActualRequestAndKeepsPriorAppliedOrganization=true;
 for(const width of [1440,760,360]){await page.setViewportSize({width,height:1000});const bounds=await panel.evaluate(element=>({documentOverflow:document.documentElement.scrollWidth>innerWidth+1,panelOverflow:element.scrollWidth>element.clientWidth+1,right:element.getBoundingClientRect().right,width:innerWidth}));assert.equal(bounds.documentOverflow,false);assert.equal(bounds.panelOverflow,false);assert.ok(bounds.right<=bounds.width);await page.screenshot({path:path.join(output,'notebook-'+width+'.png')});}
 report.checks.narrowAndWideLayouts=true;assert.deepEqual(report.errors,[]);report.passed=true;
 }
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(output,'failure.png')});}
finally{await app?.close();}
if(report.passed){const reopened=new Store(profile,{workspace});await reopened.init();assert.ok(reopened.state.scratchpad.organization.applied);assert.equal(reopened.state.scratchpad.notes.find(note=>note.id===secret.id).text,'PRIVATE_NOT_FOR_ORGANIZATION');assert.equal(reopened.state.scratchpad.notes.find(note=>note.id===design.id).text.endsWith('LAST_COMPLETE_SOURCE_MARKER'),true);report.checks.organizationAndUntouchedOriginalsPersistAcrossHostQuit=true;}
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report},null,2));
