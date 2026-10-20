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
