import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelPreferences, providerVisible, modelVisible, preferredModel, fallbackTargets, fallbackCompatible, independentUsageAllowance, usageBlocksSelection, usageExhausted, runWithFallback, handoffContext, providerUsageNotice } from '../desktop/model-preferences.mjs';
import { codexUsage, claudeUsage, usageStale } from '../desktop/usage.mjs';
import { RunActivity } from '../desktop/activity.mjs';
import {getProvider} from '../desktop/provider-catalog.mjs';

const otherSubscription=getProvider('claude')?'claude':'grok';
const connections = [{ id: 'codex', connected: true }, { id: otherSubscription, connected: true }, { id: 'grok', connected: false }, { id: 'antigravity', connected: false }];
const models = { codex: [{ id: 'gpt-main' }, { id: 'gpt-small' }], [otherSubscription]: [{ id: 'default' }, { id: 'opus' }, { id: 'sonnet' }] };
const initial = { provider: 'codex', model: 'gpt-main', effort: 'high' };
const future = new Date(Date.now() + 3600000).toISOString();
const exhausted = () => Object.assign(new Error('Subscription usage exhausted'), { code: 'usageLimitExceeded' });

test('visibility applies independently to providers, models and new default selections', () => {
  const prefs = normalizeModelPreferences({ hiddenProviders: [otherSubscription, 'made-up'], models: { codex: ['gpt-small', 'gpt-small'], grok: [], unknown: ['x'] }, fallback: { targets: [initial, initial] } });
  assert.equal(prefs.fallback.enabled, true);
  assert.equal(normalizeModelPreferences(null).fallback.enabled, true);
  assert.equal(normalizeModelPreferences({ fallback: { enabled: false } }).fallback.enabled, false);
  assert.deepEqual(prefs.hiddenProviders, [otherSubscription]); assert.equal(prefs.fallback.targets.length, 1);
  assert.equal(providerVisible(prefs, otherSubscription, connections[1]), false);
  assert.equal(providerVisible(prefs, 'grok', connections[2]), false);
  assert.equal(providerVisible(prefs, 'antigravity', connections[3]), false);
  assert.equal(providerVisible({ connectedOnly: false }, 'antigravity', connections[3]), true);
  assert.equal(modelVisible(prefs, 'codex', initial.model), false);
  assert.equal(preferredModel(prefs, 'codex', models.codex), 'gpt-small');
  assert.equal(providerVisible({ models: { codex: ['retired-model'] } }, 'codex', connections[0], models.codex), false);
  assert.equal(modelVisible({ models: { [otherSubscription]: ['auto'] } }, otherSubscription, 'default'), true);
});

test('automatic candidates exclude hidden, exhausted and disconnected choices; an ordered list skips unreported models', () => {
  const usage = { codex: codexUsage({ rateLimits: { primary: { usedPercent: 100, resetsAt: future } } }) };
  let targets = fallbackTargets({ preferences: {}, connections, models, usage, current: initial });
  assert.deepEqual(targets, [{ provider: otherSubscription, model: 'auto', effort: '' }]);
  targets = fallbackTargets({ preferences: { fallback: { mode: 'ordered', targets: [{ provider: 'grok', model: 'grok-4' }, { provider: otherSubscription, model: 'not-reported' }, { provider: otherSubscription, model: 'sonnet' }] } }, connections, models, usage, current: initial });
  assert.deepEqual(targets.map(t => t.provider + ':' + t.model), [otherSubscription+':sonnet']);
  targets = fallbackTargets({ preferences: { hiddenProviders: [otherSubscription], models: { codex: [] } }, connections, models, current: initial });
  assert.equal(targets.length, 0);
});

test('scoped Claude exhaustion allows other models but shared session exhaustion blocks them', () => {
  const usage = claudeUsage({ rate_limits: { seven_day_opus: { utilization: 100, resets_at: future }, five_hour: { utilization: 50, resets_at: future } } });
  assert.equal(usageBlocksSelection(usage, { model: 'opus' }), true);
  assert.equal(usageBlocksSelection(usage, { model: 'sonnet' }), false);
  assert.equal(usageBlocksSelection(usage, { model: 'auto' }), true);
  const scoped = claudeUsage({ rate_limits: { model_scoped: [{ display_name: 'Claude Opus 4.6', utilization: 100, resets_at: future }] } });
  assert.equal(usageBlocksSelection(scoped, { model: 'opus' }), true);
  assert.equal(usageBlocksSelection(scoped, { model: 'sonnet' }), false);
  usage.windows.find(w => w.id === 'five_hour').usedPercent = 100;
  assert.equal(usageBlocksSelection(usage, { model: 'sonnet' }), true);
  assert.equal(usageBlocksSelection({ ...usage, stale: true }, { model: 'sonnet' }), false, 'stale percentages never preempt a runtime');
});

test('Codex authoritative usage permission survives sparse updates and reset dates while preserving reset choices without account identifiers', () => {
  const first = codexUsage({ accountId: 'private-account', ordinaryUsageAllowed: false, rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'private-credit' }] }, rateLimits: { primary: { usedPercent: 100, resetsAt: future } } });
  const next = codexUsage({ ordinaryUsageAllowed: null, rateLimits: { primary: { usedPercent: 0, resetsAt: future } } }, first);
  assert.equal(next.ordinaryUsageAllowed, false); assert.equal(next.resetCredits.availableCount, 2); assert.equal(next.resetCredits.credits.length, 1);
  assert.equal(usageBlocksSelection({ ...next, stale: true }, initial), true);
  assert.ok(!JSON.stringify(next).includes('private-account'));
  assert.equal(next.resetCredits.credits[0].id, 'private-credit');
  const restored = codexUsage({ ordinaryUsageAllowed: true, rateLimitResetCredits: { availableCount: 0 }, rateLimits: { primary: { usedPercent: 0, resetsAt: future } } }, next);
  assert.equal(usageBlocksSelection(restored, initial), false); assert.equal(restored.resetCredits.availableCount, 0);
  const stale = { ...first, updatedAt: '2020-01-01T00:00:00Z', fetchStatus: 'error', stale: true };
  const metadataOnly = codexUsage({ rateLimitResetCredits: { availableCount: 1 } }, stale);
  assert.equal(metadataOnly.updatedAt, stale.updatedAt); assert.equal(usageStale(metadataOnly), true);
});

test('a reported independent quota alias can continue; unavailable metadata cannot imply recovery', () => {
  const entry = codexUsage({ ordinaryUsageAllowed: false, rateLimitsByLimitId: { codex: { primary: { usedPercent: 100, resetsAt: future } }, reserve: { normalModelSlug: 'gpt-small', spendControlReached: false, primary: { usedPercent: 10, resetsAt: future } } } });
  assert.equal(usageBlocksSelection(entry, { model: 'reserve' }), false);
  assert.equal(usageBlocksSelection(entry, { model: 'gpt-small' }), true, 'the normal slug describes the alias; it does not select that quota');
  const blocked = codexUsage({ rateLimitsByLimitId: { reserve: { spendControlReached: true } } }, entry);
  const sparse = codexUsage({ rateLimitsByLimitId: { reserve: { spendControlReached: null, primary: { usedPercent: 0, resetsAt: future } } } }, blocked);
  assert.equal(usageBlocksSelection(sparse, { model: 'reserve' }), true);
});

test('usage detection does not switch on authentication, network or ordinary request throttling', () => {
  for (const value of ['429 requests per minute exceeded', 'Your request quota exceeded: 60 requests per minute', 'Temporary rate limit reached', 'TPM quota exhausted', 'rate limit exceeded', 'Failed to authenticate', 'Server overloaded', 'Network disconnected']) assert.equal(usageExhausted(new Error(value)), false, value);
  for (const value of ["You've hit your limit", 'You’ve hit your usage limit', 'insufficient_quota', 'Weekly usage limit reached', 'You have exceeded your premium interaction quota', 'Your credit balance is too low']) assert.equal(usageExhausted(new Error(value)), true, value);
  assert.equal(usageExhausted(exhausted()), true);
  assert.equal(usageExhausted(Object.assign(new Error('DeepSeek account allowance'),{code:'ACCOUNT_QUOTA'})),true);
  for(const code of ['ACCOUNT_SIGN_IN_REQUIRED','ACCOUNT_TOKEN_INVALID']) assert.equal(usageExhausted(Object.assign(new Error('DeepSeek account sign-in required'),{code})),false);
  assert.equal(usageExhausted(Object.assign(exhausted(), { handoffUnsafe: true })), false);
});

test('success-shaped quota notices and hung usage refreshes switch automatically without another user message', async () => {
  for (const text of ["You've hit your limit · resets 9pm", "You're out of extra usage · resets tomorrow", 'Limit reached · resets 10pm']) {
    const calls = [];
    const result = await runWithFallback({ initial: { provider: 'claude', model: 'opus' }, enabled: true, candidates: () => [initial],
      refreshUsage: () => new Promise(() => {}), refreshTimeoutMs: 1,
      run: async target => { calls.push(target.provider); if (target.provider === 'claude' && providerUsageNotice(text)) throw Object.assign(Error(text), { usageLimited: true }); return { text: 'Finished work' }; } });
    assert.deepEqual(calls, ['claude', 'codex']); assert.equal(result.text, 'Finished work');
  }
});

test('a successful answer quoting a usage notice cannot cause the host to repeat task work', async () => {
  let calls = 0;
  const result = await runWithFallback({ initial, enabled: true, candidates: () => [{ provider: 'claude', model: 'opus' }], run: async () => { calls++; return { text: 'You have reached your daily limit.' }; } });
  assert.equal(calls, 1); assert.equal(result.selection, initial);
});

test('visual and tool tasks skip incompatible fallbacks while ordinary text can use them', () => {
  const connected = [{ id: 'codex', connected: true }, { id: 'antigravity', connected: true, supportsTools: false, supportsImages: false }, { id: 'grok', connected: true, supportsImages: true }];
  const exhaustedUsage = { codex: codexUsage({ rateLimits: { primary: { usedPercent: 100, resetsAt: future } } }) };
  const candidates = requirements => fallbackTargets({ preferences: {}, connections: connected, models, usage: exhaustedUsage, current: initial, requirements }).map(item => item.provider);
  assert.deepEqual(candidates({}), ['antigravity', 'grok']);
  assert.deepEqual(candidates({ tools: true }), ['grok']);
  assert.deepEqual(candidates({ images: true }), ['grok']);
  assert.equal(fallbackCompatible({ provider: 'grok', model: 'vision' }, connected[2], [{ id: 'vision', supportsImages: false }], { images: true }), false);
  assert.equal(fallbackCompatible({ provider: 'kimi-code', model: 'auto' }, { connected: true }, [], { images: true }), false);
  const scopedImageBridge = { supportsImages: false, supportsImageAttachments: true, supportsTools: true };
  assert.equal(fallbackCompatible({ provider: 'antigravity', model: 'auto' }, scopedImageBridge, [], { images: true, tools: true }), true);
  assert.equal(fallbackCompatible({ provider: 'antigravity', model: 'auto' }, scopedImageBridge, [], { images: true }), false);
});

test('a hard allowance failure skips other models at that provider without verified independent usage', async () => {
  const attempts = [];
  const result = await runWithFallback({ initial, enabled: true, candidates: () => [{ provider: 'codex', model: 'gpt-small' }, { provider: 'claude', model: 'sonnet' }], run: async target => { attempts.push(target.provider); if (target.provider === 'codex') throw exhausted(); return { text: 'continued' }; } });
  assert.deepEqual(attempts, ['codex', 'claude']);
  assert.equal(result.selection.provider, 'claude');
});

test('fresh scoped usage can prove a different model has an independent available allowance', async () => {
  const from = { provider: 'claude', model: 'opus' }, to = { provider: 'claude', model: 'sonnet' };
  const entry = claudeUsage({ rate_limits: { seven_day_opus: { utilization: 100, resets_at: future }, five_hour: { utilization: 50, resets_at: future } } });
  assert.equal(independentUsageAllowance(entry, from, to), true);
  assert.equal(independentUsageAllowance(null, from, to), false);
  assert.equal(independentUsageAllowance({ ...entry, updatedAt: '2000-01-01T00:00:00.000Z' }, from, to), false);
  const result = await runWithFallback({ initial: from, enabled: true, candidates: () => [to], independentAllowance: (failed, next) => independentUsageAllowance(entry, failed, next), run: async target => { if (target.model === 'opus') throw exhausted(); return { text: 'continued' }; } });
  assert.equal(result.selection.model, 'sonnet');
});

test('handoff waits for tools, carries progress, and keeps one logical task through multiple exhausted models', async () => {
  let releaseTool, written = false;
  const outstanding = new Promise(resolve => { releaseTool = () => { written = true; resolve(); }; });
  const order = [], message = { content: '', activity: [] };
  const activity = new RunActivity(message, { conversationId: 'task', emit: event => order.push(event.type) });
  const pending = runWithFallback({ initial, enabled: true, candidates: () => [{ provider: 'claude', model: 'opus' }, { provider: 'grok', model: 'grok-main' }], settle: () => outstanding,
    onSwitch: async () => { assert.equal(written, true); const checkpoint = handoffContext(message); assert.match(checkpoint, /file created/); assert.ok(!checkpoint.includes('PRIVATE REASONING')); activity.handoff('Continuing with the next model.'); },
    run: async (selection, attempt) => { order.push(selection.model); if (!attempt) { activity.thinking({ id: 'private', text: 'PRIVATE REASONING', start: true }); activity.tool({ id: 'write', name: 'workspace_write', input: { path: 'output.txt' }, status: 'done', output: 'file created' }); throw exhausted(); } if (attempt === 1) throw exhausted(); return { text: 'Task complete', sessionId: 'new-session' }; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!order.includes('opus'), 'the next provider must not race an existing tool');
  releaseTool(); const result = await pending; activity.finish(result.text);
  assert.equal(result.selection.model, 'grok-main'); assert.equal(message.content, 'Task complete');
  assert.ok(message.activity.some(step => step.name === 'workspace_write' && step.status === 'done'));
  assert.ok(!message.finishedAt || Date.parse(message.finishedAt) >= Date.parse(message.startedAt));
});

test('cancellation during metadata and non-usage failures cannot start another runtime', async () => {
  let calls = 0, stopped = false, switches = 0;
  await assert.rejects(runWithFallback({ initial, enabled: true, cancelled: () => stopped, candidates: () => [{ provider: 'claude', model: 'sonnet' }], run: async () => { calls++; throw exhausted(); }, refreshUsage: async () => { stopped = true; }, onSwitch: async () => { switches++; } }), /Stopped/);
  assert.equal(calls, 1); assert.equal(switches, 0);
  for (const enabled of [false, true]) {
    await assert.rejects(runWithFallback({ initial, enabled, candidates: () => [{ provider: 'claude', model: 'sonnet' }], run: async () => { throw new Error('Network failure'); }, onSwitch: async () => { switches++; } }), /Network failure/);
  }
  assert.equal(switches, 0);
});

test('fallback tries each target once, handles a stale unavailable model and never announces an attempt it cannot start', async () => {
  const choices = Array.from({ length: 20 }, (_, i) => ({ provider: 'claude', model: 'm' + i }));
  const attempts = [], switches = [];
  await assert.rejects(runWithFallback({ initial, enabled: true, candidates: () => choices, independentAllowance: () => true, refreshUsage: async () => { throw new Error('Meter unavailable'); }, run: async target => { attempts.push(target.model); throw attempts.length === 2 ? new Error('Model not available') : exhausted(); }, onSwitch: async (_, to) => { switches.push(to.model); } }), /exhausted/);
  assert.equal(attempts.length, 13); assert.equal(new Set(attempts).size, 13); assert.equal(switches.length, 12);
});

test('Claude session-limit wording triggers a real handover and automatic selection prefers the usual model and effort',async()=>{
 assert.equal(usageExhausted(Error("You've hit your session limit · resets 9:50pm")),true);
 const calls=[];const result=await runWithFallback({initial:{provider:'claude',model:'opus'},enabled:true,candidates:()=>[{provider:'codex',model:'gpt-6.1-sol',effort:'high'}],run:async selection=>{calls.push(selection);if(selection.provider==='claude')throw Error("You've hit your session limit · resets 9:50pm");return {text:'Continued and verified'};}});
 assert.equal(result.text,'Continued and verified');assert.equal(calls[1].effort,'high');assert.equal(calls.length,2);
 const preferred={provider:'codex',model:'gpt-usual',effort:'high'};
 const targets=fallbackTargets({preferences:{},connections:[{id:'claude',connected:true},{id:'codex',connected:true}],models:{codex:[{id:'gpt-usual'}]},current:{provider:'claude',model:'opus'},preferred});
 assert.deepEqual(targets[0],preferred);
});
test('large checkpoints remain valid JSON, preserve answer ends and exclude hidden reasoning', () => {
  const content = 'ANSWER START ' + 'x'.repeat(30000) + ' ANSWER END';
  const checkpoint = handoffContext({ content, activity: [{ kind: 'thinking', text: 'PRIVATE' }, ...Array.from({ length: 400 }, (_, i) => ({ kind: 'tool', name: 'workspace_write', target: String(i), status: 'done', output: '😀'.repeat(20000), input: { text: 'x'.repeat(4000) } }))] });
  const body = JSON.parse(checkpoint.split('Handoff checkpoint:\n')[1]);
  assert.match(body.partialAnswer, /^ANSWER START/); assert.match(body.partialAnswer, /ANSWER END$/);
  assert.ok(checkpoint.length < 91000); assert.ok(!checkpoint.includes('PRIVATE'));
  assert.equal(body.completedWork.at(-1).target, '399'); assert.ok(body.recentDetails.length > 0);
});
