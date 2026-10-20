import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {RunActivity} from '../desktop/activity.mjs';
import {activityVisibility, recoveredActivity, toolActivityState, toolActivityTitle} from '../desktop/activity-visibility.mjs';
import {ProviderManager} from '../desktop/providers.mjs';
import {AcpProvider} from '../desktop/provider-acp.mjs';
import {applyAntigravityEvent} from '../desktop/provider-antigravity.mjs';
import {applyMuseEvent} from '../desktop/provider-muse.mjs';
import {ApiAgent} from '../desktop/api-agent.mjs';

function fixture() {
  const events = [], message = {id: 'reply', role: 'assistant', content: ''};
  const activity = new RunActivity(message, {conversationId: 'chat', emit: event => events.push(structuredClone(event))});
  return {message, activity, events};
}
function attempt(activity, id, input, status, extra = {}) {
  activity.tool({id, name: 'workspace_shell', input, status: 'running'});
  activity.tool({id, status, ...(status === 'done' ? {outcomeConfirmed: true} : {}), ...extra});
}

test('Standard keeps only current narration, with complete history and thinking in work details', () => {
  const f = fixture();
  f.activity.delta('Earlier progress.', 'first');
  f.activity.tool({id: 'read', name: 'workspace_read', input: {path: 'a'}, status: 'running'});
  f.activity.tool({id: 'read', status: 'done', outcomeConfirmed: true});
  f.activity.permission('The sign-in expired. Exomina is renewing it and trying again.');
  f.activity.thinking({id: 'thought', text: 'Detailed provider reasoning.', start: true});
  f.activity.delta('Current plain update.', 'second');
  f.activity.cut();
  const live = activityVisibility(f.message, {standard: true, running: true});
  assert.deepEqual(live.updates.map(step => step.text), ['Current plain update.']);
  assert.ok(live.details.some(step => step.text === 'Earlier progress.'));
  assert.ok(live.details.some(step => step.kind === 'thinking' && step.text === 'Detailed provider reasoning.'));
  assert.ok(live.details.some(step => step.kind === 'status'));
  const finished = activityVisibility(f.message, {standard: true});
  assert.equal(finished.updates.length, 0);
  assert.equal(finished.details.length, f.message.activity.length);
  const advanced = activityVisibility(f.message);
  assert.equal(advanced.updates.filter(step => step.kind === 'note').length, 2);
  assert.ok(advanced.updates.some(step => step.kind === 'status'));
});

test('exact successful retries quiet failures and denials while preserving their detailed records', () => {
  const {activity, message} = fixture();
  attempt(activity, 'failed', {command: 'check', cwd: 'one'}, 'error', {output: 'Failed attempt output.'});
  attempt(activity, 'denied', {command: 'check', cwd: 'one'}, 'denied', {output: 'Earlier denial reason.'});
  attempt(activity, 'retried', {cwd: 'one', command: 'check'}, 'done');
  const view = activityVisibility(message, {standard: true, running: true});
  assert.deepEqual([...view.recovered], ['denied', 'failed']);
  assert.equal(view.updates.length, 0);
  assert.equal(view.details.find(step => step.id === 'failed').output, 'Failed attempt output.');
  assert.equal(view.details.find(step => step.id === 'denied').output, 'Earlier denial reason.');
  assert.equal(message.activity.find(step => step.id === 'failed').status, 'error');
  assert.equal(activityVisibility(message).updates.length, 2);
});

test('unrelated success, changed working directory and shared clipped prefixes never conceal failures', () => {
  const {activity, message} = fixture();
  const prefix = 'x'.repeat(5000);
  attempt(activity, 'failed', {command: prefix + ' fail', cwd: 'one'}, 'error');
  attempt(activity, 'different-tail', {command: prefix + ' pass', cwd: 'one'}, 'done');
  attempt(activity, 'different-directory', {command: prefix + ' fail', cwd: 'two'}, 'done');
  activity.delta('Everything is fine.', 'answer');
  activity.finish('Everything is fine.');
  assert.equal(recoveredActivity(message.activity).size, 0);
  assert.equal(activityVisibility(message, {standard: true}).updates[0].id, 'failed');
  assert.equal(message.activity[0].input, message.activity[1].input);
  assert.notEqual(message.activity[0].operationKey, message.activity[1].operationKey);
});

test('a closed stream, unknown result receipt, missing input and old logs provide no recovery evidence', () => {
  for (const mode of ['finish', 'unknown', 'missing', 'legacy']) {
    const {activity, message} = fixture();
    const input = mode === 'missing' ? undefined : {command: 'check'};
    attempt(activity, 'failed', input, 'error');
    if (mode === 'finish') activity.tool({id: 'unfinished', name: 'workspace_shell', input, status: 'running'});
    else attempt(activity, 'unproven', input, 'done', {outcomeConfirmed: mode !== 'unknown'});
    activity.finish('Finished.');
    if (mode === 'legacy') for (const step of message.activity) delete step.outcomeConfirmed;
    assert.equal(recoveredActivity(message.activity).size, 0, mode);
  }
});

test('a later new failure remains visible after an earlier recovery', () => {
  const {activity, message} = fixture();
  attempt(activity, 'first', {command: 'check'}, 'error');
  attempt(activity, 'success', {command: 'check'}, 'done');
  attempt(activity, 'last', {command: 'check'}, 'error');
  assert.deepEqual(activityVisibility(message, {standard: true}).updates.map(step => step.id), ['last']);
});

test('missing or false completion proof remains unknown and never uses a success title', () => {
  for (const evidence of [undefined, false]) {
    const {activity, message} = fixture();
    attempt(activity, 'failed', {command: 'check'}, 'error');
    activity.tool({id: 'receipt', name: 'workspace_shell', input: {command: 'check'}, status: 'running'});
    activity.tool({id: 'receipt', status: 'done', ...(evidence === undefined ? {} : {outcomeConfirmed: evidence})});
    const receipt = message.activity.at(-1);
    assert.equal(receipt.outcomeConfirmed, false);
    assert.equal(toolActivityState(receipt), 'unknown');
    assert.equal(toolActivityTitle(receipt), 'Running a command (result not confirmed)');
    assert.deepEqual(activityVisibility(message, {standard: true}).updates.map(step => step.id), ['failed', 'receipt']);
    assert.equal(recoveredActivity(message.activity).size, 0);
  }
});

test('successful turn endings, failed endings and handoffs preserve unfinished tool warnings', () => {
  for (const ending of ['complete', 'failed', 'handoff']) {
    const {activity, message, events} = fixture();
    activity.tool({id: 'unfinished', name: 'workspace_write', input: {path: 'file', text: 'value'}, status: 'running'});
    if (ending === 'handoff') activity.handoff('The allowance ended. Continuing with another provider.');
    else activity.finish('The turn ended.', {failed: ending === 'failed'});
    const step = message.activity.find(step => step.id === 'unfinished');
    assert.equal(step.status, 'stopped'); assert.equal(step.outcomeConfirmed, false);
    assert.equal(toolActivityTitle(step), 'Writing a file (completion not confirmed)');
    assert.ok(activityVisibility(message, {standard: true}).updates.includes(step));
    assert.ok(events.some(event => event.type === 'chat.activity' && event.step.id === 'unfinished' && event.step.status === 'stopped'));
    if (ending === 'handoff') assert.ok(activityVisibility(message, {standard: true}).updates.some(step => step.notice === 'handoff'));
    attempt(activity, 'confirmed-retry', {path: 'file', text: 'value'}, 'done');
    // A different tool cannot quiet the stopped write, even with identical args.
    assert.equal(recoveredActivity(message.activity).size, 0);
    activity.tool({id: 'write-retry', name: 'workspace_write', input: {path: 'file', text: 'value'}, status: 'done', outcomeConfirmed: true});
    assert.ok(recoveredActivity(message.activity).has('unfinished'));
  }
});

test('an idle handoff remains visible without manufacturing an unfinished tool', () => {
  const {activity, message} = fixture();
  activity.handoff('Continuing with the fallback provider.');
  const {updates} = activityVisibility(message, {standard: true});
  assert.equal(updates.length, 1); assert.equal(updates[0].notice, 'handoff');
});

test('identical operations in different helper threads or workspaces cannot establish recovery', () => {
  const {activity, message} = fixture();
  activity.tool({id: 'first', name: 'commandExecution', input: {command: 'check'}, nativeThreadId: 'helper-one', executionContext: {provider: 'codex', threadId: 'helper-one', workspace: 'first'}, status: 'error'});
  activity.tool({id: 'other-helper', name: 'commandExecution', input: {command: 'check'}, nativeThreadId: 'helper-two', executionContext: {provider: 'codex', threadId: 'helper-two', workspace: 'first'}, status: 'done', outcomeConfirmed: true});
  activity.tool({id: 'other-workspace', name: 'commandExecution', input: {command: 'check'}, nativeThreadId: 'helper-one', executionContext: {provider: 'codex', threadId: 'helper-one', workspace: 'second'}, status: 'done', outcomeConfirmed: true});
  assert.equal(recoveredActivity(message.activity).size, 0);
  activity.tool({id: 'exact-context', name: 'commandExecution', input: {command: 'check'}, nativeThreadId: 'helper-one', executionContext: {provider: 'codex', threadId: 'helper-one', workspace: 'first'}, status: 'done', outcomeConfirmed: true});
  assert.ok(recoveredActivity(message.activity).has('first'));
});

test('recording a diagnostic never claims an action succeeded or hides a stopped operation', () => {
  const {activity, message} = fixture();
  activity.tool({id: 'stopped', name: 'check', input: {path: 'a'}, status: 'stopped'});
  activity.tool({id: 'diagnostic', name: 'check', input: {path: 'a'}, status: 'done', observational: true});
  const diagnostic = message.activity.at(-1);
  assert.equal(toolActivityState(diagnostic), 'recorded'); assert.equal(toolActivityTitle(diagnostic), 'Using check (recorded)');
  assert.equal(recoveredActivity(message.activity).size, 0);
  assert.deepEqual(activityVisibility(message, {standard: true}).updates.map(step => step.id), ['stopped']);
});

test('legacy completed rows stay quiet without proving recovery of an old failure', () => {
  const message = {activity: [
    {id: 'old-error', kind: 'tool', name: 'Read', title: 'Reading a file', status: 'error', operationKey: 'same'},
    {id: 'old-done', kind: 'tool', name: 'Read', title: 'Reading a file', doneTitle: 'Read a file', status: 'done', operationKey: 'same'},
  ]};
  assert.equal(toolActivityState(message.activity[1]), 'recorded');
  assert.equal(toolActivityTitle(message.activity[1]), 'Reading a file (recorded)');
  assert.equal(recoveredActivity(message.activity).size, 0);
  const view = activityVisibility(message, {standard: true});
  assert.deepEqual(view.updates.map(step => step.id), ['old-error']);
  assert.equal(view.details.length, 2);
});

test('questions, blocked follow-ups and denied permissions remain visible during and after work', () => {
  const {activity, message} = fixture();
  activity.add({id: 'question', kind: 'question', questionId: 'q', status: 'done'});
  activity.add({id: 'followup', kind: 'followup', followupId: 'f', status: 'done'});
  activity.permission('You declined this action.', {denied: true});
  activity.delta('Which format do you prefer?\n\n- PDF\n- Text', 'question-text'); activity.cut();
  activity.delta('Later progress.', 'later'); activity.cut();
  for (const running of [true, false]) {
    const {updates} = activityVisibility(message, {standard: true, running});
    assert.ok(updates.some(step => step.kind === 'question'));
    assert.ok(updates.some(step => step.kind === 'followup'));
    assert.ok(updates.some(step => step.kind === 'status' && step.status === 'denied'));
    assert.ok(updates.some(step => step.text?.startsWith('Which format')));
  }
});

test('actual Codex result mapping distinguishes action failure from a result receipt', () => {
  const {activity, message} = fixture(), events = [];
  const manager = new ProviderManager({dataDir: path.resolve('synthetic-activity-outcome'), workspace: process.cwd(),
    emit: event => {events.push(event); if (event.type === 'chat.tool') activity.tool(event);},
    spawnImpl: () => {throw Error('This fixture cannot launch a runtime.');}});
  manager.active.set('chat', {provider: 'codex', conversationId: 'chat', sessionId: 'thread', turnId: 'turn', items: new Map(), cancelled: false});
  const complete = item => manager.codexNotification('item/completed', {threadId: 'thread', turnId: 'turn', item});
  complete({id: 'dynamic-fail', type: 'dynamicToolCall', tool: 'check', arguments: {path: 'a'}, status: 'completed', success: false, contentItems: [{type: 'inputText', text: 'Host error detail.'}]});
  complete({id: 'mcp-fail', type: 'mcpToolCall', tool: 'check', server: 'source', arguments: {path: 'a'}, status: 'completed', result: {isError: true, content: [{type: 'text', text: 'MCP error detail.'}]}});
  complete({id: 'receipt', type: 'functionCallOutput', name: 'check', status: 'completed', output: 'CreateProcess failed.'});
  complete({id: 'command-unknown', type: 'commandExecution', command: 'check', cwd: 'a', status: 'completed'});
  complete({id: 'command-success', type: 'commandExecution', command: 'check', cwd: 'a', status: 'completed', exitCode: 0});
  const byId = Object.fromEntries(message.activity.map(step => [step.id, step]));
  assert.equal(byId['dynamic-fail'].status, 'error'); assert.match(byId['dynamic-fail'].output, /Host error detail/);
  assert.equal(byId['mcp-fail'].status, 'error'); assert.match(byId['mcp-fail'].output, /MCP error detail/);
  assert.equal(byId.receipt.status, 'done'); assert.equal(byId.receipt.outcomeConfirmed, false);
  assert.equal(byId.receipt.observational, true); assert.equal(toolActivityState(byId.receipt), 'recorded');
  assert.equal(byId['command-unknown'].outcomeConfirmed, false);
  assert.equal(byId['command-success'].outcomeConfirmed, true);
  assert.equal(events.filter(event => event.type === 'chat.tool').length, 5);
});

test('ACP, Antigravity and Muse explicitly distinguish successful and failed action outcomes', () => {
  const events = [], manager = {workspace: 'synthetic', emit: event => events.push(event), toolStep: (_state, event) => events.push(event)};
  const acp = new AcpProvider(manager, 'grok'), state = {sessionId: 'synthetic-session', conversationId: 'chat'};
  acp.update('session/update', {sessionId: state.sessionId, update: {sessionUpdate: 'tool_call', toolCallId: 'a', kind: 'read', rawInput: {path: 'a'}, status: 'completed'}}, state);
  acp.update('session/update', {sessionId: state.sessionId, update: {sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed'}}, state);
  assert.deepEqual(events.splice(0).map(event => [event.status, event.outcomeConfirmed]), [['done', true], ['error', false]]);
  for (const error of [undefined, {message: 'failed'}]) applyAntigravityEvent({event: 'step_update', step_update: {step_type: 'tool', state: 'DONE', step_index: 'a', tool_name: 'Read', tool_info: {parameters: {path: 'a'}, ...(error ? {error} : {})}}}, state, manager);
  assert.deepEqual(events.splice(0).map(event => [event.status, event.outcomeConfirmed]), [['done', true], ['error', false]]);
  const museState = {...state, museKinds: new Map(), museLengths: new Map()};
  for (const status of ['completed', 'failed']) applyMuseEvent({method: 'item/completed', params: {sessionId: state.sessionId, item: {itemId: status, kind: 'toolCall', tool: 'Read', args: '{"path":"a"}', status}}}, museState, manager);
  assert.deepEqual(events.splice(0).map(event => [event.status, event.outcomeConfirmed]), [['done', true], ['error', false]]);
});

test('the actual API host tool loop publishes explicit success and error evidence', async () => {
  for (const isError of [false, true]) {
    const events = [], agent = new ApiAgent({getConnection: async () => ({baseUrl: 'http://localhost:12345', protocol: 'openai', model: 'fixture', optionalKey: true}),
      emit: event => events.push(event), callTool: async () => ({isError, content: [{type: 'text', text: 'Synthetic tool result.'}]}),
      getTools: () => [{name: 'check', inputSchema: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']}}]});
    let round = 0;
    agent.openai = async () => round++ ? {role: 'assistant', content: 'Finished.'} : {role: 'assistant', content: '', tool_calls: [{id: 'call', function: {name: 'check', arguments: '{"path":"a"}'}}]};
    await agent.run({provider: 'custom-api', conversationId: 'chat', prompt: 'Synthetic host tool.', workspace: 'synthetic'});
    const terminal = events.find(event => event.type === 'chat.tool' && event.status !== 'running');
    assert.equal(terminal.status, isError ? 'error' : 'done'); assert.equal(terminal.outcomeConfirmed, !isError);
    assert.deepEqual(events.find(event => event.status === 'running').executionContext, {provider: 'custom-api', workspace: 'synthetic'});
  }
});
