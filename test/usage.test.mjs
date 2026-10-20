import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { claudeUsage, codexUsage, UsageTracker, usageStale } from '../desktop/usage.mjs';
import { UsagePoller } from '../desktop/usage-poller.mjs';
import { readClaudeUsage, CLAUDE_USAGE_ARGS, claudeUsageEnvironment } from '../desktop/provider-usage.mjs';

const resets = new Date(Date.now() + 3_600_000).toISOString();
const claude = { subscription_type: 'pro', rate_limits_available: true, rate_limits: { five_hour: { utilization: 0.5, resets_at: resets }, seven_day: { utilization: 42, resets_at: resets } } };
const codex = { rateLimits: { planType: 'pro', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: resets } } };

test('Claude native /usage uses percentage units and full reads remove missing buckets', () => {
  const first = claudeUsage(claude);
  assert.equal(first.windows[0].usedPercent, 0.5);
  const next = claudeUsage({ ...claude, rate_limits: { seven_day: { utilization: 2, resets_at: resets } } }, first);
  assert.deepEqual(next.windows.map(item => item.id), ['seven_day']);
  assert.equal(claudeUsage({ rate_limits: null }, first), null);
  assert.equal(claudeUsage({ rate_limits: { five_hour: { utilization: null } } }, first), null);
  assert.equal(claudeUsage({ status: 'allowed' }, first).updatedAt, first.updatedAt, 'non-numeric events cannot make old readings fresh');
});

test('native usage handles scoped limits and chooses the Codex bucket', () => {
  const entry = claudeUsage({ rate_limits: { limits: [{ kind: 'weekly_scoped', percent: 19.2, scope: { model: { display_name: 'Opus' } }, resets_at: resets }] } });
  assert.equal(entry.windows[0].label, 'Weekly (Opus)');
  assert.equal(entry.windows[0].usedPercent, 19.2);
  assert.equal(claudeUsage({ ...claude, rate_limits: { ...claude.rate_limits, limits: [{ kind: 'session', percent: 1, resets_at: resets }] } }).windows.length, 1, 'native bucket projections must not duplicate the endpoint rows');
  const result = codexUsage({ ...codex, rateLimitsByLimitId: { codex: { primary: { usedPercent: 9 } }, review: { primary: { usedPercent: 100 } } } });
  assert.equal(result.windows[0].usedPercent, 9);
});

test('polling is deduplicated, failures preserve clearly stale figures and other accounts finish independently', async () => {
  const tracker = new UsageTracker(); tracker.update('claude', claude);
  let release, calls = 0;
  const poller = new UsagePoller({ tracker, connected: () => true, providers: {
    claudeUsage: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    codexUsage: async () => codex,
  } });
  const first = poller.refresh(), second = poller.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(tracker.snapshot().codex.windows[0].usedPercent, 25);
  release({ rate_limits: null }); await Promise.all([first, second]);
  const failed = tracker.snapshot().claude;
  assert.equal(failed.fetchStatus, 'error'); assert.equal(failed.windows[0].usedPercent, 0.5);
  assert.equal(usageStale(failed), true);
  tracker.refreshing('claude');
  assert.equal(usageStale(tracker.snapshot().claude), true, 'failed readings stay stale during retries');
  poller.providers.claudeUsage = async () => claude;
  await poller.refresh(); assert.equal(tracker.snapshot().claude.fetchStatus, 'ready');
  assert.equal(usageStale(tracker.snapshot().claude), false);
  poller.stop();
});

test('the polling timer stops and late responses cannot change a closed host', async () => {
  let tick, cleared = 0, finish;
  const tracker = new UsageTracker({ initial: { claude: claudeUsage(claude) } });
  assert.equal(usageStale(tracker.snapshot().claude), true, 'saved readings start as cached');
  const poller = new UsagePoller({ tracker, connected: id => id === 'claude', timers: { setInterval: callback => { tick = callback; return 7; }, clearInterval: id => { assert.equal(id, 7); cleared++; } }, providers: { claudeUsage: () => new Promise(resolve => { finish = resolve; }) } });
  poller.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(usageStale(tracker.snapshot().claude), true, 'cached readings stay stale until a live result arrives');
  const pending = poller.refresh(); tick(); poller.stop(); finish(claude); await pending;
  assert.equal(cleared, 1); assert.equal(tracker.snapshot().claude.fetchStatus, 'refreshing');
  await poller.refreshProvider('claude');
  assert.equal(tracker.snapshot().claude.fetchStatus, 'refreshing');
});

class Child extends EventEmitter {
  constructor() { super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); }
  json(value) { this.stdout.write(JSON.stringify(value) + '\n'); }
}
test('Claude polling sends only initialize/get_usage, skips transcript scans and denies unsolicited actions', async () => {
  const child = new Child(), requests = [];
  child.stdin.on('data', chunk => {
    const message = JSON.parse(String(chunk)); requests.push(message);
    if (message.request?.subtype === 'initialize') queueMicrotask(() => child.json({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } }));
    if (message.request?.subtype === 'get_usage') queueMicrotask(() => {
      child.json({ type: 'control_request', request_id: 'unsafe', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
      child.json({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: claude } });
    });
  });
  assert.deepEqual(await readClaudeUsage(child), claude);
  assert.deepEqual(requests.filter(item => item.request).map(item => item.request.subtype), ['initialize', 'get_usage']);
  assert.equal(requests[1].request.skip_behaviors, true);
  assert.equal(requests.find(item => item.response?.request_id === 'unsafe').response.subtype, 'error');
  assert.ok(CLAUDE_USAGE_ARGS.includes('--no-session-persistence'));
  assert.ok(CLAUDE_USAGE_ARGS.includes('{"disableAllHooks":true}'));
});

test('Claude metadata timeouts and unavailable limits reject without fabricated numbers', async () => {
  await assert.rejects(readClaudeUsage(new Child(), 10), /timed out/);
  const child = new Child();
  child.stdin.on('data', chunk => { const request = JSON.parse(String(chunk)); queueMicrotask(() => child.json({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: request.request.subtype === 'initialize' ? {} : { rate_limits: null } } })); });
  await assert.rejects(readClaudeUsage(child), /could not fetch/);
});

test('usage-only Claude process permits the usage fetch and keeps telemetry and updating disabled', () => {
  const parent = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: 'profile' };
  const env = claudeUsageEnvironment(parent);
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
  assert.equal(parent.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(env.DISABLE_TELEMETRY, '1'); assert.equal(env.DISABLE_ERROR_REPORTING, '1'); assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(env.CLAUDE_CONFIG_DIR, 'profile');
});

test('reset credits keep expiry details across count-only polls and drop them when the count changes', () => {
  const soon = Math.floor(Date.now() / 1000) + 86_400, later = soon + 7 * 86_400;
  const detailed = codexUsage({ ...codex, rateLimitResetCredits: { availableCount: 3, credits: [
    { id: 'opaque-1', status: 'available', resetType: 'codexRateLimits', grantedAt: soon - 86_400, expiresAt: later, title: 'Bonus reset' },
    { id: 'opaque-2', status: 'available', resetType: 'codexRateLimits', grantedAt: soon - 86_400, expiresAt: null },
    { id: 'opaque-3', status: 'available', resetType: 'codexRateLimits', grantedAt: soon - 86_400, expiresAt: soon },
    { id: 'opaque-4', status: 'redeemed', resetType: 'codexRateLimits', grantedAt: soon - 86_400, expiresAt: soon }
  ] } });
  const credits = detailed.resetCredits.credits;
  assert.deepEqual(credits.map(item => item.id), ['opaque-3', 'opaque-1', 'opaque-2', 'opaque-4'], 'usable soonest first, non-expiring next, unavailable last');
  assert.deepEqual(credits.slice(0, 3).map(item => item.expiresAt), [new Date(soon * 1000).toISOString(), new Date(later * 1000).toISOString(), null]);
  assert.equal(credits[1].title, 'Bonus reset');
  assert.equal(credits[0].usable, true); assert.equal(credits[3].usable, false); assert.equal(credits[3].unavailableReason, 'Already used');
  assert.equal(detailed.resetCredits.detailsPartial, false);
  const poll = codexUsage({ ...codex, rateLimitResetCredits: { availableCount: 3, credits: null } }, detailed);
  assert.equal(poll.resetCredits.credits, credits, 'count-only polls keep the last detailed list');
  assert.equal(codexUsage({ ...codex, rateLimitResetCredits: { availableCount: 2, credits: null } }, detailed).resetCredits.credits, null, 'a changed count invalidates old details');
  assert.deepEqual(codexUsage({ ...codex, rateLimitResetCredits: { availableCount: 0, credits: [] } }, detailed).resetCredits.credits, []);
});

test('reset rows preserve uncertainty and refresh expiry without a provider request', () => {
  const soon = Math.floor(Date.now() / 1000) + 10;
  const entry = codexUsage({ ...codex, rateLimitResetCredits: { availableCount: 6, credits: [
    { id: 'missing-expiry', status: 'available', resetType: 'codexRateLimits' },
    { id: 'unknown-type', status: 'available', resetType: 'unknown', expiresAt: null },
    { id: 'unknown-status', status: 'unknown', resetType: 'codexRateLimits', expiresAt: null },
    { id: 'expired', status: 'available', resetType: 'codexRateLimits', expiresAt: soon - 100 },
    { id: 'soon', status: 'available', resetType: 'codexRateLimits', expiresAt: soon },
    { id: 'forever', status: 'available', resetType: 'codexRateLimits', expiresAt: null }
  ] } });
  assert.deepEqual(entry.resetCredits.credits.slice(0, 2).map(credit => credit.id), ['soon', 'forever']);
  assert.equal(entry.resetCredits.detailsPartial, true, 'reported count can exceed available detail rows');
  const missing = entry.resetCredits.credits.find(credit => credit.id === 'missing-expiry');
  assert.equal(missing.expiryKnown, false); assert.equal(missing.usable, false);
  assert.equal(entry.resetCredits.credits.find(credit => credit.id === 'expired').unavailableReason, 'Expired');
  const poll = codexUsage({ ...codex, rateLimitResetCredits: { availableCount: 6, credits: null } }, entry);
  assert.equal(poll.resetCredits.detailsPartial, true);
  const tracker = new UsageTracker({ initial: { codex: entry } });
  const later = tracker.snapshot((soon + 1) * 1000).codex.resetCredits.credits;
  assert.equal(later[0].id, 'forever'); assert.equal(later.find(credit => credit.id === 'soon').unavailableReason, 'Expired');
  const changed = codexUsage({ ...codex, rateLimitResetCredits: { availableCount: 2, credits: null } }, entry);
  assert.equal(changed.resetCredits.credits, null); assert.equal(changed.resetCredits.detailsPartial, false);
});

test('only explicit refreshes request reset-credit details, separately from background polls', async () => {
  const seen = [];
  const poller = new UsagePoller({ tracker: new UsageTracker(), connected: () => true, providers: {
    claudeUsage: async options => { seen.push(['claude', options]); return claude; },
    codexUsage: async options => { seen.push(['codex', options]); return codex; }
  } });
  await poller.refresh();
  await poller.refresh({ details: true });
  assert.deepEqual(seen, [['claude', { publish: false }], ['codex', { publish: false }], ['claude', { publish: false }], ['codex', { publish: false, details: true }]]);
  poller.stop();
});
