import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { ProviderManager, JsonRpcProcess } from '../desktop/providers.mjs';

class Child extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.exitCode = null; this.signalCode = null; this.killed = false;
  }
  kill() { if (this.killed) return; this.killed = true; this.signalCode = 'SIGTERM'; this.emit('exit', null, 'SIGTERM'); this.emit('close', null, 'SIGTERM'); }
  json(value) { this.stdout.write(JSON.stringify(value) + '\n'); }
  finish(code) { this.exitCode = code; this.emit('exit', code); this.emit('close', code); }
}

async function fixture(t, spawnImpl) {
  // The host's inherited TEMP can be inside its real account directory. Keep
  // this entirely synthetic fixture within the tested source checkout instead.
  const dataDir = await mkdtemp(path.join(process.cwd(), 'provider-lifetime-test-'));
  const children = [];
  const manager = new ProviderManager({ dataDir, workspace: path.join(dataDir, 'workspace'),
    codexPath: process.execPath, claudePath: process.execPath,
    spawnImpl: (...args) => { const child = spawnImpl(...args); children.push(child); return child; } });
  manager.adapters.clear();
  t.after(async () => {
    const closed = children.filter(child => Number.isInteger(child.pid) && child.exitCode == null && child.signalCode == null)
      .map(child => new Promise(resolve => child.once('close', resolve)));
    manager.close(); await Promise.all(closed);
    await rm(dataDir, { recursive: true, force: true });
  });
  return manager;
}

test('native runtimes have independent process groups while keeping owned stdio', async t => {
  const calls = [], manager = await fixture(t, (executable, args, options) => { calls.push(options); return new Child(); });
  for (const provider of ['codex', 'claude']) {
    const child = manager.spawn(process.execPath, [], provider);
    assert.equal(calls.at(-1).detached, true);
    assert.equal(calls.at(-1).windowsHide, true);
    assert.equal(calls.at(-1).shell, false);
    assert.deepEqual(calls.at(-1).stdio, ['pipe', 'pipe', 'pipe']);
    manager.stopChild(child); assert.equal(child.killed, true);
  }
});

test('abrupt Codex output pipe errors reject pending work without escaping the runtime', async t => {
  for (const channel of ['stdout', 'stderr']) {
    const child = new Child(), exits = [], rpc = new JsonRpcProcess(child, { exit: error => exits.push(error) });
    t.after(() => rpc.close());
    const pending = rpc.request('test/pending');
    const rejected = assert.rejects(pending, /Synthetic pipe closed/);
    assert.doesNotThrow(() => child[channel].emit('error', new Error('Synthetic pipe closed')));
    await rejected;
    assert.equal(rpc.closed, true); assert.equal(child.killed, true); assert.equal(exits.length, 1);
    assert.doesNotThrow(() => child[channel].emit('error', new Error('Late pipe error')));
    assert.equal(exits.length, 1);
  }
});

test('Claude output pipe failures leave its manager usable for the next status request', async t => {
  const children = [], manager = await fixture(t, () => { const child = new Child(); children.push(child); return child; });
  for (const channel of ['stdout', 'stderr']) {
    const capture = manager.capture(process.execPath, [], 'claude');
    const rejected = assert.rejects(capture, /Synthetic Claude pipe closed/);
    while (children.length < (channel === 'stdout' ? 1 : 2)) await new Promise(resolve => setImmediate(resolve));
    assert.doesNotThrow(() => children.at(-1)[channel].emit('error', new Error('Synthetic Claude pipe closed')));
    await rejected; assert.equal(manager.closed, false); assert.equal(children.at(-1).killed, true);
  }
  const next = manager.capture(process.execPath, [], 'claude');
  while (children.length < 3) await new Promise(resolve => setImmediate(resolve));
  children.at(-1).stdout.write('still connected'); children.at(-1).finish(0);
  assert.deepEqual(await next, { code: 0, stdout: 'still connected', stderr: '' });
});

test('a closed Codex runtime cannot dispatch queued reverse requests or notifications', async () => {
  const child = new Child(); let requests = 0, notifications = 0;
  const rpc = new JsonRpcProcess(child, { request: () => requests++, notification: () => notifications++ });
  child.json({ id: 1, method: 'test/queued-request' });
  child.stdout.emit('error', new Error('Synthetic abrupt closure'));
  child.json({ id: 2, method: 'test/late-request' });
  child.json({ method: 'test/late-notification' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rpc.closed, true); assert.equal(requests, 0); assert.equal(notifications, 0);
});

test('real synthetic Codex processes can exit or be killed and be replaced without closing their host', async t => {
  const children = [];
  const synthetic = `let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\\n'))>=0){const message=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);if(message.method==='test/exit'){process.exit(17);}if(message.method==='test/pending')continue;if(message.id!==undefined)process.stdout.write(JSON.stringify({id:message.id,result:{synthetic:true}})+'\\n');}});`;
  const manager = await fixture(t, (_executable, _args, options) => { const child = spawn(process.execPath, ['-e', synthetic], options); children.push(child); return child; });
  const first = await manager.getCodex();
  await assert.rejects(first.request('test/exit', {}, 5000), /Codex runtime exited \(17\)/);
  assert.equal(manager.closed, false); assert.equal(first.closed, true);
  const second = await manager.getCodex();
  assert.notEqual(second, first); assert.deepEqual(await second.request('test/alive'), { synthetic: true });
  const pending = second.request('test/pending', {}, 5000), rejected = assert.rejects(pending, /Codex runtime exited/);
  children.at(-1).kill(); await rejected;
  assert.equal(manager.closed, false);
  const third = await manager.getCodex();
  assert.notEqual(third, second); assert.deepEqual(await third.request('test/alive'), { synthetic: true });
  assert.equal(children.length, 3);
});
