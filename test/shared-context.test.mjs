import test from 'node:test';
import assert from 'node:assert/strict';
import { planSharedContext, rememberSharedContext, CONTEXT_REFRESH_TURNS } from '../desktop/shared-context.mjs';

const parts = { memory: 'MEMORY v1\n', archive: 'ARCHIVE\n' };

test('a new session receives all shared context', () => {
  const plan = planSharedContext({}, 'claude', undefined, parts);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.text, 'MEMORY v1\nARCHIVE\n');
});

test('a resumed session gets only changed parts, and everything again after compaction, a switch or the refresh interval', () => {
  const chat = {};
  rememberSharedContext(chat, 'claude', planSharedContext(chat, 'claude', undefined, parts), { selection: { provider: 'claude' }, sessionId: 's1' });
  let plan = planSharedContext(chat, 'claude', 's1', parts);
  assert.deepEqual(plan.skipped, ['memory', 'archive']);
  assert.doesNotMatch(plan.text, /MEMORY|ARCHIVE/);
  assert.match(plan.text, /memory_wake/);
  plan = planSharedContext(chat, 'claude', 's1', { ...parts, memory: 'MEMORY v2\n' });
  assert.deepEqual(plan.skipped, ['archive']);
  assert.match(plan.text, /MEMORY v2/);
  // Another session, or another provider, starts without the context.
  assert.deepEqual(planSharedContext(chat, 'claude', 's2', parts).skipped, []);
  assert.deepEqual(planSharedContext(chat, 'codex', 's1', parts).skipped, []);
  // Compaction may have summarised the context away.
  rememberSharedContext(chat, 'claude', plan, { selection: { provider: 'claude' }, sessionId: 's1' }, true);
  assert.deepEqual(planSharedContext(chat, 'claude', 's1', parts).skipped, []);
  // A periodic full refresh bounds how long a session relies on earlier turns.
  chat.contextSent.claude = { session: 's1', hashes: planSharedContext({}, 'claude', undefined, parts).hashes, turns: CONTEXT_REFRESH_TURNS };
  assert.deepEqual(planSharedContext(chat, 'claude', 's1', parts).skipped, []);
});

test('a fallback provider is recorded as having the full context', () => {
  const chat = {};
  const plan = planSharedContext(chat, 'claude', undefined, parts);
  rememberSharedContext(chat, 'claude', plan, { selection: { provider: 'codex' }, sessionId: 't1' });
  assert.equal(chat.contextSent.codex.turns, 1);
  assert.deepEqual(planSharedContext(chat, 'codex', 't1', parts).skipped, ['memory', 'archive']);
});
