import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shownUsageProviders } from '../src/usage-visibility.js';
import { UsageTracker } from '../desktop/usage.mjs';
import { UsagePoller } from '../desktop/usage-poller.mjs';
import { prepareAntigravityProfile, resetAntigravityProfile } from '../desktop/antigravity-profile.mjs';
import { retireRemovedProviders } from '../desktop/store.mjs';
import { PROVIDER_CATALOG } from '../desktop/provider-catalog.mjs';

const NAMES = { claude: 'Claude', codex: 'ChatGPT', 'muse-code': 'Muse Code' };
const resets = new Date(Date.now() + 3_600_000).toISOString();
const codex = { rateLimits: { planType: 'pro', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: resets } } };

test('the five supported providers retain their subscription and available API connections', () => {
  assert.deepEqual(PROVIDER_CATALOG.map(item => item.id), ['codex', 'claude', 'antigravity', 'grok', 'muse-code', 'openai-api', 'anthropic-api', 'gemini', 'xai', 'custom-api']);
  assert.equal(PROVIDER_CATALOG.find(item => item.id === 'antigravity').name, 'Gemini');
  assert.equal(PROVIDER_CATALOG.some(item => item.mode === 'local'), false);
});

test('usage disappears for a signed-out account but stays while connections are still being checked', () => {
  const usage = { codex: { windows: [] }, claude: { windows: [] } };
  assert.deepEqual(shownUsageProviders([{ id: 'codex', connected: true }, { id: 'claude', connected: false }], usage, NAMES), ['codex']);
  assert.deepEqual(shownUsageProviders([{ id: 'codex', checking: true }, { id: 'claude', checking: true }], usage, NAMES).sort(), ['claude', 'codex']);
  assert.deepEqual(shownUsageProviders([], usage, NAMES).sort(), ['claude', 'codex'], 'before any status arrives, saved numbers still show');
});

test('forgetting a provider removes its saved usage, persists, and a late poll cannot bring it back', async () => {
  const saved = [], events = [];
  const tracker = new UsageTracker({ emit: event => events.push(event), onUpdate: entries => saved.push(Object.keys(entries)) });
  tracker.update('codex', codex);
  assert.ok(tracker.snapshot().codex);
  let connected = true, release;
  const poller = new UsagePoller({ providers: { codexUsage: () => new Promise(resolve => { release = () => resolve(codex); }) }, tracker, connected: () => connected });
  const pending = poller.refreshProvider('codex');
  await new Promise(resolve => setImmediate(resolve));
  connected = false; tracker.forget('codex');
  release(); await pending;
  assert.equal(tracker.forget('codex'), false);
  assert.equal(tracker.snapshot().codex, undefined, 'no allowance entry remains');
  assert.ok(!saved.at(-1).includes('codex'), 'the saved copy was updated too');
});

test('signing out of Gemini removes its isolated sign-in profile and nothing else', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-signout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = await prepareAntigravityProfile(dir);
  await mkdir(path.join(home, 'AppData'), { recursive: true });
  await writeFile(path.join(home, 'AppData', 'credential'), 'synthetic');
  await writeFile(path.join(dir, 'keep.txt'), 'other');
  assert.equal(await resetAntigravityProfile(dir), true);
  await assert.rejects(stat(home), { code: 'ENOENT' });
  assert.equal((await stat(path.join(dir, 'keep.txt'))).isFile(), true);
  assert.equal(await resetAntigravityProfile(dir), false, 'already signed out');
  assert.equal(await prepareAntigravityProfile(dir), home, 'the profile can be created again for the next sign-in');
});

test('chats and settings that used removed connections move to a kept one and keep their messages', () => {
  const messages = [{ role: 'assistant', provider: 'deepseek', content: 'Old answer' }];
  const state = {
    settings: { provider: 'openrouter', model: 'x/y', effort: 'high', modelPreferences: { hiddenProviders: ['ollama', 'codex'], models: { deepseek: ['a'], codex: ['b'] }, fallback: { targets: [{ provider: 'kimi', model: 'k' }, { provider: 'claude', model: 'auto' }] } } },
    conversations: [{ id: 'c', provider: 'anthropic-api', selection: { provider: 'anthropic-api', model: 'm' }, sessions: { 'copilot:chat': 's', codex: 'keep' }, messages }],
    schedules: [{ id: 't', provider: 'gemini', model: 'g' }],
  };
  assert.deepEqual(retireRemovedProviders(state).sort(), ['copilot', 'deepseek', 'kimi', 'ollama', 'openrouter']);
  assert.equal(state.settings.provider, 'codex'); assert.equal(state.settings.model, 'auto');
  assert.equal(state.conversations[0].provider, 'anthropic-api');
  assert.deepEqual(state.conversations[0].sessions, { codex: 'keep' });
  assert.equal(state.conversations[0].messages[0].provider, 'deepseek', 'message attribution is history');
  assert.equal(state.schedules[0].provider, 'gemini');
  assert.deepEqual(state.settings.modelPreferences, { hiddenProviders: ['codex'], models: { codex: ['b'] }, fallback: { targets: [{ provider: 'claude', model: 'auto' }] } });
  assert.deepEqual(retireRemovedProviders(state), []);
});

test('ChatGPT, Claude, Grok and Gemini sign out through their own routes and drop cached models', async t => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { ProviderManager } = await import('../desktop/providers.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-provider-signout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spawned = [], rpc = [], events = [];
  const manager = new ProviderManager({
    dataDir: path.join(dir, 'private'), workspace: path.join(dir, 'workspace'), codexPath: process.execPath, claudePath: process.execPath, emit: event => events.push(event),
    isProviderEnabled: () => true,
    spawnImpl: (executable, args) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.pid = 0; child.kill = () => {};
      spawned.push(args); setImmediate(() => child.emit('close', 0, null)); return child;
    },
  });
  t.after(() => manager.close());
  manager.getCodex = async () => ({ request: async method => { rpc.push(method); return {}; } });
  manager.modelCache.set('codex', { models: [1] }); manager.modelCache.set('claude', { models: [1] }); manager.claudeFreshAt = Date.now();
  await manager.logout('codex');
  assert.deepEqual(rpc, ['account/logout']);
  assert.equal(manager.modelCache.has('codex'), false);
  await manager.logout('claude');
  assert.deepEqual(spawned, [['auth', 'logout']]);
  assert.equal(manager.modelCache.has('claude'), false); assert.equal(manager.claudeFreshAt, 0);
  const calls = [];
  manager.adapters.get('grok').disconnect = async () => { calls.push('grok'); };
  manager.adapters.get('antigravity').disconnect = async () => { calls.push('antigravity'); };
  manager.adapters.get('muse-code').disconnect = async () => { calls.push('muse-code'); };
  for (const id of ['grok', 'antigravity', 'muse-code']) await manager.logout(id);
  assert.deepEqual(calls, ['grok', 'antigravity', 'muse-code']);
  assert.deepEqual(events.filter(event => event.type === 'auth.signedOut').map(event => event.provider), ['codex', 'claude', 'grok', 'antigravity', 'muse-code']);
  await assert.rejects(manager.logout('copilot'), /not available/);
});
