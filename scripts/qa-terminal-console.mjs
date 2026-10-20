// Real source or packaged desktop host and production renderer in a fresh encrypted synthetic profile.
// PowerShell runs harmless commands only inside that profile. Provider activity
// is canned, sign-in is disabled and all external requests are blocked.
import {_electron as electron} from 'playwright';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {extractFile} from '@electron/asar';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packaged=process.argv.includes('--packaged');
const runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||(packaged?path.join(root,'release/win-unpacked/resources/app.asar'):root));
const archived=runtimeRoot.endsWith('.asar'),hostRoot=archived?runtimeRoot+'.unpacked':runtimeRoot;
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,file)).href);
const {Store}=await import(pathToFileURL(path.join(hostRoot,'desktop/store.mjs')).href);
const {RunActivity}=await import(pathToFileURL(path.join(hostRoot,'desktop/activity.mjs')).href);
const artifactBytes=file=>archived?extractFile(runtimeRoot,path.normalize(file)):readFile(path.join(runtimeRoot,file));
const artifact={runtimeRoot,hostRoot,version:JSON.parse(await artifactBytes('package.json')).version,files:{}};
for(const file of ['desktop/main.mjs','desktop/terminal-sessions.mjs','desktop/terminal-approval.mjs','desktop/agent-commands.mjs','desktop/workspace-tools.mjs','desktop/providers.mjs','desktop/store.mjs','desktop/activity.mjs','dist/index.html']){
  const bytes=await artifactBytes(file);if(archived)assert.ok(bytes.equals(await readFile(path.join(root,file))),'Packaged file must match Source: '+file);
  artifact.files[file]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
const html=(await artifactBytes('dist/index.html')).toString('utf8'),entry=/<script\b[^>]*src="\.\/([^" ]+\.js)"[^>]*><\/script>/.exec(html);assert.ok(entry,'Production renderer entry is present');
const rendererFile=path.join('dist',entry[1]),rendererBytes=await artifactBytes(rendererFile);
if(archived)assert.ok(rendererBytes.equals(await readFile(path.join(root,rendererFile))),'Packaged renderer matches current production build');
artifact.entry=entry[1];artifact.files['dist/'+entry[1]]={bytes:rendererBytes.length,sha256:createHash('sha256').update(rendererBytes).digest('hex')};
if(archived)artifact.build=JSON.parse(await readFile(path.join(path.dirname(runtimeRoot),'..','exomina.build.json'),'utf8'));
const {profile,output}=await createProtectedQaProfile(packaged?'terminal-console-package':'terminal-console');
const workspace=path.join(profile,'workspace'),project=path.join(workspace,'project'),otherProject=path.join(workspace,'other-project'),accounts=path.join(profile,'accounts');await mkdir(project,{recursive:true});await mkdir(otherProject);await mkdir(accounts);
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{workspace,provider:'codex',model:'fixture-model',autoTitle:false,autoUpdate:false,quickAccess:false,closeToTray:false,attentionNotifications:false,memoryEnabled:false,chatMemorySummaries:false,routing:'tools',permissionMode:'ask',browserEnabled:false,desktopEnabled:false,decisionLayer:{enabled:false},appearance:{theme:'ink-wash',motion:'reduced'}});
store.state.projects=[{id:'terminal-project',name:'Terminal project',folder:project,instructions:'',files:[]},{id:'terminal-other-project',name:'Other terminal project',folder:otherProject,instructions:'',files:[]}];
const chat=store.create('codex');Object.assign(chat,{title:'Terminal console QA',titleSource:'manual',projectId:'terminal-project',permissionMode:'read-only'});
const saved={id:'saved-agent',role:'assistant',provider:'codex',content:''},activity=new RunActivity(saved,{conversationId:chat.id,emit:()=>{}});
activity.tool({id:'saved-command',name:'commandExecution',input:{command:'recorded-agent-command',cwd:project},status:'done',outcomeConfirmed:true,output:'AGENT_RECORDED_OUTPUT'});activity.finish('Saved agent work.');
chat.messages=[{id:'saved-user',role:'user',content:'Synthetic saved agent task.'},saved];await store.save();
const admissionCommand="Set-Content -LiteralPath 'admission-must-not-run.txt' -Value 'synthetic'",launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session,Notification}=require('electron');
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile,'browser-data'))});app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
app.getVersion=()=>${JSON.stringify(artifact.version)};
Notification.prototype.show=function(){};
globalThis.qaTerminal={requests:0,cancellations:[],reject:null,admissionReady:false,releaseAdmission:null,admittedWorkspace:null};
(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,detail:'Synthetic terminal QA connection'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.subscriptionModels=async()=>({codex:[{id:'fixture-model',label:'Fixture',isDefault:true,efforts:[]}]});ProviderManager.prototype.modelsFor=async()=>[{id:'fixture-model',label:'Fixture',isDefault:true,efforts:[]}];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused')};
ProviderManager.prototype.run=async function(request){qaTerminal.requests++;this.emit({type:'chat.tool',conversationId:request.conversationId,id:'live-agent',name:'commandExecution',input:{command:'synthetic-agent-running-command',cwd:request.workspace},status:'running'});this.emit({type:'chat.tool',conversationId:request.conversationId,id:'live-agent',status:'running',output:'AGENT_STREAM_OUTPUT'});return new Promise((_resolve,reject)=>qaTerminal.reject=reject)};
ProviderManager.prototype.cancel=function(id){qaTerminal.cancellations.push(id);qaTerminal.reject?.(Error('Stopped.'));qaTerminal.reject=null};
// Pause only the synthetic marker after canonical admission and before the real
// shell checks cwd. The fixture reassigns the project through ordinary host IPC.
const{WorkspaceTools}=await import(${moduleUrl('desktop/workspace-tools.mjs')});const originalShell=WorkspaceTools.prototype.shell;
WorkspaceTools.prototype.shell=async function(args,cid,options){if(args.command===${JSON.stringify(admissionCommand)}&&options?.expectedWorkspace){qaTerminal.admittedWorkspace=options.expectedWorkspace;qaTerminal.admissionReady=true;await new Promise(resolve=>qaTerminal.releaseAdmission=resolve);}return originalShell.call(this,args,cid,options)};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={scope:`Real ${archived?'packaged':'source'} host, policy, isolated PowerShell runner and production renderer. Fresh encrypted synthetic data; no provider accounts, native inference or external network.`,output,artifact,checks:{},errors:[]};let app,page,panel;
const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
async function until(read,accept,label){const end=Date.now()+15000;for(;;){const value=await read();if(accept(value))return value;if(Date.now()>end)throw Error(label+' timed out');await new Promise(resolve=>setTimeout(resolve,60));}}
async function open(){
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  app.process().stderr.on('data',chunk=>{report.hostLog=((report.hostLog||'')+String(chunk)).slice(-16000);});
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();await until(()=>invoke('bootstrap'),state=>state.connections.some(item=>item.id==='codex'&&item.connected),'Synthetic startup');
  await page.locator('[data-chat-id="'+chat.id+'"] .chat-open').click();await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption('advanced');await page.getByRole('button',{name:'Terminal',exact:true}).click();
  panel=page.getByRole('region',{name:'Terminal',exact:true});await panel.waitFor();
}
async function close(){if(!app)return;const current=app;app=null;await current.evaluate(({app})=>app.exit(0)).catch(()=>{});await current.close().catch(()=>{});}
try{
  await open();const rows=()=>invoke('terminal.list',{conversationId:chat.id});
  const row=id=>panel.locator('[data-terminal-id="'+id+'"]');
  const launchCommand=async command=>{await panel.getByRole('tab',{name:'Direct commands',exact:true}).click();await panel.getByRole('textbox',{name:'PowerShell command',exact:true}).fill(command);await panel.getByRole('button',{name:'Run command',exact:true}).click();return (await until(rows,state=>state.entries.some(entry=>entry.command===command),'Command entry')).entries.find(entry=>entry.command===command);};
  const blocked=await launchCommand("Set-Content -LiteralPath 'readonly-denied.txt' -Value 'synthetic'");await until(rows,state=>state.entries.find(entry=>entry.id===blocked.id)?.status==='denied','Read-only denial');
  assert.equal((await invoke('bootstrap')).approvals.length,0);await assert.rejects(readFile(path.join(project,'readonly-denied.txt')),{code:'ENOENT'});report.checks.readOnlyPermissionBlocksDirectCommandsWithoutApprovalBypass=true;
  await invoke('conversations.permission',{id:chat.id,mode:'ask'});
  const approved=await launchCommand("Write-Output 'CLI_UI_OK'; Write-Output (Get-Location).Path");const card=page.getByRole('alertdialog');await card.waitFor();assert.equal(await card.getByText(/Codex requires/).count(),0);await card.getByRole('button',{name:'Allow once',exact:true}).click();await until(rows,state=>state.entries.find(entry=>entry.id===approved.id)?.status==='complete','Approved command completion');
  await until(()=>row(approved.id).getByLabel('Command output',{exact:true}).textContent(),value=>value?.includes('CLI_UI_OK'),'Visible command output');assert.ok((await row(approved.id).getByLabel('Command output',{exact:true}).textContent()).includes(project));
  await row(approved.id).getByRole('status').filter({hasText:'Process exited · exit 0'}).waitFor();
  assert.equal((await invoke('conversations.get',{id:chat.id})).messages.length,2);assert.equal(await app.evaluate(()=>qaTerminal.requests),0);report.checks.idleChatAskApprovalRunsInItsProjectWithoutSendingTranscriptToAI=true;
  const stream=await launchCommand("Write-Output 'CLI_STREAM_READY'; Start-Sleep -Seconds 30; Write-Output 'CLI_SHOULD_NOT_RUN'");await card.getByRole('button',{name:'Allow once',exact:true}).click();await until(()=>row(stream.id).getByLabel('Command output',{exact:true}).textContent(),value=>value?.includes('CLI_STREAM_READY'),'Streamed output');await row(stream.id).getByRole('button',{name:'Stop command',exact:true}).click();await until(rows,state=>state.entries.find(entry=>entry.id===stream.id)?.status==='stopped','Direct stop');assert.doesNotMatch((await rows()).entries.find(entry=>entry.id===stream.id).output,/CLI_SHOULD_NOT_RUN/);report.checks.realCommandOutputStreamsAndStopTerminatesOwnedProcess=true;
  const pending=await launchCommand("Set-Content -LiteralPath 'late-approval.txt' -Value 'synthetic'");await card.waitFor();await row(pending.id).getByRole('button',{name:'Stop command',exact:true}).click();await card.waitFor({state:'hidden'});await until(rows,state=>state.entries.find(entry=>entry.id===pending.id)?.status==='stopped','Pending approval stop');await assert.rejects(readFile(path.join(project,'late-approval.txt')),{code:'ENOENT'});report.checks.stoppingPendingPermissionRemovesApprovalAndNeverLaunches=true;
  await invoke('conversations.permission',{id:chat.id,mode:'full'});await invoke('settings.save',{permissionRules:[{id:'terminal-deny-rule',tool:'workspace_shell',effect:'deny',match:"Write-Output 'DENY_RULE'"}]});const denied=await launchCommand("Write-Output 'DENY_RULE'");await until(rows,state=>state.entries.find(entry=>entry.id===denied.id)?.status==='denied','Explicit deny');assert.equal((await invoke('bootstrap')).approvals.length,0);report.checks.explicitDenyRuleStillWinsWithFullAccess=true;
  await invoke('conversations.permission',{id:chat.id,mode:'ask'});const admission=await launchCommand(admissionCommand);
  await until(()=>app.evaluate(()=>qaTerminal.admissionReady),Boolean,'Canonical terminal admission');assert.equal(path.resolve(await app.evaluate(()=>qaTerminal.admittedWorkspace)).toLowerCase(),path.resolve(project).toLowerCase());
  await invoke('projects.assign',{id:chat.id,projectId:'terminal-other-project'});await app.evaluate(()=>qaTerminal.releaseAdmission());
  const retargeted=await until(rows,state=>state.entries.find(entry=>entry.id===admission.id)?.status==='error','Admission workspace change rejection'),rejected=retargeted.entries.find(entry=>entry.id===admission.id);
  assert.match(rejected.error,/workspace changed after this terminal command was submitted/i);assert.equal(rejected.startedAt,undefined);assert.equal((await invoke('bootstrap')).approvals.length,0);
  for(const folder of [project,otherProject])await assert.rejects(readFile(path.join(folder,'admission-must-not-run.txt')),{code:'ENOENT'});
  await invoke('projects.assign',{id:chat.id,projectId:'terminal-project'});report.checks.canonicalAdmissionSnapshotRejectsProjectReassignmentBeforeApprovalOrProcess=true;
  await panel.getByRole('tab',{name:/^Agent commands/}).click();await panel.getByText('recorded-agent-command',{exact:true}).waitFor();await panel.getByText('AGENT_RECORDED_OUTPUT',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'Stop command',exact:true}).count(),0);
  await invoke('chat.send',{conversationId:chat.id,provider:'codex',model:'fixture-model',text:'Synthetic agent command visibility.',mode:'tools'});await panel.getByText('AGENT_STREAM_OUTPUT',{exact:true}).waitFor();await panel.getByRole('button',{name:'Stop agent task',exact:true}).click();await until(()=>invoke('bootstrap'),state=>!state.activeRuns.some(run=>run.conversationId===chat.id),'Agent cancellation');assert.ok(await app.evaluate((_electron,id)=>qaTerminal.cancellations.includes(id),chat.id));assert.equal(await app.evaluate(()=>qaTerminal.requests),1);report.checks.agentReportedCommandsVisibleAndControlStopsEntireTask=true;
  for(const width of [1280,760]){await page.setViewportSize({width,height:900});const geometry=await panel.evaluate(element=>{const box=element.getBoundingClientRect();return {left:box.left,right:box.right,width:innerWidth,overflow:element.scrollWidth>element.clientWidth+1};});assert.ok(geometry.left>=-1&&geometry.right<=geometry.width+1);assert.equal(geometry.overflow,false);await page.screenshot({path:path.join(output,'terminal-'+width+'.png')});}
  report.checks.consoleFitsWideAndNarrowLayouts=true;
  // Reuse the exact saved profile and recreate locators for the new page.
  await close();await open();assert.equal((await rows()).entries.length,0);await panel.getByText('No direct commands in this chat yet.',{exact:true}).waitFor();assert.equal(await app.evaluate(()=>qaTerminal.requests),0);
  await panel.getByRole('tab',{name:/^Agent commands/}).click();await panel.getByText('AGENT_RECORDED_OUTPUT',{exact:true}).waitFor();report.checks.directTranscriptsDisappearAcrossRestartWhileAgentHistoryRemains=true;
  assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{await close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report,null,2));}
