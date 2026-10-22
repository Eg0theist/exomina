import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatMemoryCompactor, CHAT_MEMORY_RULER, chooseCompactionModel, compactionRequest, correctionPrefix, validateSummary } from '../desktop/chat-memory-compactor.mjs';
import { ChatMemoryTree } from '../desktop/chat-memory-tree.mjs';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const available = () => [{ provider: 'codex', model: 'gpt-luna', role: 'light', available: true, efforts: ['low', 'medium'] }];

test('idle concurrency overlaps two jobs and foreground activity holds further dispatches to one', async () => {
  const f = fixture(6), releases = []; let foreground = false, calls = 0;
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, concurrency: 2, getConcurrency: () => foreground ? 1 : 2,
    summarize: () => { calls++; return new Promise(resolve => releases.push(() => resolve('Retained decision.'))); }
  });
  try {
    worker.notify('chat'); await nextTurn(); assert.equal(calls, 2); assert.equal(worker.stats().concurrency, 2);
    foreground = true; releases.shift()(); await nextTurn(); assert.equal(calls, 2); assert.equal(worker.stats().running, 1); assert.equal(worker.stats().concurrency, 1);
    releases.shift()(); await nextTurn(); assert.equal(calls, 3); assert.equal(worker.stats().running, 1);
    foreground = false; releases.shift()(); await nextTurn(); assert.equal(calls, 5); assert.equal(worker.stats().running, 2);
    while (f.values.size < 6) { for (const release of releases.splice(0)) release(); await nextTurn(); }
    await worker.drain(); assert.equal(calls, 6);
  } finally { await worker.close(); }
});

test('a foreground turn arriving during model lookup defers extra claims without losing work', async () => {
  const f = fixture(3); let foreground = false, gates = 0, calls = 0;
  const releases = [];
  f.tree.deferJob = async job => { f.jobs.find(value => value.id === job.id).status = 'pending'; };
  const worker = new ChatMemoryCompactor({ tree: f.tree, concurrency: 2, getConcurrency: () => foreground ? 1 : 2,
    available: async () => { if (++gates === 1) foreground = true; return available(); },
    summarize: () => { calls++; return new Promise(resolve => releases.push(() => resolve('Retained decision.'))); }
  });
  try {
    worker.notify('chat'); await nextTurn(); assert.equal(calls, 1); assert.equal(f.jobs.filter(job => job.status === 'pending').length, 2);
    while (f.values.size < 3) { releases.shift()(); await nextTurn(); assert.ok(worker.stats().running <= 1); }
    await worker.drain(); assert.equal(calls, 3); assert.equal(f.failures.length, 0);
  } finally { await worker.close(); }
});

test('validation rejects incomplete, malformed, placeholder and fenced output without cutting valid Unicode', () => {
  const options = { prefix: '[user/text]', maxBytes: 512 };
  for (const text of ['', '[pending]', '[user/text]', '[user/text] [pending]', 'A decision and', 'Details:', 'Cut off…', '```text\nClaim\n```', 'bad\uD800', '😀'.repeat(130)]) {
    assert.equal(validateSummary(text, options).valid, false, JSON.stringify(text));
  }
  const result = validateSummary('Correction: Größe is 18; source unverified.', options);
  assert.equal(result.valid, true); assert.equal(result.text, '[user/text] Correction: Größe is 18; source unverified.');
});

test('a cooling scope cannot delay a queued chat with runnable work', async () => {
  const f = fixture(1, 'b'); let now = 1000;
  f.tree.nextRetry = async ({ chatId }) => chatId === 'a' ? now + 30 * 60_000 : 0;
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, concurrency: 1, now: () => now, summarize: async () => 'Retained decision.' });
  try {
    worker.notify('a'); worker.notify('b'); await worker.drain();
    assert.equal(f.values.size, 1); assert.equal(f.jobs[0].status, 'built');
    assert.equal(worker.stats().queued, 1);
  } finally { await worker.close(); }
});

test('a temporary gate failure wakes at its own earlier deadline and retains its chat scope', async () => {
  for (const failure of ['throw', 'timeout', 'unavailable']) {
    const f = fixture(1, 'b'); let now = 1000, broken = true, serial = 0;
    const timers = new Map();
    f.tree.nextRetry = async ({ chatId }) => chatId === 'a' ? 1000 + 30 * 60_000 : 0;
    const worker = new ChatMemoryCompactor({ tree: f.tree, available, concurrency: 1, now: () => now, gateTimeoutMs: 5,
      chooseModel: (models, chatId) => {
        if (chatId === 'b' && broken) {
          if (failure === 'throw') throw Error('Private gate error');
          if (failure === 'timeout') return new Promise(() => {});
          return null;
        }
        return models[0];
      },
      setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; }, clearTimer: id => timers.delete(id),
      summarize: async () => 'Retained decision.'
    });
    try {
      worker.notify('a'); worker.notify('b'); await worker.drain();
      assert.equal(f.values.size, 0); assert.equal(timers.size, 1);
      assert.equal([...timers.values()][0].delay, 60_000, failure);
      assert.equal(worker.stats().queued, 2);
      broken = false; now += 60_000; const timer = [...timers.values()][0]; timers.clear(); timer.callback(); await worker.drain();
      assert.equal(f.values.size, 1, failure); assert.ok(f.claims.every(claim => claim.options.chatId !== undefined));
      assert.doesNotMatch(JSON.stringify(worker.stats()), /Private gate error/);
      assert.equal([...timers.values()][0].delay, 29 * 60_000);
    } finally { await worker.close(); }
    assert.equal(timers.size, 0);
  }
});

test('an idle deadline retries a failed source while other jobs progress and pause clears the timer', async () => {
  const parent = path.resolve(import.meta.dirname, '..', '.verification', 'chat-memory-compactor-tests');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'synthetic-'));
  const tree = new ChatMemoryTree(directory);
  let now = 1000, failing = true, calls = 0, nextTimer = 0;
  const timers = new Map();
  const worker = new ChatMemoryCompactor({ tree, concurrency: 1, available, now: () => now,
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }, clearTimer: id => timers.delete(id),
    summarize: async ({ job }) => { calls++; return failing && job.id === 0 && job.count === 1 ? 'x'.repeat(600) : 'A retained decision; exact originals remain available.'; }
  });
  try {
    await tree.sync('chat', Array.from({ length: 12 }, (_, id) => ({ key: String(id), role: 'user', kind: 'text', text: `Decision ${id}. ` + 'Detailed source. '.repeat(60) })));
    worker.notify('chat'); await worker.drain();
    assert.equal((await tree.stats('chat')).jobs.failed, 1);
    assert.ok(worker.stats().completed >= 11, 'The failed early leaf cannot stall the remaining eleven.');
    assert.equal(timers.size, 1); assert.equal([...timers.values()][0].delay, 60_000);
    const before = calls; failing = false; now += 60_000;
    const timer = [...timers.values()][0]; timers.clear(); timer.callback(); await worker.drain();
    assert.ok(calls > before, 'No append, explicit resume or host poll was required.');
    assert.equal((await tree.stats('chat')).pendingJobs, 0); assert.equal((await tree.audit('chat')).valid, true);
    assert.equal((await tree.zoom('chat', 0)).text.startsWith('Decision 0.'), true);
    assert.equal(timers.size, 0);
    worker.state.retryAt = now + 60_000; worker.notify('chat'); assert.equal(timers.size, 1);
    await worker.pause(); assert.equal(timers.size, 0);
  } finally { await worker.close(); await tree.close(); assert.ok(directory.startsWith(parent + path.sep)); await rm(directory, { recursive: true, force: true }); }
});

test('a global safety refusal racing dispatch stays resumable and reports its operational cause', async () => {
  const f = fixture(); let calls = 0;
  f.tree.deferJob = async job => { f.jobs.find(item => item.id === job.id).status = 'pending'; };
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, concurrency: 1,
    summarize: async () => { calls++; throw Object.assign(Error('PRIVATE_PROVIDER_TEXT'), { code: 'requestLimit' }); }
  });
  try {
    worker.notify('*'); await worker.drain();
    assert.equal(calls, 1); assert.equal(worker.stats().lastErrorCode, 'SUMMARY_REQUEST_LIMIT');
    assert.match(worker.stats().lastError, /safety limit/); assert.doesNotMatch(JSON.stringify(worker.stats()), /PRIVATE_PROVIDER_TEXT/);
    assert.equal(f.jobs[0].status, 'pending'); assert.equal(f.failures.length, 0);
    worker.notify('*'); await worker.drain(); assert.equal(calls, 1);
  } finally { await worker.close(); }
});
function fixture(count = 1, chatId = 'chat') {
  const jobs = Array.from({ length: count }, (_, index) => ({ id: index + 1, token: `claim-${index + 1}`, chatId, status: 'pending', version: 1 }));
  const values = new Map(), failures = [], claims = [];
  const tree = {
    async readyJobs(limit, options) {
      claims.push({ limit, options });
      const ready = jobs.filter(job => job.status === 'pending' && (!options?.chatId || job.chatId === options.chatId)).slice(0, limit);
      ready.forEach(job => { job.status = 'running'; });
      return ready.map(job => ({ ...job }));
    },
    async sourceTask(job) { return { source: [{ id: job.id, text: `Fact ${job.id}: user corrected the exact path to /project/new.` }], context: [], prefix: '[user/text]', maxBytes: 512 }; },
    async commitSummary(job, text) {
      const current = jobs.find(value => value.id === job.id);
      if (current.version !== job.version) return { committed: false, stale: true };
      current.status = 'built'; values.set(job.id, text);
      return { committed: true, chatId: job.chatId };
    },
    async failJob(job, failure) {
      failures.push({ job, failure });
      const current = jobs.find(value => value.id === job.id);
      if (current.version === job.version) current.status = 'blocked';
    }
  };
  return { tree, jobs, values, failures, claims };
}

test('background selection prefers verified light helpers and never bypasses unavailable choices', () => {
  const models = [
    { provider: 'codex', model: 'astra', role: 'deep', available: true, efforts: ['high'] },
    { provider: 'claude', model: 'haiku', role: 'light', available: false, efforts: [] },
    { provider: 'codex', model: 'luna', role: 'light', available: true, efforts: ['low'] }
  ];
  assert.equal(chooseCompactionModel(models).model, 'luna');
  assert.equal(chooseCompactionModel(models).effort, 'low');
  assert.equal(chooseCompactionModel(models.map(model => ({ ...model, available: false }))), null);
  assert.equal(chooseCompactionModel([{ provider: 'deepseek', model: 'small', role: 'light', available: true, efforts: [] }]), null);
});

test('unavailable models and disabled memory leave source jobs unclaimed', async () => {
  for (const reason of ['usage', 'memory']) {
    const f = fixture(); let calls = 0;
    const worker = new ChatMemoryCompactor({ tree: f.tree, available: reason === 'usage' ? () => [] : available, enabled: () => reason !== 'memory', summarize: async () => { calls++; } });
    worker.notify('chat'); await worker.drain();
    assert.equal(calls, 0); assert.equal(f.claims.length, 0); assert.equal(f.jobs[0].status, 'pending');
    assert.equal(worker.stats().state, reason === 'usage' ? 'unavailable' : 'disabled');
    await worker.close();
  }
});

test('slow helpers stay bounded to eight concurrent jobs and notify does not await providers', async () => {
  const f = fixture(19); const releases = []; let running = 0, peak = 0, calls = 0;
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, concurrency: 999, summarize: () => new Promise(resolve => {
    running++; calls++; peak = Math.max(peak, running);
    releases.push(() => { running--; resolve('User corrected the project path to /project/new.'); });
  }) });
  assert.equal(worker.notify('chat'), undefined); await nextTurn();
  assert.equal(calls, 8); assert.equal(worker.stats().running, 8); assert.equal(worker.stats().concurrency, 8);
  assert.equal((await worker.waitUntilIdle({ timeoutMs: 2 })).idle, false);
  while (f.values.size < f.jobs.length) { for (const release of releases.splice(0)) release(); await nextTurn(); }
  await worker.drain();
  assert.equal(peak, 8); assert.equal(calls, 19); assert.equal(worker.stats().completed, 19);
  assert.ok(f.claims.length <= 8, `The indexed queue was queried ${f.claims.length} times.`);
  await worker.close();
});

test('chat-specific notifications do not compact an unrelated imported history', async () => {
  const f = fixture(3, 'old'); f.jobs.push({ id: 4, token: 'claim-4', chatId: 'current', status: 'pending', version: 1 });
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, summarize: async () => 'Current chat decision.' });
  worker.notify('current'); await worker.drain();
  assert.deepEqual([...f.values.keys()], [4]); assert.ok(f.jobs.slice(0, 3).every(job => job.status === 'pending'));
  assert.ok(f.claims.every(claim => claim.options.chatId === 'current'));
  await worker.close();
});

test('oversized Unicode summaries are rewritten, prefixed and never semantically truncated', async () => {
  const f = fixture(), requests = []; const tooLong = '漢😀'.repeat(150);
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, summarize: async request => { requests.push(request); return requests.length === 1 ? tooLong : 'Correction: preserve /project/new; previous /project/old is obsolete. Outcome unverified.'; } });
  worker.notify('chat'); await worker.drain();
  assert.equal(requests.length, 2); assert.match(requests[1].task, /preceding answer was \d+ UTF-8 bytes/);
  assert.match(requests[1].task, /possibly incomplete/); assert.match(requests[0].context, /untrusted source material/);
  assert.equal(requests[0].task.split('\n').find(line => /^-{500}/.test(line)), CHAT_MEMORY_RULER);
  assert.equal(CHAT_MEMORY_RULER.length, 512);
  assert.equal(f.values.get(1), '[user/text] Correction: preserve /project/new; previous /project/old is obsolete. Outcome unverified.');
  assert.ok(Buffer.byteLength(f.values.get(1), 'utf8') <= 512);
  await worker.close();
});

test('correction excerpts end at valid Unicode boundaries and are not used as saved summaries', () => {
  assert.equal(correctionPrefix('ab😀c', 5), 'ab');
  assert.equal(correctionPrefix('ab😀c', 6), 'ab😀');
  assert.equal(correctionPrefix('a\uD800b', 4), 'a\uFFFD');
  const request = compactionRequest({ prefix: '[user/text]', source: [{ text: 'Untrusted data' }], maxBytes: 512 }, { text: '😀'.repeat(1000), bytes: 4000 }, 2);
  assert.ok(request.task.endsWith('😀'.repeat(256)));
  assert.match(request.task, /Return only the summary/);
});

test('a retained correction never crosses changed source and is cleared when its chat is removed', async () => {
  const f = fixture(), requests = [];
  let eligible = true;
  f.tree.deferJob = async job => { f.jobs.find(item => item.id === job.id).status = 'pending'; };
  const worker = new ChatMemoryCompactor({ tree: f.tree, concurrency: 1, available: () => eligible ? available() : [],
    summarize: async request => { requests.push(request); eligible = false; return 'PRIVATE_OLD_SOURCE_'.repeat(50); }
  });
  try {
    worker.notify('chat'); await worker.drain(); assert.equal(worker.stats().pendingRewrites, 1);
    f.jobs[0].version++; eligible = true;
    worker.resume('chat'); await worker.drain();
    assert.equal(requests.length, 2); assert.doesNotMatch(requests[1].task, /Attempt 2:|PRIVATE_OLD_SOURCE_/);
    assert.equal(worker.stats().pendingRewrites, 1, 'The obsolete source correction was replaced.');
    await worker.cancelChat('chat'); assert.equal(worker.stats().pendingRewrites, 0);
  } finally { await worker.close(); }
});

test('different source jobs retain the same chronological context prefix', () => {
  const context = [{ id: 0, count: 4, text: 'Earlier decision: keep the protected workspace.' }, { id: 4, count: 2, text: 'User corrected the intended release target.' }];
  const first = compactionRequest({ context, source: [{ id: 6, text: 'New decision A' }], maxBytes: 512 }, null, 1);
  const second = compactionRequest({ context, source: [{ id: 7, text: 'New decision B' }], maxBytes: 512 }, null, 1);
  const firstBoundary = first.context.indexOf(',"source":');
  const secondBoundary = second.context.indexOf(',"source":');
  assert.ok(firstBoundary > first.context.indexOf('"earlierContext":'));
  assert.equal(first.context.slice(0, firstBoundary), second.context.slice(0, secondBoundary));
  assert.ok(first.context.indexOf('Earlier decision') < first.context.indexOf('User corrected'));
  assert.notEqual(first.context.slice(firstBoundary), second.context.slice(secondBoundary));
});

test('context lines before the source are separated from finer lines covering it', () => {
  const context = [{ id: 0, count: 4, text: 'Earlier preference: plain wording.' }, { id: 4, count: 1, text: 'Finer line A' }, { id: 5, count: 1, text: 'Finer line B' }];
  const request = compactionRequest({ context, source: [{ id: 4, count: 1, text: 'A' }, { id: 5, count: 1, text: 'B' }], maxBytes: 512 }, null, 1);
  const parsed = JSON.parse(request.context);
  assert.deepEqual(parsed.earlierContext.map(entry => entry.id), [0]);
  assert.deepEqual(parsed.finerSource.map(entry => entry.id), [4, 5]);
  assert.match(request.task, /never copy their facts/);
  assert.match(request.task, /Aim for about 348 bytes/);
});

test('five oversized or placeholder answers fail without committing truncated text', async () => {
  for (const answer of ['x'.repeat(513), '[pending]']) {
    const f = fixture(); let calls = 0;
    const worker = new ChatMemoryCompactor({ tree: f.tree, available, maxAttempts: 10, summarize: async () => { calls++; return answer; } });
    worker.notify('chat'); await worker.drain();
    assert.equal(calls, 5); assert.equal(f.values.size, 0); assert.equal(f.failures.length, 1); assert.equal(f.jobs[0].status, 'blocked');
    assert.equal(f.failures[0].failure.code, answer === '[pending]' ? 'SUMMARY_INVALID' : 'SUMMARY_OVERSIZE');
    assert.ok(!f.failures[0].failure.message.includes(answer));
    await worker.close();
  }
});

test('provider errors do not repeatedly retry until a new tree source event releases the failed job', async () => {
  const f = fixture(); let calls = 0, now = 1000;
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, now: () => now, summarize: async () => { calls++; if (calls === 1) throw Error('Provider error containing private source text.'); return 'User correction retained.'; } });
  worker.notify('chat'); await worker.drain(); await nextTurn();
  assert.equal(calls, 1); assert.equal(f.failures.length, 1); assert.ok(!f.failures[0].failure.message.includes('private source'));
  worker.notify('chat'); await worker.drain(); assert.equal(calls, 1);
  f.jobs[0].status = 'pending'; f.jobs[0].version++; worker.notify('chat'); await worker.drain(); assert.equal(calls, 1, 'A source event cannot bypass failure cooldown.');
  now += 60000; worker.notify('chat'); await worker.drain();
  assert.equal(calls, 2); assert.equal(f.values.size, 1);
  await worker.close();
});

test('a denied reservation remains resumable without spinning the ready queue or spending again on source events', async () => {
  const f = fixture(3); let reservations = 0, calls = 0, allowed = false, now = 1000;
  f.tree.deferJob = async job => { f.jobs.find(item => item.id === job.id).status = 'pending'; };
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, concurrency: 1, now: () => now,
    enabled: () => reservations < 12,
    beforeRequest: () => { reservations++; return allowed; },
    summarize: async () => { calls++; return 'Retained decision.'; }
  });
  try {
    worker.notify('*'); await worker.drain();
    assert.equal(reservations, 1); assert.equal(calls, 0); assert.equal(f.jobs[0].status, 'pending');
    assert.equal(worker.stats().lastErrorCode, 'SUMMARY_NOT_AUTHORIZED'); assert.equal(worker.stats().retryAt, 61000);
    for (let i = 0; i < 10; i++) worker.notify('chat'); await worker.drain();
    assert.equal(reservations, 1, 'New source events must not recreate a fast failure loop.');
    allowed = true; now += 60000; worker.notify('*'); await worker.drain();
    assert.equal(calls, 3); assert.equal(f.values.size, 3); assert.equal(worker.stats().lastError, '');
  } finally { await worker.close(); }
});

test('a provider failure stops a backlog burst and explicit resume can retry after correction', async () => {
  const f = fixture(10); let calls = 0, broken = true;
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, concurrency: 1, summarize: async () => {
    calls++; if (broken) throw Error('Private provider payload'); return 'Retained decision.';
  } });
  try {
    worker.notify('*'); await worker.drain();
    assert.equal(calls, 1); assert.equal(f.jobs.filter(job => job.status === 'pending').length, 9);
    assert.equal(worker.stats().lastErrorCode, 'SUMMARY_FAILED');
    assert.doesNotMatch(JSON.stringify(worker.stats()), /Private provider payload/);
    broken = false; f.jobs[0].status = 'pending'; worker.resume('*'); await worker.drain();
    assert.equal(f.values.size, 10); assert.equal(calls, 11);
  } finally { await worker.close(); }
});

test('stale versions reject late summaries and compact only the newly claimed source', async () => {
  const f = fixture(); let release, calls = 0;
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, summarize: async () => { calls++; if (calls === 1) return new Promise(resolve => { release = resolve; }); return 'Updated user correction.'; } });
  worker.notify('chat'); await nextTurn();
  f.jobs[0].version++; f.jobs[0].status = 'pending'; release('Old source summary.');
  await worker.drain();
  assert.equal(worker.stats().stale, 1); assert.equal(f.values.get(1), '[user/text] Updated user correction.');
  await worker.close();
});

test('timeout and shutdown abort runtimes even when the provider promise never resolves', async () => {
  for (const operation of ['timeout', 'close']) {
    const f = fixture(); let signal;
    const worker = new ChatMemoryCompactor({ tree: f.tree, available, timeoutMs: operation === 'timeout' ? 5 : 10_000, summarize: request => { signal = request.signal; return new Promise(() => {}); } });
    worker.notify('chat'); await nextTurn();
    if (operation === 'close') await worker.close(); else await worker.drain();
    assert.equal(signal.aborted, true); assert.equal(f.values.size, 0); assert.equal(f.failures.length, 1);
    assert.equal(worker.stats().running, 0);
    await worker.close();
  }
});

test('pausing prevents a late result and status callbacks report the selected helper and failure safely', async () => {
  const f = fixture(); let release; const statuses = [];
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, onStatus: state => statuses.push(state), summarize: () => new Promise(resolve => { release = resolve; }) });
  worker.notify('chat'); await nextTurn(); await worker.pause(); release('Late result.'); await nextTurn();
  assert.equal(f.values.size, 0); assert.equal(worker.stats().paused, true); assert.equal(worker.stats().model.model, 'gpt-luna');
  assert.ok(statuses.some(status => status.state === 'disabled'));
  await worker.close();
});

test('loss of verified usage after an oversized answer prevents the next provider request', async () => {
  const f = fixture(); let eligible = true, calls = 0;
  const worker = new ChatMemoryCompactor({ tree: f.tree, available: () => eligible ? available() : [], summarize: async () => { calls++; eligible = false; return 'x'.repeat(700); } });
  worker.notify('chat'); await worker.drain();
  assert.equal(calls, 1); assert.equal(f.values.size, 0); assert.equal(f.failures.length, 1);
  assert.equal(worker.stats().state, 'waiting');
  await worker.close();
});

test('an invalidated source lease does not spend a helper request', async () => {
  const f = fixture(); let calls = 0;
  f.tree.sourceTask = async () => ({ stale: true });
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, summarize: async () => { calls++; return 'Unused'; } });
  worker.notify('chat'); await worker.drain();
  assert.equal(calls, 0); assert.equal(worker.stats().stale, 1); assert.equal(f.failures.length, 0);
  await worker.close();
});

test('deleted-chat cancellation aborts its active helper and discards completion wakeups', async () => {
  const f = fixture(2), requests = []; let release;
  const worker = new ChatMemoryCompactor({ tree: f.tree, available, concurrency: 1, summarize: request => { requests.push(request); return new Promise(resolve => { release = resolve; }); } });
  worker.notify('chat'); await nextTurn();
  await worker.cancelChat('chat');
  assert.equal(requests[0].signal.aborted, true);
  release('Late summary.'); worker.notify('chat'); await nextTurn(); await worker.drain();
  assert.equal(requests.length, 1); assert.equal(f.values.size, 0);
  assert.equal(f.jobs[1].status, 'pending'); assert.equal(worker.stats().running, 0); assert.equal(worker.stats().queued, 0);
  await worker.close();
});

test('the real tree drains leaf and newly ready parent jobs while retaining exact originals', async () => {
  const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.verification', 'chat-memory-compactor-tests');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'synthetic-'));
  const tree = new ChatMemoryTree(directory, { turnHigh: 1_500, turnLow: 750, compactionHigh: 1_800, compactionLow: 900 });
  let worker; const requests = [];
  try {
    await tree.sync('chat', Array.from({ length: 32 }, (_, id) => ({ key: `event-${id}`, role: 'user', kind: 'message', text: `Correction ${id}: the exact path is /project/new-${id}, not /project/old. ${'Original evidence. '.repeat(35)}` })));
    worker = new ChatMemoryCompactor({ tree, available, summarize: async request => {
      requests.push(request);
      if (request.job.count === 1) return `User correction ${request.job.id}: use /project/new-${request.job.id}. ${'Detail '.repeat(38)}`;
      return `User corrections ${request.job.id} through ${request.job.id + request.job.count - 1}: corrected project paths; retain exact originals for each reference. Verification remains pending.`;
    } });
    worker.notify('chat'); await worker.drain();
    assert.ok(requests.some(request => request.job.count > 1), 'Completed leaves should make parent jobs ready.');
    assert.ok(requests.every(request => ![...JSON.parse(request.context).earlierContext, ...JSON.parse(request.context).finerSource].some(entry => entry.pending)), 'No context placeholder should reach a helper.');
    const stats = await tree.stats('chat');
    assert.equal(stats.pendingJobs, 0); assert.ok(stats.viewBytes <= 1_500); assert.ok(stats.compactionBytes <= 1_800);
    const original = await tree.zoom('chat', 7, 1);
    assert.match(original.text, /^Correction 7: the exact path is \/project\/new-7/);
    assert.equal(original.totalBytes, Buffer.byteLength(original.text));
    const view = await tree.view('chat');
    assert.ok(view.entries.some(entry => entry.count > 1));
  } finally {
    await worker?.close(); await tree.close();
    const target = path.resolve(directory);
    assert.ok(target.startsWith(parent + path.sep) && path.basename(target).startsWith('synthetic-'));
    await rm(target, { recursive: true, force: true });
  }
});
