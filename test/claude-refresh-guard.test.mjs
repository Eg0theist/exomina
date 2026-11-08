import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm, writeFile, utimes, mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {claudeRefreshActive, settleClaudeProcess, REFRESH_LOCK_STALE_MS} from '../desktop/claude-refresh-guard.mjs';

const fakeChild = () => {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.stdinEnded = false;
  child.stdin = {end: () => { child.stdinEnded = true; }};
  child.exit = () => { child.exitCode = 0; child.emit('close', 0); };
  return child;
};
const home = async t => { const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-refresh-')); t.after(() => rm(dir, {recursive: true, force: true})); return dir; };

test('a fresh renewal lock (file or directory) counts as active; a stale or unrelated one does not', async t => {
  const dir = await home(t);
  assert.equal(await claudeRefreshActive(dir), false);
  await writeFile(path.join(dir, '.oauth_refresh.lock.owner'), 'x');
  assert.equal(await claudeRefreshActive(dir), false);
  await mkdir(path.join(dir, '.oauth_refresh.lock'));
  assert.equal(await claudeRefreshActive(dir), true);
  const old = new Date(Date.now() - REFRESH_LOCK_STALE_MS - 5000);
  await utimes(path.join(dir, '.oauth_refresh.lock'), old, old);
  assert.equal(await claudeRefreshActive(dir), false);
  assert.equal(await claudeRefreshActive(path.join(dir, 'missing')), false);
});

test('a forced stop waits for a renewal to finish, then stops the process', async t => {
  const dir = await home(t), lock = path.join(dir, '.oauth_refresh.lock');
  await writeFile(lock, '');
  const child = fakeChild(); let killedAt = 0;
  const started = Date.now();
  setTimeout(() => rm(lock, {force: true}), 400);
  await settleClaudeProcess(child, {home: dir, kill: () => { killedAt = Date.now(); }});
  assert.ok(killedAt - started >= 350, 'kill waited for the lock to clear');
});

test('a renewal that ends the process itself avoids the kill; no lock means an immediate stop', async t => {
  const dir = await home(t);
  await writeFile(path.join(dir, '.oauth_refresh.lock'), '');
  const child = fakeChild(); let killed = false;
  setTimeout(() => child.exit(), 200);
  await settleClaudeProcess(child, {home: dir, kill: () => { killed = true; }});
  assert.equal(killed, false);
  const other = fakeChild(); const started = Date.now();
  await settleClaudeProcess(other, {home: await home(t), kill: () => { killed = true; }});
  assert.equal(killed, true); assert.ok(Date.now() - started < 300);
});

test('a finished process gets closed stdin and time to exit by itself', async t => {
  const child = fakeChild(); let killed = false;
  setTimeout(() => child.exit(), 100);
  await settleClaudeProcess(child, {home: await home(t), kill: () => { killed = true; }, graceMs: 2000});
  assert.equal(child.stdinEnded, true); assert.equal(killed, false);
  const stuck = fakeChild();
  await settleClaudeProcess(stuck, {home: await home(t), kill: () => { killed = true; }, graceMs: 150});
  assert.equal(killed, true);
});

test('the renewal wait is bounded', async t => {
  const dir = await home(t);
  await writeFile(path.join(dir, '.oauth_refresh.lock'), '');
  const child = fakeChild(); let killed = false; const started = Date.now();
  await settleClaudeProcess(child, {home: dir, kill: () => { killed = true; }, maxRefreshMs: 300});
  assert.equal(killed, true); assert.ok(Date.now() - started < 1500);
});
