import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fallbackTargets, handoffContext, normalizeModelPreferences, runWithFallback,
  usageBlocksSelection,
} from '../desktop/model-preferences.mjs';
import { claudeUsage, codexUsage } from '../desktop/usage.mjs';

const initial = { provider: 'claude', model: 'opus', effort: 'high' };
const preferred = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
const preferences = { fallback: { enabled: true, mode: 'ordered', targets: [] } };
const connections = [
  { id: 'claude', connected: true, available: true, supportsTools: true },
  { id: 'codex', connected: true, available: true, supportsTools: true },
];
const models = { claude: [{ id: 'opus' }, { id: 'sonnet' }], codex: [{ id: 'gpt-6.1-sol' }] };
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const allowance = (provider, usedPercent) => provider === 'claude'
  ? claudeUsage({ status: usedPercent === 100 ? 'rejected' : 'allowed', rateLimitType: 'five_hour', utilization: usedPercent / 100, resetsAt: future() })
  : codexUsage({ ordinaryUsageAllowed: usedPercent < 100, rateLimits: { primary: { usedPercent, resetsAt: future() } } });
const limitFailure = () => Object.assign(new Error("You've hit your session limit · resets 9:50pm"), { usageLimited: true });
const candidates = (usage, overrides = {}) => fallbackTargets({ preferences, connections, models, usage, current: initial, preferred, ...overrides });

test('saved empty ordered fallback continues an already exhausted Claude task on available Codex', async () => {
  const usage = { claude: allowance('claude', 100), codex: allowance('codex', 25) };
  assert.equal(usageBlocksSelection(usage.claude, initial), true);
  assert.equal(usageBlocksSelection(usage.codex, preferred), false);
  const attempts = [], switches = [];
  const result = await runWithFallback({
    initial, enabled: normalizeModelPreferences(preferences).fallback.enabled,
    blocked: selection => usageBlocksSelection(usage[selection.provider], selection),
    candidates: () => candidates(usage),
    run: async selection => { attempts.push(selection); return { text: 'Same task completed', taskId: 'repair-current-task' }; },
    onSwitch: async (from, to) => switches.push({ from, to }),
  });
  assert.deepEqual(attempts, [preferred], 'the exhausted provider is skipped before starting inference');
  assert.equal(switches.length, 1);
  assert.deepEqual(switches[0], { from: initial, to: preferred });
  assert.equal(result.taskId, 'repair-current-task');
  assert.equal(result.selection.effort, 'high');
});

test('empty ordered fallback settles outstanding tools and carries work and answered followups into the same task', async () => {
  const usage = { claude: allowance('claude', 25), codex: allowance('codex', 25) };
  const message = {
    id: 'same-host-task', content: 'I completed the configuration repair.',
    activity: [
      { kind: 'thinking', text: 'PRIVATE REASONING DOES NOT TRAVEL' },
      { kind: 'tool', name: 'workspace_write', status: 'done', target: 'fixed-config.json', input: { path: 'fixed-config.json' }, output: 'Configuration written once.' },
    ],
    followups: [{ id: 'followup-1', text: 'Keep the selected workspace?', answer: 'Yes, keep it.', status: 'answered', taskStatus: 'working', mode: 'parallel' }],
  };
  const completedReply = 'The earlier completed reply remains available.';
  let releaseTool, settled = false, handoff;
  const outstanding = new Promise(resolve => { releaseTool = () => { settled = true; message.activity.push({ kind: 'tool', name: 'workspace_read', status: 'done', output: 'Configuration matches expected values.' }); resolve(); }; });
  const attempts = [];
  const pending = runWithFallback({
    initial, enabled: true, candidates: () => candidates(usage), settle: () => outstanding,
    onSwitch: async () => {
      assert.equal(settled, true, 'the replacement runtime must wait for the current tool');
      handoff = handoffContext(message, { completedReply });
    },
    run: async selection => {
      attempts.push(selection.provider);
      if (selection.provider === 'claude') { usage.claude = allowance('claude', 100); throw limitFailure(); }
      assert.equal(message.id, 'same-host-task');
      const checkpoint = JSON.parse(handoff.split('Handoff checkpoint:\n')[1]);
      assert.equal(checkpoint.sourceMessageId, message.id);
      assert.equal(checkpoint.partialAnswer, message.content);
      assert.equal(checkpoint.completedReply, completedReply);
      assert.equal(checkpoint.recentDetails.find(step => step.name === 'workspace_write').output, 'Configuration written once.');
      assert.equal(checkpoint.recentDetails.find(step => step.name === 'workspace_read').output, 'Configuration matches expected values.');
      assert.equal(checkpoint.followups[0].answer, 'Yes, keep it.');
      assert.equal(checkpoint.followups[0].taskStatus, 'working');
      assert.ok(!handoff.includes('PRIVATE REASONING DOES NOT TRAVEL'));
      assert.match(handoff, /Do not repeat successful side effects/);
      return { text: 'Repair verified and followup handled', taskId: message.id };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(attempts, ['claude'], 'Codex cannot start while a tool is unfinished');
  releaseTool();
  const result = await pending;
  assert.deepEqual(attempts, ['claude', 'codex']);
  assert.equal(result.taskId, message.id);
  assert.equal(message.activity.filter(step => step.name === 'workspace_write').length, 1);
});

test('automatic recovery from an empty ordered list keeps hidden, disconnected, exhausted and API connections excluded', () => {
  const usage = {
    claude: allowance('claude', 100), codex: allowance('codex', 25),
    'muse-code': { provider: 'muse-code', updatedAt: new Date().toISOString(), fetchStatus: 'ready', windows: [{ id: 'weekly', usedPercent: 100, resetsAt: future() }] },
  };
  const targets = candidates(usage, {
    preferences: { ...preferences, hiddenProviders: ['grok'] },
    connections: [
      ...connections,
      { id: 'grok', connected: true },
      { id: 'antigravity', connected: false },
      { id: 'muse-code', connected: true },
      { id: 'openai-api', connected: true },
      { id: 'anthropic-api', connected: true },
      { id: 'custom-api', connected: true },
    ],
  });
  assert.ok(targets.length > 0, 'a connected subscription with remaining allowance must remain reachable');
  assert.deepEqual([...new Set(targets.map(target => target.provider))], ['codex']);
  assert.deepEqual(targets[0], preferred);
});

test('disabled fallback never starts another runtime even when the ordered list is empty', async () => {
  let requestedCandidates = 0;
  const attempts = [], failure = limitFailure();
  const disabled = normalizeModelPreferences({ fallback: { enabled: false, mode: 'ordered', targets: [] } });
  await assert.rejects(runWithFallback({
    initial, enabled: disabled.fallback.enabled,
    candidates: () => { requestedCandidates++; return [preferred]; },
    run: async selection => { attempts.push(selection.provider); throw failure; },
  }), error => error === failure);
  assert.deepEqual(attempts, ['claude']);
  assert.equal(requestedCandidates, 0);
});

test('a nonempty explicit fallback list stays restrictive when its only connection is unavailable', async () => {
  const usage = { claude: allowance('claude', 100), codex: allowance('codex', 25) };
  const explicit = { fallback: { enabled: true, mode: 'ordered', targets: [{ provider: 'grok', model: 'auto' }] } };
  const available = candidates(usage, { preferences: explicit, connections: [...connections, { id: 'grok', connected: false }] });
  assert.deepEqual(available, [], 'a named but unavailable target must not silently widen to Codex');
  const attempts = [], failure = limitFailure();
  await assert.rejects(runWithFallback({
    initial, enabled: true, candidates: () => available,
    run: async selection => { attempts.push(selection.provider); throw failure; },
  }), error => error === failure && error.fallbackExhausted === true);
  assert.deepEqual(attempts, ['claude']);
});
