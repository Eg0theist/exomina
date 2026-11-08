import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageHandoffs, nearingUsageLimit, briefingContext } from '../desktop/usage-handoffs.mjs';
import { claudeUsage } from '../desktop/usage.mjs';
import { handoffContext } from '../desktop/model-preferences.mjs';
import { ConversationTools } from '../desktop/conversation-tools.mjs';

const future = new Date(Date.now() + 3600000).toISOString();
const reading = (used = 85) => claudeUsage({ rate_limits: { five_hour: { utilization: used, resets_at: future } } });
const input = { goal: 'Finish report', verified: 'node --test report.test.mjs: 3 pass', inProgress: 'Layout', nextSteps: 'Check layout', openDecisions: 'None', files: 'report.mjs', checks: 'Visual layout not checked' };
function fixture(options = {}) {
  const run = { message: { id: 'reply', activity: [] }, selection: { provider: 'claude', model: 'opus' } };
  const calls = [], changes = []; let saved = 0;
  const manager = new UsageHandoffs({ runs: () => new Map([['chat', run]]), usage: () => ({ claude: reading() }), enabled: () => true,
    steer: async (id, request) => { calls.push({ id, ...request }); return true; }, save: async () => { saved++; }, changed: (_run, text) => changes.push(text), ...options });
  return { manager, run, calls, changes, saved: () => saved };
}
test('handoff preparation uses fresh, applicable 85% usage and skips exhausted/reset/scoped windows', () => {
  assert.equal(nearingUsageLimit(reading(84.9), { model: 'opus' }), false);
  assert.equal(nearingUsageLimit(reading(), { model: 'opus' }), true);
  assert.equal(nearingUsageLimit(reading(100), { model: 'opus' }), false);
  assert.equal(nearingUsageLimit({ ...reading(), stale: true }, { model: 'opus' }), false);
  assert.equal(nearingUsageLimit({ ...reading(), windows: [{ id: 'seven_day_opus', usedPercent: 90, resetsAt: future }] }, { model: 'sonnet' }), false);
  assert.equal(nearingUsageLimit({ ...reading(), windows: [{ id: 'five_hour', usedPercent: 95, resetsAt: '2000-01-01' }] }, { model: 'opus' }), false);
});
test('one in-turn briefing survives automatic and manual model handover and conversation reads', async () => {
  const f = fixture(); await Promise.all([f.manager.observe(), f.manager.observe()]);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].prompt, /continue/i);
  assert.match(f.calls[0].prompt, /Do not repeat passed checks/);
  await f.manager.record(f.run, input); await f.manager.observe();
  assert.equal(f.saved(), 1); assert.equal(f.calls.length, 1);
  assert.match(handoffContext(f.run.message), /3 pass/);
  assert.match(briefingContext([f.run.message]), /Visual layout not checked/);
  const tools = new ConversationTools({ getConversations: () => [{ id: 'chat', messages: [f.run.message] }] });
  const read = await tools.call('conversation_read', { messageId: 'reply' }, 'chat');
  assert.match(JSON.parse(read.content[0].text).text, /Saved model handoff/);
  await assert.rejects(f.manager.record(f.run, input), /No handoff/);
});
test('private, discovery, cancelled and disabled runs cannot prepare handoffs', async () => {
  for (const key of ['private', 'discovery', 'cancelled']) { const f = fixture(); f.run[key] = true; await f.manager.observe(); assert.equal(f.calls.length, 0); }
  const f = fixture({ enabled: () => false }); await f.manager.observe(); assert.equal(f.calls.length, 0);
});
test('a fast save during steer is not overwritten, and a failed save remains retryable', async () => {
  const f = fixture({ steer: async () => { await f.manager.record(f.run, input); return true; } });
  await f.manager.observe(); assert.equal(f.run.handoffRequests.values().next().value.status, 'prepared');
  const failed = fixture({ save: async () => { throw Error('Disk unavailable'); } }); await failed.manager.observe();
  await assert.rejects(failed.manager.record(failed.run, input), /Disk unavailable/); assert.deepEqual(failed.run.message.handoffBriefings, []);
  await assert.rejects(failed.manager.record(failed.run, { ...input, checks: 'x'.repeat(3001) }), /seven handoff/);
});

test('a pending briefing save rejects a concurrent record and preserves the successful briefing', async () => {
  let release;
  const f = fixture({ save: () => new Promise(resolve => { release = resolve; }) }); await f.manager.observe();
  const first = f.manager.record(f.run, input);
  await assert.rejects(f.manager.record(f.run, input), /No handoff/);
  release(); await first;
  assert.equal(f.run.message.handoffBriefings.length, 1); assert.equal(f.run.handoffRequests.values().next().value.status, 'prepared');
});

import { switchBriefing, modelSwitched, replySelection } from '../desktop/usage-handoffs.mjs';
const toolReply = (extra = {}) => ({ id: 'r1', role: 'assistant', lane: 'tools', provider: 'claude', providersUsed: [{ provider: 'claude', model: 'opus' }], activity: [
  { kind: 'tool', name: 'Edit', category: 'write', target: 'desktop/routing.mjs', status: 'done' },
  { kind: 'tool', name: 'Read', category: 'read', target: 'desktop/main.mjs', status: 'done' },
  { kind: 'tool', name: 'Bash', category: 'execute', target: 'npm test', status: 'error', output: '2 failing: routing.test.mjs' },
  { kind: 'note', text: 'thinking aloud' }], followups: [{ id: 'f1', text: 'Also fix titles', taskStatus: 'working' }, { id: 'f2', text: 'done one', taskStatus: 'handled' }], ...extra });

test('a model switch after tool work passes host-recorded working state without a model call', () => {
  const result = switchBriefing([{ role: 'user', content: 'go' }, toolReply()], { provider: 'codex', model: 'gpt-6.1-sol' });
  assert.ok(result);
  const state = JSON.parse(result.text.split('Working state:\n')[1]);
  assert.deepEqual(state.filesChanged, ['desktop/routing.mjs']);
  assert.deepEqual(state.filesRead, ['desktop/main.mjs']);
  assert.deepEqual(state.commands, [{ command: 'npm test', status: 'error' }]);
  assert.match(state.problems[0].output, /2 failing/);
  assert.deepEqual(state.unfinishedFollowups.map(item => item.id), ['f1']);
  assert.equal(state.sourceMessageId, 'r1');
  assert.match(result.text, /claude · opus[\s\S]*codex · gpt-6\.1-sol/);
});

test('no switch briefing for the same model, an unreported model, or a chat-only reply', () => {
  const messages = [toolReply()];
  assert.equal(switchBriefing(messages, { provider: 'claude', model: 'opus' }), null);
  assert.equal(switchBriefing(messages, { provider: 'claude', model: 'auto' }), null);
  assert.equal(switchBriefing([toolReply({ lane: 'chat', activity: [] })], { provider: 'codex', model: 'x' }), null);
  assert.equal(switchBriefing([], { provider: 'codex', model: 'x' }), null);
  assert.ok(switchBriefing(messages, { provider: 'claude', model: 'sonnet' }), 'model change within one provider counts');
  assert.equal(modelSwitched({ provider: 'claude', model: '' }, { provider: 'claude', model: 'opus' }), false);
  assert.deepEqual(replySelection(toolReply({ providersUsed: [{ provider: 'claude', model: 'opus' }, { provider: 'codex', model: 'auto' }] })), { provider: 'codex', model: '' });
});

test('a saved briefing stops being injected once it is older than the recent replies', () => {
  const saved = { id: 'old', role: 'assistant', handoffBriefings: [{ status: 'prepared', goal: 'ExampleCo drafts' }] };
  const later = n => Array.from({ length: n }, (_, i) => [{ role: 'user', content: 'q' + i }, { id: 'a' + i, role: 'assistant', content: 'a' }]).flat();
  assert.match(briefingContext([saved, ...later(2)]), /ExampleCo drafts/);
  assert.equal(briefingContext([saved, ...later(3)]), '');
  assert.equal(briefingContext([saved, ...later(2), { role: 'assistant', error: true }]).includes('ExampleCo'), true, 'failed replies do not push it out');
});
