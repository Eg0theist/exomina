// All providers and confirmations in this file are fakes. Never redeems live credits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ManualUsageReset } from '../desktop/usage-resets.mjs';

function fixture(overrides = {}) {
  const calls = [], state = { key: null, count: 2, credits: null };
  const reset = new ManualUsageReset({ read: async () => { calls.push('read'); return { rateLimitResetCredits: { availableCount: state.count, credits: state.credits } }; }, consume: async (key, creditId) => { calls.push(['consume', key, creditId]); return { outcome: 'reset' }; }, confirm: async request => { calls.push(['confirm', request]); return true; }, getAttempt: () => state.key, saveAttempt: async key => { state.key = key; calls.push(['save', key]); }, refresh: async () => { calls.push('refresh'); return true; }, ...overrides });
  return { reset, calls, state };
}
test('opening metadata, zero credits, unsupported providers and declined confirmation do not redeem a reset', async () => {
  const { reset, calls, state } = fixture({ confirm: async () => false });
  assert.deepEqual(calls, []);
  assert.equal((await reset.request('codex')).outcome, 'cancelled');
  state.count = 0; assert.equal((await reset.request('codex')).outcome, 'noCredit');
  await assert.rejects(reset.request('claude'), /does not expose/);
  assert.ok(!calls.some(value => Array.isArray(value) && value[0] === 'consume'));
  assert.equal(state.key, null);
});

const resetCredit = (id, expiresAt = null, overrides = {}) => ({ id, expiresAt, grantedAt: Math.floor(Date.now() / 1000) - 60, resetType: 'codexRateLimits', status: 'available', title: `Reset ${id}`, ...overrides });

test('known credits default to the earliest usable expiry and an explicit choice reaches confirmation and consume unchanged', async () => {
  const soon = Math.floor(Date.now() / 1000) + 3600;
  for (const [choice, expected] of [[null, 'soon'], ['later', 'later'], ['forever', 'forever']]) {
    const { reset, calls, state } = fixture();
    state.count = 3; state.credits = [resetCredit('later', soon + 86400), resetCredit('forever'), resetCredit('soon', soon)];
    await reset.request('codex', choice);
    const confirmation = calls.find(call => call[0] === 'confirm')[1];
    assert.equal(confirmation.credit.id, expected);
    assert.equal(confirmation.credit.title, `Reset ${expected}`);
    assert.equal(confirmation.credit.expiresAt, expected === 'forever' ? null : expected === 'soon' ? soon : soon + 86400);
    const saved = calls.find(call => call[0] === 'save')[1], consumed = calls.find(call => call[0] === 'consume');
    assert.deepEqual(saved, { idempotencyKey: consumed[1], creditId: expected }); assert.equal(consumed[2], expected);
  }
});

test('expired, used, redeeming, unknown and stale selections are rejected before confirmation or redemption', async () => {
  const expired = Math.floor(Date.now() / 1000) - 10;
  for (const credit of [resetCredit('chosen', expired), resetCredit('chosen', null, { status: 'redeemed' }), resetCredit('chosen', null, { status: 'redeeming' }), resetCredit('chosen', null, { status: 'unknown' }), resetCredit('chosen', null, { resetType: 'unknown' }), { ...resetCredit('chosen'), expiresAt: undefined }, resetCredit('other')]) {
    const { reset, calls, state } = fixture(); state.credits = [credit];
    await assert.rejects(reset.request('codex', 'chosen'), /cannot be used|no longer in the refreshed list/);
    assert.equal(calls.length, 1); assert.equal(state.key, null);
  }
  const { reset, calls } = fixture();
  await assert.rejects(reset.request('codex', 'not-in-count-only-data'), /did not supply reset details/);
  await assert.rejects(reset.request('codex', ''), /valid usage reset/);
  assert.equal(calls.length, 1);
});

test('a fresh zero count blocks an initial request even if detail rows still look available', async () => {
  const { reset, state, calls } = fixture(); state.count = 0; state.credits = [resetCredit('stale')];
  assert.equal((await reset.request('codex', 'stale')).outcome, 'noCredit');
  assert.deepEqual(calls, ['read']);
});

test('declining a particular credit keeps it unspent, and expiry during confirmation is checked again', async t => {
  const declined = fixture({ confirm: async () => false }); declined.state.credits = [resetCredit('chosen')];
  assert.equal((await declined.reset.request('codex', 'chosen')).outcome, 'cancelled');
  assert.equal(declined.state.key, null); assert.ok(!declined.calls.some(call => call[0] === 'consume'));
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const expiring = fixture({ confirm: async () => { t.mock.timers.tick(2000); return true; } });
  expiring.state.credits = [resetCredit('chosen', 1_800_000_001)];
  await assert.rejects(expiring.reset.request('codex', 'chosen'), /expired while awaiting/);
  assert.equal(expiring.state.key, null); assert.ok(!expiring.calls.some(call => call[0] === 'consume'));
});

test('an uncertain exact choice keeps its credit and key even when the provider reports zero or no longer lists it', async () => {
  const consumed = [], confirmations = []; let first = true;
  const { reset, state } = fixture({ confirm: async data => { confirmations.push(data); return true; }, consume: async (key, creditId) => { consumed.push({ key, creditId }); if (first) { first = false; throw new Error('Connection lost'); } return { outcome: 'alreadyRedeemed' }; } });
  state.credits = [resetCredit('chosen')];
  await assert.rejects(reset.request('codex', 'chosen'), /Connection lost/);
  const pending = state.key; assert.equal(pending.creditId, 'chosen');
  state.count = 0; state.credits = [];
  await assert.rejects(reset.request('codex', 'different'), /previous reset is still pending/);
  assert.equal(state.key, pending);
  assert.equal((await reset.request('codex')).outcome, 'alreadyRedeemed');
  assert.deepEqual(consumed[0], consumed[1]); assert.equal(confirmations[1].retry, true); assert.equal(confirmations[1].credit, null);
  assert.equal(state.key, null);
});

test('legacy pending keys retry the provider-default choice and migrate to the structured attempt without changing keys', async () => {
  const { reset, state, calls } = fixture();
  const key = '12345678-1234-1234-1234-123456789abc'; state.key = key; state.count = 0;
  await assert.rejects(reset.request('codex', 'new-choice'), /previous reset is still pending/);
  assert.equal((await reset.request('codex')).outcome, 'reset');
  assert.deepEqual(calls.find(call => call[0] === 'save')[1], { idempotencyKey: key, creditId: null });
  assert.deepEqual(calls.find(call => call[0] === 'consume'), ['consume', key, null]);
});
test('redemption happens only after confirmation and confirmed outcomes clear the attempt and refresh', async () => {
  const { reset, calls, state } = fixture();
  assert.deepEqual(await reset.request('codex'), { outcome: 'reset', usageRefreshed: true });
  assert.equal(calls[1][0], 'confirm'); assert.equal(calls[2][0], 'save'); assert.equal(calls[3][0], 'consume');
  assert.match(calls[3][1], /^[\da-f-]{36}$/); assert.equal(state.key, null); assert.equal(calls.at(-1), 'refresh');
});
test('uncertain outcomes keep the same request key and can be checked manually even after the last credit was consumed', async () => {
  let fail = true; const consumed = [], confirmations = [];
  const { reset, state } = fixture({ confirm: async data => { confirmations.push(data); return true; }, consume: async key => { consumed.push(key); if (fail) { fail = false; throw new Error('Connection lost'); } return { outcome: 'alreadyRedeemed' }; } });
  await assert.rejects(reset.request('codex'), /Connection lost/);
  assert.ok(state.key); state.count = 0;
  const result = await reset.request('codex');
  assert.equal(result.outcome, 'alreadyRedeemed'); assert.equal(consumed[0], consumed[1]); assert.equal(state.key, null);
  assert.equal(confirmations.length, 2); assert.equal(confirmations[1].retry, true); assert.equal(confirmations[1].count, 0);
});
test('concurrent clicks cannot redeem twice and a failed usage refresh does not erase a confirmed result', async () => {
  let confirm; const { reset, calls } = fixture({ confirm: () => new Promise(resolve => { confirm = resolve; }), refresh: async () => { throw new Error('Offline'); } });
  const first = reset.request('codex'); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(reset.request('codex'), /already awaiting/); confirm(true);
  assert.deepEqual(await first, { outcome: 'reset', usageRefreshed: false });
  assert.equal(calls.filter(value => Array.isArray(value) && value[0] === 'consume').length, 1);
});
test('unknown reset outcomes remain pending instead of spending a new credit on retry', async () => {
  const { reset, state } = fixture({ consume: async () => ({ outcome: 'unexpected' }) });
  await assert.rejects(reset.request('codex'), /did not confirm/); const key = state.key;
  await assert.rejects(reset.request('codex'), /did not confirm/); assert.deepEqual(state.key, key);
});
test('reset redemption is desktop UI only, with unconditional native confirmation and no agent-tool definition', async () => {
  const main = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /case 'usage\.resetCredit'/);
  assert.match(main, /dialog\.showMessageBox\(window,\{type:'question',title:'Use a ChatGPT usage reset\?'/);
  assert.match(main, /defaultId:0,cancelId:0/);
  const definitions = main.slice(main.indexOf('function definitions()'), main.indexOf('function callTool('));
  assert.ok(!definitions.includes('usageReset') && !definitions.includes('resetCredit'));
  const automated = main.slice(main.indexOf('const result=await runWithFallback'), main.indexOf('/** Names a chat'));
  assert.ok(!automated.includes('consumeCodexReset') && !automated.includes('usageReset'));
});
