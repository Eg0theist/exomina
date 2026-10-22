import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderManager, JsonRpcProcess, subscriptionEnvironment } from '../desktop/providers.mjs';
import {getProvider} from '../desktop/provider-catalog.mjs';
import {codexPolicy} from '../desktop/permissions.mjs';
import {UserQuestions} from '../desktop/user-questions.mjs';

class Child extends EventEmitter {
  constructor() { super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.killed = false; }
  kill() { if (this.killed) return; this.killed = true; this.emit('exit', null, 'SIGTERM'); this.emit('close', null, 'SIGTERM'); }
  json(value) { this.stdout.write(JSON.stringify(value) + '\n'); }
  finish(code = 0) { this.stdout.end(); this.stderr.end(); setImmediate(() => { this.emit('exit', code); this.emit('close', code); }); }
}

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'exomina-provider-test-'));
  const events = [], calls = [], children = [];
  let handler = () => {};
  const manager = new ProviderManager({ dataDir, workspace: path.join(dataDir, 'workspace'),
    isProviderEnabled: () => true,
    claudeRuntime: 'bundled',
    codexPath: process.execPath, claudePath: process.execPath,
    gateway: { url: 'http://127.0.0.1:1', token: 'synthetic-test-token', script: path.join(dataDir, 'gateway.mjs') },
    emit: event => events.push(event),
    spawnImpl: (exe, args, options) => { const child = new Child(); calls.push({ exe, args, options, child }); children.push(child); handler(child, args, options); return child; },
    ...overrides,
  });
  // This suite exercises the Codex/Claude native protocols. ACP adapters have
  // their own complete fixture suite, including independent metadata failure.
  manager.adapters.clear();
  t.after(async () => { manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { manager, dataDir, events, calls, children, setHandler: value => { handler = value; } };
}

test('background summaries cannot automatically retry an expired Claude sign-in', async t => {
  const { manager, events, calls } = await fixture(t);
  const expired = Object.assign(new Error('OAuth session expired'), { noOutput: true });
  let attempts = 0;
  manager.runOnce = async () => { attempts++; throw expired; };
  await assert.rejects(manager.run({ provider: 'claude', conversationId: 'memory-compaction-synthetic', noAuthRetry: true, noTools: true }), /OAuth session expired/);
  assert.equal(attempts, 1);
  assert.equal(events.some(event => event.type === 'chat.retry'), false);
  assert.equal(calls.length, 0);
});

test('Claude success-shaped quota notices and native rejected-usage events reject with an explicit usage flag',async t=>{
 for(const rejected of [false,true]){
  const f=await fixture(t);f.manager.claudeStatus=async()=>({connected:true});
  f.setHandler(child=>setImmediate(()=>{if(rejected)child.json({type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'five_hour'}});child.json({type:'result',subtype:'success',is_error:false,result:rejected?'Partial work preserved':"You've hit your session limit · resets 9:50pm",session_id:'limit-session'});child.finish();}));
  await assert.rejects(f.manager.run({provider:'claude',conversationId:'quota-'+rejected,prompt:'Synthetic task',noAuthRetry:true}),error=>error.usageLimited===true);
 }
});
test('Claude rejected usage without a final frame and assistant-only quota errors remain eligible for fallback', async t => {
  for (const mode of ['rejected-without-result', 'assistant-only', 'empty-result']) {
    const f = await fixture(t); f.manager.claudeStatus = async () => ({ connected: true });
    f.setHandler(child => setImmediate(() => {
      if (mode === 'rejected-without-result') child.json({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
      else child.json({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your limit · resets 9pm" }] } });
      if (mode === 'empty-result') child.json({ type: 'result', subtype: 'success', result: '', is_error: false });
      child.finish();
    }));
    await assert.rejects(f.manager.run({ provider: 'claude', conversationId: mode, prompt: 'Synthetic task', noAuthRetry: true }), error => error.usageLimited === true);
  }
});

test('Claude rejected usage ends input so a missing final result cannot leave the runtime waiting for more prompts', async t => {
  const f = await fixture(t); f.manager.claudeStatus = async () => ({ connected: true });
  f.setHandler(child => { child.stdin.once('finish', () => child.finish()); setImmediate(() => child.json({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } })); });
  await assert.rejects(f.manager.run({ provider: 'claude', conversationId: 'reject-eof', prompt: 'Synthetic task', noAuthRetry: true }), error => error.usageLimited === true);
  assert.equal(f.children[0].stdin.writableEnded, true);
});

test('Codex dynamic calls deliver MCP capabilities and never retry result-conversion failures', async t => {
  let calls = 0, result = { content: [], structuredContent: { elements: [{ element_token: 'current:1' }], capture_id: 'current-capture' } };
  const f = await fixture(t, { callTool: async () => { calls++; return result; } });
  f.manager.active.set('chat', { provider: 'codex', conversationId: 'chat', sessionId: 'thread-tool', turnId: 'turn-tool', codexPermissionsVerified: true, dynamicItems: true, toolDefinitions: [{ name: 'observe' }], reject: () => {} });
  const params = { threadId: 'thread-tool', turnId: 'turn-tool', tool: 'observe', arguments: {} };
  const output = await f.manager.codexRequest('item/tool/call', params);
  assert.equal(output.success, true); assert.match(output.contentItems[0].text, /current:1/); assert.equal(calls, 1);
  result = { content: [{ type: 'text', text: 1 }] };
  const failed = await f.manager.codexRequest('item/tool/call', params);
  assert.equal(failed.success, false); assert.match(failed.contentItems[0].text, /effects may already be complete/); assert.equal(calls, 2);
});
test('stale, ended and tool-free native turns cannot dispatch host tool calls', async t => {
  let calls = 0; const f = await fixture(t, { callTool: async () => { calls++; return { content: [] }; } });
  const state = { provider: 'codex', conversationId: 'chat', sessionId: 'thread-tool', turnId: 'turn-tool', codexPermissionsVerified: true, dynamicItems: true, toolDefinitions: [{ name: 'observe' }], reject: () => {} };
  f.manager.active.set('chat', state);
  const params = { threadId: 'thread-tool', turnId: 'older-turn', tool: 'observe', arguments: {} };
  await assert.rejects(f.manager.codexRequest('item/tool/call', params), /previous native turn/);
  params.turnId = 'turn-tool'; state.turnEnded = true;
  await assert.rejects(f.manager.codexRequest('item/tool/call', params), /native turn has ended/);
  state.turnEnded = false; state.noTools = true;
  await assert.rejects(f.manager.codexRequest('item/tool/call', params), /tool-free helper/);
  assert.equal(calls, 0);
});
test('Codex native questions use timed cards and return actual answers without approval',async t=>{
  const received=[],approvals=[];let response={answers:{tone:{answers:['Custom answer']}}};
  const f=await fixture(t,{requestUserInput:async(...args)=>{received.push(args);return response;},approve:async request=>{approvals.push(request);return true;}});
  const state={provider:'codex',conversationId:'chat',sessionId:'thread-question',codexPermissionsVerified:true,cancelled:false,reject:()=>{}};f.manager.active.set('chat',state);
  const params={threadId:'thread-question',questions:[{id:'tone',header:'Tone',question:'Which tone?',options:[{label:'Warm',description:'Friendly.'}]}]};
  assert.deepEqual(await f.manager.codexRequest('item/tool/requestUserInput',params),response);assert.deepEqual(received[0],['chat',{questions:params.questions},{wait:true}]);assert.equal(approvals.length,0);
  response={status:'unanswered',answers:{}};assert.deepEqual(await f.manager.codexRequest('item/tool/requestUserInput',params),{answers:{}});
  state.noTools=true;await assert.rejects(f.manager.codexRequest('item/tool/requestUserInput',params),/tool-free helper/);
});

test('native async questions persist before acknowledgement and deliver the later answer to their chat',async t=>{
  const chat={id:'chat',messages:[{id:'reply',role:'assistant',content:''}]},run={message:chat.messages[0]},events=[],deliveries=[],timers=new Map();let nextTimer=0,saved=0;
  const questions=new UserQuestions({getRun:id=>id==='chat'?run:undefined,getChat:()=>chat,save:async()=>{saved++;},emit:event=>events.push(event),deliver:async(...args)=>{deliveries.push(args);return {followup:'tracked'};},setTimer:callback=>{const id=++nextTimer;timers.set(id,callback);return id;},clearTimer:id=>timers.delete(id)});
  const received=[],approvals=[];
  const f=await fixture(t,{requestUserInput:async(...args)=>{received.push(args);return questions.ask(...args);},approve:async request=>{approvals.push(request);return true;}});
  const state={provider:'codex',conversationId:'chat',sessionId:'thread-async',turnId:'turn-async',codexPermissionsVerified:true,cancelled:false,reject:()=>{}};f.manager.active.set('chat',state);
  const params={threadId:'thread-async',turnId:'turn-async',itemId:'native-question',isBlocking:false,autoResolutionMs:25000,questions:[{id:'tone',header:'Tone',question:'Which tone?',options:null}]};
  assert.deepEqual(await f.manager.codexRequest('item/tool/requestUserInput',params),{answers:{}});
  assert.deepEqual(received[0],['chat',{questions:params.questions,wait_seconds:25},{wait:false}]);
  const group=run.message.questions[0];assert.equal(group.status,'waiting');assert.equal(group.waitSeconds,25);assert.deepEqual(group.questions[0].options,[]);assert.equal(events.at(-1).question.id,group.id);assert.ok(saved);assert.equal(approvals.length,0);assert.equal(deliveries.length,0);
  await questions.answer('chat',{id:group.id,answers:{tone:'Warm'}});
  assert.equal(deliveries.length,1);assert.equal(deliveries[0][0],'chat');assert.match(deliveries[0][1],/User answer: Warm/);assert.equal(group.deliveryState,'delivered');assert.equal(timers.size,0);
  await questions.answer('chat',{id:group.id,answers:{tone:'Warm'}});assert.equal(deliveries.length,1,'the async native callback and host follow-up cannot send twice');
  await assert.rejects(f.manager.codexRequest('item/tool/requestUserInput',{...params,turnId:'older-turn'}),/previous native turn/);
});

test('native question duration is bounded and zero does not silently close the response window',async t=>{
  const received=[];const f=await fixture(t,{requestUserInput:async(...args)=>{received.push(args);return {answers:{}};}});
  f.manager.active.set('chat',{provider:'codex',conversationId:'chat',sessionId:'thread-duration',codexPermissionsVerified:true,cancelled:false,reject:()=>{}});
  const params={threadId:'thread-duration',isBlocking:false,questions:[{id:'choice',header:'Choice',question:'Which one?',options:null}]};
  for(const autoResolutionMs of [0,null,1,600001])await f.manager.codexRequest('item/tool/requestUserInput',{...params,autoResolutionMs});
  assert.deepEqual(received.map(([,args])=>args.wait_seconds),[undefined,undefined,10,300]);
  await f.manager.codexRequest('item/tool/requestUserInput',{...params,isBlocking:true});assert.deepEqual(received.at(-1)[2],{wait:true});
});

test('ended native turns cannot open another question card', async t => {
  let asked = 0; const f = await fixture(t, { requestUserInput: async () => { asked++; return { answers: {} }; } });
  f.manager.active.set('chat', { provider: 'codex', conversationId: 'chat', sessionId: 'thread-question', turnId: 'turn-question', turnEnded: true, codexPermissionsVerified: true, reject: () => {} });
  await assert.rejects(f.manager.codexRequest('item/tool/requestUserInput', { threadId: 'thread-question', turnId: 'turn-question', questions: [] }), /native turn has ended/);
  assert.equal(asked, 0);
});

test('blocking native questions cannot return answers after Stop, turn end or active-turn replacement', async t => {
  for (const change of ['cancelled', 'ended', 'state-replaced', 'turn-replaced']) {
    let finish; const f = await fixture(t, { requestUserInput: async () => new Promise(resolve => { finish = resolve; }) });
    const state = { provider: 'codex', conversationId: 'chat', sessionId: 'thread-question', turnId: 'turn-question', codexPermissionsVerified: true, reject: () => {} };
    f.manager.active.set('chat', state);
    const request = f.manager.codexRequest('item/tool/requestUserInput', { threadId: 'thread-question', turnId: 'turn-question', isBlocking: true, questions: [] });
    const rejected = assert.rejects(request, /no longer belongs to the active turn/);
    if (change === 'cancelled') state.cancelled = true;
    else if (change === 'ended') state.turnEnded = true;
    else if (change === 'state-replaced') f.manager.active.set('chat', { ...state });
    else state.turnId = 'new-turn';
    finish({ answers: { choice: { answers: ['Saved answer'] } } });
    await rejected;
  }
});

function codexSession(params, id = 'thread-test') {
  const type = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }[params.sandbox];
  return { thread: { id, status: { type: 'idle' } }, cwd: params.cwd, sandbox: { type }, approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer };
}

// Persistent stream-json inference starts at its first input frame. Status
// helpers still read the entire text input until EOF.
function onClaudeInput(child, args, listener) {
  child.stdin.once(args.includes('--replay-user-messages') ? 'data' : 'finish', listener);
}

function codexServer(child, requests, { account = { type: 'chatgpt', planType: 'plus' }, turn, models = [], capabilities = { imageGeneration: true, namespaceTools: true }, imageEnabled = true, session = codexSession } = {}) {
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      requests.push(message);
      if (!message.method) { turn?.(message, child); continue; }
      const results = {
        initialize: {}, 'account/read': { account },
        'modelProvider/capabilities/read': capabilities,
        'experimentalFeature/list': { data: [{ name: 'image_generation', enabled: imageEnabled }], nextCursor: null },
        'model/list': typeof models === 'function' ? models(message.params) : { data: models, nextCursor: null },
        'thread/start': message.method === 'thread/start' ? session(message.params, 'thread-test', message.method) : undefined,
        'thread/resume': message.method === 'thread/resume' ? session(message.params, 'thread-test', message.method) : undefined,
        'turn/start': { turn: { id: 'turn-test' } }, 'turn/interrupt': {}, 'turn/steer': { turnId: 'turn-test' },
        'account/login/start': { type: 'chatgpt', loginId: 'test-login', authUrl: 'https://auth.openai.com/authorize?test=1' },
      };
      if (message.id !== undefined) queueMicrotask(() => {
        child.json({ id: message.id, result: results[message.method] || {} });
        if (['turn/start', 'turn/interrupt'].includes(message.method)) setImmediate(() => turn?.(message, child));
      });
    }
  });
}

function notification(child, method, params = {}) {
  child.json({ method, params: { threadId: 'thread-test', turnId: 'turn-test', ...params } });
}

test('Codex applies each newly selected permission level and workspace to creation, resume and turn startup',async t=>{
  let mode='ask';const requests=[],f=await fixture(t,{getPermissionMode:()=>mode});
  f.setHandler(child=>codexServer(child,requests,{turn(message){if(message.method==='turn/start')notification(child,'turn/completed',{turn:{status:'completed',items:[]}});}}));
  for(const [index,selected] of ['ask','full','read-only','auto-edit'].entries()){
    mode=selected;const workspace=path.join(f.dataDir,'workspace-'+index);
    await f.manager.run({provider:'codex',conversationId:'permissions',workspace,prompt:'Synthetic turn',...(index?{sessionId:'thread-test'}:{})});
    const policy=codexPolicy(mode),thread=requests.filter(r=>r.method==='thread/start'||r.method==='thread/resume').at(-1),turn=requests.filter(r=>r.method==='turn/start').at(-1);
    assert.equal(thread.params.cwd,workspace);assert.equal(thread.params.sandbox,policy.sandbox);assert.equal(thread.params.approvalPolicy,policy.approvalPolicy);
    assert.equal(turn.params.cwd,workspace);assert.deepEqual(turn.params.sandboxPolicy,policy.sandboxPolicy);assert.equal(turn.params.approvalPolicy,policy.approvalPolicy);
    assert.equal(thread.params.approvalsReviewer,'user');assert.equal(turn.params.approvalsReviewer,'user');
  }
  assert.equal(requests.filter(r=>r.method==='thread/start').length,1);assert.equal(requests.filter(r=>r.method==='thread/resume').length,3);
});

test('Codex rejects missing or incompatible permissions on a fresh thread before any turn',async t=>{
  for(const override of [{sandbox:undefined},{approvalPolicy:'never'},{approvalsReviewer:'guardian_subagent'},{cwd:path.resolve('wrong-folder')},{sandbox:{type:'workspaceWrite',networkAccess:true}}]){
    const requests=[],f=await fixture(t);f.setHandler(child=>codexServer(child,requests,{session:params=>({...codexSession(params),...override})}));
    await assert.rejects(f.manager.run({provider:'codex',conversationId:'mismatch',prompt:'Do not act'}),error=>{
      assert.equal(error.code,'codexPermissionMismatch');assert.match(error.message,/Requested:.*workspaceWrite/s);assert.match(error.message,/Effective:/);assert.doesNotMatch(error.message,/sandbox setup|repair Windows/i);return true;
    });
    assert.equal(requests.filter(r=>r.method==='thread/start').length,1);assert.equal(requests.some(r=>r.method==='turn/start'),false);
  }
});

test('Codex cannot call host tools or request approval while returned permissions are unverified',async t=>{
  let acted=0;const f=await fixture(t,{callTool:async()=>{acted++;},approve:async()=>{acted++;return true;}});
  f.manager.active.set('pending',{provider:'codex',sessionId:'unverified-thread',conversationId:'pending',cancelled:false});
  for(const method of ['item/tool/call','item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'])await assert.rejects(f.manager.codexRequest(method,{threadId:'unverified-thread',tool:'workspace_write'}),/permissions have not been verified/);
  assert.equal(acted,0);f.manager.active.delete('pending');
});

function nativeApprovalState(f, overrides = {}) {
  const state = { provider: 'codex', conversationId: 'native-approval', sessionId: 'native-thread', turnId: 'native-turn', codexPermissionsVerified: true,
    cancelled: false, reject: () => {}, items: new Map([['edit-item', { changes: [{ path: 'synthetic.txt', diff: '+synthetic change' }] }]]), ...overrides };
  f.manager.active.set(state.conversationId, state);
  return state;
}

const nativeApprovalCases = [
  { method: 'item/commandExecution/requestApproval', params: { command: 'synthetic-cleanup approved-fixture', cwd: 'synthetic-workspace' }, kind: 'execute', tool: 'codex.command' },
  { method: 'item/fileChange/requestApproval', params: { itemId: 'edit-item' }, kind: 'write', tool: 'codex.edit' },
  { method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { write: ['synthetic-workspace'] } } }, kind: 'elevate', tool: 'codex.permissions' },
];

test('native command, file and access confirmations require a real answer even under Full access', async t => {
  const approvals = [];
  let response = { approved: true, scope: 'once' };
  const f = await fixture(t, { getPermissionMode: () => 'full', approveDetailed: async request => { approvals.push(request); return response; } });
  nativeApprovalState(f);
  for (const entry of nativeApprovalCases) {
    const params = { threadId: 'native-thread', turnId: 'native-turn', reason: 'Synthetic native confirmation', ...entry.params };
    for (const scope of ['once', 'chat', 'always']) {
      response = { approved: true, scope };
      const actual = await f.manager.codexRequest(entry.method, params);
      const session = scope === 'chat';
      assert.deepEqual(actual, entry.kind === 'elevate'
        ? { permissions: scope === 'once' ? entry.params.permissions : {}, scope: 'turn' }
        : { decision: scope === 'always' ? 'decline' : session ? 'acceptForSession' : 'accept' });
      const request = approvals.at(-1);
      assert.equal(request.requireConfirmation, true, `${entry.method} must retain Codex's native confirmation`);
      assert.equal(request.action.kind, entry.kind); assert.equal(request.action.tool, entry.tool);
      assert.equal(request.conversationId, 'native-approval');
      if (entry.kind !== 'elevate') assert.equal(request.allowSession, true);
    }
    response = { approved: false };
    assert.deepEqual(await f.manager.codexRequest(entry.method, params), entry.kind === 'elevate' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' });
  }
  assert.match(approvals.find(request => request.action.kind === 'write').detail, /synthetic.txt\n\+synthetic change/);
});

test('native command session approval is only offered when the runtime supports it', async t => {
  const approvals = [], f = await fixture(t, { approveDetailed: async request => { approvals.push(request); return { approved: true, scope: 'chat' }; } });
  nativeApprovalState(f);
  const params = { threadId: 'native-thread', turnId: 'native-turn', command: 'synthetic-command' };
  assert.deepEqual(await f.manager.codexRequest('item/commandExecution/requestApproval', { ...params, availableDecisions: ['accept', 'decline'] }), { decision: 'decline' });
  assert.equal(approvals.at(-1).allowSession, false);
  assert.deepEqual(await f.manager.codexRequest('item/commandExecution/requestApproval', { ...params, availableDecisions: ['accept', 'acceptForSession', 'decline'] }), { decision: 'acceptForSession' });
  assert.equal(approvals.at(-1).allowSession, true);
});

test('unsupported native approval choices decline without presenting an unusable prompt', async t => {
  const approvals = [], f = await fixture(t, { approveDetailed: async request => { approvals.push(request); return { approved: true, scope: 'once' }; } });
  nativeApprovalState(f);
  for (const entry of nativeApprovalCases.filter(entry => entry.kind !== 'elevate')) {
    for (const availableDecisions of [[], ['decline'], ['acceptForSession', 'decline'], [{ acceptWithExecpolicyAmendment: { execpolicyAmendment: ['synthetic-command'] } }, 'decline']]) {
      assert.deepEqual(await f.manager.codexRequest(entry.method, { threadId: 'native-thread', turnId: 'native-turn', ...entry.params, availableDecisions }), { decision: 'decline' });
    }
  }
  assert.equal(approvals.length, 0, 'unsupported choices must not open a prompt that cannot return the offered decision');
  assert.equal(f.events.filter(event => event.name === 'Codex approval unavailable').length, 8);
});

test('native confirmation cannot use automatic policy approval or an answer with no explicit scope', async t => {
  let response;
  const f = await fixture(t, { approveDetailed: async () => response });
  nativeApprovalState(f);
  for (const entry of nativeApprovalCases) {
    for (const scope of ['policy', undefined]) {
      response = { approved: true, ...(scope ? { scope } : {}) };
      assert.deepEqual(await f.manager.codexRequest(entry.method, { threadId: 'native-thread', turnId: 'native-turn', ...entry.params }),
        entry.kind === 'elevate' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' });
    }
  }
});

test('native network confirmations also remain explicit under Full access', async t => {
  const approvals = [], f = await fixture(t, { getPermissionMode: () => 'full', approveDetailed: async request => { approvals.push(request); return { approved: true, scope: 'once' }; } });
  nativeApprovalState(f);
  assert.deepEqual(await f.manager.codexRequest('item/commandExecution/requestApproval', {
    threadId: 'native-thread', turnId: 'native-turn', command: 'synthetic-client', networkApprovalContext: { protocol: 'https', host: 'fixture.example' },
  }), { decision: 'accept' });
  assert.equal(approvals[0].requireConfirmation, true); assert.equal(approvals[0].allowSession, true);
  assert.deepEqual(approvals[0].action, { kind: 'network', tool: 'codex.network', target: 'fixture.example' });
});

test('native approvals reject stale or ended turns and tool-free helpers before showing a prompt', async t => {
  let prompts = 0;
  const f = await fixture(t, { approveDetailed: async () => { prompts++; return { approved: true }; } });
  const state = nativeApprovalState(f);
  for (const entry of nativeApprovalCases) {
    await assert.rejects(f.manager.codexRequest(entry.method, { threadId: 'native-thread', turnId: 'older-turn', ...entry.params }), /previous native turn/);
  }
  assert.equal(prompts, 0);
  state.turnEnded = true;
  for (const entry of nativeApprovalCases) {
    await assert.rejects(f.manager.codexRequest(entry.method, { threadId: 'native-thread', turnId: 'native-turn', ...entry.params }), /native turn has ended/);
  }
  assert.equal(prompts, 0);
  state.turnEnded = false;
  state.noTools = true;
  for (const entry of nativeApprovalCases) {
    await assert.rejects(f.manager.codexRequest(entry.method, { threadId: 'native-thread', turnId: 'native-turn', ...entry.params }), /tool-free helper/);
  }
  assert.equal(prompts, 0);
});

test('an approval answer arriving after Stop, turn end, turn replacement or conversation replacement cannot authorize work', async t => {
  for (const change of ['stop', 'end', 'turn', 'conversation']) {
    for (const entry of nativeApprovalCases) {
      let finishApproval;
      const f = await fixture(t, { approveDetailed: () => new Promise(resolve => { finishApproval = resolve; }) });
      const state = nativeApprovalState(f);
      const result = f.manager.codexRequest(entry.method, { threadId: 'native-thread', turnId: 'native-turn', ...entry.params });
      assert.equal(typeof finishApproval, 'function');
      if (change === 'stop') state.cancelled = true;
      if (change === 'end') state.turnEnded = true;
      if (change === 'turn') state.turnId = 'replacement-turn';
      if (change === 'conversation') f.manager.active.set(state.conversationId, { ...state });
      finishApproval({ approved: true, scope: 'once' });
      assert.deepEqual(await result, entry.kind === 'elevate' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' }, `${entry.method} cannot use approval after ${change}`);
    }
  }
});

test('a resumed old Full-access never thread is replaced before continuing with native confirmations', async t => {
  const requests = [], f = await fixture(t, { getPermissionMode: () => 'full' });
  f.setHandler(child => codexServer(child, requests, {
    session: (params, _id, method) => ({ ...codexSession(params, method === 'thread/resume' ? 'old-full-thread' : 'fresh-full-thread'), ...(method === 'thread/resume' ? { approvalPolicy: 'never' } : {}) }),
    turn(message) { if (message.method === 'turn/start') notification(child, 'turn/completed', { threadId: 'fresh-full-thread', turn: { status: 'completed', items: [] } }); },
  }));
  const checkpoint = 'Original cleanup remains pending; nothing was deleted. Continue after permission recovery.';
  const result = await f.manager.run({ provider: 'codex', conversationId: 'full-migration', sessionId: 'old-full-thread', prompt: 'Continue', recoveryPrompt: checkpoint });
  assert.equal(result.sessionId, 'fresh-full-thread');
  const starts = requests.filter(request => request.method === 'thread/start'), turns = requests.filter(request => request.method === 'turn/start');
  assert.equal(starts.length, 1); assert.equal(turns.length, 1);
  assert.equal(starts[0].params.approvalPolicy, 'on-request'); assert.equal(starts[0].params.sandbox, 'danger-full-access');
  assert.equal(turns[0].params.threadId, 'fresh-full-thread'); assert.equal(turns[0].params.approvalPolicy, 'on-request');
  assert.equal(turns[0].params.input[0].text, checkpoint);
  assert.ok(requests.indexOf(starts[0]) < requests.indexOf(turns[0]), 'replacement permissions are checked before starting a turn');
});

test('old Full-access never threads cannot continue when replacement keeps returning never', async t => {
  const requests = [], f = await fixture(t, { getPermissionMode: () => 'full' });
  f.setHandler(child => codexServer(child, requests, { session: (params, _id, method) => ({ ...codexSession(params, method === 'thread/resume' ? 'old-full-thread' : 'fresh-full-thread'), approvalPolicy: 'never' }) }));
  await assert.rejects(f.manager.run({ provider: 'codex', conversationId: 'full-migration-blocked', sessionId: 'old-full-thread', prompt: 'Do not act', recoveryPrompt: 'Synthetic completed-work checkpoint' }), error => {
    assert.equal(error.code, 'codexPermissionMismatch');
    assert.match(error.message, /on-request/); assert.match(error.message, /after one fresh-thread attempt/);
    return true;
  });
  assert.equal(requests.filter(request => request.method === 'thread/start').length, 1);
  assert.equal(requests.some(request => request.method === 'turn/start'), false);
});

test('Codex recovers a mismatched resume once with the same settings and completed-work context',async t=>{
  const requests=[],f=await fixture(t,{getPermissionMode:()=> 'full',toolDefinitions:[{name:'workspace_read',description:'Synthetic read',inputSchema:{type:'object'}}]});
  f.setHandler(child=>codexServer(child,requests,{session:(params,_id,method)=>({...codexSession(params,method==='thread/start'?'fresh-thread':'old-thread'),...(method==='thread/resume'?{sandbox:{type:'readOnly'}}:{})}),turn(message){if(message.method==='turn/start')notification(child,'turn/completed',{threadId:'fresh-thread',turn:{status:'completed',items:[]}});}}));
  const prompt='Conversation: Build and publish. Completed-work checkpoint: published successfully; do not publish again. Current request: fix the follow-up.';
  const result=await f.manager.run({provider:'codex',conversationId:'recovery',sessionId:'old-thread',prompt:'Continue',recoveryPrompt:prompt});
  assert.equal(result.sessionId,'fresh-thread');assert.equal(requests.filter(r=>r.method==='thread/start').length,1);assert.equal(requests.filter(r=>r.method==='turn/start').length,1);
  const resumed=requests.find(r=>r.method==='thread/resume').params,started=requests.find(r=>r.method==='thread/start').params,turn=requests.find(r=>r.method==='turn/start').params;
  for(const field of ['cwd','sandbox','approvalPolicy','approvalsReviewer','config'])assert.deepEqual(started[field],resumed[field]);
  assert.equal(turn.threadId,'fresh-thread');assert.equal(turn.input[0].text,prompt);assert.equal(turn.sandboxPolicy.type,'dangerFullAccess');
  assert.equal(started.dynamicTools[0].name,'workspace_read');assert.ok(f.events.some(event=>event.name==='Codex permission recovery'));
  await assert.rejects(f.manager.codexRequest('item/tool/call',{threadId:'fresh-thread',tool:'workspace_read'}),/No active conversation/);
});

test('Codex stops after one persistent mismatch and reports requested, resumed and fresh permissions',async t=>{
  const requests=[],f=await fixture(t,{getPermissionMode:()=> 'full'});
  f.setHandler(child=>codexServer(child,requests,{session:(params,_id,method)=>({...codexSession(params,method==='thread/start'?'fresh-thread':'old-thread'),sandbox:{type:'readOnly'}})}));
  await assert.rejects(f.manager.run({provider:'codex',conversationId:'persistent',sessionId:'old-thread',prompt:'Continue',recoveryPrompt:'Completed task checkpoint'}),error=>{
    assert.match(error.message,/Requested:.*dangerFullAccess/s);assert.match(error.message,/Effective:.*readOnly/s);assert.match(error.message,/after one fresh-thread attempt:.*readOnly/s);assert.doesNotMatch(error.message,/sandbox setup|repair Windows/i);return true;
  });
  assert.equal(requests.filter(r=>r.method==='thread/resume').length,1);assert.equal(requests.filter(r=>r.method==='thread/start').length,1);assert.equal(requests.some(r=>r.method==='turn/start'),false);
});

test('Codex does not restart an already active resumed thread or a turn that has begun',async t=>{
  const requests=[],f=await fixture(t);
  f.setHandler(child=>codexServer(child,requests,{session:params=>({...codexSession(params),thread:{id:'thread-test',status:{type:'active'}},sandbox:{type:'readOnly'}})}));
  await assert.rejects(f.manager.run({provider:'codex',conversationId:'busy',sessionId:'thread-test',prompt:'Continue',recoveryPrompt:'Checkpoint'}),/may still be running/);
  assert.equal(requests.some(r=>r.method==='thread/start'||r.method==='turn/start'),false);
  const later=[],second=await fixture(t);second.setHandler(child=>codexServer(child,later,{turn(message){if(message.method==='turn/start')notification(child,'turn/completed',{turn:{status:'failed',error:{message:'Incompatible permissions during turn.'}}});}}));
  await assert.rejects(second.manager.run({provider:'codex',conversationId:'started',sessionId:'thread-test',prompt:'Continue'}),/Incompatible permissions/);
  assert.equal(later.filter(r=>r.method==='turn/start').length,1);assert.equal(later.some(r=>r.method==='thread/start'),false);
});

test('Codex recovery preserves native visible history when no host checkpoint is supplied and reports failed fresh creation',async t=>{
  for(const fails of [false,true]){
    const requests=[],f=await fixture(t);f.manager.validateEffort=async()=>null;f.manager.validateSpeed=async()=>null;
    f.manager.getCodex=async()=>({request:async(method,params)=>{
      requests.push({method,params});
      if(method==='account/read')return {account:{type:'chatgpt'}};
      if(method==='thread/resume')return {...codexSession(params,'old'),sandbox:{type:'readOnly'}};
      if(method==='thread/read')return {thread:{id:'old',turns:[{id:'prior',status:'completed',items:[{type:'agentMessage',text:'Original task complete.'},{type:'commandExecution',status:'completed',aggregatedOutput:'Published once.'}]}]}};
      if(method==='thread/start'){if(fails)throw Error('Synthetic creation failure.');return codexSession(params,'fresh');}
      if(method==='turn/start'){setImmediate(()=>f.manager.codexNotification('turn/completed',{threadId:'fresh',turn:{status:'completed',items:[]}}));return {turn:{id:'new-turn'}};}
      throw Error('Unexpected request '+method);
    }});
    const work=f.manager.run({provider:'codex',conversationId:'native-history',sessionId:'old',prompt:'Fix the follow-up'});
    if(fails)await assert.rejects(work,/Requested:.*Effective:.*Recovery failed: Synthetic creation failure/s);
    else{
      assert.equal((await work).sessionId,'fresh');const input=requests.find(r=>r.method==='turn/start').params.input[0].text;
      assert.match(input,/Original task complete/);assert.match(input,/Published once/);assert.match(input,/Fix the follow-up/);
    }
    assert.equal(requests.filter(r=>r.method==='thread/start').length,1);
    if(fails)assert.equal(requests.some(r=>r.method==='turn/start'),false);
  }
});

test('official realtime notifications reach their own subscription listener without an active coding turn',async t=>{
  const requests=[],f=await fixture(t);f.setHandler(child=>codexServer(child,requests));const events=[];
  const unsubscribe=f.manager.onRealtime((method,params)=>events.push({method,params}));await f.manager.getCodex();
  notification(f.children[0],'thread/realtime/sdp',{sdp:'v=0 synthetic answer'});notification(f.children[0],'thread/realtime/item/completed',{item:{id:'voice',type:'transcriptSegment',role:'user',text:'Hello'}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(events.length,2);assert.equal(f.manager.active.size,0);assert.equal(requests.some(request=>request.method==='turn/start'),false);
  unsubscribe();notification(f.children[0],'thread/realtime/closed',{reason:'requested'});await new Promise(resolve=>setImmediate(resolve));assert.equal(events.length,2);
});

test('Codex live steering targets the active turn without interrupting or starting another turn', async t => {
  const requests = [], f = await fixture(t);
  f.setHandler(child => codexServer(child, requests));
  const original = f.manager.run({ provider: 'codex', conversationId: 'live', prompt: 'Continue the original task.' });
  while (!f.manager.active.get('live')?.turnId) await new Promise(resolve => setImmediate(resolve));
  const before = f.manager.active.get('live');
  assert.equal(await f.manager.steer('live', { prompt: 'How far along are you? Continue afterwards.', messageId: 'followup-1', images: [{ mimeType: 'image/png', dataBase64: TINY_PNG }] }), true);
  const sent = requests.find(r => r.method === 'turn/steer').params;
  assert.equal(sent.expectedTurnId, 'turn-test'); assert.equal(sent.threadId, 'thread-test'); assert.equal(sent.clientUserMessageId, 'followup-1');
  assert.equal(sent.input[1].url, `data:image/png;base64,${TINY_PNG}`);
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(requests.filter(r => r.method === 'turn/interrupt').length, 0);
  assert.equal(f.manager.active.get('live'), before); assert.equal(before.cancelled, false);
  notification(f.children[0], 'item/agentMessage/delta', { itemId: 'answer', delta: 'The build is running. Continuing the task.' });
  notification(f.children[0], 'turn/completed', { turn: { status: 'completed' } });
  assert.match((await original).text, /Continuing the task/);
  assert.equal(await f.manager.steer('live', { prompt: 'Too late.' }), false);
});

test('host-only Codex research keeps its browser capability while disabling native tools and personal project context',async t=>{
  const requests=[],tools=[{name:'browser_snapshot',description:'Read selected browser',inputSchema:{type:'object',properties:{}}}];
  const f=await fixture(t,{getPermissionMode:()=> 'read-only'});f.setHandler(child=>codexServer(child,requests,{turn(message){if(message.method==='turn/start')notification(child,'turn/completed',{turn:{status:'completed'}});}}));
  await f.manager.run({provider:'codex',conversationId:'research',prompt:'Synthetic research',toolDefinitions:tools,hostToolsOnly:true,noPersistence:true});
  const start=requests.find(r=>r.method==='thread/start').params;
  assert.deepEqual(start.dynamicTools.map(tool=>tool.name),['browser_snapshot']);assert.equal(start.config.features.shell_tool,false);assert.equal(start.config.features.multi_agent,false);assert.equal(start.config.features.apps,false);assert.equal(start.config.features.memories,false);assert.equal(start.config.project_doc_max_bytes,0);assert.equal(start.config.web_search,'disabled');
});
test('host-only Claude research exposes only selected MCP tools and suppresses native tools and project memory',async t=>{
  let args,env;const tools=[{name:'browser_snapshot',description:'Read selected browser',inputSchema:{type:'object'}}],f=await fixture(t,{getPermissionMode:()=> 'read-only'});
  f.manager.claudeStatus=async()=>({connected:true});f.setHandler((child,received,options)=>{args=received;env=options.env;setImmediate(()=>{child.json({type:'result',subtype:'success',result:'Synthetic result',session_id:'research'});child.finish();});});
  await f.manager.run({provider:'claude',conversationId:'research',prompt:'Synthetic research',toolDefinitions:tools,hostToolsOnly:true,noPersistence:true});
  assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(args.includes('mcp__exomina__browser_snapshot'));assert.ok(!args.includes('--bare'));assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,'1');assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,'1');assert.ok(args.includes('--strict-mcp-config'));assert.ok(!args.includes('--permission-prompt-tool'));
});
test('Codex helper threads disable native tools and have no host tools',async t=>{const requests=[];const f=await fixture(t,{getPermissionMode:()=> 'read-only'});f.setHandler(child=>codexServer(child,requests,{turn(message){if(message.method==='turn/start')notification(child,'turn/completed',{turn:{status:'completed'}});}}));await f.manager.run({provider:'codex',conversationId:'helper',prompt:'Synthetic review',toolDefinitions:[],noTools:true,ephemeral:true});const start=requests.find(r=>r.method==='thread/start').params;assert.deepEqual(start.dynamicTools,[]);assert.equal(start.config.features.shell_tool,false);assert.equal(start.config.features.multi_agent,false);assert.equal(start.config.features.image_generation,false);assert.equal(start.ephemeral,true);assert.equal(start.config.web_search,'disabled');});
test('Claude helper requests disable built-in tools and per-run host tools',async t=>{let args;const f=await fixture(t,{getPermissionMode:()=> 'read-only',toolDefinitions:[{name:'workspace_write',description:'Write',inputSchema:{type:'object'}}]});f.manager.claudeStatus=async()=>({connected:true});f.setHandler((child,received)=>{args=received;setImmediate(()=>{child.json({type:'result',subtype:'success',result:'Review',session_id:'helper-session'});child.finish();});});await f.manager.run({provider:'claude',conversationId:'helper',prompt:'Synthetic review',toolDefinitions:[],noTools:true});assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(!args.includes('--allowedTools'));});

test('temporary Codex requests use in-memory threads, disable project context and release subscriptions',async t=>{const requests=[];const f=await fixture(t,{getPermissionMode:()=> 'read-only'});f.setHandler(child=>codexServer(child,requests,{turn(message){if(message.method==='turn/start')notification(child,'turn/completed',{turn:{status:'completed'}});}}));await f.manager.run({provider:'codex',conversationId:'temporary',prompt:'Synthetic temporary chat',toolDefinitions:[],noTools:true,noPersistence:true});const start=requests.find(r=>r.method==='thread/start').params;assert.equal(start.ephemeral,true);assert.equal(start.config.project_doc_max_bytes,0);assert.deepEqual(start.dynamicTools,[]);assert.equal(start.config.features.memories,false);assert.equal(start.config.features.multi_agent,false);assert.ok(requests.some(r=>r.method==='thread/unsubscribe'));});
test('temporary Claude requests keep the subscription sign-in, suppress project memory and skip session persistence',async t=>{let args,env;const f=await fixture(t);f.manager.claudeStatus=async()=>({connected:true});f.setHandler((child,received,options)=>{args=received;env=options.env;setImmediate(()=>{child.json({type:'result',subtype:'success',result:'Hello',session_id:'temporary-session'});child.finish();});});await f.manager.run({provider:'claude',conversationId:'temporary',prompt:'Synthetic temporary chat',toolDefinitions:[],noTools:true,noPersistence:true});assert.ok(!args.includes('--bare'),'--bare makes Claude ignore OAuth sign-in');assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,'1');assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,'1');assert.ok(env.CLAUDE_CONFIG_DIR);assert.ok(args.includes('--no-session-persistence'));assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(!args.includes('--resume'));});
test('Codex and Claude send uploaded screenshot pixels as native image input', async t => {
  const image = { mimeType: 'image/png', dataBase64: TINY_PNG };
  const f = await fixture(t), requests = [];
  f.setHandler(child => codexServer(child, requests, { turn(message) { if (message.method === 'turn/start') notification(child, 'turn/completed', { turn: { status: 'completed' } }); } }));
  await f.manager.run({ provider: 'codex', conversationId: 'image-input', prompt: 'Inspect screenshot', images: [image] });
  assert.deepEqual(requests.find(item => item.method === 'turn/start').params.input[1], { type: 'image', url: `data:image/png;base64,${TINY_PNG}` });
  let received = '', imageArgs;
  f.setHandler((child, args) => {
    child.stdin.on('data', data => { received += data; });
    onClaudeInput(child, args, () => {
      if (args[0] === 'auth') child.json({ loggedIn: true, authMethod: 'claude.ai' });
      else { imageArgs = args; child.json({ type: 'result', subtype: 'success', result: 'Inspected', session_id: 's1' }); }
      child.finish();
    });
  });
  await f.manager.run({ provider: 'claude', conversationId: 'claude-image-input', prompt: 'Inspect screenshot', images: [image] });
  assert.ok(imageArgs.includes('--input-format'));
  assert.deepEqual(JSON.parse(received).message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } });
});

test('subscription environment isolates credentials and removes API/provider overrides without mutating parent', () => {
  const parent = { PATH: 'safe-path', USERPROFILE: 'profile', OPENAI_API_KEY: 'secret', CODEX_HOME: 'existing',
    ANTHROPIC_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'https://untrusted', CLAUDE_CONFIG_DIR: 'existing', CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    CLAUDECODE: '1', AWS_ACCESS_KEY_ID: 'secret', AZURE_OPENAI_API_KEY: 'secret', GOOGLE_APPLICATION_CREDENTIALS: 'secret',
    EXOMINA_GOOGLE_CLIENT_SECRET: 'server-secret', EXOMINA_TOOL_TOKEN: 'server-token' };
  const codex = subscriptionEnvironment('codex', 'new-data', parent);
  const claude = subscriptionEnvironment('claude', 'new-data', parent);
  assert.equal(codex.CODEX_HOME, path.join('new-data', 'codex-home'));
  assert.equal(claude.CLAUDE_CONFIG_DIR, path.join('new-data', 'claude-home'));
  assert.equal(claude.PATH, 'safe-path');
  for (const env of [codex, claude]) for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(env[key], path.join('new-data', 'runtime-tmp'));
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'EXOMINA_GOOGLE_CLIENT_SECRET', 'EXOMINA_TOOL_TOKEN']) {
    assert.equal(claude[key], undefined); assert.equal(codex[key], undefined);
  }
  assert.equal(parent.ANTHROPIC_API_KEY, 'secret');
});

test('Codex refuses API-key authentication before sending a prompt', async t => {
  const f = await fixture(t); const requests = [];
  f.setHandler(child => codexServer(child, requests, { account: { type: 'apiKey' } }));
  await assert.rejects(f.manager.run({ provider: 'codex', prompt: 'never sent', conversationId: 'c1' }), /ChatGPT subscription/);
  assert.equal(requests.some(r => r.method === 'thread/start' || r.method === 'turn/start'), false);
  assert.equal(f.calls[0].options.shell, false);
});

test('Codex streams text, calls shared tools, maps image results, asks for command approval, and denies unknown server methods', async t => {
  const approvals = [], toolCalls = [], requests = [];
  const f = await fixture(t, {
    toolDefinitions: [{ name: 'browser_snapshot', description: 'Synthetic snapshot', inputSchema: { type: 'object' } }],
    approve: async request => { approvals.push(request); return false; },
    callTool: async (...args) => { toolCalls.push(args); return { content: [{ type: 'text', text: 'Synthetic' }, { type: 'image', mimeType: 'image/png', data: 'dGVzdA==' }] }; },
  });
  f.setHandler(child => codexServer(child, requests, { turn(message) {
    if (message.method === 'turn/start') {
      notification(child, 'item/agentMessage/delta', { itemId: 'm1', delta: 'Hello ' });
      child.json({ id: 'tool-1', method: 'item/tool/call', params: { threadId: 'thread-test', turnId: 'turn-test', callId: 'call-1', tool: 'browser_snapshot', arguments: { tab: 1 } } });
    } else if (message.id === 'tool-1') {
      child.json({ id: 'approve-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-test', command: 'echo synthetic', cwd: 'workspace', reason: 'Test' } });
    } else if (message.id === 'approve-1') {
      child.json({ id: 'unknown-1', method: 'unknown/unsafe', params: { threadId: 'thread-test' } });
    } else if (message.id === 'unknown-1') {
      notification(child, 'item/agentMessage/delta', { itemId: 'm1', delta: 'world' });
      notification(child, 'item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'Hello world' } });
      notification(child, 'turn/completed', { turn: { id: 'turn-test', status: 'completed', items: [] } });
    }
  } }));
  const result = await f.manager.run({ provider: 'codex', conversationId: 'c1', prompt: 'synthetic', model: 'auto' });
  assert.deepEqual(result, { sessionId: 'thread-test', text: 'Hello world' });
  assert.equal(f.events.filter(e => e.type === 'chat.delta').map(e => e.text).join(''), 'Hello world');
  assert.deepEqual(toolCalls[0].slice(0, 3), ['browser_snapshot', { tab: 1 }, 'c1']);
  assert.equal(toolCalls[0][3].nativeThreadId, 'thread-test');
  assert.equal(toolCalls[0][3].nativeTurnId, 'turn-test');
  assert.equal(typeof toolCalls[0][3].isActive, 'function');
  assert.equal(approvals[0].conversationId, 'c1');
  assert.equal(requests.find(r => r.id === 'approve-1').result.decision, 'decline');
  assert.equal(requests.find(r => r.id === 'unknown-1').error.code, -32601);
  assert.deepEqual(requests.find(r => r.id === 'tool-1').result.contentItems[1], { type: 'inputImage', imageUrl: 'data:image/png;base64,dGVzdA==' });
  const start = requests.find(r => r.method === 'thread/start');
  assert.equal(start.params.dynamicTools[0].type, 'function');
  assert.equal(start.params.sandbox, 'workspace-write');
  assert.equal(start.params.approvalPolicy, 'untrusted');
  assert.equal(start.params.model, undefined);
  assert.equal(start.params.config.projects[path.join(f.dataDir, 'workspace')].trust_level, 'trusted');
});

test('Codex resumes an explicit session and reports provider failures', async t => {
  const f = await fixture(t); const requests = [];
  f.setHandler(child => codexServer(child, requests, { turn(message) {
    if (message.method === 'turn/start') notification(child, 'turn/completed', { turn: { id: 'turn-test', status: 'failed', error: { message: 'Quota reached' } } });
  } }));
  await assert.rejects(f.manager.run({ provider: 'codex', conversationId: 'c1', sessionId: 'thread-test', prompt: 'synthetic' }), /Quota reached/);
  assert.equal(requests.some(r => r.method === 'thread/start'), false);
  assert.equal(requests.find(r => r.method === 'thread/resume').params.threadId, 'thread-test');
});

test('Codex early usage errors retain the run until native tools have stopped, before fallback can begin', async t => {
  const f = await fixture(t), requests = []; let release;
  f.setHandler(child => codexServer(child, requests, { turn(message) {
    if (message.method === 'turn/start') notification(child, 'error', { error: { message: 'Included allowance depleted', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false });
    if (message.method === 'turn/interrupt') release = () => notification(child, 'turn/completed', { turn: { status: 'interrupted' } });
  } }));
  let finished = false;
  const run = f.manager.run({ provider: 'codex', conversationId: 'handoff', prompt: 'synthetic' }); run.catch(() => { finished = true; });
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(finished, false); assert.equal(f.manager.active.has('handoff'), true);
  release(); await assert.rejects(run, error => error.code === 'usageLimitExceeded');
  assert.equal(f.manager.active.has('handoff'), false);
});

test('Stop during a native usage handoff remains immediate and cannot cause another attempt', async t => {
  const f = await fixture(t), requests = []; let interrupting = false;
  f.setHandler(child => codexServer(child, requests, { turn(message) {
    if (message.method === 'turn/start') notification(child, 'error', { error: { message: 'Allowance depleted', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false });
    if (message.method === 'turn/interrupt') interrupting = true;
  } }));
  const run = f.manager.run({ provider: 'codex', conversationId: 'handoff-stop', prompt: 'synthetic' }); run.catch(() => {});
  while (!interrupting) await new Promise(resolve => setTimeout(resolve, 5));
  f.manager.cancel('handoff-stop'); await assert.rejects(run, /Stopped/);
  assert.equal(f.manager.active.has('handoff-stop'), false);
});

test('usage polling requests counts only and manual redemption uses one validated request without retries or model turns', async t => {
  const f = await fixture(t), requests = [];
  f.setHandler(child => codexServer(child, requests));
  await f.manager.codexUsage({ publish: false });
  await f.manager.codexUsage({ publish: false, details: true });
  assert.deepEqual(requests.filter(r => r.method === 'account/rateLimits/read').map(r => r.params), [{ excludeResetCreditDetails: true }, { excludeResetCreditDetails: false }]);
  const key = '12345678-1234-1234-1234-123456789abc';
  await f.manager.consumeCodexReset(key);
  await f.manager.consumeCodexReset(key, 'exact-credit-id');
  await assert.rejects(f.manager.consumeCodexReset('invalid'), /Invalid reset/);
  await assert.rejects(f.manager.consumeCodexReset(key, ''), /Invalid usage reset selection/);
  await assert.rejects(f.manager.consumeCodexReset(key, { id: 'invalid' }), /Invalid usage reset selection/);
  assert.deepEqual(requests.filter(r => r.method === 'account/rateLimitResetCredit/consume').map(r => r.params), [{ idempotencyKey: key }, { idempotencyKey: key, creditId: 'exact-credit-id' }]);
  assert.equal(requests.some(r => r.method === 'turn/start'), false);
});

test('Codex cancellation interrupts its active turn and releases the conversation', async t => {
  const f = await fixture(t); const requests = [];
  let started; const ready = new Promise(resolve => { started = resolve; });
  f.setHandler(child => codexServer(child, requests, { turn(message) { if (message.method === 'turn/start') started(); } }));
  const running = f.manager.run({ provider: 'codex', conversationId: 'c1', prompt: 'synthetic' });
  await ready; f.manager.cancel('c1');
  await assert.rejects(running, /Stopped/);
  assert.ok(requests.some(r => r.method === 'turn/interrupt'));
  assert.equal(f.manager.active.has('c1'), false);
});

test('Claude blocks non-subscription authentication without invoking inference', async t => {
  const f = await fixture(t);
  f.setHandler((child, args) => { child.stdin.on('finish', () => { assert.deepEqual(args, ['auth', 'status']); child.json({ loggedIn: true, authMethod: 'api_key' }); child.finish(); }); });
  await assert.rejects(f.manager.run({ provider: 'claude', conversationId: 'c1', prompt: 'never sent' }), /subscription login/);
  assert.equal(f.calls.length, 1);
});

test('Claude sign-in forwards a delayed official URL once after the initial connection response', async t => {
  const f = await fixture(t);
  const initial = await f.manager.connect('claude');
  assert.equal(initial.url, undefined);
  assert.deepEqual(f.calls[0].args, ['auth', 'login']);
  const url = 'https://claude.ai/oauth/authorize?synthetic=1';
  f.children[0].stdout.write(`Open this URL: ${url}\n`);
  f.children[0].stderr.write(`Browser fallback: ${url}\n`);
  assert.deepEqual(f.events.filter(event => event.type === 'auth.url'), [{ type: 'auth.url', provider: 'claude', url }]);
  const closed = new Promise(resolve => f.children[0].once('close', resolve));
  f.children[0].finish();
  await closed;
  assert.equal(f.manager.loginProcesses.has('claude'), false);
});

test('Claude uses isolated subscription auth, an app MCP gateway, streams without duplicate text, and returns result session', async t => {
  const f = await fixture(t); let savedConfig;
  f.manager.toolDefinitions.push({name:'memory_note',inputSchema:{type:'object'}},{name:'conversation_read',inputSchema:{type:'object'}});
  f.setHandler((child, args, options) => {
    onClaudeInput(child, args, async () => {
      if (args[0] === 'auth') { child.json({ loggedIn: true, authMethod: 'claude.ai' }); child.finish(); return; }
      assert.equal(options.shell, false);
      const configPath = args[args.indexOf('--mcp-config') + 1];
      savedConfig = JSON.parse(await readFile(configPath, 'utf8'));
      child.json({ type: 'system', subtype: 'init', session_id: 'claude-session' });
      child.json({ type: 'stream_event', event: { type: 'message_start' } });
      child.json({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Hallo 嫌' } } });
      child.json({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hallo 嫌' }] } });
      child.json({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__exomina__browser_snapshot', input: {} }] } });
      child.json({ type: 'result', subtype: 'success', result: 'Hallo 嫌', session_id: 'claude-session' });
      child.finish();
    });
  });
  const result = await f.manager.run({ provider: 'claude', conversationId: 'c1', prompt: 'synthetic', sessionId: 'resume-id', model: 'auto' });
  assert.deepEqual(result, { sessionId: 'claude-session', text: 'Hallo 嫌' });
  assert.equal(f.events.filter(e => e.type === 'chat.delta').map(e => e.text).join(''), 'Hallo 嫌');
  assert.equal(savedConfig.mcpServers.exomina.env.EXOMINA_TOOL_CONVERSATION, 'c1');
  assert.equal(savedConfig.mcpServers.exomina.env.ELECTRON_RUN_AS_NODE, '1');
  const args = f.calls[1].args;
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
  assert.equal(args[args.indexOf('--resume') + 1], 'resume-id');
  assert.equal(args.includes('--bare'), false);
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.equal(args.includes('--model'), false);
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'mcp__exomina__request_permission');
  assert.ok(args.includes('--allowedTools'));
  assert.ok(args.includes('mcp__exomina__memory_note'));
  assert.ok(args.includes('mcp__exomina__conversation_read'));
  assert.equal(args.includes('mcp__exomina__browser_snapshot'),false);
  await assert.rejects(readFile(args[args.indexOf('--mcp-config') + 1]), { code: 'ENOENT' });
});

test('Claude surfaces streamed provider errors even when process exits zero', async t => {
  const f = await fixture(t);
  f.setHandler((child, args) => onClaudeInput(child, args, () => {
    if (args[0] === 'auth') child.json({ loggedIn: true, authMethod: 'claude.ai' });
    else child.json({ type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Subscription limit reached'] });
    child.finish();
  }));
  await assert.rejects(f.manager.run({ provider: 'claude', conversationId: 'c1', prompt: 'synthetic' }), /Subscription limit reached/);
});

test('RPC process rejects pending requests on malformed protocol instead of hanging', async () => {
  const child = new Child();
  const rpc = new JsonRpcProcess(child);
  const request = rpc.request('initialize', {}, 1000);
  child.stdout.write('not-json\n');
  await assert.rejects(request, /invalid JSON/);
  assert.equal(child.killed, true);
});

test('Codex does not report success for missing or unexpected completed-turn status', async t => {
  const f = await fixture(t); const requests = [];
  f.setHandler(child => codexServer(child, requests, { turn(message) {
    if (message.method === 'turn/start') notification(child, 'turn/completed', { turn: { id: 'turn-test', items: [] } });
  } }));
  await assert.rejects(f.manager.run({ provider: 'codex', conversationId: 'c1', prompt: 'synthetic' }), /unexpected completion status/);
});

function claudeMetadata(child, requests, models) {
  child.stdin.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const request = JSON.parse(line); requests.push(request);
      queueMicrotask(() => child.json({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models } } }));
    }
  });
}

test('subscription discovery reads native metadata without starting turns and preserves dynamic Codex efforts', async t => {
  const f = await fixture(t); const codexRequests = [], claudeRequests = [];
  const model = { id: 'display-id', model: 'native-model', displayName: 'Native model', isDefault: true, defaultReasoningEffort: 'ultra', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }, { reasoningEffort: 'medium' }] };
  f.setHandler((child, args) => {
    if (args[0] === 'app-server') codexServer(child, codexRequests, { models: params => params.cursor ? { data: [{ ...model, model: 'other-model', isDefault: false }, { ...model, model: 'hidden', hidden: true }], nextCursor: null } : { data: [model], nextCursor: 'next' } });
    else claudeMetadata(child, claudeRequests, [
      { value: 'default', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'max'] },
      { value: 'haiku', displayName: 'Haiku' }, { value: 'fable', displayName: 'Credits model' }, { value: 'best' },
    ]);
  });
  const result = await f.manager.subscriptionModels();
  assert.deepEqual(result.codex.map(model => model.id), ['native-model', 'other-model']);
  assert.equal(result.codex[0].defaultEffort, 'ultra');
  assert.deepEqual(result.codex[0].efforts.map(e => e.id), ['ultra', 'medium']);
  if(getProvider('claude')){assert.deepEqual(result.claude.map(model => model.id), ['default', 'haiku']);assert.deepEqual(result.claude[1].efforts, []);}
  else assert.equal(result.claude,undefined,'Beta discovery omits the unshipped runtime.');
  assert.deepEqual(codexRequests.filter(m => m.method === 'model/list').map(m => m.params), [{ limit: 100, includeHidden: false }, { limit: 100, includeHidden: false, cursor: 'next' }]);
  assert.equal(codexRequests.some(m => m.method === 'turn/start'), false);
  assert.equal(claudeRequests.length, getProvider('claude')?1:0);
  if(getProvider('claude')){assert.equal(claudeRequests[0].request.subtype, 'initialize');assert.ok(f.calls.find(call => call.args[0] === '-p').args.includes('--no-session-persistence'));}
  result.codex[0].efforts.length = 0;
  assert.equal((await f.manager.subscriptionModels()).codex[0].efforts.length, 2, 'caller mutation must not change the cache');
  assert.equal(f.calls.length, getProvider('claude')?2:1);
});

test('Codex validates model-specific effort before inference and applies it on a resumed turn', async t => {
  const f = await fixture(t); const requests = [];
  f.setHandler(child => codexServer(child, requests, { models: [{ model: 'native-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] }], turn(message) {
    if (message.method === 'turn/start') notification(child, 'turn/completed', { turn: { status: 'completed' } });
  } }));
  await assert.rejects(f.manager.run({ provider: 'codex', conversationId: 'c1', prompt: 'never sent', model: 'native-model', effort: 'high' }), /does not support/);
  assert.equal(requests.some(r => r.method === 'thread/start' || r.method === 'turn/start'), false);
  await f.manager.run({ provider: 'codex', conversationId: 'c1', prompt: 'synthetic', sessionId: 'thread-test', model: 'native-model', effort: 'ultra' });
  assert.equal(requests.find(r => r.method === 'thread/resume').params.model, 'native-model');
  assert.equal(requests.find(r => r.method === 'turn/start').params.effort, 'ultra');
});

test('Claude validates advertised effort and passes exact model and effort flags', async t => {
  const f = await fixture(t); const metadataRequests = [];
  f.setHandler((child, args) => {
    if (args.includes('--input-format') && !args.includes('--replay-user-messages')) { claudeMetadata(child, metadataRequests, [{ value: 'opus', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['low', 'xhigh'] }, { value: 'haiku' }]); return; }
    onClaudeInput(child, args, () => {
      if (args[0] === 'auth') child.json({ loggedIn: true, authMethod: 'claude.ai' });
      else child.json({ type: 'result', subtype: 'success', result: 'synthetic', session_id: 's1' });
      child.finish();
    });
  });
  await assert.rejects(f.manager.run({ provider: 'claude', conversationId: 'c1', model: 'haiku', effort: 'high', prompt: 'never sent' }), /does not support/);
  assert.equal(f.calls.some(call => call.args.includes('--permission-prompt-tool')), false);
  await f.manager.run({ provider: 'claude', conversationId: 'c1', model: 'opus', effort: 'xhigh', prompt: 'synthetic' });
  const args = f.calls.find(call => call.args.includes('--permission-prompt-tool')).args;
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
  assert.equal(metadataRequests.length, 1);
});

test('provider metadata discovery fails independently and closes on manager shutdown', async t => {
  const f = await fixture(t); const requests = [];
  f.setHandler((child, args) => {
    if (args[0] === 'app-server') codexServer(child, requests, { models: [] });
    else child.stdin.on('data', () => child.stdout.write('invalid-json\n'));
  });
  assert.deepEqual(await f.manager.subscriptionModels(), getProvider('claude')?{ codex: [], claude: [] }:{codex:[]});
  assert.equal(f.manager.metadataProcesses.size, 0);
  f.setHandler(() => {});
  const pending = f.manager.claudeModels();
  await new Promise(resolve => setTimeout(resolve, 20));
  f.manager.close();
  await assert.rejects(pending, /closed before returning/);
});

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxoAAAAASUVORK5CYII=';

test('Codex delivers only final native images once, including final-turn fallback, before run completion', async t => {
  const f = await fixture(t), requests = [];
  const image = { type: 'imageGeneration', id: 'image-one', status: 'completed', result: TINY_PNG, savedPath: '/untrusted/path/ignored.png' };
  f.setHandler(child => codexServer(child, requests, { turn(message) {
    if (message.method !== 'turn/start') return;
    notification(child, 'item/started', { item: { ...image, status: 'in_progress' } });
    notification(child, 'item/completed', { item: { ...image, status: 'in_progress' } });
    assert.equal(f.events.some(event => event.type === 'chat.image.generated'), false);
    notification(child, 'item/completed', { item: image });
    notification(child, 'item/completed', { item: image });
    notification(child, 'turn/completed', { turn: { status: 'completed', items: [image, { ...image, id: 'image-two' }] } });
  } }));
  await f.manager.run({ provider: 'codex', conversationId: 'c1', prompt: 'Generate a synthetic test image.' });
  const images = f.events.filter(event => event.type === 'chat.image.generated');
  assert.deepEqual(images.map(event => event.itemId), ['image-one', 'image-two']);
  assert.deepEqual(images[0], { type: 'chat.image.generated', provider: 'codex', conversationId: 'c1', itemId: 'image-one', dataBase64: TINY_PNG, mimeType: 'image/png' });
  assert.match(requests.find(r => r.method === 'thread/start').params.developerInstructions, /current user explicitly asks/);
  assert.match(requests.find(r => r.method === 'thread/start').params.developerInstructions, /never silently switch to an API key/);
});

test('native image result validation rejects URLs, malformed base64, non-images and failed items without leaking payloads', async t => {
  const f = await fixture(t), requests = [];
  const invalid = ['https://private.example/image.png', `data:image/png;base64,${TINY_PNG}`, TINY_PNG + '=', Buffer.from('<svg onload="secret-payload"/>').toString('base64'), 'secret-payload!'];
  f.setHandler(child => codexServer(child, requests, { turn(message) {
    if (message.method !== 'turn/start') return;
    for (const [index, result] of invalid.entries()) notification(child, 'item/completed', { item: { type: 'imageGeneration', id: `invalid-${index}`, status: 'completed', result, savedPath: '/never-read.png' } });
    notification(child, 'item/completed', { item: { type: 'imageGeneration', id: 'failure', status: 'failed', result: TINY_PNG, failure: { type: 'usageLimitExceeded', limitId: 'private-limit-id' } } });
    notification(child, 'turn/completed', { turn: { status: 'completed', items: [] } });
  } }));
  await f.manager.run({ provider: 'codex', conversationId: 'c1', prompt: 'Synthetic' });
  assert.equal(f.events.some(event => event.type === 'chat.image.generated'), false);
  assert.match(f.events.at(-1).detail, /image-generation limit/);
  const serialized = JSON.stringify(f.events);
  for (const forbidden of [...invalid, 'private-limit-id', '/never-read.png']) assert.equal(serialized.includes(forbidden), false);
});

test('native image payloads above 20 MiB are rejected within the bounded protocol limit', async t => {
  const f = await fixture(t), requests = [];
  f.setHandler(child => codexServer(child, requests, { turn(message) {
    if (message.method !== 'turn/start') return;
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1); Buffer.from(TINY_PNG, 'base64').copy(oversized);
    notification(child, 'item/completed', { item: { type: 'imageGeneration', id: 'too-large', status: 'completed', result: oversized.toString('base64') } });
    notification(child, 'turn/completed', { turn: { status: 'completed', items: [] } });
  } }));
  await f.manager.run({ provider: 'codex', conversationId: 'c1', prompt: 'Synthetic' });
  assert.equal(f.events.some(event => event.type === 'chat.image.generated'), false);
  assert.match(f.events.at(-1).detail, /oversized image/);
});

test('per-run empty Codex tool catalog is advertised and enforced, and cannot silently reuse a wider session', async t => {
  const f = await fixture(t, { toolDefinitions: [{ name: 'memory_note', description: 'Synthetic', inputSchema: { type: 'object' } }], callTool: async () => { throw Error('Must not execute'); } }), requests = [];
  f.setHandler(child => codexServer(child, requests, { turn(message) {
    if (message.method === 'turn/start') child.json({ id: 'denied-tool', method: 'item/tool/call', params: { threadId: 'thread-test', tool: 'memory_note', arguments: {} } });
    else if (message.id === 'denied-tool') notification(child, 'turn/completed', { turn: { status: 'completed', items: [] } });
  } }));
  await f.manager.run({ provider: 'codex', conversationId: 'image-subtask', prompt: 'Synthetic', toolDefinitions: [] });
  assert.deepEqual(requests.find(r => r.method === 'thread/start').params.dynamicTools, []);
  assert.match(requests.find(r => r.id === 'denied-tool').error.message, /Unknown tool/);
  await assert.rejects(f.manager.run({ provider: 'codex', conversationId: 'other', prompt: 'Synthetic', sessionId: 'old-session', toolDefinitions: [] }), /require a new native conversation/);
});

test('native image availability checks capability, feature and subscription plan without a model turn', async t => {
  for (const [account, capabilities, enabled, expected] of [
    [{ type: 'chatgpt', planType: 'plus' }, { imageGeneration: true, namespaceTools: true }, true, true],
    [{ type: 'chatgpt', planType: 'free' }, { imageGeneration: true, namespaceTools: true }, true, false],
    [{ type: 'apiKey' }, { imageGeneration: true, namespaceTools: true }, true, false],
    [{ type: 'chatgpt', planType: 'plus' }, { imageGeneration: false, namespaceTools: true }, true, false],
    [{ type: 'chatgpt', planType: 'plus' }, { imageGeneration: true, namespaceTools: true }, false, false],
  ]) {
    const f = await fixture(t), requests = [];
    f.setHandler(child => codexServer(child, requests, { account, capabilities, imageEnabled: enabled }));
    const result = await f.manager.codexImageCapabilities(account);
    assert.equal(result.available, expected); assert.equal(result.requiresImageModel, true);
    assert.equal(requests.some(r => r.method === 'turn/start'), false);
  }
});

test('resuming a native conversation excludes hydrated image-heavy turns without deleting provider history', async t => {
  const f = await fixture(t), requests = [];
  f.setHandler(child => codexServer(child, requests, { turn(message) { if (message.method === 'turn/start') notification(child, 'turn/completed', { turn: { status: 'completed', items: [] } }); } }));
  await f.manager.run({ provider: 'codex', conversationId: 'c1', prompt: 'Continue', sessionId: 'thread-test' });
  const params = requests.find(r => r.method === 'thread/resume').params;
  assert.equal(params.excludeTurns, true); assert.equal(params.threadId, 'thread-test'); assert.equal(params.history, undefined);
});

test('concurrent native image subtasks route identical item IDs to their own conversations', async t => {
  const f = await fixture(t), turns = [];
  let nextThread = 0;
  f.manager.getCodex = async () => ({ request: async (method, params) => {
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'plus' } };
    if (method === 'thread/start') return codexSession(params, `isolated-${++nextThread}`);
    if (method === 'turn/start') {
      turns.push(params.threadId);
      if (turns.length === 2) setImmediate(() => {
        for (const threadId of [...turns].reverse()) {
          f.manager.codexNotification('item/completed', { threadId, item: { type: 'imageGeneration', id: 'same-image-id', status: 'completed', result: TINY_PNG } });
          f.manager.codexNotification('turn/completed', { threadId, turn: { status: 'completed', items: [] } });
        }
      });
      return { turn: { id: `turn-${params.threadId}` } };
    }
    throw Error('Unexpected synthetic request');
  } });
  const results = await Promise.all(['first-chat', 'second-chat'].map(conversationId => f.manager.run({ provider: 'codex', conversationId, prompt: 'Synthetic image', toolDefinitions: [] })));
  assert.notEqual(results[0].sessionId, results[1].sessionId);
  assert.deepEqual(f.events.filter(event => event.type === 'chat.image.generated').map(event => event.conversationId).sort(), ['first-chat', 'second-chat']);
});

test('Claude streams thinking, tool steps with their results, and named text blocks', async t => {
  const f = await fixture(t);
  f.setHandler((child, args) => {
    onClaudeInput(child, args, () => {
      if (args[0] === 'auth') { child.json({ loggedIn: true, authMethod: 'claude.ai' }); child.finish(); return; }
      child.json({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg1' } } });
      child.json({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
      child.json({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check the theme first.' } } });
      child.json({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      child.json({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Looking.' } } });
      child.json({ type: 'assistant', message: { id: 'msg1', content: [{ type: 'thinking', thinking: 'Check the theme first.' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.css' } }] } });
      child.json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'body{}' }] }] } });
      child.json({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg2' } } });
      child.json({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it.' } } });
      child.json({ type: 'result', subtype: 'success', result: 'Found it.', session_id: 's' });
      child.finish();
    });
  });
  await f.manager.run({ provider: 'claude', conversationId: 'c2', prompt: 'synthetic' });
  const thinking = f.events.filter(e => e.type === 'chat.thinking');
  assert.deepEqual(thinking.map(e => [e.id, e.text, e.done, !!e.start]), [['msg1:0', '', false, true], ['msg1:0', 'Check the theme first.', false, false], ['msg1:0', '', true, false]]);
  assert.deepEqual(f.events.filter(e => e.type === 'chat.tool').map(e => [e.id, e.name, e.status, e.output]), [['tu1', 'Read', 'running', undefined], ['tu1', undefined, 'done', 'body{}']]);
  assert.deepEqual(f.events.filter(e => e.type === 'chat.delta').map(e => [e.block, e.text]), [['msg1', 'Looking.'], ['msg2', 'Found it.']]);
});

test('an expired Claude sign-in is retried once, and stale sign-ins start Claude processes one at a time', async t => {
  const f = await fixture(t);
  let attempts = 0, running = 0, overlap = false;
  f.setHandler((child, args) => {
    onClaudeInput(child, args, async () => {
      if (args[0] === 'auth') { child.json({ loggedIn: true, authMethod: 'claude.ai' }); child.finish(); return; }
      attempts++; running++; if (running > 1) overlap = true;
      if (attempts === 1) { running--; child.json({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }); child.finish(); return; }
      await new Promise(resolve => setTimeout(resolve, 30));
      child.json({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' + attempts } } });
      running--;
      child.json({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } });
      child.json({ type: 'result', subtype: 'success', result: 'ok', session_id: 's' + attempts });
      child.finish();
    });
  });
  const first = await f.manager.run({ provider: 'claude', conversationId: 'r1', prompt: 'synthetic' });
  assert.equal(first.text, 'ok'); assert.equal(attempts, 2);
  assert.ok(f.events.some(e => e.type === 'chat.retry' && e.conversationId === 'r1'));
  // Fresh now: parallel runs no longer wait for each other. Make the sign-in stale and check they queue.
  f.manager.claudeFreshAt = 0;
  const results = await Promise.all([f.manager.run({ provider: 'claude', conversationId: 'p1', prompt: 'a' }), f.manager.run({ provider: 'claude', conversationId: 'p2', prompt: 'b' })]);
  assert.deepEqual(results.map(r => r.text), ['ok', 'ok']);
  assert.equal(overlap, false);
});

test('Codex speeds come from advertised service tiers and apply to one turn only', async t => {
  const f = await fixture(t); const requests = [];
  const tiers = [{ id: 'fast', name: 'Fast', description: 'Faster responses; uses usage more quickly.' }, { id: 'default', name: 'Standard', description: '' }];
  f.setHandler(child => codexServer(child, requests, { models: [{ model: 'quick-model', isDefault: true, supportedReasoningEfforts: [], serviceTiers: tiers }, { model: 'plain-model', supportedReasoningEfforts: [] }], turn(message) {
    if (message.method === 'turn/start') notification(child, 'turn/completed', { turn: { status: 'completed' } });
  } }));
  const models = await f.manager.modelsFor('codex');
  assert.deepEqual(models.find(m => m.id === 'quick-model').speeds, [{ id: 'fast', label: 'Fast', description: 'Faster responses; uses usage more quickly.' }]);
  assert.deepEqual(models.find(m => m.id === 'plain-model').speeds, []);
  await assert.rejects(f.manager.run({ provider: 'codex', conversationId: 'c1', prompt: 'never sent', model: 'plain-model', speed: 'fast' }), /does not offer that speed/);
  assert.equal(requests.some(r => r.method === 'turn/start'), false);
  await f.manager.run({ provider: 'codex', conversationId: 'c1', prompt: 'synthetic', model: 'quick-model', speed: 'fast' });
  await f.manager.run({ provider: 'codex', conversationId: 'c2', prompt: 'synthetic', model: 'quick-model', speed: 'standard' });
  await f.manager.run({ provider: 'codex', conversationId: 'c3', prompt: 'synthetic', model: 'quick-model' });
  const turns = requests.filter(r => r.method === 'turn/start').map(r => r.params);
  assert.equal(turns[0].serviceTierForTurn, 'fast');
  assert.equal(turns[1].serviceTierForTurn, 'default');
  assert.equal('serviceTierForTurn' in turns[2], false);
  assert.equal(turns.some(turn => 'serviceTier' in turn), false);
  assert.ok(f.events.some(e => e.type === 'chat.timing' && e.conversationId === 'c1'));
});

test('Claude fast mode is offered only where advertised, is opted in per run and reports when it was not applied', async t => {
  const f = await fixture(t); const metadataRequests = [];
  let init = { type: 'system', subtype: 'init', session_id: 's1', fast_mode_state: 'off', fast_mode_disabled_reason: 'extra_usage_disabled' };
  f.setHandler((child, args) => {
    if (args.includes('--input-format') && !args.includes('--replay-user-messages')) { claudeMetadata(child, metadataRequests, [{ value: 'opus', displayName: 'Opus', supportsFastMode: true }, { value: 'haiku' }]); return; }
    onClaudeInput(child, args, () => {
      if (args[0] === 'auth') child.json({ loggedIn: true, authMethod: 'claude.ai' });
      else { child.json(init); child.json({ type: 'result', subtype: 'success', result: 'synthetic', session_id: 's1' }); }
      child.finish();
    });
  });
  const models = await f.manager.modelsFor('claude');
  assert.equal(models.find(m => m.id === 'opus').speeds[0].paid, true);
  assert.deepEqual(models.find(m => m.id === 'haiku').speeds, []);
  await assert.rejects(f.manager.run({ provider: 'claude', conversationId: 'c1', model: 'haiku', speed: 'fast', prompt: 'never sent' }), /does not offer that speed/);
  await f.manager.run({ provider: 'claude', conversationId: 'c1', model: 'opus', speed: 'fast', prompt: 'synthetic' });
  const fastArgs = f.calls.filter(call => call.args.includes('--permission-prompt-tool')).at(-1).args;
  assert.deepEqual(JSON.parse(fastArgs[fastArgs.indexOf('--settings') + 1]), { fastMode: true });
  assert.match(f.events.find(e => e.type === 'chat.notice').text, /not used because extra usage credits are turned off/);
  init = { type: 'system', subtype: 'init', session_id: 's1' };
  await f.manager.run({ provider: 'claude', conversationId: 'c2', model: 'opus', speed: 'standard', prompt: 'synthetic' });
  const standardArgs = f.calls.filter(call => call.args.includes('--permission-prompt-tool')).at(-1).args;
  assert.equal(standardArgs.includes('--settings'), false);
  assert.equal(f.events.filter(e => e.type === 'chat.notice').length, 1);
  assert.equal(metadataRequests.length, 1);
});

test('a recently proven Claude sign-in and an older model list do not start extra runtime processes', async t => {
  const f = await fixture(t); const metadataRequests = [];
  f.setHandler((child, args) => {
    if (args.includes('--input-format') && !args.includes('--replay-user-messages')) { claudeMetadata(child, metadataRequests, [{ value: 'opus', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['high'] }]); return; }
    onClaudeInput(child, args, () => {
      if (args[0] === 'auth') child.json({ loggedIn: true, authMethod: 'claude.ai' });
      else child.json({ type: 'result', subtype: 'success', result: 'synthetic', session_id: 's1' });
      child.finish();
    });
  });
  await f.manager.modelsFor('claude');
  f.manager.modelCache.get('claude').time = Date.now() - 30 * 60 * 1000;
  f.manager.claudeFreshAt = Date.now();
  await f.manager.run({ provider: 'claude', conversationId: 'c1', model: 'opus', effort: 'high', prompt: 'synthetic' });
  assert.equal(f.calls.filter(call => call.args[0] === 'auth').length, 0);
  assert.equal(metadataRequests.length, 1);
  f.manager.claudeFreshAt = 0;
  await f.manager.run({ provider: 'claude', conversationId: 'c2', model: 'opus', prompt: 'synthetic' });
  assert.equal(f.calls.filter(call => call.args[0] === 'auth').length, 1);
});

test('chat-mode runs switch off built-in tools and expose only conversation tools plus request_tools', async t => {
  const tools = ['memory_note', 'archive_search', 'workspace_write', 'browser_open'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
  const f = await fixture(t, { toolDefinitions: tools }); const requests = [];
  f.manager.claudeStatus = async () => ({ connected: true });
  f.setHandler((child, args) => {
    if (args[0] === 'app-server') { codexServer(child, requests, { turn(message) { if (message.method === 'turn/start') notification(child, 'turn/completed', { turn: { status: 'completed' } }); } }); return; }
    onClaudeInput(child, args, () => { child.json({ type: 'result', subtype: 'success', result: 'synthetic', session_id: 's1' }); child.finish(); });
  });
  await f.manager.run({ provider: 'claude', conversationId: 'c1', prompt: 'synthetic', lean: true, allowEscalation: true });
  const args = f.calls.find(call => call.args.includes('-p')).args;
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args.includes('--permission-prompt-tool'), false);
  const allowed = args.slice(args.indexOf('--allowedTools') + 1).filter(arg => arg.startsWith('mcp__'));
  assert.deepEqual(allowed, ['mcp__exomina__memory_note', 'mcp__exomina__archive_search', 'mcp__exomina__request_tools']);
  await f.manager.run({ provider: 'codex', conversationId: 'c2', prompt: 'synthetic', lean: true, allowEscalation: false });
  const start = requests.find(r => r.method === 'thread/start').params;
  assert.deepEqual(start.dynamicTools.map(tool => tool.name), ['memory_note', 'archive_search']);
  assert.equal(start.config.features.shell_tool, false);
  assert.equal(start.config.web_search, 'disabled');
});
