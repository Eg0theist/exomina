import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REQUEST_LIMITS, RequestGuard, RequestLimitError, normalizeRequestLimits } from '../desktop/request-guard.mjs';

const clock = () => { let time = 1_000_000_000_000; const now = () => time; now.advance = ms => { time += ms; }; return now; };

test('availability is read-only and reports when all rolling safety windows have room', () => {
  const now = clock(), emitted = [], guard = new RequestGuard({ now, emit: event => emitted.push(event), getLimits: () => ({ background: { hour: 2, day: 3 } }) });
  const first = now();
  guard.check({ provider: 'codex', kind: 'background' }); now.advance(1000);
  guard.check({ provider: 'codex', kind: 'background' });
  const before = JSON.stringify(guard.view());
  for (let i = 0; i < 10; i++) assert.deepEqual(guard.availability({ provider: 'codex', kind: 'background' }), { blocked: true, reason: 'hour', window: 'hour', used: 2, max: 2, retryAt: first + 3600000 });
  assert.equal(JSON.stringify(guard.view()), before); assert.equal(emitted.length, 0);
  now.advance(3600000);
  guard.check({ provider: 'codex', kind: 'background' });
  const block = guard.availability({ provider: 'codex', kind: 'background' });
  assert.equal(block.window, 'day'); assert.equal(block.retryAt, first + 86400000);
  now.advance(block.retryAt - now()); assert.equal(guard.availability({ provider: 'codex', kind: 'background' }).blocked, false);
  guard.persistenceError = 'Unavailable'; assert.equal(guard.availability({ provider: 'codex' }).reason, 'storage');
  guard.getLimits = () => ({ enabled: false }); assert.equal(guard.availability({ provider: 'codex' }).blocked, false);
});

test('limits are normalized, bounded and never lower the daily cap below the hourly one', () => {
  assert.deepEqual(normalizeRequestLimits(undefined), DEFAULT_REQUEST_LIMITS);
  assert.deepEqual(normalizeRequestLimits({ background: { hour: 5, day: 2 }, reply: { hour: -3, day: 'x' } }), { enabled: true, reply: { hour: 120, day: 600 }, background: { hour: 5, day: 5 }, tokens: { hour: 1000000, day: 5000000 } });
  assert.equal(normalizeRequestLimits({ enabled: false }).enabled, false);
  assert.equal(normalizeRequestLimits({ reply: { hour: 10 ** 9 } }).reply.hour, 120);
});

test('an hourly limit refuses the next request with a plain explanation, then recovers as the window moves', () => {
  const now = clock(), events = [];
  const guard = new RequestGuard({ getLimits: () => ({ background: { hour: 3, day: 100 } }), now, emit: event => events.push(event), nameOf: () => 'ChatGPT' });
  for (let index = 0; index < 3; index++) guard.check({ provider: 'codex', kind: 'background' });
  assert.throws(() => guard.check({ provider: 'codex', kind: 'background' }), error => error instanceof RequestLimitError && error.code === 'requestLimit' && /ChatGPT/.test(error.message) && /safety limit is 3/.test(error.message) && /not your plan/.test(error.message));
  assert.throws(() => guard.check({ provider: 'codex', kind: 'background' }), RequestLimitError);
  assert.equal(events.length, 1, 'one notice per window, not one per refusal');
  guard.check({ provider: 'codex', kind: 'reply' });
  guard.check({ provider: 'claude', kind: 'background' });
  now.advance(3600_001);
  guard.check({ provider: 'codex', kind: 'background' });
});

test('the daily limit holds even when each hour looks calm', () => {
  const now = clock();
  const guard = new RequestGuard({ getLimits: () => ({ reply: { hour: 10, day: 12 } }), now });
  for (let hour = 0; hour < 2; hour++) { for (let index = 0; index < 6; index++) guard.check({ provider: 'grok', kind: 'reply' }); now.advance(3600_001); }
  assert.throws(() => guard.check({ provider: 'grok', kind: 'reply' }), error => error.window === 'day');
});

test('turning the limits off allows requests but still counts them, and bad input is rejected', () => {
  const guard = new RequestGuard({ getLimits: () => ({ enabled: false, background: { hour: 1, day: 1 } }), now: clock() });
  for (let index = 0; index < 5; index++) guard.check({ provider: 'codex', kind: 'background' });
  assert.equal(guard.view().used.codex.background.hour, 5);
  assert.throws(() => guard.check({ provider: 'codex', kind: 'other' }), TypeError);
  assert.throws(() => guard.check({ kind: 'reply' }), TypeError);
});

test('counts survive a restart so a crash loop cannot reset the safeguard', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'request-guard.json'), now = clock(), limits = () => ({ background: { hour: 2, day: 10 } });
  const first = await new RequestGuard({ file, getLimits: limits, now }).init();
  first.check({ provider: 'codex', kind: 'background' }); first.check({ provider: 'codex', kind: 'background' });
  await first.close();
  assert.match(await readFile(file, 'utf8'), /codex:background/);
  const second = await new RequestGuard({ file, getLimits: limits, now }).init();
  assert.throws(() => second.check({ provider: 'codex', kind: 'background' }), RequestLimitError);
  await second.close();
  await writeFile(file, '{ not json');
  const third = await new RequestGuard({ file, getLimits: limits, now }).init();
  assert.throws(()=>third.check({ provider: 'codex', kind: 'background' }),/saved safety counters/);
  await third.close();
  assert.equal(await readFile(file,'utf8'),'{ not json','closing must not overwrite unreadable safety counters');
});

test('concurrent API reservations share a durable cap and rejected reservations leave it unchanged',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'guard-reserve-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'guard.json'),now=clock(),limits=()=>({tokens:{hour:1000,day:1000}});
  const guard=await new RequestGuard({file,now,getLimits:limits}).init();
  await guard.reserveTokens('openai-api',700);
  await assert.rejects(guard.reserveTokens('openai-api',400),RequestLimitError);
  assert.equal(guard.view().tokens['openai-api'].hour,700);
  const restarted=await new RequestGuard({file,now,getLimits:limits}).init();
  await assert.rejects(restarted.reserveTokens('openai-api',400),RequestLimitError);
  await restarted.close();await guard.close();
});

test('a refused request never reaches account preparation or a provider process', async t => {
  const { ProviderManager } = await import('../desktop/providers.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'exomina-guard-manager-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seen = [], calls = { prepare: 0, spawn: 0 };
  const manager = new ProviderManager({
    dataDir: path.join(directory, 'private'), workspace: path.join(directory, 'workspace'), codexPath: process.execPath, claudePath: process.execPath,
    isProviderEnabled: () => true,
    beforePrepare: async () => { calls.prepare++; }, spawnImpl: () => { calls.spawn++; throw Error('Unexpected process start.'); },
    beforeRequest: request => { seen.push(request); throw new RequestLimitError('Paused by the safeguard.', request); },
  });
  t.after(() => manager.close());
  await assert.rejects(manager.run({ provider: 'codex', conversationId: 'chat', prompt: 'Hello' }), /Paused by the safeguard/);
  await assert.rejects(manager.run({ provider: 'codex', conversationId: 'helper', prompt: 'Summarize', ephemeral: true }), RequestLimitError);
  await assert.rejects(manager.oneShot('claude', 'Name this chat'), RequestLimitError);
  assert.deepEqual(seen.map(request => [request.provider, request.kind]), [['codex', 'reply'], ['codex', 'background'], ['claude', 'background']]);
  assert.deepEqual(calls, { prepare: 0, spawn: 0 });
});

test('API tokens are estimated, capped per connection, persisted, and refused before the next round', async () => {
  const now = clock(), events = [];
  const dir = await mkdtemp(path.join(os.tmpdir(), 'guard-tokens-')), file = path.join(dir, 'guard.json');
  try {
    const guard = await new RequestGuard({ file, getLimits: () => ({ tokens: { hour: 1000, day: 1500 } }), now, emit: event => events.push(event), nameOf: () => 'OpenAI API', writeDelay: 1 }).init();
    guard.checkTokens('openai-api');
    guard.addTokens('openai-api', 600); guard.addTokens('openai-api', 500.2);
    assert.throws(() => guard.checkTokens('openai-api'), error => error instanceof RequestLimitError && error.kind === 'tokens' && error.window === 'hour' && /OpenAI API/.test(error.message));
    guard.checkTokens('anthropic-api');
    assert.equal(events.length, 1);
    assert.deepEqual(guard.view().tokens['openai-api'], { hour: 1101, day: 1101 });
    await guard.close();
    const again = await new RequestGuard({ file, getLimits: () => ({ tokens: { hour: 1000, day: 1500 } }), now }).init();
    assert.throws(() => again.checkTokens('openai-api'), RequestLimitError);
    now.advance(3600_001);
    again.checkTokens('openai-api');
    again.addTokens('openai-api', 450);
    assert.throws(() => again.checkTokens('openai-api'), error => error.window === 'day');
    const off = new RequestGuard({ getLimits: () => ({ enabled: false }), now });
    off.addTokens('openai-api', 1e9); off.checkTokens('openai-api');
    assert.equal(off.view().tokens['openai-api'].hour, 1e9);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
