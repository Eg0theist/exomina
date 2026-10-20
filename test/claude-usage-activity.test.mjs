import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeUsageActivity } from '../desktop/claude-usage-activity.mjs';

const session_id = 'session', turnId = 'host-invocation';
const start = (usage = { input_tokens: 1000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 3000, output_tokens: 0 }, model = 'claude-exact') =>
  ({ type: 'stream_event', session_id, event: { type: 'message_start', message: { id: 'message', model, usage } } });
const model = (inputTokens = 1000000, contextWindow = 200000) => ({ inputTokens, cacheReadInputTokens: 2000000, cacheCreationInputTokens: 300000, outputTokens: 2000, thinkingTokens: 800, contextWindow });
const fixture = () => new ClaudeUsageActivity({ turnId, sessionId: () => session_id });

test('Claude latest request input includes uncached input, cache reads and cache writes', () => {
  const usage = fixture().observe(start());
  assert.equal(usage.provider, 'claude'); assert.equal(usage.threadId, session_id); assert.equal(usage.turnId, turnId);
  assert.deepEqual(usage.last, { inputTokens: 24000, cachedInputTokens: 20000, cacheWriteInputTokens: 3000, outputTokens: 0, reasoningOutputTokens: null, totalTokens: null });
  assert.equal(usage.total.inputTokens, null); assert.equal(usage.modelContextWindow, null);
});

test('Claude message deltas update the latest request snapshot without adding cumulative deltas', () => {
  const activity = fixture(); activity.observe(start());
  const delta = output_tokens => ({ type: 'stream_event', session_id, event: { type: 'message_delta', usage: { output_tokens, output_tokens_details: { thinking_tokens: 40 } } } });
  activity.observe(delta(100)); const usage = activity.observe(delta(150));
  assert.equal(usage.last.outputTokens, 150); assert.equal(usage.last.inputTokens, 24000); assert.equal(usage.last.reasoningOutputTokens, 40);
  const next = activity.observe(start({ input_tokens: 2000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 0 }));
  assert.equal(next.last.inputTokens, 3000); assert.equal(next.last.outputTokens, 0); assert.equal(next.last.reasoningOutputTokens, null);
});

test('terminal cumulative modelUsage replaces totals and never changes the latest request input', () => {
  const activity = fixture(); activity.observe(start());
  const result = inputTokens => ({ type: 'result', session_id, usage: { input_tokens: 99999999, output_tokens: 88888888 }, modelUsage: { 'claude-exact': model(inputTokens) } });
  const first = activity.observe(result(1000000)), second = activity.observe(result(2000000));
  assert.equal(first.last.inputTokens, 24000); assert.equal(second.last.inputTokens, 24000);
  assert.equal(first.total.inputTokens, 3300000); assert.equal(second.total.inputTokens, 4300000);
  assert.equal(second.total.outputTokens, 2000); assert.equal(second.total.reasoningOutputTokens, null); assert.equal(second.total.totalTokens, null);
  assert.equal(second.modelContextWindow, 200000); assert.equal(second.totalScope, 'providerRun');
});

test('Claude window follows only an exact latest streamed model and totals include all pipeline models', () => {
  const activity = fixture(); activity.observe(start());
  const result = { type: 'result', session_id, modelUsage: { 'claude-exact': model(), 'claude-helper': model(500, 1000000) } };
  const usage = activity.observe(result);
  assert.equal(usage.modelContextWindow, 200000); assert.equal(usage.total.inputTokens, 5600500);
  assert.equal(activity.observe(start(undefined, 'different-alias')).modelContextWindow, null);
  const missing = activity.observe({ type: 'result', session_id, modelUsage: { 'claude-only': model() } });
  assert.equal(missing.modelContextWindow, null);
});

test('missing stream usage stays unknown instead of substituting result usage or cumulative totals', () => {
  const activity = fixture(), usage = activity.observe({ type: 'result', session_id, usage: { input_tokens: 900000 }, modelUsage: { 'claude-exact': model() } });
  assert.equal(usage.last.inputTokens, null); assert.equal(usage.modelContextWindow, null); assert.equal(usage.total.inputTokens, 3300000);
  assert.equal(activity.observe(start({ input_tokens: 1000, output_tokens: 10 })).last.inputTokens, null);
  const absent = activity.observe({ type: 'result', session_id }); assert.equal(absent.total.inputTokens, null); assert.equal(absent.modelContextWindow, null);
});

test('subagent, foreign-session and partial assistant frames cannot overwrite the latest main request', () => {
  const activity = fixture(); activity.observe(start());
  assert.equal(activity.observe({ ...start(), parent_tool_use_id: 'subagent-tool' }), null);
  assert.equal(activity.observe({ ...start(), session_id: 'another-session' }), null);
  assert.equal(activity.observe({ type: 'assistant', session_id, message: { usage: { input_tokens: 999999 } } }), null);
  const usage = activity.observe({ type: 'result', session_id, modelUsage: { 'claude-exact': model() } }); assert.equal(usage.last.inputTokens, 24000);
});

test('negative, unsafe and missing counts remain unknown and invalid maps cannot invent context', () => {
  const activity = fixture();
  assert.equal(activity.observe(start({ input_tokens: -1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 })).last.inputTokens, null);
  assert.equal(activity.observe(start({ input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 })).last.inputTokens, null);
  activity.observe(start());
  assert.equal(activity.observe({ type: 'result', session_id, modelUsage: { 'claude-exact': { ...model(), contextWindow: -1, cacheReadInputTokens: '1000' } } }).modelContextWindow, null);
  const usage = activity.observe({ type: 'result', session_id, modelUsage: Array(1000).fill(model()) });
  assert.equal(usage.total.inputTokens, null); assert.equal(usage.modelContextWindow, null);
});
