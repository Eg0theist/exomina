import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ChatMemoryTree } from '../desktop/chat-memory-tree.mjs';
import { RequestGuard, RequestLimitError } from '../desktop/request-guard.mjs';
import { backfillHourlyCap } from '../desktop/chat-memory-backfill.mjs';
import { ProviderManager } from '../desktop/providers.mjs';

test('catch-up has independent durable rolling limits, including no hourly limit', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'catchup-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now(), hour = 2;
  const options = { file: path.join(directory, 'guard.json'), now: () => now, getLimits: () => ({ background: { hour: 1, day: 1 } }), getCatchUpLimit: () => hour };
  const guard = await new RequestGuard(options).init();
  await guard.checkAndPersist({ provider: 'codex', kind: 'background' });
  assert.throws(() => guard.check({ provider: 'codex', kind: 'background' }), RequestLimitError);
  for (let i = 0; i < 2; i++) await guard.checkAndPersist({ provider: 'codex', kind: 'catchup' });
  assert.equal(guard.view().used.codex.background.hour, 1);
  assert.equal(guard.view().used.codex.catchup.hour, 2);
  const retry = guard.availability({ provider: 'codex', kind: 'catchup' }).retryAt;
  assert.equal(retry, now + 3600000); await guard.close();
  const restarted = await new RequestGuard(options).init();
  assert.throws(() => restarted.check({ provider: 'codex', kind: 'catchup' }), /Memory & privacy/);
  hour = null; for (let i = 0; i < 151; i++) restarted.check({ provider: 'codex', kind: 'catchup' });
  assert.equal(restarted.availability({ provider: 'codex', kind: 'background' }).blocked, true);
  hour = 2; assert.equal(restarted.availability({ provider: 'codex', kind: 'catchup' }).blocked, true);
  now += 3600001; assert.equal(restarted.availability({ provider: 'codex', kind: 'catchup' }).blocked, false);
  await restarted.close();
  assert.equal(backfillHourlyCap({}), 300); assert.equal(backfillHourlyCap({ chatMemoryBackfillHourlyCap: null }), null);
  for (const value of [0, -1, 1.5, '300', 20001]) assert.equal(backfillHourlyCap({ chatMemoryBackfillHourlyCap: value }), 300);
});

test('only the explicit catch-up provider run uses the catch-up counter', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'catchup-routing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seen = [];
  const manager = new ProviderManager({ dataDir: directory, workspace: directory, beforeRequest: request => { seen.push(request.kind); throw new RequestLimitError('Stopped before account access.', request); } });
  t.after(() => manager.close());
  for (const options of [{}, { ephemeral: true }, { ephemeral: true, memoryCatchUp: true }]) await assert.rejects(manager.run({ provider: 'codex', conversationId: 'synthetic', prompt: 'Synthetic', ...options }), /Stopped before account access/);
  assert.deepEqual(seen, ['reply', 'background', 'catchup']);
});

test('progress counts committed summaries, pages contents, scopes chats and survives restart', async t => {
  const parent = process.platform === 'win32' ? 'C:/Program Files/Exomina/Workspace/.exomina-qa-temp' : os.tmpdir();
  await mkdir(parent, { recursive: true }); const directory = await mkdtemp(path.join(parent, 'memory-progress-'));
  let tree = await new ChatMemoryTree(directory).init();
  t.after(async () => { await tree.close(); await rm(directory, { recursive: true, force: true }); });
  for (const chatId of ['visible', 'excluded']) for (let id = 0; id < 3; id++) await tree.append(chatId, { key: `source-${id}`, role: 'user', kind: 'message', text: 'Important original user decision. '.repeat(50) });
  let view = await tree.progress(['visible']); assert.equal(view.totals.pending, 3); assert.equal(view.totals.saved, 0);
  const [first] = await tree.readyJobs(1, { chatId: 'visible' });
  await assert.rejects(tree.commitSummary(first, 'x'.repeat(600)), /512/);
  assert.equal((await tree.progress(['visible'])).totals.savedCatchUp, 0);
  assert.equal((await tree.commitSummary(first, 'Saved user decision.', { origin: 'catchup', provider: 'codex', model: 'synthetic-model' })).committed, true);
  assert.equal((await tree.commitSummary(first, 'Duplicate.', { origin: 'catchup' })).committed, false);
  const [second] = await tree.readyJobs(1, { chatId: 'visible' }); await tree.commitSummary(second, 'Earlier summary.');
  view = await tree.progress(['visible'], { limit: 1 });
  assert.equal(view.totals.saved, 2); assert.equal(view.totals.savedCatchUp, 1); assert.equal(view.entries.length, 1); assert.equal(view.nextOffset, 1);
  assert.equal(view.entries[0].model, 'synthetic-model'); assert.match(view.entries[0].text, /Saved user decision/); assert.ok(Date.parse(view.entries[0].savedAt));
  assert.ok(view.totals.pending >= 1, 'Parents created by commits remain pending.');
  const page2 = await tree.progress(['visible'], { offset: view.nextOffset, limit: 1 }); assert.equal(page2.entries[0].origin, null); assert.equal(page2.nextOffset, null);
  const pending = await tree.progress(['visible'], { state: 'pending' }); assert.ok(pending.entries.every(row => row.chatId === 'visible'));
  await assert.rejects(tree.progress(['visible'], { chatId: 'excluded' }), /unavailable/);
  for (const options of [{ state: 'invalid' }, { limit: 51 }, { offset: -1 }]) await assert.rejects(tree.progress(['visible'], options));
  await tree.close(); tree = await new ChatMemoryTree(directory).init();
  view = await tree.progress(['visible'], { state: 'catchup' }); assert.equal(view.total, 1); assert.equal(view.totals.savedCatchUp, 1); assert.equal(view.entries[0].origin, 'catchup');
  await tree.removeChat('visible'); assert.equal((await tree.progress(['visible'])).totals.savedCatchUp, 0);
});
