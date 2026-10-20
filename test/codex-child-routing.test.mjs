import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {CodexChildRouting} from '../desktop/codex-child-routing.mjs';
import {ProviderManager} from '../desktop/providers.mjs';
import {codexPermissions} from '../desktop/codex-permissions.mjs';
import {codexPolicy} from '../desktop/permissions.mjs';

const workspace = path.resolve('synthetic-helper-workspace');
function fixture(overrides = {}) {
  const events = [], calls = [], interrupts = [];
  const manager = new ProviderManager({dataDir: path.resolve('synthetic-helper-profile'), workspace,
    emit: event => events.push(event), callTool: async (...args) => {calls.push(args); return {content: [{type: 'text', text: 'Synthetic observation.'}]};}, ...overrides});
  manager.rpc = {closed: false, request: async (method, params) => {interrupts.push({method, params}); return {};}};
  const root = {provider: 'codex', conversationId: 'chat', sessionId: 'root', turnId: 'root-turn', text: '',
    requestedPermissions: codexPermissions(workspace, codexPolicy('ask')), codexPermissionsVerified: true, nativeChildInheritanceVerified: true,
    toolDefinitions: [{name: 'observe'}], items: new Map(), messages: new Map(), imageItems: new Set(), cancelled: false,
    resolve: () => {root.resolved = true;}, reject: () => {root.rejected = true;}};
  manager.active.set(root.conversationId, root);
  return {manager, root, events, calls, interrupts};
}
function metadata(parent, childId = 'child', extra = {}) {
  return {id: childId, cwd: workspace, parentThreadId: parent.sessionId, forkedFromId: null,
    source: {subAgent: {thread_spawn: {parent_thread_id: parent.sessionId, depth: (parent.nativeDepth || 0) + 1, agent_path: `/root/${childId}`}}}, ...extra};
}
function spawn(f, parent = f.root, childId = 'child', extra = {}) {
  f.manager.codexNotification('thread/started', {thread: metadata(parent, childId, extra)});
  f.manager.codexNotification('turn/started', {threadId: childId, turn: {id: `${childId}-turn`}});
  return f.manager.stateFor({threadId: childId});
}
const call = (f, childId = 'child', turnId = `${childId}-turn`, tool = 'observe') => f.manager.codexRequest('item/tool/call', {threadId: childId, turnId, tool, callId: 'same-call', arguments: {}});

test('native direct and nested helpers route only to their proven owning conversation and tool scope', async () => {
  const f = fixture(), child = spawn(f), nested = spawn(f, child, 'nested');
  assert.equal((await call(f)).success, true); assert.equal((await call(f, 'nested')).success, true);
  assert.deepEqual(f.calls.map(args => args[2]), ['chat', 'chat']);
  assert.equal(f.calls[0][3].nativeThreadId, 'child'); assert.equal(f.calls[1][3].nativeTurnId, 'nested-turn');
  assert.equal(f.calls[1][3].isActive(), true);
  assert.notEqual(child.items, f.root.items); assert.notEqual(nested.messages, child.messages);
  await assert.rejects(call(f, 'child', 'child-turn', 'not-in-root-catalogue'), /Unknown tool/);
});
test('thread ids claimed in tool arguments, generic forks, analytics source and unknown ancestry grant no routing', async () => {
  for (const extra of [
    {parentThreadId: 'unknown'}, {forkedFromId: 'another'}, {source: 'subAgent'},
    {source: {subAgent: 'review'}}, {source: {subAgent: {thread_spawn: {parent_thread_id: 'unknown', depth: 1}}}},
    {source: {subAgent: {thread_spawn: {parent_thread_id: 'root', depth: 2}}}},
    {cwd: path.resolve('other-workspace')}, {cwd: 'relative'},
  ]) {
    const f = fixture(); spawn(f, f.root, 'unowned', extra);
    await assert.rejects(call(f, 'unowned'), /No active conversation/); assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.manager.codexNotification('item/completed', {threadId: 'root', turnId: 'root-turn', item: {type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', senderThreadId: 'root', receiverThreadIds: ['claimed'], status: 'completed'}});
  await assert.rejects(f.manager.codexRequest('item/tool/call', {threadId: 'claimed', turnId: 'claimed-turn', tool: 'observe', arguments: {parentThreadId: 'root'}}), /No active conversation/);
});
test('a full history fork is accepted only with the same independently proven live ThreadSpawn ancestry', async () => {
  const f = fixture(); spawn(f, f.root, 'fork-child', {forkedFromId: 'root'});
  assert.equal((await call(f, 'fork-child')).success, true);
});
test('unverified, ended, cancelled and tool-free parent contexts cannot expand host authority', async () => {
  for (const flag of ['unverified', 'unverified-runtime', 'ended', 'cancelled', 'noTools']) {
    const f = fixture();
    if (flag === 'unverified') f.root.codexPermissionsVerified = false;
    else if (flag === 'unverified-runtime') f.root.nativeChildInheritanceVerified = false;
    else if (flag === 'ended') f.root.turnEnded = true;
    else if (flag === 'cancelled') f.root.cancelled = true;
    else f.root.noTools = true;
    spawn(f);
    await assert.rejects(call(f), flag === 'noTools' ? /tool-free helper/ : /No active conversation/);
    assert.equal(f.calls.length, 0);
  }
});
test('native child callbacks require their own observed current turn and reject missing or stale turn ids', async () => {
  const f = fixture(); f.manager.codexNotification('thread/started', {thread: metadata(f.root)});
  await assert.rejects(call(f), /active native turn/);
  f.manager.codexNotification('turn/started', {threadId: 'child', turn: {id: 'child-turn'}});
  await assert.rejects(call(f, 'child', 'root-turn'), /active native turn/);
  await assert.rejects(f.manager.codexRequest('item/tool/call', {threadId: 'child', tool: 'observe'}), /active native turn/);
  assert.equal(f.calls.length, 0);
});
test('child completion and output stay separate from the root answer and completion', async () => {
  const f = fixture(), child = spawn(f);
  f.manager.codexNotification('item/agentMessage/delta', {threadId: 'child', turnId: 'child-turn', itemId: 'reply', delta: 'Child reply'});
  f.manager.codexNotification('turn/completed', {threadId: 'child', turn: {id: 'child-turn', status: 'completed', items: []}});
  assert.equal(child.turnEnded, true); assert.equal(f.root.turnEnded, undefined); assert.equal(f.root.resolved, undefined);
  assert.equal(f.root.text, ''); assert.equal(f.events.some(event => event.type === 'chat.delta'), false);
  assert.ok(f.events.some(event => event.type === 'chat.tool' && event.nativeThreadId === 'child' && event.output === 'Child reply'));
  await assert.rejects(call(f), /native turn has ended/);
});
test('stale child completion cannot finish the current turn, and completed turn ids cannot reopen', async () => {
  const f = fixture(), child = spawn(f);
  f.manager.codexNotification('turn/completed', {threadId: 'child', turn: {id: 'stale', status: 'completed'}});
  assert.equal(child.turnEnded, false);
  f.manager.codexNotification('turn/started', {threadId: 'child', turn: {id: 'unexpected-parallel'}});
  assert.equal(child.turnId, 'child-turn');
  f.manager.codexNotification('turn/completed', {threadId: 'child', turn: {id: 'child-turn', status: 'completed'}});
  f.manager.codexNotification('turn/started', {threadId: 'child', turn: {id: 'child-next'}});
  assert.equal((await call(f, 'child', 'child-next')).success, true);
  f.manager.codexNotification('turn/completed', {threadId: 'child', turn: {id: 'child-next', status: 'completed'}});
  f.manager.codexNotification('turn/started', {threadId: 'child', turn: {id: 'child-turn'}});
  assert.equal(child.turnId, 'child-next'); assert.equal(child.turnEnded, true);
});
test('root replacement, root-turn replacement, parent completion and Stop revoke descendants and late callbacks', async () => {
  for (const change of ['state', 'turn', 'ended', 'stop']) {
    const f = fixture(), child = spawn(f); spawn(f, child, 'nested');
    if (change === 'state') f.manager.active.set('chat', {...f.root});
    else if (change === 'turn') f.root.turnId = 'new-root-turn';
    else if (change === 'ended') f.manager.codexNotification('turn/completed', {threadId: 'root', turn: {id: 'root-turn', status: 'completed', items: []}});
    else f.manager.cancel('chat');
    await assert.rejects(call(f), /No active conversation/); await assert.rejects(call(f, 'nested'), /No active conversation/);
    assert.equal(f.manager.codexChildren.children.size, 0); assert.equal(f.calls.length, 0);
    if (change === 'ended' || change === 'stop') assert.deepEqual(f.interrupts.filter(row => row.method === 'turn/interrupt').map(row => row.params.threadId).sort(), change === 'stop' ? ['child', 'nested', 'root'] : ['child', 'nested']);
  }
});
test('a completed native parent helper retires and interrupts its running descendants', async () => {
  const f = fixture(), child = spawn(f); spawn(f, child, 'nested');
  f.manager.codexNotification('turn/completed', {threadId: 'child', turn: {id: 'child-turn', status: 'completed'}});
  await assert.rejects(call(f, 'nested'), /No active conversation/);
  assert.deepEqual(f.interrupts.map(row => row.params.threadId), ['nested']);
});
test('native helper closure and transport loss immediately revoke pending connector forms and tools', async () => {
  const forms = [], f = fixture({cancelElicitation: args => forms.push(args)}); spawn(f);
  f.manager.codexNotification('thread/closed', {threadId: 'child'});
  assert.deepEqual(forms, [{threadId: 'child'}]); assert.deepEqual(f.interrupts.map(row => row.params.threadId), ['child']);
  f.manager.codexNotification('thread/started', {thread: metadata(f.root)});
  await assert.rejects(call(f), /No active conversation/);
  spawn(f, f.root, 'other-child'); f.manager.rpc.closed = true; f.manager.codexChildren.clear();
  assert.deepEqual(forms.at(-1), {threadId: 'other-child'}); await assert.rejects(call(f, 'other-child'), /No active conversation/);
});
test('native helper usage and plan snapshots do not overwrite the root task telemetry', () => {
  const f = fixture(); spawn(f);
  f.manager.codexNotification('turn/plan/updated', {threadId: 'child', turnId: 'child-turn', explanation: 'Helper only', plan: [{step: 'child step', status: 'inProgress'}]});
  assert.equal(f.events.some(event => event.type === 'chat.nativeActivity'), false);
  f.manager.codexNotification('turn/plan/updated', {threadId: 'root', turnId: 'root-turn', explanation: 'Root', plan: [{step: 'root step', status: 'inProgress'}]});
  assert.equal(f.events.filter(event => event.type === 'chat.nativeActivity').length, 1);
});
test('concurrent roots and colliding item ids remain scoped; inconsistent ownership permanently revokes a child', async () => {
  const f = fixture(), other = {...f.root, conversationId: 'other-chat', sessionId: 'other-root', turnId: 'other-turn', items: new Map(), messages: new Map()};
  f.manager.active.set('other-chat', other); spawn(f); spawn(f, other, 'other-child');
  await call(f); await call(f, 'other-child');
  assert.deepEqual(f.calls.map(args => args[2]), ['chat', 'other-chat']);
  const ids = f.events.filter(event => event.type === 'chat.tool' && event.name.endsWith(': observe')).map(event => event.id);
  assert.ok(ids.some(value => value === 'helper:child:call:same-call')); assert.ok(ids.some(value => value === 'helper:other-child:call:same-call'));
  f.manager.codexNotification('thread/started', {thread: metadata(other, 'child')});
  f.manager.codexNotification('thread/started', {thread: metadata(f.root, 'child')});
  await assert.rejects(call(f), /No active conversation/);
});
test('incompatible native child settings revoke future tools instead of expanding its host permissions', async () => {
  const f = fixture(); spawn(f);
  const settings = {...f.root.requestedPermissions, sandboxPolicy: f.root.requestedPermissions.sandbox};
  f.manager.codexNotification('thread/settings/updated', {threadId: 'child', threadSettings: settings});
  assert.equal((await call(f)).success, true);
  f.manager.codexNotification('thread/settings/updated', {threadId: 'child', threadSettings: {...settings, approvalsReviewer: 'guardian_subagent'}});
  f.manager.codexNotification('thread/started', {thread: metadata(f.root)});
  await assert.rejects(call(f), /No active conversation/);
});
test('pending native child questions, approvals and connector forms cannot return accepted answers after lifecycle end', async () => {
  for (const kind of ['question', 'approval', 'permissions', 'form']) {
    let finish;
    const pending = () => new Promise(resolve => {finish = resolve;});
    const f = fixture({requestUserInput: pending, approveDetailed: pending, requestElicitation: pending}); spawn(f);
    const method = {question: 'item/tool/requestUserInput', approval: 'item/commandExecution/requestApproval', permissions: 'item/permissions/requestApproval', form: 'mcpServer/elicitation/request'}[kind];
    const request = f.manager.codexRequest(method, {threadId: 'child', turnId: 'child-turn', itemId: 'item', questions: [], permissions: {read: ['test']}});
    const checked = kind === 'question' ? assert.rejects(request, /no longer belongs/) : request;
    f.manager.cancel('chat');
    finish(kind === 'question' ? {answers: {test: {answers: ['Actual answer']}}} : kind === 'form' ? {action: 'accept', content: {test: 'answer'}} : {approved: true, scope: 'once'});
    const result = await checked;
    if (kind === 'approval') assert.deepEqual(result, {decision: 'decline'});
    if (kind === 'permissions') assert.deepEqual(result, {permissions: {}, scope: 'turn'});
    if (kind === 'form') assert.deepEqual(result, {action: 'cancel'});
  }
});
test('successful helper forms and questions use the owning visible chat and child-aware liveness', async () => {
  const requests = [], f = fixture({requestElicitation: async (...args) => {requests.push(args); return {action: 'accept', content: {choice: 'actual'}};}, requestUserInput: async (...args) => {requests.push(args); return {answers: {choice: {answers: ['Actual answer']}}};}});
  spawn(f);
  assert.equal((await f.manager.codexRequest('mcpServer/elicitation/request', {threadId: 'child', turnId: 'child-turn'})).action, 'accept');
  assert.equal(requests[0][0], 'chat'); assert.equal(requests[0][2].isActive(), true);
  assert.equal((await f.manager.codexRequest('mcpServer/elicitation/request', {threadId: 'child', turnId: null})).action, 'accept');
  assert.equal((await f.manager.codexRequest('mcpServer/elicitation/request', {threadId: 'child'})).action, 'accept');
  await assert.rejects(f.manager.codexRequest('mcpServer/elicitation/request', {threadId: 'child', turnId: 'old-turn'}), /active native turn/);
  await f.manager.codexRequest('item/tool/requestUserInput', {threadId: 'child', turnId: 'child-turn', questions: []}); assert.equal(requests.at(-1)[0], 'chat');
});
test('late dynamic tool results do not confirm success after their child task ended', async () => {
  let finish; const f = fixture({callTool: async () => new Promise(resolve => {finish = resolve;})}); spawn(f);
  const request = call(f); f.manager.cancel('chat'); finish({content: []});
  const result = await request; assert.equal(result.success, false); assert.match(result.contentItems[0].text, /effects may already be complete/);
});
test('registry depth, ambiguous roots, receiver-only claims and size limits fail closed', () => {
  const f = fixture(); f.manager.codexChildren = new CodexChildRouting(f.manager.active, {maxChildren: 1, maxDepth: 1});
  const child = spawn(f); assert.ok(child); assert.equal(spawn(f, child, 'nested'), undefined); assert.equal(spawn(f, f.root, 'extra'), undefined);
  f.manager.active.set('ambiguous', {...f.root, conversationId: 'ambiguous'});
  assert.equal(f.manager.stateFor({threadId: 'root'}), undefined); assert.equal(f.manager.stateFor({threadId: 'child'}), undefined);
});

test('native helper cards report known nickname, configured model, actual task and lifecycle separately', () => {
  const f = fixture(); f.root.runtimeSelection = {model: 'actual-parent-model'};
  const child = spawn(f, f.root, 'child', {agentNickname: 'Ada', agentRole: 'reviewer', model: 'configured-child-model', reasoningEffort: 'high'});
  const helpers = () => f.events.filter(event => event.type === 'chat.helper').map(event => event.helper);
  assert.equal(helpers().at(-1).name, 'Ada'); assert.equal(helpers().at(-1).configuredModel, 'configured-child-model');
  assert.equal(helpers().at(-1).effectiveModel, undefined); assert.equal(helpers().at(-1).sourceModel, 'actual-parent-model'); assert.equal(helpers().at(-1).status, 'running');
  f.manager.codexNotification('item/completed', {threadId: 'root', turnId: 'root-turn', item: {type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent',
    senderThreadId: 'root', receiverThreadIds: ['child'], status: 'completed', prompt: 'Review the repaired parser.', model: 'requested-alias', reasoningEffort: 'low', agentsStates: {child: {status: 'running'}}}});
  assert.equal(helpers().at(-1).task, 'Review the repaired parser.'); assert.equal(helpers().at(-1).requestedModel, 'requested-alias');
  f.manager.codexNotification('model/rerouted', {threadId: 'child', turnId: 'child-turn', fromModel: 'configured-child-model', toModel: 'executed-child-model', reason: 'availability'});
  assert.equal(helpers().at(-1).effectiveModel, 'executed-child-model'); assert.equal(helpers().at(-1).modelSource, 'execution');
  f.manager.codexNotification('turn/completed', {threadId: 'child', turn: {id: 'child-turn', status: 'completed'}});
  assert.equal(helpers().at(-1).status, 'complete'); const count = helpers().length;
  f.manager.cancel('chat'); assert.equal(helpers().length, count); assert.equal(child.retired, true);
});
test('pre-spawn collaboration metadata is scoped display data and cannot admit a claimed native receiver', async () => {
  const f = fixture();
  f.manager.codexNotification('item/completed', {threadId: 'root', turnId: 'root-turn', item: {type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', senderThreadId: 'root',
    receiverThreadIds: ['child'], status: 'completed', prompt: 'Actual native task.', model: 'requested', agentsStates: {child: {status: 'pendingInit'}}}});
  assert.equal(f.events.some(event => event.type === 'chat.helper'), false); await assert.rejects(call(f), /No active conversation/);
  spawn(f); const helper = f.events.filter(event => event.type === 'chat.helper').at(-1).helper;
  assert.equal(helper.task, 'Actual native task.'); assert.equal(helper.requestedModel, 'requested'); assert.equal(helper.effectiveModel, undefined);
  assert.equal(f.manager.codexChildren.pendingMetadata.size, 0);
});
test('native helper Stop, failure and unknown identity remain honest and stale completions are ignored', () => {
  const f = fixture(); const metadataWithoutNames = {source: {subAgent: {thread_spawn: {parent_thread_id: 'root', depth: 1}}}};
  spawn(f, f.root, 'child', metadataWithoutNames);
  const helpers = () => f.events.filter(event => event.type === 'chat.helper').map(event => event.helper);
  assert.equal(helpers().at(-1).name, undefined); assert.equal(helpers().at(-1).task, undefined); assert.equal(helpers().at(-1).effectiveModel, undefined);
  f.manager.codexNotification('turn/completed', {threadId: 'child', turn: {id: 'stale', status: 'completed'}}); assert.equal(helpers().at(-1).status, 'running');
  f.manager.codexNotification('error', {threadId: 'child', turnId: 'child-turn', willRetry: false, error: {message: 'Native failure.'}});
  assert.equal(helpers().at(-1).status, 'failed'); assert.equal(helpers().at(-1).error, 'Native failure.');
  spawn(f, f.root, 'other'); f.manager.cancel('chat'); assert.equal(helpers().at(-1).status, 'cancelled');
});
test('native helper task follow-ups reuse the card while proven new turns resume actual lifecycle', () => {
  const f = fixture(); spawn(f);
  f.manager.codexNotification('model/rerouted', {threadId: 'child', turnId: 'child-turn', fromModel: 'initial', toModel: 'first-executed', reason: 'availability'});
  f.manager.codexNotification('turn/completed', {threadId: 'child', turn: {id: 'child-turn', status: 'completed'}});
  f.manager.codexNotification('item/completed', {threadId: 'root', turnId: 'root-turn', item: {type: 'collabAgentToolCall', id: 'followup', tool: 'followupTask', senderThreadId: 'root',
    receiverThreadIds: ['child'], status: 'completed', prompt: 'Check the next revision.', agentsStates: {child: {status: 'running'}}}});
  let helper = f.events.filter(event => event.type === 'chat.helper').at(-1).helper;
  assert.equal(helper.status, 'complete'); assert.equal(helper.task, 'Check the next revision.');
  f.manager.codexNotification('turn/started', {threadId: 'child', turn: {id: 'next-turn'}});
  helper = f.events.filter(event => event.type === 'chat.helper').at(-1).helper; assert.equal(helper.status, 'running'); assert.equal(helper.finishedAt, undefined);
  assert.equal(helper.effectiveModel, undefined);
  assert.equal(new Set(f.events.filter(event => event.type === 'chat.helper').map(event => event.helper.id)).size, 1);
});
test('subAgentActivity lifecycle joins a proven native child but cannot register a claimed child or revive a failure',async()=>{
  const f=fixture(),event=(id,kind)=>f.manager.codexNotification('item/completed',{threadId:'root',turnId:'root-turn',item:{type:'subAgentActivity',id:`activity-${id}-${kind}`,agentThreadId:id,agentPath:`/root/${id}`,kind}});
  event('claimed','started');assert.equal(f.events.some(row=>row.type==='chat.helper'),false);await assert.rejects(call(f,'claimed'),/No active conversation/);
  const tool=f.events.find(row=>row.type==='chat.tool');assert.equal(tool.helper.threadIds[0],'claimed');assert.equal(tool.helper.action,'started');
  spawn(f);event('child','interacted');assert.equal(f.events.filter(row=>row.type==='chat.helper').at(-1).helper.status,'running');
  event('child','completed');assert.equal(f.events.filter(row=>row.type==='chat.helper').at(-1).helper.status,'complete');
  spawn(f,f.root,'failed');f.manager.codexNotification('error',{threadId:'failed',turnId:'failed-turn',willRetry:false,error:{message:'Synthetic child failure.'}});event('failed','completed');assert.equal(f.events.filter(row=>row.type==='chat.helper').at(-1).helper.status,'failed');
});
test('native model receipts update actual root identity without a reportSelection request or duplicate events', () => {
  const f = fixture(); f.root.messageId = 'owning-reply';
  f.manager.reportedSelection(f.root, {model: 'configured-native-model', effort: 'high'});
  f.manager.reportedSelection(f.root, {model: 'configured-native-model', effort: 'high'});
  let events = f.events.filter(event => event.type === 'chat.selection'); assert.equal(events.length, 1);
  assert.deepEqual(events[0].selection, {provider: 'codex', model: 'configured-native-model', effort: 'high'});
  assert.equal(events[0].messageId, 'owning-reply');
  f.manager.codexNotification('model/rerouted', {threadId: 'root', turnId: 'root-turn', fromModel: 'configured-native-model', toModel: 'executed-native-model', reason: 'availability'});
  events = f.events.filter(event => event.type === 'chat.selection'); assert.equal(events.length, 2); assert.equal(events.at(-1).selection.model, 'executed-native-model');
  f.manager.reportedSelection(f.root, {}); assert.equal(f.events.filter(event => event.type === 'chat.selection').length, 2);
});
