// Production host and renderer with synthetic providers/browser; network blocked.
import {_electron as electron} from 'playwright';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {MemoryStore} from '../desktop/memory.mjs';
const root=process.cwd(),runtimeRoot=process.argv.includes('--packaged')?path.join(process.env.EXOMINA_QA_PACKAGE_DIR||path.join(root,'release/win-unpacked'),'resources/app.asar'):root,{output,profile}=await createProtectedQaProfile('notes-five'),workspace=path.join(profile,'workspace');await mkdir(workspace);
const seed=new Store(profile,{workspace});await seed.init();Object.assign(seed.state.settings,{autoUpdate:false,quickAccess:false,autoTitle:false,browserEnabled:true,chatMemorySummaries:false,permissionMode:'ask',personalization:{instructions:'PRIVATE_STYLE_SENTINEL'},appearance:{motion:'reduced'}});await seed.save();
const memory=new MemoryStore(profile);await memory.note('PRIVATE_MEMORY_SENTINEL prefers unrelated private research.');await memory.note('Phoenix export verified; restore remains unverified.');await memory.note('Phoenix bird mythology sketch.');memory.close();
const url=file=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session}=require('electron');(async()=>{
app.commandLine.appendSwitch('mute-audio');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qa={requests:[],browser:[],blocked:[],pages:new Map(),waiters:new Map(),slow:false,extraCalls:false,forceTimeout:false};
const nativeTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,delay,...args)=>nativeTimeout(fn,qa.forceTimeout&&delay===120000?40:delay,...args);
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${url('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${url('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,checking:false,detail:'Synthetic subscription'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];
ProviderManager.prototype.codexUsage=async()=>({rateLimits:{primary:{usedPercent:10,windowDurationMins:300}}});ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused')};ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};
ProviderManager.prototype.run=async function(request){
qa.requests.push({prompt:request.prompt,context:request.developerInstructions,tools:request.toolDefinitions?.map(t=>t.name),hostToolsOnly:request.hostToolsOnly});
try{await this.callTool('workspace_write',{path:'unapproved.txt',text:'No'},request.conversationId)}catch(e){qa.blocked.push(e.message)}
await this.callTool('browser_open',{url:'https://example.org/primary'},request.conversationId);await this.callTool('browser_snapshot',{include_screenshot:false},request.conversationId);
if(qa.extraCalls)for(let n=0;n<7;n++)try{await this.callTool('browser_snapshot',{include_screenshot:false},request.conversationId)}catch(e){qa.blocked.push(e.message)}
if(qa.slow)await new Promise((resolve,reject)=>qa.waiters.set(request.conversationId,reject));
return {sessionId:'fixture',text:'A bounded fixture report. Source: https://example.org/primary. Findings are inconclusive.'};};
const cancel=ProviderManager.prototype.cancel;ProviderManager.prototype.cancel=function(id){qa.waiters.get(id)?.(Error('Stopped'));qa.waiters.delete(id);return cancel.call(this,id)};
const{BrowserChoice}=await import(${url('desktop/browser-choice.mjs')});const state=BrowserChoice.prototype.state;
BrowserChoice.prototype.state=function(id){return qa.pages.get(id)||state.call(this,id)};
BrowserChoice.prototype.call=async function(name,input,id){qa.browser.push({name,id});if(!this.current.isEnabled())throw Error('Browser tools are off');if(!await this.current.approve({title:'Read public source?',conversationId:id,detail:JSON.stringify(input)}))throw Error('Browser action declined');if(name==='browser_open'){qa.pages.set(id,{url:input.url,title:'Primary fixture'});return {content:[{type:'text',text:JSON.stringify(qa.pages.get(id))}]}}return {content:[{type:'text',text:JSON.stringify({...qa.pages.get(id),text:'A synthetic primary source with enough readable content to serve as browser evidence.',pageRead:{available:true}})}]};};
await import(${url('desktop/main.mjs')});})().catch(e=>{console.error(e);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:profile,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={passed:false,runtimeRoot,checks:{},errors:[],scope:'Production IPC and renderer, synthetic subscription and browser; external network and personal accounts unavailable. Time-limit check accelerates only the research timer.'};
let app,page;const until=async(read,accept)=>{const end=Date.now()+15000;let value;do{value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,60));}while(Date.now()<end);throw Error('State timeout: '+JSON.stringify(value));};
try{
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));
 const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();await until(()=>invoke('bootstrap'),s=>s.connections.some(c=>c.id==='codex'&&c.connected));
 if(!process.argv.includes('--rewrite-only')){
 await page.getByRole('button',{name:'Tools',exact:true}).click();await page.locator('.research-workspace>summary').click();
 const panel=page.getByRole('region',{name:'Research workspace',exact:true});await panel.waitFor();assert.equal(await app.evaluate(()=>qa.requests.length),0);
 await panel.getByRole('textbox',{name:'Research question',exact:true}).fill('What evidence supports this public claim?');await panel.getByRole('combobox',{name:'Research budget',exact:true}).selectOption('brief');
 await panel.getByRole('button',{name:'Start research',exact:true}).click();let view=await until(()=>invoke('research.view'),v=>v.runs[0]?.status==='complete');
 assert.deepEqual(view.runs[0].sources,['https://example.org/primary']);const request=await app.evaluate(()=>qa.requests[0]);assert.deepEqual(request.tools.sort(),['browser_inspect','browser_open','browser_snapshot']);assert.equal(request.hostToolsOnly,true);
 for(const sentinel of ['PRIVATE_MEMORY_SENTINEL','PRIVATE_STYLE_SENTINEL'])assert.equal(JSON.stringify(request).includes(sentinel),false);assert.equal(await app.evaluate(()=>qa.blocked.length),1);report.checks.researchUiScopeEvidenceAndPrivateContext=true;
 await app.evaluate(()=>{qa.extraCalls=true;qa.browser=[]});await invoke('research.start',{topic:'Budget test',provider:'codex',budget:'brief'});await until(()=>invoke('research.view'),v=>v.runs[0]?.status!=='running');assert.equal(await app.evaluate(()=>qa.browser.length),8);assert.ok(await app.evaluate(()=>qa.blocked.some(x=>x.includes('browser limit'))));report.checks.hostBrowserCallBudget=true;
 await app.evaluate(()=>{qa.extraCalls=false;qa.slow=true});await invoke('research.start',{topic:'Stop test',provider:'codex',budget:'brief'});view=await until(()=>invoke('research.view'),v=>!!v.runs[0]?.conversationId);await invoke('research.stop',{id:view.runs[0].id});await until(()=>invoke('bootstrap'),s=>!s.activeRuns.length);assert.equal((await invoke('research.view')).runs[0].status,'stopped');report.checks.stopCancelsActiveProvider=true;
 await app.evaluate(()=>{qa.forceTimeout=true});await invoke('research.start',{topic:'Time test',provider:'codex',budget:'brief'});view=await until(()=>invoke('research.view'),v=>v.runs[0]?.status==='limited');assert.match(view.runs[0].error,/Time budget reached/);report.checks.hostTimeBudget=true;
 await app.evaluate(()=>{qa.slow=false;qa.forceTimeout=false});await invoke('settings.save',{browserEnabled:false});const count=await app.evaluate(()=>qa.requests.length);await assert.rejects(invoke('research.start',{topic:'Browser off',provider:'codex',budget:'brief'}),/Browser tools are off/);assert.equal(await app.evaluate(()=>qa.requests.length),count);report.checks.browserOffSendsNothing=true;
 await invoke('settings.save',{browserEnabled:true,permissionRules:[{id:'deny-source',tool:'browser_open',match:'',effect:'deny'}]});await invoke('research.start',{topic:'Denied test',provider:'codex',budget:'brief'});view=await until(()=>invoke('research.view'),v=>v.runs[0]?.status==='failed');const chat=await invoke('conversations.get',{id:view.runs[0].conversationId});assert.ok(JSON.stringify(chat).includes('Blocked by your rule'));report.checks.explicitDenyRuleWins=true;await invoke('settings.save',{permissionRules:[]});
 await page.getByRole('combobox',{name:'Discovery focus',exact:true}).selectOption('tools');await page.getByRole('button',{name:'Save preferences',exact:true}).click();assert.equal((await invoke('discoveries.view')).settings.focus,'tools');assert.equal(await app.evaluate(()=>qa.requests.length),count+1);report.checks.discoveryFocusSavesWithoutInference=true;
 const matches=await invoke('memory.search',{query:'Phoenix restore'});assert.match(matches[0].text,/export verified/);assert.deepEqual(matches[0].match.terms,['phoenix','restore']);report.checks.rankedMemoryHostSearch=true;
 await page.screenshot({path:path.join(output,'research.png')});await invoke('conversations.delete',{id:view.runs[0].conversationId,deleteMemories:false});assert.equal((await invoke('research.view')).runs.some(r=>r.conversationId===view.runs[0].conversationId),false);report.checks.researchChatDeletionRemovesRun=true;
 }
 if(process.argv.includes('--rewrite-only')){
  await app.evaluate(()=>{qa.slow=true});await invoke('research.start',{topic:'Revocation test',provider:'codex',budget:'brief'});await until(()=>invoke('research.view'),v=>!!v.runs[0]?.conversationId);await invoke('settings.save',{browserEnabled:false});await until(()=>invoke('research.view'),v=>v.runs[0]?.status==='stopped'&&!v.busy);assert.equal((await invoke('bootstrap')).activeRuns.length,0);report.checks.turningBrowserOffCancelsResearch=true;await app.evaluate(()=>{qa.slow=false});await invoke('settings.save',{browserEnabled:true});
 }
 const countBeforeRewrite=await app.evaluate(()=>qa.requests.length);
 await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption('standard');await page.getByRole('button',{name:'Exomina home',exact:true}).click();await page.getByRole('button',{name:'A text',exact:true}).click();
 await page.getByRole('textbox',{name:'Task material and context',exact:true}).fill('The original voice should survive.');await page.getByRole('combobox',{name:'Text task',exact:true}).selectOption('rewrite');await page.getByRole('textbox',{name:'Rewrite voice reference',exact:true}).fill('STYLE_ONLY_EXAMPLE');await page.getByRole('combobox',{name:'Rewrite freedom',exact:true}).selectOption('full');await page.getByRole('button',{name:'Review task request',exact:true}).click();
 const draft=await page.getByRole('textbox',{name:'Message',exact:true}).inputValue();assert.match(draft,/restructure and rewrite freely/);assert.match(draft,/STYLE_ONLY_EXAMPLE/);assert.match(draft,/style only/);const countAfter=await app.evaluate(()=>qa.requests.length);assert.equal(countAfter,countBeforeRewrite);report.checks.manualRewriteOnlyDraftsForReview=true;
 await page.getByRole('button',{name:'Edit setup',exact:true}).click();assert.equal(await page.getByRole('combobox',{name:'Rewrite freedom',exact:true}).inputValue(),'full');assert.equal(await page.getByRole('textbox',{name:'Rewrite voice reference',exact:true}).inputValue(),'STYLE_ONLY_EXAMPLE');report.checks.rewriteSetupSurvivesReview=true;
 await page.setViewportSize({width:560,height:820});assert.equal(await page.locator('.task-start').evaluate(e=>e.scrollWidth>e.clientWidth+1),false);report.checks.narrowRewriteLayout=true;await page.screenshot({path:path.join(output,'rewrite.png')});
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{await app?.close();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report},null,2));}
