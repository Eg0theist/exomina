import test from 'node:test';
import assert from 'node:assert/strict';
import {AppInspection,APP_INSPECTION_TOOLS,inspectionValue,inspectionReadActions} from '../desktop/app-inspection.mjs';
import {PermissionPolicy,hostAction} from '../desktop/permissions.mjs';
import {FOLLOWUP_READ_TOOLS,readFollowupTool} from '../desktop/followup-tools.mjs';
import {LEAN_TOOLS} from '../desktop/routing.mjs';

const envelope=result=>JSON.parse(result.content[0].text);

test('settings exposes aggregate safety counters and the specific memory pause without private guard payloads', async () => {
  const f = fixture();
  f.inspector.getGuard = () => ({ limits: { background: { hour: 30, day: 150 } }, used: { codex: { background: { hour: 30, day: 65 } } }, error: '', internal: 'PRIVATE_GUARD_SENTINEL' });
  f.inspector.getMemory = () => ({ backfill: { reason: 'safety-hour', safety: { blocked: true, window: 'hour', used: 30, max: 30, retryAt: 2000, internal: 'PRIVATE_SAFETY_SENTINEL' } } });
  const view = await data(f.inspector, { section: 'settings' });
  assert.equal(view.requestSafety.used.codex.background.hour, 30);
  assert.equal(view.memory.status.backfill.reason, 'safety-hour'); assert.equal(view.memory.status.backfill.safety.retryAt, 2000);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_(GUARD|SAFETY)_SENTINEL/);
});
async function data(inspector,args={},current='chat'){
  let page=envelope(await inspector.call({...args,limit:32000},current)),text=page.text;
  while(page.nextOffset!==null){page=envelope(await inspector.call({...args,snapshot:page.snapshot,offset:page.nextOffset,limit:32000},current));text+=page.text;}
  return JSON.parse(text);
}
function fixture(){
  const state={settings:{memoryEnabled:false,permissionMode:'read-only',permissionRules:[],browserEnabled:false,desktopEnabled:false,provider:'codex',workspace:'C:/project',voice:{rate:1},personalization:{tone:'direct',instructions:'Use plain prose',soul:{text:'SHARED_CHARACTER_PRIVATE'}},apiConnections:{key:'ACCOUNT_SENTINEL'},externalMcpServers:[{id:'tools',name:'Tools',enabled:true,command:'node',args:['script.js','--token','CLI_SECRET_SENTINEL'],env:{API_KEY:'ENV_SECRET_SENTINEL'}}]},conversations:[{id:'chat',title:'Current chat',messages:[{id:'reply',role:'assistant',provider:'codex',timing:{prepareMs:100},activity:[{id:'event',kind:'tool',name:'workspace_shell',input:'{"command":"Write-Output sample","api_key":"NESTED_SECRET_SENTINEL"}',output:'Visible result',status:'done'},{id:'thinking',kind:'thinking',text:'HIDDEN_THINKING_SENTINEL'}],questions:[{id:'question',status:'answered',questions:[{question:'Which?',options:[]}],answers:{choice:'One'}}]}]},{id:'other',title:'OTHER_CHAT_SENTINEL',messages:[]},{id:'private',title:'PRIVATE_CHAT_SENTINEL',private:true,messages:[]}],projects:[{id:'project',name:'Project',instructions:'Useful instructions',folder:'C:/project',files:['main.js']}],prompts:[{id:'prompt',name:'Review',shortcut:'review',text:'Read carefully'}],schedules:[{id:'schedule',name:'Weekly',prompt:'Prepare report',enabled:true,last:{status:'complete'}}],scratchpad:{notes:[{allowAI:false,title:'UNSHARED_NOTE_SENTINEL',text:'UNSHARED_TEXT_SENTINEL'}]}};
  const sessions=[{id:'pty:user',conversationId:'chat',owner:'user',title:'Personal PowerShell',workspace:'C:/project',status:'running',pid:123,buffer:'PS C:/Users/synthetic> ',pty:{private:'PTY_OBJECT_SENTINEL'}},{id:'pty:other',conversationId:'other',owner:'user',title:'OTHER_TERMINAL_SENTINEL',status:'running',buffer:'OTHER_TERMINAL_OUTPUT_SENTINEL'},{id:'pty:private',conversationId:'private',owner:'agent',title:'PRIVATE_TERMINAL_SENTINEL',status:'running',buffer:'PRIVATE_TERMINAL_OUTPUT_SENTINEL'}];
  const activity={restart:{idle:false,blockers:[{kind:'terminals',count:3,message:'Close 3 open terminal sessions.'}]},terminals:sessions,replies:[{conversationId:'chat',provider:'codex',startedAt:'2026-10-18T12:00:00Z'},{conversationId:'private',provider:'PRIVATE_PROVIDER_SENTINEL'}],queues:[],commands:[],analysis:[],approvals:[],noteScoped:[]};
  let time=1000,allow=true,projections=0;
  const policy=new PermissionPolicy({getSettings:()=>state.settings,getChatMode:id=>state.conversations.find(c=>c.id===id)?.permissionMode});
  const check=(action,id,scope)=>{for(const subject of inspectionReadActions(action,scope?.conversationId||id,scope?.terminalId)){const verdict=policy.evaluate(subject,id);if(verdict.decision!=='allow')throw Error(verdict.reason);}};
  const inspector=new AppInspection({getState:()=>state,getActivity:()=>activity,getTerminal:()=>{projections++;return {sessions,entries:[{id:'direct',conversationId:'chat',command:'Write-Output direct',output:'direct output',status:'complete'}]};},getVoice:()=>({local:{active:false},realtime:{active:true,phase:'connected',conversationId:'other',voice:'cove',sessionId:'VOICE_SECRET_SENTINEL',sdp:'RAW_SDP_SENTINEL'}}),getModels:()=>({connections:[{id:'codex',connected:true,token:'MODEL_SECRET_SENTINEL'}],models:{codex:[{id:'model'}]},usage:{codex:{windows:[{usedPercent:12}]}}}),getIntegrations:()=>({phone:{configured:true,pairing:{link:'PAIR_SECRET_SENTINEL'},phones:[{id:'phone',name:'My phone'}]},messaging:{telegram:{enabled:true,state:'connected',code:'LOGIN_SECRET_SENTINEL'}}}),getTools:()=>APP_INSPECTION_TOOLS,authorize:async()=>allow,check,now:()=>time});
  return {state,sessions,activity,inspector,policy,setTime:value=>time=value,decline:()=>allow=false,get projections(){return projections;}};
}

test('app inspection is a closed read-only tool in chat mode and side answers',async()=>{
  assert.equal(hostAction('app_inspect',{section:'settings'}).kind,'read');assert.equal(hostAction('app_inspect',{section:'settings'}).target,'settings');
  assert.equal(LEAN_TOOLS.test('app_inspect'),true);assert.equal(FOLLOWUP_READ_TOOLS.has('app_inspect'),true);
  const schema=APP_INSPECTION_TOOLS[0].inputSchema;assert.equal(schema.additionalProperties,false);assert.equal('command'in schema.properties,false);assert.equal('method'in schema.properties,false);
  const f=fixture(),work={item:{}};const receipt=await readFollowupTool(work,'app_inspect',{section:'activity'},{live:()=>true,dispatch:(name,args)=>f.inspector.call(args,'chat')});assert.equal(receipt.isError,undefined);assert.equal(work.readCalls,1);
});

test('coverage routes preserve dedicated note/browser/history controls and reveal no unshared content',async()=>{
  const f=fixture(),view=await data(f.inspector),text=JSON.stringify(view);
  assert.ok(view.sections.settings);assert.ok(view.routes.notebook.tools.includes('notes_overview'));assert.ok(view.routes.browser.tools.includes('browser_inspect'));
  assert.doesNotMatch(text,/UNSHARED_|ACCOUNT_SENTINEL|SHARED_CHARACTER_PRIVATE|PRIVATE_CHAT_SENTINEL|OTHER_CHAT_SENTINEL|PRIVATE_PROVIDER_SENTINEL/);
});

test('live activity names exact owned blockers and anonymizes inaccessible chats',async()=>{
  const f=fixture(),view=await data(f.inspector,{section:'activity'}),block=view.restart.blockers[0];
  assert.equal(block.count,3);assert.equal(block.items[0].id,'pty:user');assert.equal(block.items[0].title,'Personal PowerShell');assert.equal(block.items[1].otherChat,true);assert.equal(block.items[2].otherChat,true);
  assert.doesNotMatch(JSON.stringify(view),/OTHER_|PRIVATE_|PTY_OBJECT/);
  f.state.settings.memoryEnabled=true;const shared=await data(f.inspector,{section:'activity'});assert.equal(shared.terminals.find(item=>item.id==='pty:other').title,'OTHER_TERMINAL_SENTINEL');assert.doesNotMatch(JSON.stringify(shared),/PRIVATE_TERMINAL|PRIVATE_CHAT/);
});

test('personal terminal output is directly readable but scoped and has no control capability',async()=>{
  const f=fixture(),listing=await data(f.inspector,{section:'terminals'});assert.deepEqual(listing.sessions.map(item=>item.id),['pty:user']);assert.equal(listing.directCommands[0].output,'direct output');
  const view=await data(f.inspector,{section:'terminal_output',id:'pty:user'});assert.match(view.text,/PS C:\/Users\/synthetic>/);assert.equal(view.owner,'user');assert.equal(view.pty,undefined);
  for(const id of ['pty:other','pty:private','unrelated-os-process'])await assert.rejects(data(f.inspector,{section:'terminal_output',id}),/does not belong/);
  await assert.rejects(f.inspector.call({section:'terminal_output',id:'pty:user',command:'delete'},'chat'),/documented/);
});

test('terminal output pagination preserves the whole retained ring and a fixed observation',async()=>{
  const f=fixture();f.sessions[0].buffer='x'.repeat(260000)+'END_OF_OUTPUT';f.sessions[0].nextCursor=f.sessions[0].buffer.length;
  const view=await data(f.inspector,{section:'terminal_output',id:'pty:user'});assert.equal(view.text,f.sessions[0].buffer);
  const first=envelope(await f.inspector.call({section:'terminal_output',id:'pty:user',limit:20},'chat'));f.sessions[0].buffer='new output';
  let page=first,text=first.text;while(page.nextOffset!==null){page=envelope(await f.inspector.call({section:'terminal_output',id:'pty:user',snapshot:first.snapshot,offset:page.nextOffset,limit:32000},'chat'));text+=page.text;}
  assert.ok(JSON.parse(text).text.endsWith('END_OF_OUTPUT'));
});

test('cross-chat reads require sharing and never include temporary chats',async()=>{
  const f=fixture();await assert.rejects(data(f.inspector,{section:'diagnostics',conversationId:'other'}),/Shared memory is off/);
  f.state.settings.memoryEnabled=true;assert.deepEqual((await data(f.inspector,{section:'diagnostics',conversationId:'other'})).messages,[]);
  await assert.rejects(data(f.inspector,{section:'diagnostics',conversationId:'private'}),/saved chat is unavailable/);await assert.rejects(f.inspector.call({},'private'),/saved chat/);
});

test('permission denial happens before projection and also applies to snapshot continuation',async()=>{
  const f=fixture();f.decline();await assert.rejects(f.inspector.call({section:'terminals'},'chat'),/declined or blocked/);assert.equal(f.projections,0);
  const g=fixture(),first=envelope(await g.inspector.call({section:'settings',limit:10},'chat'));g.state.settings.permissionRules=[{effect:'deny',tool:'app_inspect',match:'settings'}];
  await assert.rejects(g.inspector.call({section:'settings',snapshot:first.snapshot,offset:first.nextOffset},'chat'),/Blocked by your rule/);
});

test('existing terminal and history deny rules cannot be bypassed by the inspector',async()=>{
  const f=fixture();f.state.settings.permissionRules=[{effect:'deny',tool:'terminal_read',match:''}];
  await assert.rejects(data(f.inspector,{section:'terminal_output',id:'pty:user'}),/terminal_read/);await assert.rejects(data(f.inspector,{section:'terminals'}),/terminal_read/);
  f.state.settings.permissionRules=[{effect:'deny',tool:'conversation_read',match:''}];await assert.rejects(data(f.inspector,{section:'diagnostics'}),/conversation_read/);
  assert.ok((await data(f.inspector,{section:'activity'})).restart);
});

test('cached pages recheck revoked sharing, deleted chats and scoped note tasks',async()=>{
  for(const revoke of [f=>f.state.settings.memoryEnabled=false,f=>f.state.conversations.splice(1,1),f=>f.activity.noteScoped.push('chat')]){
    const f=fixture();f.state.settings.memoryEnabled=true;const first=envelope(await f.inspector.call({section:'diagnostics',conversationId:'other',limit:1},'chat'));revoke(f);
    await assert.rejects(f.inspector.call({section:'diagnostics',conversationId:'other',snapshot:first.snapshot,offset:first.nextOffset},'chat'),/Shared memory|unavailable|scoped note/);
  }
});

test('snapshots expire, bind every selector and reject unscoped offsets',async()=>{
  const f=fixture(),first=envelope(await f.inspector.call({section:'settings',limit:1},'chat'));
  await assert.rejects(f.inspector.call({section:'activity',snapshot:first.snapshot,offset:1},'chat'),/another read/);
  await assert.rejects(f.inspector.call({section:'settings',offset:1},'chat'),/snapshot/);f.setTime(122000);
  await assert.rejects(f.inspector.call({section:'settings',snapshot:first.snapshot,offset:1},'chat'),/expired/);
});

test('settings use a positive allowlist and preserve the character service boundary',async()=>{
  const f=fixture(),view=await data(f.inspector,{section:'settings'});assert.equal(view.app.provider,'codex');assert.equal(view.personalization.tone,'direct');assert.equal(view.app.browserEnabled,false);
  assert.doesNotMatch(JSON.stringify(view),/ACCOUNT_SENTINEL|SHARED_CHARACTER_PRIVATE|CLI_SECRET_SENTINEL|ENV_SECRET_SENTINEL/);assert.ok(view.characterRoute.tools.includes('soul_reflect'));
});

test('settings expose effective Memory defaults and projected live status without sync or provider work',async()=>{
  const f=fixture(),calls=[];
  f.inspector.getMemory=id=>{calls.push(id);return {total:42,pendingJobs:3,lastError:'A source event conflicted.',jobs:{ready:2,running:1,failed:0,secret:'JOB_SENTINEL'},background:{running:1,lastResponseBytes:900,lastResponseEmpty:false,pendingRewrites:1,rewrites:'SOURCE_SENTINEL',model:{provider:'codex',model:'gpt-6-luna',effort:'high',payload:'MODEL_SENTINEL'},chatId:'OTHER_CHAT_SENTINEL',task:'SOURCE_SENTINEL'},backfill:{requests:12,ceiling:50,reason:'usage-high',extra:'COUNTER_SENTINEL'},originals:'ORIGINAL_SENTINEL'};};
  let view=await data(f.inspector,{section:'settings'});
  assert.deepEqual(calls,['chat']);assert.equal(view.memory.effective.usageCeiling,50);assert.equal(view.memory.effective.catchUp,true);assert.equal(view.memory.effective.dailyCap,1500);
  assert.equal(view.memory.status.total,42);assert.equal(view.memory.status.backfill.requests,12);assert.equal(view.memory.status.background.model.effort,'high');assert.equal(view.memory.effective.allowanceReservePercent,50);
  assert.equal(view.memory.status.background.lastResponseBytes,900);assert.equal(view.memory.status.background.lastResponseEmpty,false);assert.equal(view.memory.status.background.pendingRewrites,1);
  assert.doesNotMatch(JSON.stringify(view),/JOB_SENTINEL|MODEL_SENTINEL|OTHER_CHAT_SENTINEL|SOURCE_SENTINEL|COUNTER_SENTINEL|ORIGINAL_SENTINEL/);
  f.state.settings.chatMemoryBackfillUsageCeiling=null;f.state.settings.chatMemoryBackfillDailyCap=null;
  view=await data(f.inspector,{section:'settings'});assert.equal(view.memory.effective.usageCeiling,null);assert.equal(view.memory.effective.dailyCap,null);assert.equal(view.app.chatMemoryBackfillUsageCeiling,null);
  await assert.rejects(data(f.inspector,{section:'settings',conversationId:'other'}),/Shared memory/);assert.deepEqual(calls,['chat','chat']);
});

test('recorded diagnostics expose results and timing while omitting hidden reasoning and credentials',async()=>{
  const f=fixture(),view=await data(f.inspector,{section:'diagnostics',messageId:'reply'});assert.equal(view.messages[0].timing.prepareMs,100);assert.equal(view.messages[0].events[0].output,'Visible result');
  assert.doesNotMatch(JSON.stringify(view),/HIDDEN_THINKING_SENTINEL|NESTED_SECRET_SENTINEL/);assert.equal(view.messages[0].events.length,1);
  await assert.rejects(data(f.inspector,{section:'diagnostics',messageId:'not-a-message'}),/assistant message/);
});

test('diagnostic reads do not recursively copy their own earlier snapshots',async()=>{
  const f=fixture();f.state.conversations[0].messages[0].activity.push({id:'inspection',kind:'tool',name:'mcp__exomina__app_inspect',status:'done',output:'PREVIOUS_LARGE_INSPECTION_SENTINEL'});
  const view=await data(f.inspector,{section:'diagnostics'});assert.doesNotMatch(JSON.stringify(view),/PREVIOUS_LARGE_INSPECTION_SENTINEL/);assert.match(view.messages[0].events.at(-1).payloadRoute,/recursive snapshots/);
});

test('integration projections exclude environment values, CLI secrets and pairing data',async()=>{
  const f=fixture(),view=await data(f.inspector,{section:'integrations'});assert.deepEqual(view.external[0].environmentNames,['API_KEY']);assert.equal(view.external[0].arguments[2],'[excluded]');assert.equal(view.phone.phones[0].name,'My phone');
  assert.doesNotMatch(JSON.stringify(view),/CLI_SECRET_SENTINEL|ENV_SECRET_SENTINEL|PAIR_SECRET_SENTINEL|LOGIN_SECRET_SENTINEL/);
});

test('credential redaction covers nested JSON, bearer values, URLs and CLI assignments',()=>{
  const source={password:'SECRET1',nested:'{"api_key":"SECRET2"}',log:'Authorization: Bearer SECRET3 token=SECRET4 --api-key SECRET5 https://name:SECRET6@example.test/?access_token=SECRET7',sessionId:'SECRET8',thread_id:'SECRET9'};
  assert.doesNotMatch(JSON.stringify(inspectionValue(source)),/SECRET[1-9]/);
  const value=JSON.parse('{"__proto__":{"safe":true}}'),projected=inspectionValue(value);assert.equal(Object.getPrototypeOf(projected),Object.prototype);assert.equal(projected.safe,undefined);
});

test('voice is an observation and never reads audio or provider transports',async()=>{
  const f=fixture(),view=await data(f.inspector,{section:'voice'});assert.deepEqual(view.realtime,{active:true,otherChat:true});assert.equal(view.settings.rate,1);assert.doesNotMatch(JSON.stringify(view),/VOICE_SECRET|RAW_SDP/);
  f.state.settings.memoryEnabled=true;const shared=await data(f.inspector,{section:'voice'});assert.equal(shared.realtime.voice,'cove');assert.equal(shared.realtime.sessionId,undefined);
});

test('navigation reports only bounded display state and clears private selection',async()=>{
  const f=fixture();assert.equal((await data(f.inspector,{section:'navigation'})).available,false);
  f.inspector.reportNavigation({page:'settings',conversationId:'chat',interfaceView:'diagnostics',settingsSection:'updates',draft:'UNSENT_DRAFT_SENTINEL',layout:{enabled:true,groups:{right:{panels:['terminal','bad']}}},savedWorkspaces:[{name:'Coding',layout:{enabled:true}}]});
  const view=await data(f.inspector,{section:'workspaces'});assert.equal(view.navigation.settingsSection,'updates');assert.equal(view.navigation.savedWorkspaces[0].name,'Coding');assert.doesNotMatch(JSON.stringify(view),/UNSENT_DRAFT|bad/);
  f.inspector.reportNavigation({private:true,conversationId:'private'});assert.equal((await data(f.inspector,{section:'navigation'})).available,false);
  assert.throws(()=>f.inspector.reportNavigation({extra:'x'.repeat(70000)}),/bounded/);
});

test('projects, prompts, tasks, cards and cached catalogue are readable without mutating their source',async()=>{
  const f=fixture(),before=JSON.stringify(f.state);
  assert.equal((await data(f.inspector,{section:'projects'}))[0].instructions,'Useful instructions');assert.equal((await data(f.inspector,{section:'prompts'}))[0].text,'Read carefully');assert.equal((await data(f.inspector,{section:'schedules'}))[0].last.status,'complete');assert.equal((await data(f.inspector,{section:'questions'})).questions[0].answers.choice,'One');assert.equal((await data(f.inspector,{section:'models'})).connections[0].connected,true);assert.equal((await data(f.inspector,{section:'tools'}))[0].name,'app_inspect');
  assert.equal(JSON.stringify(f.state),before);
});

test('unknown fields, prototypes, arbitrary sections and invalid limits fail closed',async()=>{
  const f=fixture();for(const args of [{section:'bootstrap'},{section:'__proto__'},{method:'terminal.input'},{section:'settings',limit:0},{section:'settings',limit:32001},{section:'settings',offset:-1},{section:'settings',query:4}])await assert.rejects(f.inspector.call(args,'chat'));
});

test('activity and coverage cannot repeat command content, queued text or unexpected blocker payloads',async()=>{
  const f=fixture();f.activity.commands=[{id:'command',conversationId:'chat',status:'running',command:'COMMAND_CONTENT_SENTINEL',output:'COMMAND_OUTPUT_SENTINEL'}];
  f.activity.queues=[{conversationId:'chat',items:[{id:'queued',provider:'codex',text:'QUEUED_TEXT_SENTINEL',payload:{draft:'UNSENT_SENTINEL'}}]}];
  f.activity.restart.blockers.push({kind:'commands',count:1,message:'Wait for a running command.',items:f.activity.commands,privateDetail:'BLOCKER_DETAIL_SENTINEL'});
  f.state.settings.permissionRules=[{effect:'deny',tool:'terminal_read',match:''},{effect:'deny',tool:'conversation_read',match:''}];
  for(const section of ['activity','overview']){const view=await data(f.inspector,{section});assert.doesNotMatch(JSON.stringify(view),/COMMAND_CONTENT|COMMAND_OUTPUT|QUEUED_TEXT|UNSENT_SENTINEL|BLOCKER_DETAIL/);}
});

test('protected diagnostic payloads route through source tools after sharing or tool permissions change',async()=>{
  const f=fixture();for(const name of ['notes_read','browser_snapshot','workspace_read','memory_recall','conversation_read','analysis_report','ghidra_query','external_private','image_read'])f.state.conversations[0].messages[0].activity.push({id:name,kind:'tool',name,status:'done',input:'PROTECTED_INPUT_SENTINEL',output:'PROTECTED_OUTPUT_SENTINEL',text:'PROTECTED_TEXT_SENTINEL',detail:'PROTECTED_DETAIL_SENTINEL'});
  const view=await data(f.inspector,{section:'diagnostics'});assert.equal(view.messages[0].events[0].output,'Visible result');assert.doesNotMatch(JSON.stringify(view),/PROTECTED_(?:INPUT|OUTPUT|TEXT|DETAIL)_SENTINEL/);assert.ok(view.messages[0].events.slice(1).every(event=>event.payloadRoute));
});

test('alias denies use the requested chat and exact terminal rather than only the calling chat',async()=>{
  const f=fixture();f.state.settings.memoryEnabled=true;f.state.settings.permissionRules=[{effect:'deny',tool:'conversation_read',match:'other'}];
  await assert.rejects(data(f.inspector,{section:'diagnostics',conversationId:'other'}),/conversation_read other/);assert.equal((await data(f.inspector,{section:'diagnostics'})).conversationId,'chat');
  f.state.settings.permissionRules=[{effect:'deny',tool:'terminal_read',match:'pty:user'}];await assert.rejects(data(f.inspector,{section:'terminal_output',id:'pty:user'}),/terminal_read pty:user/);
});

test('nested settings and cached models are projected rather than blindly copied',async()=>{
  const f=fixture();f.state.settings.appearance={theme:'ink-wash',unexpected:'APPEARANCE_SENTINEL'};f.state.settings.voice.extra='VOICE_SETTING_SENTINEL';f.state.settings.modelPreferences={unexpected:'MODEL_SETTING_SENTINEL'};
  f.inspector.getModels=()=>({models:{codex:[{id:'model',unknown:'MODEL_PAYLOAD_SENTINEL',sessionInfo:{data:'MODEL_SESSION_SENTINEL'}}]},usage:{codex:{unknown:'USAGE_PAYLOAD_SENTINEL',windows:[{id:'window',usedPercent:10,unknown:'USAGE_WINDOW_SENTINEL'}]}}});
  assert.doesNotMatch(JSON.stringify(await data(f.inspector,{section:'settings'})),/APPEARANCE_SENTINEL|VOICE_SETTING_SENTINEL|MODEL_SETTING_SENTINEL/);
  const models=await data(f.inspector,{section:'models'});assert.equal(models.usage.codex.windows[0].usedPercent,10);assert.doesNotMatch(JSON.stringify(models),/MODEL_PAYLOAD|MODEL_SESSION|USAGE_PAYLOAD|USAGE_WINDOW/);
});

test('unbound voice previews disclose activity only and never arbitrary preview strings',async()=>{
  const f=fixture();f.inspector.getVoice=()=>({realtime:{active:true,preview:'VOICE_PREVIEW_SENTINEL',phase:'VOICE_PHASE_SENTINEL',voice:'VOICE_NAME_SENTINEL',sdp:'VOICE_SDP_SENTINEL'}});
  assert.deepEqual((await data(f.inspector,{section:'voice'})).realtime,{active:true,otherChat:true});
});

test('credential redaction precedes truncation and handles ANSI, key blocks and signed links',()=>{
  const source={openaiApiKey:'CAMEL_SECRET_SENTINEL',databaseCredentials:{value:'NESTED_SECRET_SENTINEL'},log:'sk-ansi\u001b[31msplitsecret123456 https://example.test/?sig=SIGNED_SECRET_SENTINEL&key=QUERY_SECRET_SENTINEL Authorization: Token HEADER_SECRET_SENTINEL',keyBlock:'-----BEGIN OPENSSH PRIVATE KEY-----\n'+('KEY_SECRET_SENTINEL'.repeat(70000)),pgp:'-----BEGIN PGP PRIVATE KEY BLOCK-----\nPGP_SECRET_SENTINEL\n-----END PGP PRIVATE KEY BLOCK-----'};
  const view=JSON.stringify(inspectionValue(source));assert.doesNotMatch(view,/SECRET_SENTINEL|ansisplitsecret|KEY_SECRET/);assert.match(view,/credential redacted/);
  const json=JSON.stringify({safe:'x'.repeat(1048600),apiKey:'AFTER_TRUNCATION_SECRET_SENTINEL'});assert.doesNotMatch(inspectionValue(json),/AFTER_TRUNCATION_SECRET/);
});

test('Ask mode treats inspection and all of its continued pages as reads without extra prompts',async()=>{
  const f=fixture();f.state.settings.permissionMode='ask';let asks=0;f.inspector.authorize=async({action,conversationId})=>{const verdict=f.policy.evaluate(action,conversationId);if(verdict.decision==='ask')asks++;return verdict.decision==='allow';};
  const first=envelope(await f.inspector.call({section:'settings',limit:10},'chat'));assert.notEqual(first.nextOffset,null);const next=envelope(await f.inspector.call({section:'settings',snapshot:first.snapshot,offset:first.nextOffset,limit:10},'chat'));assert.ok(next.text);assert.equal(asks,0);
});
