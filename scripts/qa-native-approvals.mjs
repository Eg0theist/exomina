import {_electron as electron} from 'playwright';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {extractFile} from '@electron/asar';

// This launches Source's Electron through an isolated, permanently hidden
// launcher. Importing a packaged app.asar verifies its actual host/renderer;
// the packaged EXE is never launched. Native approval requests are synthetic,
// while ProviderManager.codexRequest, main's policy and ApprovalCard are real.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root);
const fixture=await createProtectedQaProfile('native-approvals'),{profile,output}=fixture;
const workspace=path.join(output,'workspace');await mkdir(workspace);
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{workspace,autoTitle:false,autoUpdate:false,closeToTray:false,memoryEnabled:false,chatMemorySummaries:false,browserEnabled:false,desktopEnabled:false,permissionMode:'full',permissionRules:[],routing:'tools'});
const chat=store.create('codex');chat.title='Native approval QA';chat.titleSource='manual';await store.save();
const expectedVersion=JSON.parse(runtimeRoot.endsWith('.asar')?extractFile(runtimeRoot,'package.json'):await readFile(path.join(runtimeRoot,'package.json'),'utf8')).version;
const moduleUrl=name=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,name)).href);
const launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const {app,BrowserWindow,session,dialog}=require('electron');
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile,'browser-data'))});
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};
app.commandLine.appendSwitch('mute-audio');dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};app.getVersion=()=>${JSON.stringify(expectedVersion)};
globalThis.qaApprovals={calls:[],results:{},providerRequests:0,sequence:0};
(async()=>{await app.whenReady();for(const partition of [session.defaultSession,session.fromPartition('persist:exomina-browser')])partition.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
const {ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const {PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,installed:true,connected:item.id==='codex',available:true,checking:false,detail:'Synthetic QA connection.'}));for(const row of rows)onStatus?.(row);return rows};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.getCodex=async()=>{throw Error('Native account/runtime access prohibited in native approval QA')};
ProviderManager.prototype.run=async function(request){const qa=globalThis.qaApprovals;const label=request.prompt.split('Current user request:\\n').at(-1).trim();
 const seq=++qa.sequence,state={provider:'codex',conversationId:request.conversationId,sessionId:'synthetic-thread-'+seq,turnId:'synthetic-turn-'+seq,codexPermissionsVerified:true,cancelled:false,turnEnded:false,items:new Map(),toolDefinitions:[],reject:()=>{}};
 qa.calls.push(label);qa.manager=this;qa.state=state;this.active.set(request.conversationId,state);
 const parameters={threadId:state.sessionId,turnId:state.turnId,itemId:'synthetic-item-'+seq,command:'Write-Output \\"native-approval-marker\\"',cwd:${JSON.stringify(workspace)},reason:'Synthetic native runtime confirmation; this command will never execute.'};
 if(label.startsWith('file')){delete parameters.command;state.items.set(parameters.itemId,{changes:[{path:'synthetic-file.txt',diff:'+ synthetic file preview'}]});}
 if(label.startsWith('additional')){delete parameters.command;parameters.permissions={fileSystem:{write:[${JSON.stringify(workspace)}]}};}
 if(label==='once-only')parameters.availableDecisions=['accept','decline'];
 if(label==='unsupported-choice')parameters.availableDecisions=[{acceptWithExecpolicyAmendment:{execpolicy_amendment:['synthetic-tool']}}];
 if(label==='stale-before'){parameters.turnId='previous-turn';}
 if(label==='ended-before'){state.turnEnded=true;}
 try{
  let result;
  if(label==='host-command')result=JSON.parse((await this.callTool('workspace_shell',{command:'Write-Output "host-approval-marker"',timeoutSeconds:10},request.conversationId)).content[0].text);
  else {qa.providerRequests++;result=await this.codexRequest(label.startsWith('file')?'item/fileChange/requestApproval':label.startsWith('additional')?'item/permissions/requestApproval':'item/commandExecution/requestApproval',parameters);}
  qa.results[label]={value:result};
 }catch(error){qa.results[label]={error:error.message};}
 finally{if(this.active.get(request.conversationId)===state)this.active.delete(request.conversationId);}
 return {text:'Completed synthetic '+label,sessionId:state.sessionId};
};
await import(${moduleUrl('desktop/main.mjs')});
})().catch(error=>{console.error(error);app.exit(1)});`);
const env={...process.env,EXOMINA_DATA_DIR:profile,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key))delete env[key];
let app,page;
const report={runtimeRoot,output,scope:'Actual production native request handler, host permission routing and ApprovalCard in an encrypted synthetic profile. No personal profiles, native model processes, deletion or visible GUI.',checks:{},errors:[]};
const reportDir=path.resolve(process.env.EXOMINA_QA_REPORT_DIR||path.resolve(root,'../Workspace/native-approval-verification'));await mkdir(reportDir,{recursive:true});
async function invoke(method,payload={}){return page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});}
async function settings(mode,rules=[]){await invoke('settings.save',{permissionMode:mode,permissionRules:rules});}
async function send(label){await invoke('chat.send',{conversationId:chat.id,provider:'codex',text:label,mode:'tools'});}
async function result(label){
 const deadline=Date.now()+15000;let value;
 while(Date.now()<deadline){value=await app.evaluate((_electron,label)=>globalThis.qaApprovals.results[label],label);if(value)break;await new Promise(resolve=>setTimeout(resolve,25));}
 assert.ok(value,`The synthetic provider did not complete ${label}. Calls: ${JSON.stringify(await app.evaluate(()=>globalThis.qaApprovals.calls))}`);
 await page.waitForFunction(()=>window.studio.invoke('bootstrap').then(data=>data.activeRuns.length===0));await card().waitFor({state:'hidden'});return value;
}
async function savedGrants(){return {chat:await invoke('permissions.chat',{conversationId:chat.id}),rules:(await invoke('bootstrap')).settings.permissionRules};}
const card=()=>page.locator('.approval-card');
async function confirm(label,decision,{session=true,mode='full',rules=[],expected='accept'}={}){
 await settings(mode,rules);const grantsBefore=await savedGrants();await send(label);await card().waitFor();
 const pending=(await invoke('bootstrap')).approvals[0];assert.equal(pending.suggestion,null);assert.equal(pending.allowSession,session);assert.equal(pending.mode,mode);
 assert.equal(await card().getByRole('button',{name:'Always allow',exact:false}).count(),0);assert.equal(await card().getByRole('button',{name:'Allow for this chat',exact:true}).count(),0);
 assert.equal(await card().getByRole('button',{name:'Allow for this session',exact:true}).count(),session?1:0);
 assert.equal(await app.evaluate((_electron,label)=>globalThis.qaApprovals.results[label],label),undefined);
 if(label==='full-deny')await card().screenshot({path:path.join(reportDir,runtimeRoot===root?'source-native-approval-card.png':'packaged-native-approval-card.png'),animations:'disabled'});
 if(decision==='once')await card().getByRole('button',{name:'Allow once',exact:true}).click();
 else if(decision==='chat')await card().getByRole('button',{name:'Allow for this session',exact:true}).click();
 else if(decision==='deny')await card().getByRole('button',{name:'Deny',exact:true}).click();
 else await invoke('approval.respond',{id:pending.id,decision,rule:{tool:'codex.command',match:''}});
 await card().waitFor({state:'hidden'});const actual=await result(label);
 assert.equal(actual.value.decision,expected);assert.deepEqual(await savedGrants(),grantsBefore);
 return pending;
}
try{
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.locator('.chat-open').filter({hasText:chat.title}).click();
 await confirm('full-deny','deny',{expected:'decline'});report.checks.fullNativeRequestShowsApprovalAndDenialDeclines=true;
 await confirm('full-once','once');report.checks.fullNativeOnceExplicitlyAccepts=true;
 await confirm('full-session','chat',{expected:'acceptForSession'});report.checks.fullNativeSessionMapsToNativeCacheWithoutHostGrant=true;
 await confirm('full-repeat','deny',{expected:'decline'});report.checks.sessionChoiceCreatesNoAutomaticHostGrant=true;
 await confirm('once-only','once',{session:false});report.checks.runtimeOnceOnlyChoiceDoesNotOfferSessionApproval=true;
 await send('unsupported-choice');assert.equal((await result('unsupported-choice')).value.decision,'decline');assert.equal(await card().count(),0);report.checks.unsupportedNativeChoiceDeclinedWithoutInventingPermission=true;
 const allowRule={id:'synthetic-allow',effect:'allow',tool:'codex.command',match:'',createdAt:'2026-10-10T00:00:00.000Z'};
 await confirm('allow-rule-once','once',{mode:'ask',rules:[allowRule]});assert.deepEqual((await savedGrants()).rules,[allowRule]);report.checks.savedAllowRuleStillRequiresNativeConfirmation=true;
 await confirm('forged-always','always',{expected:'decline'});assert.deepEqual((await savedGrants()).rules,[]);report.checks.nativeAlwaysCannotCreateSavedRule=true;
 await settings('full');await send('file-session');await card().waitFor();const filePending=(await invoke('bootstrap')).approvals[0];assert.match(filePending.detail,/synthetic-file.txt[\s\S]*synthetic file preview/);assert.equal(filePending.suggestion,null);assert.equal(filePending.allowSession,true);await card().getByRole('button',{name:'Allow for this session',exact:true}).click();assert.equal((await result('file-session')).value.decision,'acceptForSession');assert.deepEqual((await savedGrants()).chat.grants,[]);report.checks.filePreviewAndSessionDecisionPreserved=true;
 await settings('full');await send('additional-once');await card().waitFor();let pending=(await invoke('bootstrap')).approvals[0];assert.equal(pending.suggestion,null);assert.equal(Boolean(pending.allowSession),false);assert.equal(await card().getByRole('button',{name:'Allow for this session',exact:true}).count(),0);await card().getByRole('button',{name:'Allow once',exact:true}).click();let actual=await result('additional-once');assert.deepEqual(actual.value,{permissions:{fileSystem:{write:[workspace]}},scope:'turn'});report.checks.additionalAccessUsesOnlyExplicitTurnApproval=true;
 await send('additional-forged-session');await card().waitFor();pending=(await invoke('bootstrap')).approvals[0];await invoke('approval.respond',{id:pending.id,decision:'chat'});actual=await result('additional-forged-session');assert.deepEqual(actual.value,{permissions:{},scope:'turn'});report.checks.additionalAccessRejectsForgedSessionDecision=true;
 await settings('full',[{id:'synthetic-deny',effect:'deny',tool:'codex.command',match:'',createdAt:'2026-10-10T00:00:00.000Z'}]);await send('deny-rule');assert.equal((await result('deny-rule')).value.decision,'decline');assert.equal(await card().count(),0);report.checks.savedDenyRuleDeclinesWithoutCard=true;
 await settings('read-only');await send('read-only');assert.equal((await result('read-only')).value.decision,'decline');assert.equal(await card().count(),0);report.checks.readOnlyDoesNotOfferEscalation=true;
 await settings('full');await send('stale-before');actual=await result('stale-before');assert.ok(actual.error||actual.value?.decision==='decline');assert.equal(await card().count(),0);report.checks.previousTurnRequestDeniedBeforeApproval=true;
 await send('ended-before');actual=await result('ended-before');assert.ok(actual.error||actual.value?.decision==='decline');assert.equal(await card().count(),0);report.checks.endedTurnRequestDeniedBeforeApproval=true;
 await send('deny-rule-after');await card().waitFor();await settings('full',[{id:'synthetic-late-deny',effect:'deny',tool:'codex.command',match:'',createdAt:'2026-10-10T00:00:00.000Z'}]);await card().getByRole('button',{name:'Allow once',exact:true}).click();assert.equal((await result('deny-rule-after')).value.decision,'decline');report.checks.pendingApprovalRechecksNewDenyRule=true;
 await settings('full');await send('read-only-after');await card().waitFor();await settings('read-only');await card().getByRole('button',{name:'Allow once',exact:true}).click();assert.equal((await result('read-only-after')).value.decision,'decline');report.checks.pendingApprovalRechecksReadOnlyMode=true;
 await settings('full');await send('ended-after');await card().waitFor();await app.evaluate(()=>globalThis.qaApprovals.state.turnEnded=true);await card().getByRole('button',{name:'Allow once',exact:true}).click();assert.equal((await result('ended-after')).value.decision,'decline');report.checks.pendingApprovalCannotApproveEndedTurn=true;
 await send('stale-after');await card().waitFor();await app.evaluate(()=>globalThis.qaApprovals.state.turnId='changed-turn');await card().getByRole('button',{name:'Allow once',exact:true}).click();assert.equal((await result('stale-after')).value.decision,'decline');report.checks.pendingApprovalCannotApprovePreviousTurn=true;
 await send('stopped-run');await card().waitFor();await invoke('chat.cancel',{conversationId:chat.id});actual=await result('stopped-run');assert.equal(actual.value.decision,'decline');assert.equal(await card().count(),0);report.checks.stoppingRunDeclinesPendingNativeRequest=true;
 await send('host-command');actual=await result('host-command');assert.equal(actual.value.exitCode,0);assert.match(actual.value.output,/host-approval-marker/);assert.equal(await card().count(),0);report.checks.ordinaryFullHostCommandStillRunsAutomatically=true;
 const detached=await app.evaluate(async()=>{try{return await globalThis.qaApprovals.manager.codexRequest('item/commandExecution/requestApproval',{threadId:globalThis.qaApprovals.state.sessionId,turnId:globalThis.qaApprovals.state.turnId,itemId:'detached-item',command:'Write-Output detached-marker'});}catch(error){return {error:error.message};}});assert.match(detached.error,/No active conversation|denied/i);report.checks.completedRunCannotRequestApproval=true;
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(window=>window.isVisible())),false);report.checks.noVisibleAppWindow=true;
 assert.deepEqual(report.errors,[]);report.checks.noRendererErrors=true;report.passed=true;report.protection=await fixture.verify();
 await page.screenshot({path:path.join(reportDir,runtimeRoot===root?'source-native-approvals.png':'packaged-native-approvals.png')});
}catch(error){report.error=error.stack;if(page)await page.screenshot({path:path.join(reportDir,'native-approval-qa-failure.png')}).catch(()=>{});throw error;}
finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}await writeFile(path.join(reportDir,runtimeRoot===root?'source-native-approvals-qa.json':'packaged-native-approvals-qa.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
