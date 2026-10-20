import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProviderManager } from '../desktop/providers.mjs';
import { getProvider } from '../desktop/provider-catalog.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'exomina-disabled-provider-'));
  const calls = { prepare: 0, spawn: 0, environment: 0, executable: 0, runOnce: 0 };
  const manager = new ProviderManager({
    dataDir: path.join(directory, 'private'), workspace: path.join(directory, 'workspace'),
    codexPath: process.execPath, claudePath: process.execPath,
    beforePrepare: async () => { calls.prepare++; throw Error('Unexpected vault or account preparation.'); },
    spawnImpl: () => { calls.spawn++; throw Error('Unexpected process start.'); },
    ...options,
  });
  manager.environment = () => { calls.environment++; throw Error('Unexpected environment inspection.'); };
  manager.executable = () => { calls.executable++; throw Error('Unexpected executable resolution.'); };
  t.after(async () => {
    manager.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('exomina-disabled-provider-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { manager, directory, calls };
}

const operations = (manager, provider) => [
  () => manager.connect(provider),
  () => manager.run({ provider, conversationId: 'disabled', prompt: 'Never sent' }),
  () => manager.runOnce({ provider, conversationId: 'disabled', prompt: 'Never sent' }),
  () => manager.oneShot(provider, 'Never sent'),
];

test('unknown providers fail at every public entry point before profile or process access', async t => {
  const f = await fixture(t);
  for (const operation of operations(f.manager, 'unknown-provider')) await assert.rejects(operation(), /not available in this build/);
  assert.deepEqual(f.calls, { prepare: 0, spawn: 0, environment: 0, executable: 0, runOnce: 0 });
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(f.manager.active.size, 0);
  assert.equal(f.manager.loginProcesses.size, 0);
});

test('retired Gemini CLI cannot start a runtime or discover models through another provider', async t => {
  const f = await fixture(t);
  assert.equal(getProvider('gemini-cli'), undefined);
  assert.equal(f.manager.adapters.has('gemini-cli'), false);
  assert.equal(getProvider('antigravity')?.mode, 'subscription');
  assert.equal(getProvider('antigravity')?.name, 'Gemini');
  for (const removed of ['copilot', 'kimi-code', 'deepseek', 'ollama', 'custom', 'openrouter']) assert.equal(getProvider(removed), undefined);
  for (const kept of ['openai-api', 'anthropic-api', 'gemini', 'xai']) assert.equal(getProvider(kept)?.mode, 'api');
  for (const operation of [...operations(f.manager, 'gemini-cli'), () => f.manager.modelsFor('gemini-cli')]) await assert.rejects(operation(), /not available in this build/);
  assert.deepEqual(f.calls, { prepare: 0, spawn: 0, environment: 0, executable: 0, runOnce: 0 });
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(f.manager.active.size, 0);
});

test('disabled native providers cannot use login, chat, direct runs or helper requests', async t => {
  const f = await fixture(t, { isProviderEnabled: () => false });
  for (const provider of ['codex', 'claude', 'antigravity', 'grok', 'muse-code', 'kimi-code', 'copilot']) {
    for (const operation of operations(f.manager, provider)) await assert.rejects(operation(), /not available in this build/);
  }
  assert.deepEqual(f.calls, { prepare: 0, spawn: 0, environment: 0, executable: 0, runOnce: 0 });
  assert.deepEqual(await readdir(f.directory), [], 'No private folder, account/password files or workspace is created.');
  assert.equal(f.manager.active.size, 0);
  assert.equal(f.manager.silent.size, 0);
});

test('the default manager keeps opt-in connections off', async t => {
  const f = await fixture(t);
  assert.equal(f.manager.isProviderEnabled('claude'), Boolean(getProvider('claude')) && !getProvider('claude').optIn);
  if (f.manager.isProviderEnabled('claude')) {
    assert.doesNotThrow(() => f.manager.requireProvider('claude'));
  } else {
    for (const operation of operations(f.manager, 'claude')) await assert.rejects(operation(), /not available in this build/);
  }
  assert.deepEqual(f.calls, { prepare: 0, spawn: 0, environment: 0, executable: 0, runOnce: 0 });
  assert.deepEqual(await readdir(f.directory), []);
});

test('run checks the distribution gate before invoking an overridden runtime path', async t => {
  const f = await fixture(t, { isProviderEnabled: () => false });
  f.manager.runOnce = async () => { f.calls.runOnce++; return { text: 'Unexpected' }; };
  await assert.rejects(f.manager.run({ provider: 'claude', conversationId: 'disabled', prompt: 'Never sent' }), /not available in this build/);
  assert.equal(f.calls.runOnce, 0);
  assert.deepEqual(await readdir(f.directory), []);
});
