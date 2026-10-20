import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, link } from 'node:fs/promises';
import { acquireAntigravityTurn, prepareAntigravityProfile, antigravityEnvironment, ANTIGRAVITY_SETTINGS } from '../desktop/antigravity-profile.mjs';

async function fixture(t) {
  const parent = path.resolve('.verification');
  await mkdir(parent, { recursive: true });
  const dataDir = await mkdtemp(path.join(parent, 'antigravity-profile-'));
  const closes = [];
  t.after(async () => {
    for (const turn of closes) await turn.close();
    assert.equal((await realpath(dataDir)).toLowerCase(), dataDir.toLowerCase());
    assert.equal(path.dirname(dataDir), parent);
    await rm(dataDir, { recursive: true, force: true });
  });
  const home = await prepareAntigravityProfile(dataDir);
  return { dataDir, home, track: turn => closes.push(turn), config: path.join(home, '.gemini', 'config', 'mcp_config.json'), settings: path.join(home, '.gemini', 'antigravity-cli', 'settings.json') };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const configured = token => ({ mcpServers: { exomina: { command: 'synthetic-exomina', env: { EXOMINA_TOOL_TOKEN: token } } } });

test('every turn reloads native deny and credit settings in the protected profile', async t => {
  const f = await fixture(t), turn = await acquireAntigravityTurn(f.dataDir, {});
  f.track(turn);
  await writeFile(f.settings, JSON.stringify({ useG1Credits: true, permissions: { allow: ['command(*)'] } }));
  await turn.configure(configured('first'));
  assert.deepEqual(await read(f.settings), ANTIGRAVITY_SETTINGS);
  assert.equal(turn.path, f.home);
  const env = antigravityEnvironment({ USERPROFILE: 'external', HOME: 'external', APPDATA: 'external', LOCALAPPDATA: 'external' }, f.home);
  assert.equal(env.HOME, f.home); assert.equal(env.USERPROFILE, f.home);
  for (const field of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) assert.ok(env[field].startsWith(f.home + path.sep));
});

test('metadata initialization preserves active configuration and turns serialize across adapter instances', async t => {
  const f = await fixture(t), first = await acquireAntigravityTurn(f.dataDir, {});
  f.track(first);
  await first.configure(configured('active'));
  // A separately initialized status/model adapter uses the same module-owned profile.
  assert.equal(await prepareAntigravityProfile(f.dataDir), f.home);
  assert.deepEqual(await read(f.config), configured('active'));
  let secondAcquired = false;
  const waiting = acquireAntigravityTurn(f.dataDir, {}).then(turn => { secondAcquired = true; return turn; });
  await tick(); await tick();
  assert.equal(secondAcquired, false);
  assert.deepEqual(await read(f.config), configured('active'));
  await first.close();
  const second = await waiting;
  f.track(second);
  assert.equal(secondAcquired, true);
  assert.equal(second.path, first.path);
  assert.deepEqual(await read(f.config), { mcpServers: {} });
  await second.configure(configured('next'));
  assert.deepEqual(await read(f.config), configured('next'));
  await second.close();
  assert.deepEqual(await read(f.config), { mcpServers: {} });
});

test('cancelling a queued turn preserves an active owner block and does not launch the queue', async t => {
  const f = await fixture(t), first = await acquireAntigravityTurn(f.dataDir, {}), queued = {};
  f.track(first);
  await first.configure(configured('active'));
  const waiting = acquireAntigravityTurn(f.dataDir, queued);
  const rejected = assert.rejects(waiting, /Stopped/);
  while (!queued.adapterCancel) await tick();
  first.block(); queued.cancelled = true; queued.adapterCancel();
  await rejected;
  await assert.rejects(acquireAntigravityTurn(f.dataDir, {}), error => error.handoffUnsafe && /previous process stopped/.test(error.message));
  assert.deepEqual(await read(f.config), configured('active'));
  // Only the active owner closes after the caller confirms its child has stopped.
  await first.close();
  const next = await acquireAntigravityTurn(f.dataDir, {});
  f.track(next);
  await next.configure();
  assert.deepEqual(await read(f.config), { mcpServers: {} });
});

test('tool-free turns share the same lock and replace prior MCP capability bytes with an empty config', async t => {
  const f = await fixture(t), first = await acquireAntigravityTurn(f.dataDir, {});
  f.track(first);
  await first.configure(configured('prior-token'));
  const secondState = {}, waiting = acquireAntigravityTurn(f.dataDir, secondState);
  while (!secondState.adapterCancel) await tick();
  await first.close();
  const second = await waiting;
  f.track(second);
  await second.configure(null);
  assert.deepEqual(await read(f.config), { mcpServers: {} });
});

test('configuration rejects a file hard-linked outside its owned config location', async t => {
  const f = await fixture(t), turn = await acquireAntigravityTurn(f.dataDir, {});
  await link(f.config, path.join(f.dataDir, 'other-file.json'));
  await assert.rejects(turn.configure(configured('never-written')), /redirected file/);
  await assert.rejects(turn.close(), /redirected file/);
  assert.deepEqual(await read(f.config), { mcpServers: {} });
});
