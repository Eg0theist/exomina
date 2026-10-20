import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ProviderManager } from '../desktop/providers.mjs';
import { RunActivity } from '../desktop/activity.mjs';

function fixture() {
  const events = [], calls = [], messages = new Map(), activities = new Map();
  const forbidden = name => () => { calls.push(name); throw Error('A diagnostic cannot act.'); };
  const manager = new ProviderManager({ dataDir: path.resolve('synthetic-notification-profile'), workspace: process.cwd(),
    emit: event => { events.push(event); if (event.type === 'chat.tool') activities.get(event.conversationId)?.tool(event); },
    spawnImpl: forbidden('spawn'), beforePrepare: forbidden('prepare'), callTool: forbidden('callTool'), approve: forbidden('approve') });
  function add(id, provider = 'codex') {
    const message = { content: '' }; messages.set(id, message);
    activities.set(id, new RunActivity(message, { conversationId: id, emit: () => {} }));
    const state = { provider, conversationId: id, sessionId: 'thread-' + id, turnId: 'turn-' + id, items: new Map(), cancelled: false, reject: () => {} };
    manager.active.set(id, state); return state;
  }
  const state = add('one');
  return { manager, events, calls, messages, state, add };
}

test('thread warnings target only their current chat; global notices explicitly identify provider scope', () => {
  const f = fixture(); f.add('two'); f.add('claude', 'claude'); const cancelled = f.add('cancelled'); cancelled.cancelled = true;
  const ended = f.add('ended'); ended.turnEnded = true;
  f.manager.codexNotification('warning', { threadId: 'thread-one', message: 'A tool is unavailable.' });
  assert.deepEqual(f.events.map(event => event.conversationId), ['one']);
  f.manager.codexNotification('warning', { threadId: 'unknown', message: 'Unknown thread warning.' });
  f.manager.codexNotification('configWarning', { summary: 'Deprecated option ignored.', details: 'Use the new option.', path: '/private/config/location', range: { start: { line: 1, column: 1 } } });
  f.manager.codexNotification('deprecationNotice', { summary: 'Older protocol is deprecated.' });
  assert.deepEqual(f.events.slice(1).map(event => event.conversationId), ['one', 'two', 'one', 'two']);
  assert.match(f.events[1].output, /^Global Provider configuration warning:/);
  assert.match(f.events[3].output, /^Global Provider deprecation notice:/);
  assert.doesNotMatch(JSON.stringify(f.events), /private\/config\/location|Unknown thread warning/);
  assert.deepEqual(f.calls, []);
});

test('warning text is sanitized, bounded, deduplicated and ignores malformed messages', () => {
  const f = fixture();
  const warning = { message: 'api_key="synthetic-secret" password="hidden" Bearer bearerSecret.123 https://user:pass@example.invalid/a?token=opaqueSecret\n' + 'x'.repeat(12000), threadId: null };
  f.manager.codexNotification('warning', warning); f.manager.codexNotification('warning', warning);
  for (const params of [null, [], {}, { summary: 1 }, { summary: 'Wrong target', threadId: 1 }]) f.manager.codexNotification('configWarning', params);
  assert.equal(f.events.length, 1); assert.ok(f.events[0].output.length <= 4000);
  assert.doesNotMatch(JSON.stringify(f.events), /synthetic-secret|hidden|bearerSecret|user:pass|opaqueSecret/);
  assert.match(f.events[0].output, /credential redacted/);
  assert.deepEqual(f.events[0].historyOutput, f.events[0].output);
  for (let index = 0; index < 110; index++) f.manager.codexNotification('deprecationNotice', { summary: 'Notice ' + index });
  assert.equal(f.events.length, 100); assert.equal(f.state.codexNotices.size, 100);
  assert.deepEqual(f.calls, []);
});

test('native command progress updates the existing activity without exposing a split secret', () => {
  const f = fixture(), target = { threadId: 'thread-one', turnId: 'turn-one', itemId: 'command' };
  f.manager.codexNotification('item/started', { ...target, item: { id: 'command', type: 'commandExecution', status: 'inProgress', command: 'synthetic build' } });
  f.manager.codexNotification('item/commandExecution/outputDelta', { ...target, delta: 'api_key="syn' });
  assert.equal(f.events.length, 1);
  f.manager.codexNotification('item/commandExecution/outputDelta', { ...target, delta: 'thetic-secret"\nBuild step 1 passed.\n' });
  const step = f.messages.get('one').activity[0];
  assert.equal(step.status, 'running'); assert.match(step.output, /Build step 1 passed/);
  assert.doesNotMatch(JSON.stringify(f.events), /synthetic-secret|api_key="syn/);
  f.manager.codexNotification('item/completed', { ...target, item: { id: 'command', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'api_key="synthetic-secret"\nBuild finished.' } });
  assert.equal(f.messages.get('one').activity.length, 1); assert.equal(step.status, 'done'); assert.match(step.output, /Build finished/);
  assert.equal(f.state.codexProgress.size, 0); assert.doesNotMatch(JSON.stringify(f.events), /synthetic-secret/);
  assert.deepEqual(f.calls, []);
});

test('completed commands without an aggregate publish retained final lines safely', () => {
  const f = fixture(), target = { threadId: 'thread-one', turnId: 'turn-one', itemId: 'command' };
  f.manager.codexNotification('item/started', { ...target, item: { id: 'command', type: 'commandExecution', status: 'inProgress', command: 'synthetic build' } });
  f.manager.codexNotification('item/commandExecution/outputDelta', { ...target, delta: 'Build progressed.\napi_key="synthetic-secret"' });
  f.manager.codexNotification('item/completed', { ...target, item: { id: 'command', type: 'commandExecution', status: 'completed', exitCode: 1, aggregatedOutput: null } });
  const step = f.messages.get('one').activity[0];
  assert.equal(step.status, 'error'); assert.match(step.output, /Build progressed/); assert.match(step.output, /credential redacted/); assert.match(step.output, /Exit code 1/);
  assert.doesNotMatch(JSON.stringify(f.events), /synthetic-secret/); assert.equal(f.state.codexProgress.size, 0);
});

test('MCP progress is sanitized and ignores unknown, stale, completed and cancelled targets', () => {
  const f = fixture(), target = { threadId: 'thread-one', turnId: 'turn-one', itemId: 'mcp' };
  f.manager.codexNotification('item/started', { ...target, item: { id: 'mcp', type: 'mcpToolCall', tool: 'read', status: 'inProgress' } });
  f.manager.codexNotification('item/mcpToolCall/progress', { ...target, message: 'Reading source; password=syntheticSecret' });
  assert.equal(f.events.length, 2); assert.match(f.messages.get('one').activity[0].output, /Reading source/);
  assert.doesNotMatch(JSON.stringify(f.events), /syntheticSecret/);
  for (const params of [{ ...target, turnId: 'older', message: 'stale' }, { ...target, threadId: 'unknown', message: 'unknown' }, { ...target, itemId: 'missing', message: 'missing' }, { ...target, message: 1 }]) f.manager.codexNotification('item/mcpToolCall/progress', params);
  f.manager.codexNotification('item/completed', { ...target, item: { id: 'mcp', type: 'mcpToolCall', tool: 'read', status: 'completed' } });
  f.manager.codexNotification('item/mcpToolCall/progress', { ...target, message: 'late' });
  const count = f.events.length; f.state.cancelled = true;
  f.manager.codexNotification('item/mcpToolCall/progress', { ...target, message: 'cancelled' });
  assert.equal(f.events.length, count); assert.equal(f.messages.get('one').activity.length, 1);
  assert.deepEqual(f.calls, []);
});

test('overlong streaming chunks and lines are omitted explicitly instead of retaining raw data', () => {
  const f = fixture(), target = { threadId: 'thread-one', turnId: 'turn-one', itemId: 'command' };
  f.manager.codexNotification('item/started', { ...target, item: { id: 'command', type: 'commandExecution', status: 'inProgress', command: 'synthetic build' } });
  f.manager.codexNotification('item/commandExecution/outputDelta', { ...target, delta: 'private-fragment'.repeat(500) });
  assert.match(f.events.at(-1).output, /Long command-output line omitted/);
  assert.equal(f.state.codexProgress.get('command').pending, '');
  f.manager.codexNotification('item/commandExecution/outputDelta', { ...target, delta: 'continuation\nReadable update.\n' });
  assert.match(f.events.at(-1).output, /Readable update/); assert.doesNotMatch(JSON.stringify(f.events), /private-fragment|continuation/);
  f.manager.codexNotification('item/commandExecution/outputDelta', { ...target, delta: 'x'.repeat(64001) });
  assert.match(f.events.at(-1).output, /Large command-output chunk omitted/);
  f.manager.codexNotification('item/completed', { ...target, item: { id: 'command', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: null } });
  assert.match(f.events.at(-1).output, /Large command-output chunk omitted/); assert.doesNotMatch(JSON.stringify(f.events), /private-fragment|continuation|xxxxxxx/);
  assert.ok(f.events.at(-1).output.length <= 4000); assert.deepEqual(f.calls, []);
});
