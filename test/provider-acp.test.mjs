import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AcpTransport, acpModelOptions } from '../desktop/provider-acp.mjs';

class Child extends EventEmitter {
  constructor() { super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.killed = false; }
  kill() { if (!this.killed) { this.killed = true; this.emit('exit', 0); } }
  json(value) { this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); }
}

test('ACP model metadata supports ordinary model lists and categorized model and reasoning options', () => {
  const plain = acpModelOptions({ models: { availableModels: [{ modelId: 'auto', name: 'Auto' }], currentModelId: 'auto' } });
  assert.deepEqual(plain.map(model => model.id), ['auto']);
  const categorized = acpModelOptions({ configOptions: [
    { id: 'choose-model', category: 'model', currentValue: 'model-a', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }] },
    { id: 'reasoning-level', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
  ] });
  assert.deepEqual(categorized.map(model => model.id), ['model-a', 'model-b']);
  assert.ok(categorized.every(model => Array.isArray(model.efforts)));
  assert.deepEqual(categorized.find(model => model.id === 'model-a').efforts.map(effort => effort.id).filter(Boolean).length > 0 ? ['has-efforts'] : ['no-efforts'], ['has-efforts']);
});

test('ACP requests resolve and a closed transport rejects what is pending', async () => {
  const child = new Child(), rpc = new AcpTransport(child), pending = rpc.request('initialize');
  child.json({ id: 1, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  const later = rpc.request('session/new');
  rpc.close();
  await assert.rejects(later, /closed/i);
});

test('ACP malformed and oversized messages fail closed', async () => {
  for (const output of ['{"jsonrpc":"9.0","id":1}\n', 'not json\n', 'x'.repeat(32 * 1024 * 1024 + 1)]) {
    const child = new Child(), rpc = new AcpTransport(child), request = rpc.request('initialize');
    child.stdout.write(output); await assert.rejects(request); assert.equal(child.killed, true);
  }
});
