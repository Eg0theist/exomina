import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatMemoryBackfill, backfillEnabled, backfillCap, backfillChoice, backfillUsageCeiling, backfillUsageBlock, chooseBackfillModel, localDay, BACKFILL_DAILY_CAP } from '../desktop/chat-memory-backfill.mjs';
import { ChatMemoryCompactor } from '../desktop/chat-memory-compactor.mjs';
import { ChatMemoryTree } from '../desktop/chat-memory-tree.mjs';
import { RequestGuard } from '../desktop/request-guard.mjs';

const NOW = Date.parse('2026-10-20T12:00:00');
const fresh = (used = 10, extra = {}, at = NOW) => ({ codex: { provider: 'codex', fetchStatus: 'ready', updatedAt: new Date(at).toISOString(), windows: [{ id: 'primary', usedPercent: used, resetsAt: new Date(at + 3_600_000).toISOString() }, { id: 'secondary', usedPercent: 5, resetsAt: new Date(at + 86_400_000).toISOString() }], ...extra } });
const models = [
  { provider: 'claude', model: 'haiku', role: 'light', available: true, efforts: [] },
  { provider: 'codex', model: 'gpt-6.1-sol', role: 'balanced', available: true, defaultEffort: 'low', efforts: ['low', 'medium'] },
  { provider: 'codex', model: 'gpt-6-luna', role: 'light', available: true, defaultEffort: 'medium', efforts: ['low', 'medium', 'high'] }
];

test('two parallel catch-up requests share hourly and daily accounting without dispatching past the guard', async () => {
  const f = await setup({ settings: { chatMemoryBackfillDailyCap: 3 } });
  const guard = new RequestGuard({ now: () => NOW, getLimits: () => ({}), getCatchUpLimit: () => 2 });
  f.backfill.getRequestAvailability = provider => guard.availability({ provider, kind: 'catchup' });
  const tree = await new ChatMemoryTree(path.join(f.dir, 'real-queue')).init();
  await tree.sync('a', Array.from({ length: 4 }, (_, id) => ({ key: String(id), role: 'user', kind: 'message', text: `Synthetic decision ${id}. ` + 'Detailed context. '.repeat(60) })));
  let calls = 0;
  const worker = new ChatMemoryCompactor({ tree, concurrency: 2, available: () => models, chooseModel: list => f.backfill.choose(list), beforeRequest: (job, model) => f.backfill.reserve(job, model), summarize: async () => { await guard.checkAndPersist({ provider: 'codex', kind: 'catchup' }); calls++; await new Promise(resolve => setImmediate(resolve)); return 'Retained decision.'; } });
  try {
    worker.notify('*'); await worker.drain();
    assert.equal(calls, 2); assert.equal(worker.stats().completed, 2); assert.ok(f.backfill.status().requests >= calls && f.backfill.status().requests <= 3, 'A reservation racing the hourly gate stays conservatively counted, without dispatch.'); assert.equal(guard.view().used.codex.catchup.hour, 2);
    assert.equal(guard.availability({ provider: 'codex', kind: 'catchup' }).blocked, true); assert.ok(['safety-hour', 'daily-cap'].includes(f.backfill.status().reason)); assert.equal((await tree.stats('a')).pendingJobs, 2); assert.equal((await tree.stats('a')).jobs.running, 0); assert.equal((await tree.audit('a')).valid, true);
  } finally { await worker.close(); await tree.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('recommended retries Luna once then uses verified Sol for that source and returns to Luna for the next', async () => {
  const f = await setup();
  const jobs = [0, 1].map(id => ({ id, count: 1, chatId: 'a', sourceHash: String(id), state: 'ready' }));
  const used = [];
  const tree = {
    async readyJobs(limit) { return jobs.filter(job => job.state === 'ready').slice(0, limit).map(job => { job.state = 'running'; return { ...job, token: String(job.id) }; }); },
    async sourceTask() { return { source: [{ text: 'User corrected the path; verification is pending.' }], prefix: '[user/text]' }; },
    async commitSummary(job) { jobs[job.id].state = 'built'; return { committed: true }; },
    async failJob(job) { jobs[job.id].state = 'failed'; }
  };
  const worker = new ChatMemoryCompactor({ tree, concurrency: 1, available: () => models,
    chooseModel: list => f.backfill.choose(list), chooseFallback: (list, current) => f.backfill.fallback(list, current),
    beforeRequest: (job, model) => f.backfill.reserve(job, model),
    summarize: async ({ model, job }) => { used.push(model.model); return job.id === 0 && model.model === 'gpt-6-luna' ? 'x'.repeat(600) : 'Correction retained; verification pending.'; }
  });
  try {
    worker.notify('*'); await worker.drain();
    assert.deepEqual(used, ['gpt-6-luna', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna']);
    assert.equal(f.backfill.status().requests, 4); assert.equal(worker.stats().completed, 2);
    const luna = { ...chooseBackfillModel(models), backfill: true };
    f.state.settings.chatMemoryBackfillModel = { provider: 'codex', model: 'gpt-6-luna', effort: 'high' };
    assert.equal(f.backfill.fallback(models, luna), null, 'An explicit choice cannot silently switch.');
    delete f.state.settings.chatMemoryBackfillModel;
    assert.equal(f.backfill.fallback(models.filter(model => model.model !== 'gpt-6.1-sol'), luna), null);
    f.state.usage = fresh(90); assert.equal(f.backfill.fallback(models, luna), null, 'Fallback keeps the usage guard.');
  } finally { await worker.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('catch-up waits before reserving at the real global safety limit and recovers when its window expires', async () => {
  let now = NOW;
  const f = await setup({ settings: { chatMemoryBackfillDailyCap: null }, now: () => now });
  const guard = new RequestGuard({ now: () => now, getLimits: () => ({ background: { hour: 2, day: 10 } }) });
  f.backfill.getRequestAvailability = provider => guard.availability({ provider, kind: 'background' });
  const jobs = Array.from({ length: 3 }, (_, id) => ({ id, chatId: 'a', count: 1, token: String(id), state: 'ready' }));
  const tree = {
    async readyJobs(limit) { return jobs.filter(job => job.state === 'ready').slice(0, limit).map(job => { job.state = 'running'; return job; }); },
    async sourceTask() { return { source: [{ text: 'Synthetic retained decision.' }] }; },
    async commitSummary(job) { jobs[job.id].state = 'built'; return { committed: true }; },
    async failJob(job) { jobs[job.id].state = 'failed'; }
  };
  let calls = 0;
  const worker = new ChatMemoryCompactor({ tree, concurrency: 1, now: () => now, available: () => models,
    chooseModel: list => f.backfill.choose(list), beforeRequest: (job, model) => f.backfill.reserve(job, model),
    summarize: async () => { await guard.checkAndPersist({ provider: 'codex', kind: 'background' }); calls++; return 'Retained decision.'; }
  });
  try {
    worker.notify('*'); await worker.drain();
    assert.equal(calls, 2); assert.equal(f.backfill.status().requests, 2); assert.equal(worker.stats().failed, 0);
    assert.equal(f.backfill.status().reason, 'safety-hour'); assert.equal(f.backfill.status().safety.max, 2);
    for (let i = 0; i < 20; i++) worker.notify('*'); await worker.drain();
    assert.equal(f.backfill.status().requests, 2, 'Wakes at the safety gate consume no reservations.');
    now += 3600001; f.state.usage = fresh(10, {}, now);
    worker.notify('*'); await worker.drain();
    assert.equal(calls, 3); assert.equal(worker.stats().completed, 3); assert.equal(worker.stats().failed, 0);
    assert.ok(jobs.every(job => job.state === 'built'));
    assert.equal(f.backfill.status().requests, 3);
  } finally { await worker.close(); await rm(f.dir, { recursive: true, force: true }); }
});
async function setup({ settings = {}, usage = fresh(), now = () => NOW } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-backfill-'));
  const refreshed = [];
  const state = { settings: { chatMemoryEnabled: true, ...settings }, usage };
  const make = () => new ChatMemoryBackfill({ file: path.join(dir, 'backfill.json'), getSettings: () => state.settings, getUsage: () => state.usage, refreshUsage: id => refreshed.push(id), now }).load();
  return { dir, state, refreshed, make, backfill: await make() };
}

test('an oversized summary keeps its correction across a rolling safety pause', async () => {
  let now = NOW;
  const f = await setup({ settings: { chatMemoryBackfillDailyCap: null }, now: () => now });
  const guard = new RequestGuard({ now: () => now, getLimits: () => ({ background: { hour: 1, day: 10 } }) });
  f.backfill.getRequestAvailability = provider => guard.availability({ provider, kind: 'background' });
  const job = { id: 1, chatId: 'a', count: 1, sourceHash: 'unchanged-source', state: 'ready' };
  let claims = 0, calls = 0;
  const requests = [];
  const tree = {
    async readyJobs() { if (job.state !== 'ready') return []; job.state = 'running'; return [{ ...job, token: String(++claims) }]; },
    async sourceTask() { return { source: [{ id: 1, text: 'Synthetic retained decision.' }] }; },
    async commitSummary() { job.state = 'built'; return { committed: true }; },
    async deferJob() { job.state = 'ready'; },
    async failJob() { job.state = 'failed'; }
  };
  const worker = new ChatMemoryCompactor({ tree, concurrency: 1, now: () => now, available: () => models,
    chooseModel: list => f.backfill.choose(list), beforeRequest: (j, model) => f.backfill.reserve(j, model),
    summarize: async request => {
      await guard.checkAndPersist({ provider: 'codex', kind: 'background' }); calls++; requests.push(request);
      return request.task.includes('Attempt 2:') ? 'Retained decision.' : 'PRIVATE_CANDIDATE_'.repeat(50);
    }
  });
  try {
    worker.notify('*'); await worker.drain();
    assert.equal(calls, 1); assert.equal(job.state, 'ready'); assert.equal(worker.stats().pendingRewrites, 1);
    assert.ok(worker.stats().lastResponseBytes > 512); assert.equal(worker.stats().lastResponseEmpty, false);
    assert.doesNotMatch(JSON.stringify(worker.stats()), /PRIVATE_CANDIDATE/);
    worker.notify('*'); await worker.drain(); assert.equal(calls, 1);
    now += 3600001; f.state.usage = fresh(10, {}, now);
    worker.notify('*'); await worker.drain();
    assert.equal(calls, 2); assert.equal(job.state, 'built'); assert.equal(worker.stats().completed, 1);
    assert.match(requests[1].task, /Attempt 2: the preceding answer was 900 UTF-8 bytes/);
    assert.equal(worker.stats().pendingRewrites, 0); assert.equal(f.backfill.status().requests, 2);
  } finally { await worker.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('backfill picks GPT-6-Luna at high effort on ChatGPT and never Claude', () => {
  assert.deepEqual(chooseBackfillModel(models) && { provider: chooseBackfillModel(models).provider, model: chooseBackfillModel(models).model, effort: chooseBackfillModel(models).effort }, { provider: 'codex', model: 'gpt-6-luna', effort: 'high' });
  assert.equal(chooseBackfillModel(models.filter(model => model.model !== 'gpt-6-luna')).model, 'gpt-6.1-sol');
  assert.equal(chooseBackfillModel(models.filter(model => model.provider === 'claude')), null);
  assert.equal(chooseBackfillModel(models.map(model => ({ ...model, available: false }))), null);
});

test('settings default to on with a 1500 request cap and reject invalid caps', () => {
  assert.equal(backfillEnabled({}), true);
  assert.equal(backfillEnabled({ chatMemoryBackfill: false }), false);
  assert.equal(backfillEnabled({ chatMemoryEnabled: false }), false);
  assert.equal(backfillCap({}), BACKFILL_DAILY_CAP);
  assert.equal(backfillCap({ chatMemoryBackfillDailyCap: 0 }), 0);
  assert.equal(backfillCap({ chatMemoryBackfillDailyCap: -1 }), BACKFILL_DAILY_CAP);
  assert.equal(backfillCap({ chatMemoryBackfillDailyCap: 1.5 }), BACKFILL_DAILY_CAP);
});

test('usage must be fresh and every live ChatGPT window below the ceiling', () => {
  assert.equal(backfillUsageBlock(fresh(10).codex, NOW), '');
  assert.equal(backfillUsageBlock(fresh(50).codex, NOW), 'usage-high');
  assert.equal(backfillUsageBlock(undefined, NOW), 'usage-unknown');
  assert.equal(backfillUsageBlock({ ...fresh(10).codex, fetchStatus: 'cached' }, NOW), 'usage-unknown');
  assert.equal(backfillUsageBlock({ ...fresh(10).codex, updatedAt: new Date(NOW - 86_400_000).toISOString() }, NOW), 'usage-unknown');
  assert.equal(backfillUsageBlock({ ...fresh(10).codex, windows: [] }, NOW), 'usage-unknown');
  assert.equal(backfillUsageBlock(fresh(10, { ordinaryUsageAllowed: false }).codex, NOW), 'usage-limit');
  const expired = fresh(10).codex; expired.windows.push({ id: 'old', usedPercent: 99, resetsAt: new Date(NOW - 1).toISOString() });
  assert.equal(backfillUsageBlock(expired, NOW), 'usage-unknown');
});

test('percentage threshold is configurable or disabled without removing provider limits', async () => {
  assert.equal(backfillUsageCeiling({}), 50);
  for (const value of [-1,0,101,2.5,'90',undefined]) assert.equal(backfillUsageCeiling({chatMemoryBackfillUsageCeiling:value}),50);
  const f = await setup({usage:fresh(53),settings:{chatMemoryBackfillUsageCeiling:75}});
  try {
    const model=await f.backfill.choose(models);assert.ok(model);
    assert.equal(await f.backfill.reserve({},model),true);
    f.state.settings.chatMemoryBackfillUsageCeiling=53;
    assert.equal(await f.backfill.reserve({},model),false);
    assert.equal(f.backfill.status().reason,'usage-high');
    f.state.settings.chatMemoryBackfillUsageCeiling=null;
    f.state.usage={};assert.equal(await f.backfill.reserve({},model),true);
    assert.equal(f.backfill.status().ceiling,null);
    assert.equal(f.backfill.status().reason,'');
    f.state.usage=fresh(99,{ordinaryUsageAllowed:false});
    assert.equal(await f.backfill.reserve({},model),false);
    assert.equal(f.backfill.status().reason,'usage-limit');
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test('inspection status does not refresh usage or dispatch model requests', async () => {
  const f=await setup({usage:{}});
  try {assert.equal(f.backfill.status().reason,'usage-unknown');await new Promise(setImmediate);assert.deepEqual(f.refreshed,[]);}
  finally {await rm(f.dir,{recursive:true,force:true});}
});

test('stale provider denials refresh even when the percentage guard is disabled',async()=>{
  for(const ceiling of [75,null]){
    const f=await setup({settings:{chatMemoryBackfillUsageCeiling:ceiling},usage:fresh(10,{ordinaryUsageAllowed:false},NOW-86_400_000)});
    try{assert.equal(await f.backfill.choose(models),null);await new Promise(setImmediate);assert.deepEqual(f.refreshed,['codex']);f.state.usage=fresh(10);assert.ok(await f.backfill.choose(models));}
    finally{await rm(f.dir,{recursive:true,force:true});}
  }
});

test('the daily cap counts every request, survives a restart and resets the next day', async () => {
  let now = NOW;
  const f = await setup({ settings: { chatMemoryBackfillDailyCap: 3 }, now: () => now });
  try {
    const model = await f.backfill.choose(models);
    assert.equal(model.backfill, true);
    for (let i = 0; i < 3; i++) assert.equal(await f.backfill.reserve({ chatId: 'a' }, model), true);
    assert.equal(await f.backfill.reserve({ chatId: 'a' }, model), false);
    assert.equal(f.backfill.status().reason, 'daily-cap');
    assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'backfill.json'), 'utf8')), { day: localDay(NOW), requests: 3 });
    const restarted = await f.make();
    assert.equal(await restarted.choose(models), null);
    assert.equal(restarted.status().requests, 3);
    now = NOW + 86_400_000; f.state.usage = fresh(10, {}, now);
    assert.ok(await restarted.choose(models));
    assert.equal(restarted.status().requests, 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('off, high or unverifiable usage spends nothing and refreshes usage at most every ten minutes', async () => {
  let now = NOW;
  const f = await setup({ usage: {}, now: () => now });
  try {
    assert.equal(await f.backfill.choose(models), null);
    assert.equal(f.backfill.status().reason, 'usage-unknown');
    await f.backfill.choose(models); await new Promise(setImmediate);
    assert.deepEqual(f.refreshed, ['codex']);
    now += 10 * 60_000; await f.backfill.choose(models); await new Promise(setImmediate);
    assert.deepEqual(f.refreshed, ['codex', 'codex']);
    f.state.usage = fresh(70, {}, now);
    assert.equal(await f.backfill.choose(models), null);
    assert.equal(f.backfill.status().reason, 'usage-high');
    f.state.usage = fresh(10, {}, now); f.state.settings.chatMemoryBackfill = false;
    assert.equal(await f.backfill.choose(models), null);
    assert.equal(f.backfill.status().reason, 'off');
    assert.equal(await f.backfill.reserve({ chatId: 'a' }, { provider: 'codex', backfill: true }), false);
    assert.equal(await f.backfill.reserve({ chatId: 'a' }, { provider: 'codex' }), false, 'An on-demand lease is never counted as backfill.');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('the compactor runs idle catch-up on ChatGPT until the cap and a finished reply does not abort it', async () => {
  const f = await setup({ settings: { chatMemoryBackfillDailyCap: 5 } });
  try {
    const pending = Array.from({ length: 50 }, (_, id) => ({ id, count: 1, chatId: id % 2 ? 'a' : 'b', token: 'job-' + id, state: 'ready' }));
    const tree = { async readyJobs(limit, { chatId } = {}) { return pending.filter(job => job.state === 'ready' && (!chatId || job.chatId === chatId)).slice(0, limit).map(job => { job.state = 'running'; return job; }); }, async sourceTask() { return { source: [{ text: 'synthetic' }], maxBytes: 512 }; }, async commitSummary(job) { pending[job.id].state = 'built'; return { committed: true }; }, async failJob(job) { job.state = 'failed'; } };
    const used = [];
    const worker = new ChatMemoryCompactor({ tree, concurrency: 1, available: () => models, chooseModel: models => f.backfill.choose(models), beforeRequest: (job, model) => f.backfill.reserve(job, model), summarize: async ({ model }) => { used.push(`${model.provider}/${model.model}/${model.effort}`); return 'A retained decision.'; } });
    worker.notify('*'); await worker.drain();
    assert.equal(used.length, 5);
    assert.ok(used.every(entry => entry === 'codex/gpt-6-luna/high'));
    assert.equal(pending.filter(job => job.state === 'built').length, 5);
    worker.notify('*'); await worker.drain();
    assert.equal(used.length, 5, 'The cap holds across wakes.');
    await worker.close();

    const g = await setup();
    let signal, release;
    const slow = new ChatMemoryCompactor({ tree: { ...tree, readyJobs: async () => [{ id: 0, count: 1, chatId: 'a', token: 't', state: 'running' }] }, concurrency: 1, available: () => models, chooseModel: models => g.backfill.choose(models), beforeRequest: (job, model) => g.backfill.reserve(job, model), summarize: request => { signal = request.signal; return new Promise(resolve => { release = resolve; }); } });
    slow.notify('a'); while (!release) await new Promise(setImmediate);
    const stopping = slow.stopChat('a', { keepBackfill: true });
    await new Promise(setImmediate);
    assert.equal(signal.aborted, false);
    await stopping; release('Kept.'); await new Promise(setImmediate);
    await slow.close(); await rm(g.dir, { recursive: true, force: true });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('expired or malformed usage never authorizes catch-up', () => {
  assert.equal(backfillUsageBlock(fresh(49.9).codex, NOW), '');
  for (const usedPercent of [null, undefined, -1, '10', NaN, Infinity]) {
    const entry = fresh().codex; entry.windows[0].usedPercent = usedPercent;
    assert.equal(backfillUsageBlock(entry, NOW), 'usage-unknown');
  }
  const expired = fresh().codex; expired.windows.forEach(item => item.resetsAt = new Date(NOW - 1).toISOString());
  assert.equal(backfillUsageBlock(expired, NOW), 'usage-unknown');
  const malformed = fresh().codex; malformed.windows[0].resetsAt = 'bad-date';
  assert.equal(backfillUsageBlock(malformed, NOW), 'usage-unknown');
});

test('corrupt existing counters stop spending across restarts instead of resetting allowance', async () => {
  const f = await setup();
  try {
    for (const text of ['{broken', JSON.stringify({ day: localDay(NOW), requests: -1 }), JSON.stringify({ requests: 0 })]) {
      await writeFile(path.join(f.dir, 'backfill.json'), text, 'utf8');
      for (let restart = 0; restart < 2; restart++) {
        const worker = await f.make();
        assert.equal(await worker.choose(models), null);
        assert.equal(worker.status().reason, 'storage');
      }
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('provider default and explicit effort are honored without hidden model fallback', () => {
  assert.equal(chooseBackfillModel(models, { provider: 'codex', model: 'gpt-6-luna', effort: '' }).effort, 'medium');
  assert.equal(chooseBackfillModel(models, { provider: 'codex', model: 'gpt-6-luna', effort: 'ultra' }), null);
  assert.equal(chooseBackfillModel([{ provider: 'codex', model: 'gpt-6-astra', available: true, role: 'deep' }]), null);
});

test('pause, selection changes, lower caps and quota refreshes during a counter write prevent dispatch', async () => {
  const changes = [
    state => { state.settings.chatMemoryBackfill = false; },
    state => { state.settings.chatMemoryBackfillDailyCap = 0; },
    state => { state.settings.chatMemoryBackfillModel = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' }; },
    state => { state.settings.chatMemoryBackfillModel = { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }; },
    state => { state.settings.chatMemoryBackfillModel = { provider: 'claude', model: 'haiku', effort: '' }; },
    state => { state.usage = fresh(60); },
    state => { state.settings.chatMemoryBackfillUsageCeiling = 5; }
  ];
  for (const change of changes) {
    const f = await setup();
    try {
      let release, started;
      const writing = new Promise(resolve => { started = resolve; });
      f.backfill.writeCounter = async () => { started(); await new Promise(resolve => { release = resolve; }); };
      const model = await f.backfill.choose(models), reservation = f.backfill.reserve({ chatId: 'a' }, model);
      await writing; change(f.state); release();
      assert.equal(await reservation, false);
      assert.equal(f.backfill.status().requests, 1, 'Conservatively retain the reserved attempt.');
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }
});

test('parallel reservations never exceed the shared daily cap', async () => {
  const f = await setup({ settings: { chatMemoryBackfillDailyCap: 3 } });
  try {
    const model = await f.backfill.choose(models);
    const results = await Promise.all(Array.from({ length: 20 }, () => f.backfill.reserve({ chatId: 'a' }, model)));
    assert.equal(results.filter(Boolean).length, 3);
    assert.equal(JSON.parse(await readFile(path.join(f.dir, 'backfill.json'), 'utf8')).requests, 3);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('one global wake progresses every chat and counts oversize retries', async () => {
  const f = await setup({ settings: { chatMemoryBackfillDailyCap: 4 } });
  try {
    const pending = ['a', 'b', 'c'].map((chatId, id) => ({ id, count: 1, chatId, token: String(id), state: 'ready' }));
    const tree = { async readyJobs(limit, { chatId } = {}) { return pending.filter(job => job.state === 'ready' && (!chatId || job.chatId === chatId)).slice(0, limit).map(job => { job.state = 'running'; return job; }); }, async sourceTask() { return { source: [{ text: 'Synthetic source' }], maxBytes: 512 }; }, async commitSummary(job) { pending[job.id].state = 'built'; return { committed: true }; }, async failJob(job) { pending[job.id].state = 'failed'; } };
    let calls = 0;
    const worker = new ChatMemoryCompactor({ tree, concurrency: 1, available: () => models, chooseModel: list => f.backfill.choose(list), beforeRequest: (job, model) => f.backfill.reserve(job, model), summarize: async () => ++calls === 1 ? 'x'.repeat(600) : 'Faithful synthetic result.' });
    worker.notify('*'); await worker.drain();
    assert.equal(calls, 4);
    assert.ok(pending.every(job => job.state === 'built'));
    assert.equal(f.backfill.status().requests, 4);
    await worker.close();
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('a chosen model and effort are used exactly, on that provider\'s usage, without fallback', async () => {
  const choice = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' };
  assert.deepEqual((({ provider, model, effort }) => ({ provider, model, effort }))(chooseBackfillModel(models, choice)), choice);
  assert.equal(chooseBackfillModel(models, { provider: 'codex', model: 'gpt-6.1-sol', effort: '' }).effort, 'low');
  assert.equal(chooseBackfillModel(models, { provider: 'codex', model: 'missing' }), null, 'An unavailable choice waits instead of switching.');
  assert.equal(backfillChoice({ provider: 'openai-api', model: 'x' }), null, 'Paid API providers are not offered.');
  assert.equal(backfillChoice({ provider: 'claude', model: 'haiku', effort: '' }).provider, 'claude');
  const f = await setup({ settings: { chatMemoryBackfillModel: { provider: 'claude', model: 'haiku', effort: '' } } });
  try {
    assert.equal(await f.backfill.choose(models), null);
    assert.equal(f.backfill.status().reason, 'usage-unknown', 'Claude usage must be verified separately.');
    await new Promise(setImmediate); assert.deepEqual(f.refreshed, ['claude']);
    f.state.usage = { ...fresh(10), claude: { ...fresh(10).codex, provider: 'claude' } };
    const chosen = await f.backfill.choose(models);
    assert.equal(chosen.provider, 'claude'); assert.equal(chosen.model, 'haiku');
    assert.equal(await f.backfill.reserve({ chatId: 'a' }, chosen), true);
    assert.equal(await f.backfill.reserve({ chatId: 'a' }, { ...chosen, provider: 'codex' }), false);
    assert.deepEqual((({ provider, model }) => ({ provider, model }))(f.backfill.status()), { provider: 'claude', model: 'haiku' });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('no daily limit keeps the usage guard and a counter write failure stops for the day', async () => {
  assert.equal(backfillCap({ chatMemoryBackfillDailyCap: null }), Infinity);
  const f = await setup({ settings: { chatMemoryBackfillDailyCap: null } });
  try {
    const model = await f.backfill.choose(models);
    for (let i = 0; i < 30; i++) assert.equal(await f.backfill.reserve({ chatId: 'a' }, model), true);
    assert.deepEqual((({ cap, unlimited, requests }) => ({ cap, unlimited, requests }))(f.backfill.status()), { cap: null, unlimited: true, requests: 30 });
    f.state.usage = fresh(60);
    assert.equal(await f.backfill.reserve({ chatId: 'a' }, model), false);
    assert.equal(f.backfill.status().reason, 'usage-high');
    f.state.usage = fresh(10); f.backfill.file = path.join(f.dir, 'missing', 'backfill.json');
    assert.equal(await f.backfill.reserve({ chatId: 'a' }, model), false);
    assert.equal(f.backfill.status().reason, 'storage');
    assert.equal(await f.backfill.choose(models), null);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
