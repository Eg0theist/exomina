// Real host/compiled Settings with encrypted synthetic storage and a model fixture.
import {_electron as electron} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';

const root=process.cwd(),runtime=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root);
const {output,profile}=await createProtectedQaProfile('soul');
const workspace=path.join(profile,'workspace'),accounts=path.join(profile,'accounts');await mkdir(workspace);await mkdir(accounts);
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{provider:'codex',model:'gpt-fixture',effort:'high',autoTitle:false,autoUpdate:false,quickAccess:false,memoryEnabled:false,browserEnabled:false,desktopEnabled:false,permissionMode:'ask',appearance:{theme:'ink-wash',motion:'reduced'},personalization:{soul:{traits:Array.from({length:40},(_,i)=>({id:`t${i}`,text:`Synthetic durable preference ${i}.`,evidence:`User request ${i}.`,source:'stated',since:'2026-10-17'}))}}});
store.state.conversations.push({id:'soul-qa',title:'Soul QA',provider:'codex',updatedAt:new Date().toISOString(),sessions:{},messages:[]});await store.save();
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(runtime,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session}=require('electron');(async()=>{
app.commandLine.appendSwitch('mute-audio');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qa={results:[],mode:'consolidate',contexts:[]};
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
const models={codex:[{id:'gpt-fixture',label:'Fixture GPT',isDefault:true,supportsImages:true,efforts:[{id:'high',label:'High'}]}]};
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,checking:false,detail:'Synthetic subscription'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.subscriptionModels=async()=>models;ProviderManager.prototype.modelsFor=async id=>models[id]||[];ProviderManager.prototype.codexUsage=async()=>({rateLimits:{primary:{usedPercent:20,windowDurationMins:300}}});
ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused')};ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};
ProviderManager.prototype.run=async function(request){
 if(request.conversationId!=='soul-qa')throw Error('Unexpected model request');qa.contexts.push(request.prompt);
 const args=qa.mode==='consolidate'?{action:'consolidate',ids:['t0','t1'],evidence:'The first two observations overlap.',traits:[{text:'Synthetic preferences zero and one, retaining both.',evidence:'Both original user requests.',source:'stated'}]}:qa.mode.startsWith('stated')?{action:'add',source:'stated',text:'Verified synthetic request.',evidence:'Direct user statement.',quote:qa.mode==='stated-good'?'Exercise synthetic soul learning.':'A completely invented quote.'}:{action:'add',text:'Another synthetic observation.',evidence:'Synthetic user interaction.'};
 const result=await this.callTool('soul_reflect',args,request.conversationId);qa.results.push(result);return{text:result.isError?'Learning refused.':'Learning fixture complete.'};
};await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={scope:'Real host and compiled Settings, synthetic encrypted storage/model fixture. No personal account access or network. Semantic quality of live consolidation is not tested.',runtime,checks:{},errors:[]};let app;
async function until(read,accept,label){const end=Date.now()+15000;let value;do{value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,80));}while(Date.now()<end);throw Error(label+': '+JSON.stringify(value).slice(0,1000));}
try{
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
 const state=await until(()=>invoke('bootstrap'),s=>s.connections.some(i=>i.id==='codex'&&i.connected)&&s.providerModels.codex?.length,'Startup');
 assert.equal(state.settings.personalization.soul.traits.length,40);assert.equal(state.tools.find(t=>t.name==='soul_reflect').enabled,true);report.checks.moreThan24SurviveRealStorageAndDesktopOff=true;
 async function run(){const count=await app.evaluate(()=>qa.results.length);await invoke('chat.send',{conversationId:'soul-qa',provider:'codex',model:'gpt-fixture',effort:'high',mode:'tools',text:'Exercise synthetic soul learning.'});await until(()=>app.evaluate(()=>qa.results.length),n=>n===count+1,'Tool result');await until(()=>invoke('bootstrap'),s=>!s.activeRuns.length,'Turn end');return app.evaluate(()=>qa.results.at(-1));}
 let result=await run();assert.ok(!result.isError,JSON.stringify(result));let current=await invoke('bootstrap');assert.equal(current.approvals.length,0);assert.equal(current.settings.personalization.soul.traits.length,39);assert.equal(current.settings.personalization.soul.traits[0].source,'stated');report.checks.askModeConsolidationHasNoApprovalAndRetainsSources=true;
 await invoke('settings.save',{permissionRules:[{id:'deny-soul',tool:'soul_reflect',match:'add',effect:'deny'}]});await app.evaluate(()=>{qa.mode='add'});result=await run();assert.equal(result.isError,true);assert.match(JSON.stringify(result),/Blocked by your rule/);assert.equal((await invoke('bootstrap')).settings.personalization.soul.traits.length,39);report.checks.explicitDenyRuleWins=true;
 await invoke('settings.save',{permissionRules:[],personalization:{...state.settings.personalization,tone:'formal'}});assert.equal((await invoke('bootstrap')).settings.personalization.soul.traits.length,39);report.checks.staleGeneralSettingsCannotOverwriteSoul=true;
 await app.evaluate(()=>{qa.mode='stated-bad'});result=await run();assert.equal(result.isError,true);assert.match(JSON.stringify(result),/actual user message/);assert.equal((await invoke('bootstrap')).settings.personalization.soul.traits.length,39);
 await app.evaluate(()=>{qa.mode='stated-good'});result=await run();assert.ok(!result.isError,JSON.stringify(result));let evidenceSoul=(await invoke('bootstrap')).settings.personalization.soul;const verified=evidenceSoul.traits.find(t=>t.text==='Verified synthetic request.');assert.equal(verified.quote,'Exercise synthetic soul learning.');await invoke('soul.change',{action:'harddelete',id:verified.id});assert.equal((await invoke('bootstrap')).settings.personalization.soul.traits.length,39);report.checks.hostVerifiesDirectQuotesAndSettingsPurgeWorks=true;
 await page.keyboard.press('Control+,');await page.getByRole('navigation',{name:'Settings categories'}).getByRole('button',{name:'Conversation',exact:true}).click();const panel=page.locator('#settings-personalization');
 await panel.getByText(/characters used\./).waitFor();await panel.getByText('Edit observation',{exact:true}).first().click();const editor=panel.getByRole('textbox',{name:'Observation',exact:true}).first();await editor.fill('User edited this observation.');await editor.press('Tab');
 await until(()=>invoke('bootstrap'),s=>s.settings.personalization.soul.traits[0].text==='User edited this observation.','Edit from Settings');await panel.getByText('Recent changes and recovery',{exact:true}).click();
 await panel.getByRole('button',{name:'Roll back to before this change',exact:true}).first().click();await until(()=>invoke('bootstrap'),s=>s.settings.personalization.soul.traits[0].text==='Synthetic preferences zero and one, retaining both.','Restore');
 await panel.locator('strong').filter({hasText:'Synthetic preferences zero and one, retaining both.'}).waitFor();report.checks.compiledSettingsEditAndRecoveryWork=true;
 const soul=(await invoke('bootstrap')).settings.personalization.soul;assert.ok(soul.traits[0].evidenceLog.some(e=>e.evidence==='User request 0.'));assert.ok(soul.traits[0].evidenceLog.some(e=>e.evidence==='User request 1.'));
 await panel.getByRole('button',{name:'Forget: Synthetic durable preference 39.',exact:true}).click();const forgotten=(await until(()=>invoke('bootstrap'),s=>s.settings.personalization.soul.traits.length===38,'Permanent deletion')).settings.personalization.soul;assert.equal(JSON.stringify(forgotten).includes('Synthetic durable preference 39.'),false);assert.equal(JSON.stringify(forgotten).includes('User request 39.'),false);report.checks.forgetPurgesRecoveryCopies=true;
 await page.setViewportSize({width:760,height:1000});await page.screenshot({path:path.join(output,'soul-settings.png')});assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(app)await(await app.firstWindow()).screenshot({path:path.join(output,'failure.png')});}
finally{await app?.close();}
if(report.passed){const saved=new Store(profile,{workspace});await saved.init();assert.equal(saved.state.settings.personalization.soul.traits.length,38);assert.equal(JSON.stringify(saved.state.settings.personalization.soul).includes('User request 39.'),false);report.checks.encryptedPersistenceRetainsEvidenceAndPurge=true;}
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report},null,2));
