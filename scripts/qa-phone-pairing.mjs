// Real desktop dispatcher + real encrypted relay + sandboxed phone renderer.
// Fresh synthetic EFS profile only; all provider/network calls stay on loopback.
import { _electron as electron } from 'playwright';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { extractFile } from '@electron/asar';
import { AccountService } from '../cloud/accounts.mjs';
import { RelayService } from '../cloud/relay.mjs';
import { createAccountServer } from '../cloud/accounts-server.mjs';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';

const root=process.cwd(),runtime=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root);
const notebookTailOnly=process.argv.includes('--notebook-tail-only');
const version=JSON.parse(runtime.endsWith('.asar')?extractFile(runtime,'package.json'):await readFile(path.join(runtime,'package.json'),'utf8')).version;
const fixture=await createProtectedQaProfile('phone-pairing'),{output,profile}=fixture;
const workspace=path.join(profile,'workspace'),accountsDir=path.join(profile,'accounts');
await mkdir(workspace);await mkdir(accountsDir);
const accounts=new AccountService({secret:'synthetic-phone-qa-secret-0123456789',inviteOnly:true});
const relay=new RelayService({accounts}),server=createAccountServer(accounts,{relay,webRoot:path.join(root,'dist')});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
let mode='write',file='phone-proof.txt';
const provider=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  res.setHeader('content-type','text/event-stream');
  const body=JSON.parse(raw||'{}'),last=body.messages?.at(-1);
  const delta=last?.role==='user'?{tool_calls:[{index:0,id:'qa-call-'+Date.now(),type:'function',function:mode==='question'?{name:'ask_user_question',arguments:JSON.stringify({questions:[{question:'Pick a colour for this synthetic task.',options:['Blue','Red']}],require_answer:true,wait_seconds:60})}:{name:'workspace_write',arguments:JSON.stringify({path:file,text:'Written from a paired phone.'})}}]}:{content:mode==='question'?'Phone question answer received.':'Phone task completed.'};
  res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));const providerBase='http://127.0.0.1:'+provider.address().port+'/v1';
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{provider:'custom-api',autoTitle:false,autoUpdate:false,closeToTray:false,quickAccess:false,memoryEnabled:false,chatMemorySummaries:false,browserEnabled:false,desktopEnabled:false,permissionMode:'ask',routing:'tools'});
const sharedNote={id:'phone-shared-note',title:'Notebook source',text:'Verify the phone notebook.\nhttps://example.com/source',revision:1,allowAI:true,updatedAt:new Date().toISOString()};
const draftChat=store.create('custom-api');draftChat.title='Phone second chat';draftChat.messages=[{id:'second-history',role:'assistant',content:'Second chat history'}];
const historyChat=store.create('custom-api');historyChat.title='Phone history request';
historyChat.messages=[{id:'old-phone-question',role:'assistant',content:'An old question',questions:[{id:'old-phone-group',status:'open',requireAnswer:true,questions:[{id:'old-colour',question:'Which historical colour?',options:[{label:'Amber'},{label:'Violet'}]}]}]},...Array.from({length:80},(_,i)=>({id:'history-'+i,role:'assistant',content:'Recent history '+i}))];
historyChat.messages.at(-1).followups=[{id:'saved-followup',text:'Explain the earlier change',answer:'SAVED_FOLLOWUP_ANSWER',summary:'SAVED_FOLLOWUP_RESOLUTION',status:'answered',taskStatus:'handled'}];
store.state.scratchpad={notes:[sharedNote],jobs:[],handled:[],organization:{autoRefresh:false,applied:{id:'phone-overview',createdAt:new Date().toISOString(),overview:'An organized source for phone work.',sources:[{id:sharedNote.id,revision:1}],groups:[{title:'Phone workflow',summary:'Continue from the notebook.',items:[{id:'phone-idea',noteId:sharedNote.id,noteTitle:sharedNote.title,title:'Read and reuse notes',summary:'Verify the phone notebook.',quote:'Verify the phone notebook.',offset:0}]}]},proposal:null}};
await store.save();
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(runtime,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,[
  "const{app,BrowserWindow,dialog,session}=require('electron');(async()=>{",
  "app.commandLine.appendSwitch('mute-audio');app.getVersion=()=>"+JSON.stringify(version)+";BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};",
  "dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};",
  "await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)&&!details.url.startsWith("+JSON.stringify(base)+")&&!details.url.startsWith("+JSON.stringify(new URL('/',providerBase).href)+")}));",
  "const{ProviderManager}=await import("+moduleUrl('desktop/providers.mjs')+");const{PROVIDER_CATALOG}=await import("+moduleUrl('desktop/provider-catalog.mjs')+");",
  "ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:false,installed:true,available:true,checking:false,detail:'Synthetic status'}));rows.forEach(row=>onStatus?.(row));return rows};",
  "ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;",
  "ProviderManager.prototype.connect=async()=>{throw Error('Native sign-in prohibited')};ProviderManager.prototype.getCodex=async()=>{throw Error('Native account access prohibited')};ProviderManager.prototype.run=async()=>{throw Error('Native inference prohibited')};",
  "const{ApiAgent}=await import("+moduleUrl('desktop/api-agent.mjs')+");const run=ApiAgent.prototype.run;ApiAgent.prototype.run=function(request){if(request.provider!=='custom-api')throw Error('Unexpected model request');return run.call(this,request)};",
  "await import("+moduleUrl('desktop/main.mjs')+");})().catch(error=>{console.error(error);app.exit(1)});"
].join('\n'),'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accountsDir,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={version,runtime,scope:'Production desktop host + safeStorage + real HTTP encrypted relay, sandboxed phone at 390px; synthetic provider and fresh EFS profile only.',notebookTailOnly,checks:{},errors:[]};
let app,desktop,phone;
async function until(read,accept=Boolean){const end=Date.now()+20000;do{const value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,70));}while(Date.now()<end);throw Error('Expected QA state did not arrive.');}
try{
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});desktop=await app.firstWindow();desktop.setDefaultTimeout(20000);desktop.on('pageerror',error=>report.errors.push(error.message));
  const invoke=(method,payload={})=>desktop.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
  await desktop.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  await invoke('provider.configure',{provider:'custom-api',baseUrl:providerBase,model:'phone-fixture',supportsTools:true,supportsImages:false,maxOutputTokens:2048});
  await desktop.keyboard.press('Control+,');await desktop.getByRole('navigation',{name:'Settings categories'}).getByRole('button',{name:'Connections & sync',exact:true}).click();
  await desktop.getByRole('button',{name:'Phone access',exact:true}).click();
  await desktop.getByLabel('Phone relay address',{exact:true}).fill(base);
  await desktop.getByLabel('Phone relay invitation',{exact:true}).fill(accounts.createInvite('synthetic-owner@example.com').code);
  await desktop.getByRole('button',{name:'Connect phone relay',exact:true}).click();
  const enabled=desktop.getByRole('switch',{name:'Allow phone control',exact:true});await enabled.waitFor();assert.equal(await enabled.isChecked(),false);
  await enabled.click();await until(()=>enabled.isChecked());await desktop.getByRole('button',{name:'Pair a phone',exact:true}).click();
  const pairingLink=await until(()=>invoke('remote.status'),status=>!!status.pairing).then(status=>status.pairing.link);
  const nextWindow=app.waitForEvent('window');
  await app.evaluate(({BrowserWindow},{url,origin})=>{
    const window=new BrowserWindow({show:false,width:390,height:844,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:'persist:synthetic-phone'}});
    window.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)&&!details.url.startsWith(origin+'/')}));
    window.loadURL(url);
  },{url:pairingLink,origin:base});
  phone=await nextWindow;phone.setDefaultTimeout(20000);phone.on('pageerror',error=>report.errors.push(error.message));await phone.setViewportSize({width:390,height:844});
  await phone.getByRole('heading',{name:'Pair with your computer',exact:true}).waitFor();assert.equal(await phone.evaluate(()=>location.hash),'');
  await phone.getByLabel('Phone name',{exact:true}).fill('Synthetic phone');await phone.getByRole('button',{name:'Pair this phone',exact:true}).click();
  await phone.getByRole('heading',{name:'Confirm on your computer',exact:true}).waitFor();
  const code=await phone.locator('.phone-confirmation').innerText();
  await until(()=>invoke('remote.refresh'),status=>status.pending.length===1);
  assert.equal((await invoke('remote.status')).pending[0].fingerprint,code);
  assert.equal(await desktop.getByRole('button',{name:'Approve phone',exact:true}).isEnabled(),false);
  await desktop.getByLabel('The code matches my phone',{exact:true}).check();await desktop.getByRole('button',{name:'Approve phone',exact:true}).click();
  await phone.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  await until(()=>phone.getByRole('status').innerText(),text=>text==='Computer connected');
  report.checks.qrFragmentAndMatchingConfirmation=true;
  let desktopNote;
  if(!notebookTailOnly){
  await phone.getByRole('button',{name:/^Work/}).click();
  await phone.getByRole('button',{name:'Open task: Phone history request',exact:true}).click();
  await phone.getByText('Which historical colour?',{exact:true}).waitFor();
  await phone.getByText('SAVED_FOLLOWUP_RESOLUTION',{exact:true}).waitFor();
  await phone.getByText('Earlier answer while work continued',{exact:true}).click();
  await phone.getByText('SAVED_FOLLOWUP_ANSWER',{exact:true}).waitFor();
  assert.equal(await phone.getByText('An old question',{exact:true}).count(),0);
  report.checks.workFindsOldQuestionAndSavedFollowup=true;
  await phone.getByRole('combobox',{name:'Conversation',exact:true}).selectOption('');
  assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await phone.getByRole('textbox',{name:'Message',exact:true}).fill('Write a synthetic proof file.');
  await phone.getByRole('button',{name:'Send message',exact:true}).click();
  await phone.locator('.phone-approval').waitFor();await assert.rejects(access(path.join(workspace,file)));
  assert.equal(await phone.getByRole('button',{name:/always/i}).count(),0);
  await phone.getByRole('button',{name:'Allow once',exact:true}).click();
  await until(()=>readFile(path.join(workspace,file),'utf8').catch(()=>''),text=>text==='Written from a paired phone.');
  await phone.getByText('Phone task completed.',{exact:true}).waitFor();
  await phone.screenshot({path:path.join(output,'phone-chat.png')});
  report.checks.actualDesktopToolApprovalAndFileWrite=true;
  const activeChat=await phone.getByRole('combobox',{name:'Conversation',exact:true}).inputValue();
  await phone.getByRole('textbox',{name:'Message',exact:true}).fill('FIRST_UNSENT_DRAFT');
  await phone.getByRole('combobox',{name:'Conversation',exact:true}).selectOption(draftChat.id);
  await phone.getByText('Second chat history',{exact:true}).waitFor();
  await phone.getByRole('textbox',{name:'Message',exact:true}).fill('SECOND_UNSENT_DRAFT');
  await phone.getByRole('combobox',{name:'Conversation',exact:true}).selectOption(activeChat);
  await until(()=>phone.getByRole('textbox',{name:'Message',exact:true}).inputValue(),text=>text==='FIRST_UNSENT_DRAFT');
  await phone.reload();await phone.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  await until(()=>phone.getByRole('combobox',{name:'Conversation',exact:true}).inputValue(),id=>id===activeChat);
  assert.equal(await phone.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'FIRST_UNSENT_DRAFT');
  await phone.getByText('Phone task completed.',{exact:true}).waitFor();report.checks.indexedDbKeysSurviveReload=true;
  report.checks.separateChatDraftsAndSelectionSurviveReload=true;
  let phoneOffline=true;
  await phone.route('**/v1/relay/**',route=>phoneOffline?route.abort():route.continue());
  const beforeReconnect=(await invoke('bootstrap')).conversations.map(chat=>[chat.id,chat.messages.length]);
  await phone.evaluate(()=>dispatchEvent(new Event('offline')));
  await until(()=>phone.locator('header [role=status]').innerText(),text=>text==='Computer not responding');
  assert.equal(await phone.getByRole('button',{name:'Send message',exact:true}).isDisabled(),true);
  phoneOffline=false;await phone.evaluate(()=>dispatchEvent(new Event('online')));
  await until(()=>phone.locator('header [role=status]').innerText(),text=>text==='Computer connected');
  assert.equal(await phone.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'FIRST_UNSENT_DRAFT');
  assert.deepEqual((await invoke('bootstrap')).conversations.map(chat=>[chat.id,chat.messages.length]),beforeReconnect);
  report.checks.reconnectRefreshesWithoutSendingDraft=true;
  file='phone-denied.txt';await phone.getByRole('textbox',{name:'Message',exact:true}).fill('Deny this synthetic write.');
  await phone.getByRole('button',{name:'Send message',exact:true}).click();await phone.locator('.phone-approval').waitFor();await phone.getByRole('button',{name:'Deny',exact:true}).click();
  await until(()=>invoke('bootstrap'),state=>state.activeRuns.length===0);await assert.rejects(access(path.join(workspace,file)));report.checks.denialPreventsRealWrite=true;
  mode='question';await phone.getByRole('textbox',{name:'Message',exact:true}).fill('Ask me the synthetic colour question.');
  await phone.getByRole('button',{name:'Send message',exact:true}).click();
  await phone.getByRole('radio',{name:'Blue',exact:true}).check();
  await phone.getByRole('combobox',{name:'Send during work',exact:true}).selectOption('queue');
  await phone.getByRole('textbox',{name:'Message',exact:true}).fill('QUEUED_PHONE_MESSAGE');
  await phone.getByRole('button',{name:'Send message',exact:true}).click();
  await phone.getByRole('region',{name:'Messages waiting for the reply',exact:true}).getByText('QUEUED_PHONE_MESSAGE',{exact:true}).waitFor();
  const queue=(await invoke('bootstrap')).queues[activeChat];assert.equal(queue.length,1);
  await phone.getByRole('button',{name:/^Work/}).click();
  await phone.getByText(/1 message queued/).waitFor();
  await phone.screenshot({path:path.join(output,'phone-work.png')});
  await phone.getByRole('button',{name:'Chats',exact:true}).click();
  assert.equal(await phone.getByRole('radio',{name:'Blue',exact:true}).isChecked(),true);
  await invoke('chat.unqueue',{conversationId:activeChat,id:queue[0].id});
  report.checks.queueAndQuestionSelectionSurviveWorkNavigation=true;
  await phone.getByRole('button',{name:'Send answer',exact:true}).click();
  await phone.getByText('Phone question answer received.',{exact:true}).waitFor();report.checks.realQuestionRoundTrip=true;
  await phone.getByRole('button',{name:'Notes',exact:true}).click();await phone.getByRole('button',{name:'Overview',exact:true}).click();await phone.getByRole('button',{name:/Phone workflow/}).click();
  await phone.getByRole('button',{name:/Notebook source.*open original note/}).click();await until(()=>phone.getByLabel('Note text',{exact:true}).inputValue(),text=>text===sharedNote.text);report.checks.phoneOverviewTopicsAndOriginalSourceJump=true;
  await phone.getByLabel('Note text',{exact:true}).fill('PHONE_UNSAVED_DRAFT');await phone.getByRole('button',{name:'Chats',exact:true}).click();await phone.getByRole('button',{name:'Notes',exact:true}).click();assert.equal(await phone.getByLabel('Note text',{exact:true}).inputValue(),'PHONE_UNSAVED_DRAFT');report.checks.phoneDraftSurvivesSectionChanges=true;
  desktopNote=(await invoke('notes.view')).notes.find(note=>note.id===sharedNote.id);await invoke('notes.save',{...desktopNote});await phone.getByRole('button',{name:'Refresh notebook',exact:true}).click();await until(()=>phone.getByRole('button',{name:'Refresh notebook',exact:true}).isEnabled());assert.equal(await phone.getByLabel('Note text',{exact:true}).inputValue(),'PHONE_UNSAVED_DRAFT');assert.equal(await phone.getByRole('button',{name:'Save note',exact:true}).isEnabled(),true);await phone.getByRole('button',{name:'Save note',exact:true}).click();await until(()=>invoke('notes.view'),view=>view.notes.some(note=>note.id===sharedNote.id&&note.text==='PHONE_UNSAVED_DRAFT'));report.checks.unchangedComputerContentRebasesPhoneDraft=true;
  await phone.getByLabel('Note text',{exact:true}).fill('PHONE_UNSAVED_DRAFT_AFTER_REBASE');desktopNote=(await invoke('notes.view')).notes.find(note=>note.id===sharedNote.id);await invoke('notes.save',{...desktopNote,text:'COMPUTER_CONCURRENT_VERSION'});await phone.getByRole('button',{name:'Refresh notebook',exact:true}).click();await phone.getByText('This note changed on your computer. Your phone draft is still here.',{exact:true}).waitFor();assert.equal(await phone.getByLabel('Note text',{exact:true}).inputValue(),'PHONE_UNSAVED_DRAFT_AFTER_REBASE');assert.equal(await phone.getByRole('button',{name:'Save note',exact:true}).isDisabled(),true);report.checks.concurrentDesktopEditPreservesPhoneDraftAndBlocksOverwrite=true;
  const chatsBefore=(await invoke('bootstrap')).conversations.map(chat=>[chat.id,chat.messages.length]);await phone.getByRole('button',{name:'Use in chat',exact:true}).click();assert.match(await phone.getByRole('textbox',{name:'Message',exact:true}).inputValue(),/PHONE_UNSAVED_DRAFT/);assert.deepEqual((await invoke('bootstrap')).conversations.map(chat=>[chat.id,chat.messages.length]),chatsBefore);report.checks.noteCanPrepareChatWithoutSending=true;
  await phone.getByRole('button',{name:'Notes',exact:true}).click();await phone.getByRole('button',{name:'Discard phone edits',exact:true}).click();await until(()=>phone.getByLabel('Note text',{exact:true}).inputValue(),text=>text==='COMPUTER_CONCURRENT_VERSION');await phone.getByLabel('Note text',{exact:true}).fill('RECONCILED_PHONE_VERSION');await phone.getByRole('button',{name:'Save note',exact:true}).click();await until(()=>invoke('notes.view'),view=>view.notes.some(note=>note.id===sharedNote.id&&note.text==='RECONCILED_PHONE_VERSION'&&note.allowAI===true));report.checks.reconciledPhoneSavePreservesExistingAISharing=true;
  desktopNote=(await invoke('notes.view')).notes.find(note=>note.id===sharedNote.id);await invoke('notes.save',{...desktopNote,text:'COMPUTER_CLEAN_REFRESH'});await until(()=>phone.getByLabel('Note text',{exact:true}).inputValue(),text=>text==='COMPUTER_CLEAN_REFRESH');report.checks.cleanPhoneNoteRefreshesFromDesktopEvents=true;
  }else{
    desktopNote=(await invoke('notes.view')).notes.find(note=>note.id===sharedNote.id);await invoke('notes.save',{...desktopNote,text:'COMPUTER_CLEAN_REFRESH'});
    await phone.getByRole('button',{name:'Notes',exact:true}).click();
  }
  await phone.getByRole('button',{name:'Overview',exact:true}).click();await phone.getByText('Your notes changed since this overview. Refresh organization on your computer.',{exact:true}).waitFor();report.checks.phoneOverviewExplainsStaleSources=true;
  desktopNote=(await invoke('notes.view')).notes.find(note=>note.id===sharedNote.id);await invoke('notes.save',{...desktopNote,allowAI:false});await phone.getByText('A source note was deleted, emptied or made private. Its previous organization was removed. Create a new proposal from currently shared notes.',{exact:true}).waitFor();assert.equal(await phone.getByRole('button',{name:/Phone workflow/}).count(),0);report.checks.overviewDisappearsAfterSourceSharingRevoked=true;
  await phone.screenshot({path:path.join(output,'phone-notebook.png')});assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await phone.getByRole('button',{name:'Your notes',exact:true}).click();await phone.getByRole('button',{name:'New note',exact:true}).click();
  await phone.getByLabel('Note title',{exact:true}).fill('Phone note');await phone.getByLabel('Note text',{exact:true}).fill('Saved from my phone.');
  await phone.getByRole('button',{name:'Save note',exact:true}).click();
  await until(()=>invoke('notes.view'),view=>view.notes.some(note=>note.text==='Saved from my phone.'&&note.allowAI===false));report.checks.notesSavePreservesAIGrant=true;
  await desktop.getByRole('combobox',{name:'Interface view',exact:true}).selectOption('standard');
  assert.equal(await desktop.getByRole('switch',{name:'Allow phone control',exact:true}).isVisible(),true);
  await desktop.getByRole('button',{name:'Remove phone',exact:true}).click();
  await until(()=>invoke('remote.status'),status=>status.phones.length===0);
  await phone.reload();await phone.getByRole('heading',{name:'Pair with your computer',exact:true}).waitFor();
  report.checks.removalAndStandardSettings=true;
  const saved=JSON.parse(await readFile(path.join(profile,'remote-connection.json'),'utf8'));
  assert.deepEqual(Object.keys(saved).sort(),['encrypted','version']);report.checks.realOsEncryptedConnection=true;
  await desktop.screenshot({path:path.join(output,'desktop-phone-settings.png')});
  assert.deepEqual(report.errors,[]);report.protection=await fixture.verify();report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;await desktop?.screenshot({path:path.join(output,'desktop-failure.png')}).catch(()=>{});await phone?.screenshot({path:path.join(output,'phone-failure.png')}).catch(()=>{});}
finally{await app?.close();relay.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));accounts.close();report.exitCodeBeforeFinalize=process.exitCode??0;process.exitCode=report.passed?0:1;await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report},null,2));}
