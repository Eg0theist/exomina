// Finish only the remaining agent/control/layout checks against an existing
// synthetic terminal QA profile. Preserve the original direct-command results.
import {_electron as electron} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

assert.ok(process.argv[2],'Pass the existing synthetic terminal QA directory.');
const root=process.cwd(),output=path.resolve(process.argv[2]),priorFile=path.join(output,'result.json'),priorBytes=await readFile(priorFile),prior=JSON.parse(priorBytes);
assert.equal(path.resolve(prior.output),output);assert.equal(prior.checks.explicitDenyRuleStillWinsWithFullAccess,true);
const profile=path.join(output,'data'),workspace=path.join(profile,'workspace'),accounts=path.join(profile,'accounts');assert.match(await readFile(path.join(profile,'synthetic-profile.txt'),'utf8'),/Synthetic Exomina QA profile/);
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(root,file)).href),launcher=path.join(output,'agent-continuation-launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session,Notification}=require('electron');
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile,'browser-data'))});app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};Notification.prototype.show=function(){};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};globalThis.qaTerminal={requests:0,cancellations:[],reject:null};
(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,detail:'Synthetic terminal QA connection'}));rows.forEach(row=>onStatus?.(row));return rows};ProviderManager.prototype.subscriptionModels=async()=>({codex:[{id:'fixture-model',label:'Fixture',isDefault:true,efforts:[]}]});ProviderManager.prototype.modelsFor=async()=>[{id:'fixture-model',label:'Fixture',isDefault:true,efforts:[]}];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused')};
ProviderManager.prototype.run=async function(request){qaTerminal.requests++;this.emit({type:'chat.tool',conversationId:request.conversationId,id:'live-agent',name:'commandExecution',input:{command:'synthetic-agent-running-command',cwd:request.workspace},status:'running'});this.emit({type:'chat.tool',conversationId:request.conversationId,id:'live-agent',status:'running',output:'AGENT_STREAM_OUTPUT'});return new Promise((_resolve,reject)=>qaTerminal.reject=reject)};
ProviderManager.prototype.cancel=function(id){qaTerminal.cancellations.push(id);qaTerminal.reject?.(Error('Stopped.'));qaTerminal.reject=null};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={scope:'Remaining agent activity/control and layout checks only, reusing the exact synthetic profile. No direct command repeated or profile data reseeded. Corrected canned provider emits a start then a separate output update, as the real streaming path does.',output,originalReport:{path:priorFile,sha256:createHash('sha256').update(priorBytes).digest('hex'),completedChecks:Object.keys(prior.checks).filter(key=>prior.checks[key])},checks:{},errors:[]};let app,page;
const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
async function until(read,accept,label){const deadline=Date.now()+15000;for(;;){const value=await read();if(accept(value))return value;if(Date.now()>deadline)throw Error(label+' timed out');await new Promise(resolve=>setTimeout(resolve,60));}}
try{
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});app.process().stderr.on('data',chunk=>{report.hostLog=(report.hostLog||'')+String(chunk).slice(0,4000);});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  const state=await until(()=>invoke('bootstrap'),state=>state.connections.some(item=>item.id==='codex'&&item.connected),'Synthetic startup'),chat=state.conversations.find(chat=>chat.title==='Terminal console QA');assert.ok(chat);
  await page.locator('[data-chat-id="'+chat.id+'"] .chat-open').click();await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption('advanced');await page.getByRole('button',{name:'Terminal',exact:true}).click();const panel=page.getByRole('region',{name:'Terminal',exact:true});await panel.waitFor();
  assert.equal((await invoke('terminal.list',{conversationId:chat.id})).entries.length,0);assert.equal(await app.evaluate(()=>qaTerminal.requests),0);report.checks.directTranscriptsWereNotPersistedAcrossRestart=true;
  await panel.getByRole('tab',{name:/^Agent commands/}).click();await invoke('chat.send',{conversationId:chat.id,provider:'codex',model:'fixture-model',text:'Synthetic agent command continuation.',mode:'tools'});
  await panel.getByText('AGENT_STREAM_OUTPUT',{exact:true}).waitFor();await panel.getByRole('button',{name:'Stop agent task',exact:true}).click();await until(()=>invoke('bootstrap'),state=>!state.activeRuns.some(run=>run.conversationId===chat.id),'Agent cancellation');assert.ok(await app.evaluate((_electron,id)=>qaTerminal.cancellations.includes(id),chat.id));assert.equal(await app.evaluate(()=>qaTerminal.requests),1);report.checks.reportedAgentOutputAppearsAndStopCancelsEntireTask=true;
  for(const width of [1280,760]){await page.setViewportSize({width,height:900});const geometry=await panel.evaluate(element=>{const box=element.getBoundingClientRect();return {left:box.left,right:box.right,width:innerWidth,overflow:element.scrollWidth>element.clientWidth+1};});assert.ok(geometry.left>=-1&&geometry.right<=geometry.width+1);assert.equal(geometry.overflow,false);await page.screenshot({path:path.join(output,'agent-continuation-'+width+'.png')});}
  report.checks.consoleFits1280And760pxLayouts=true;assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(output,'agent-continuation-failure.png')}).catch(()=>{});}
finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}await writeFile(path.join(output,'agent-continuation-final-result.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report,null,2));}
