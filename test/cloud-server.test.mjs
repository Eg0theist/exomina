import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { CloudAuth } from '../cloud/auth.mjs';
import { DeviceStore } from '../cloud/devices.mjs';
import { SyncStore } from '../cloud/sync-store.mjs';
import { createCloudServer } from '../cloud/server.mjs';

const publicUrl = 'https://exomina.test';
async function fixture(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-server-test-'));
  const distDir = path.join(dir, 'public'), privateDir = path.join(dir, 'private');
  await mkdir(path.join(distDir, 'assets'), { recursive: true }); await mkdir(privateDir);
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>Synthetic Exomina</title>');
  await writeFile(path.join(distDir, 'assets', 'app.js'), '/* synthetic public app */');
  await writeFile(path.join(privateDir, 'private.js'), 'PRIVATE_SYNTHETIC_FILE');
  const auth = new CloudAuth({ dataDir: privateDir, publicUrl, ownerEmail: 'owner@example.test', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', fetchImpl: () => { throw new Error('No external requests allowed in this test'); } });
  await auth.init();
  const rawToken = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  const now = Math.floor(Date.now() / 1000), subject = 'synthetic-owner';
  auth.db.prepare('INSERT INTO owner_bindings VALUES(?,?)').run(auth.ownerEmail, subject);
  auth.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)').run(createHash('sha256').update(rawToken).digest('hex'), auth.scope, subject, auth.ownerEmail, 'Synthetic Owner', csrf, now, now + 3600);
  const devices = new DeviceStore({ dataDir: privateDir, scope: auth.scope }); await devices.init();
  const syncStore = new SyncStore({ dataDir: privateDir }); await syncStore.init();
  const calls = [], changed = [], listeners = new Set();
  const service = {
    syncStore,
    invoke: async (method, payload, options) => { calls.push({ method, payload, options }); if (method === 'test.failure') throw new Error('PRIVATE_SYNTHETIC_INTERNAL_ERROR'); return { synthetic: true, method, payload }; },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    beforeSync: input => { if (input.entity.id === 'active-chat') throw Object.assign(new Error('This chat is active.'), { code: 409 }); },
    syncChanged: async metadata => { changed.push(metadata); },
  };
  const server = createCloudServer({ service, auth, devices, distDir }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const owner = { host: 'exomina.test', cookie: `${auth.cookieName}=${rawToken}`, origin: publicUrl, 'x-csrf-token': csrf };
  const request = (url, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method: options.method || 'GET', headers: { host: 'exomina.test', ...options.headers }, signal: AbortSignal.timeout(5000) }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let data; try { data = JSON.parse(text); } catch { data = text; } resolve({ status: response.statusCode, headers: new Headers(Object.entries(response.headers).map(([key, value]) => [key, String(value)])), data, text }); });
    });
    req.once('error', reject); req.end(options.body);
  });
  const post = (url, value, headers = owner) => request(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const pair = async () => { const pending = await post('/api/invoke', { method: 'device.pairingCode' }); assert.equal(pending.status, 200); const result = await post('/api/pair', { code: pending.data.code, name: 'Synthetic paired desktop' }, {}); assert.equal(result.status, 200); return result.data; };
  try { await run({ dir, distDir, privateDir, auth, devices, syncStore, service, calls, changed, listeners, server, origin, port, owner, request, post, pair }); }
  finally { await new Promise(resolve => server.close(resolve)); server.closeAllConnections(); syncStore.close(); devices.close(); auth.close(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('exomina-server-test-')); await rm(dir, { recursive: true, force: true }); }
}

test('all private data and event endpoints require authentication and mutations require CSRF', async () => fixture(async ({ request, post, owner, calls }) => {
  for (const route of ['/api/events', '/api/sync/changes', '/api/sync/get?kind=note&id=x', '/api/sync/list?kind=chat', '/api/sync/snapshot', '/api/not-real']) {
    const response = await request(route); assert.equal(response.status, 401, route); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await post('/api/invoke', { method: 'bootstrap' }, {})).status, 401);
  const status = await request('/api/auth/status'); assert.equal(status.status, 200); assert.equal(status.data.authenticated, false); assert.equal('csrf' in status.data, false); assert.equal(status.text.includes('owner@example'), false);
  assert.equal((await request('/api/auth/status', { headers: owner })).data.authenticated, true);
  assert.equal((await post('/api/invoke', { method: 'bootstrap' }, { ...owner, 'x-csrf-token': '' })).status, 403);
  assert.equal((await post('/api/invoke', { method: 'bootstrap' }, { ...owner, origin: 'https://attacker.test' })).status, 403);
  assert.equal((await post('/api/invoke', { method: 'bootstrap' }, { ...owner, authorization: 'Bearer invalid' })).status, 401);
  const success = await post('/api/invoke', { method: 'chat.send', payload: { prompt: 'Synthetic text' }, requestId: 'request-1' });
  assert.equal(success.status, 200); assert.deepEqual(calls[0], { method: 'chat.send', payload: { prompt: 'Synthetic text' }, options: { requestId: 'request-1' } });
  const failure = await post('/api/invoke', { method: 'test.failure' }); assert.equal(failure.status, 500); assert.equal(failure.text.includes('PRIVATE_SYNTHETIC_INTERNAL_ERROR'), false);
}));

test('one-use pairing, bearer synchronization, optimistic conflicts, tombstones and revocation work over HTTP', async () => fixture(async ({ post, request, owner, changed, pair }) => {
  const code = await post('/api/invoke', { method: 'device.pairingCode' });
  const paired = await post('/api/pair', { code: code.data.code }, {}); assert.equal(paired.status, 200);
  assert.equal((await post('/api/pair', { code: code.data.code }, {})).status, 401);
  const bearer = { authorization: `Bearer ${paired.data.token}` };
  assert.equal((await post('/api/invoke', { method: 'device.pairingCode' }, bearer)).status, 403);
  assert.equal((await post('/api/invoke', { method: 'device.revoke', payload: { id: paired.data.deviceId } }, bearer)).status, 403);
  const input = { operationId: 'create-1', type: 'put', entity: { kind: 'note', id: 'note-1', payload: { text: 'Synthetic shared memory ä 中文.' } } };
  assert.equal((await post('/api/sync/apply', { ...input, deviceId: 'impersonation' }, bearer)).status, 403);
  const first = await post('/api/sync/apply', input, bearer); assert.equal(first.status, 200); assert.equal(first.data.revision, 1); assert.equal('payload' in first.data.entity, false); assert.equal(changed.length, 1);
  assert.equal((await post('/api/sync/apply', input, bearer)).data.duplicate, true);
  const conflict = await post('/api/sync/apply', { ...input, operationId: 'edit-1', expectedRevision: 0 }, bearer);
  assert.equal(conflict.status, 409); assert.equal(conflict.data.current.revision, 1); assert.equal('payload' in conflict.data.current, false);
  const get = await request('/api/sync/get?kind=note&id=note-1', { headers: bearer }); assert.equal(get.data.payload.text, input.entity.payload.text);
  const list = await request('/api/sync/list?kind=note&limit=1', { headers: bearer }); assert.equal(list.data.entities.length, 1); assert.equal('payload' in list.data.entities[0], false);
  const snapshot = await request('/api/sync/snapshot?limit=1', { headers: bearer }); assert.equal(snapshot.data.snapshotSeq, 1);
  const blocked = await post('/api/sync/apply', { ...input, operationId: 'active', entity: { ...input.entity, id: 'active-chat' } }, bearer); assert.equal(blocked.status, 409);
  assert.equal((await post('/api/sync/apply', { operationId: 'delete-1', expectedRevision: 1, type: 'delete', entity: { kind: 'note', id: 'note-1' } }, bearer)).data.revision, 2);
  assert.equal((await request('/api/sync/get?kind=note&id=note-1', { headers: bearer })).data.payload, null);
  assert.equal((await post('/api/sync/apply', { ...input, operationId: 'stale', expectedRevision: 2 }, bearer)).status, 409);
  const events = (await request('/api/sync/changes?after=0&limit=200', { headers: bearer })).data.events; assert.equal(events.length, 2); assert.ok(events.every(event => !('payload' in event)));
  assert.equal((await post('/api/invoke', { method: 'device.revoke', payload: { id: paired.data.deviceId } }, owner)).status, 200);
  assert.equal((await request('/api/sync/changes', { headers: bearer })).status, 401);
  const another = await pair(); assert.notEqual(another.deviceId, paired.data.deviceId);
}));

test('SSE streams require a current credential and close immediately when their device is revoked', async () => fixture(async ({ port, post, pair, listeners }) => {
  const paired = await pair();
  const response = await new Promise((resolve, reject) => { const req = http.get({ hostname: '127.0.0.1', port, path: '/api/events', headers: { host: 'exomina.test', authorization: `Bearer ${paired.token}` }, signal: AbortSignal.timeout(5000) }, resolve); req.once('error', reject); });
  assert.equal(response.statusCode, 200); assert.match(response.headers['content-type'], /text\/event-stream/);
  const reader = response[Symbol.asyncIterator]();
  try {
    const first = await reader.next(); assert.match(new TextDecoder().decode(first.value), /state.changed/); assert.equal(listeners.size, 1);
    for (const emit of listeners) emit({ type: 'chat.delta', delta: 'SYNTHETIC_STREAM', seq: 7 });
    assert.match(new TextDecoder().decode((await reader.next()).value), /id: 7\ndata: .*SYNTHETIC_STREAM/);
    await post('/api/invoke', { method: 'device.revoke', payload: { id: paired.deviceId } });
    assert.equal((await reader.next()).done, true); assert.equal(listeners.size, 0);
  } finally { response.destroy(); }
}));

test('logout aliases invalidate the owner session and reject cross-origin logout', async () => fixture(async ({ post, request, owner }) => {
  assert.equal((await post('/auth/logout', {}, { ...owner, origin: 'https://attacker.test' })).status, 403);
  assert.equal((await post('/auth/logout', {})).status, 204);
  assert.equal((await request('/api/auth/status', { headers: owner })).data.authenticated, false);
  assert.equal((await post('/api/auth/logout', {})).status, 401);
}));

test('public files have a restrictive policy and traversal, symlinks, and unexpected hosts fail closed', async () => fixture(async ({ request, port, distDir, privateDir }) => {
  const page = await request('/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/assets/app.js')).status, 200);
  assert.equal((await request('/private/private.js')).status, 404);
  assert.equal((await request('/assets/app.js.map')).status, 404);
  assert.equal((await request('/', { headers: { host: 'attacker.test' } })).status, 403);
  const raw = target => new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, path: target, headers: { host: 'exomina.test' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }); req.once('error', reject); req.end(); });
  for (const target of ['/assets/../private/private.js', '/assets/%2e%2e/private/private.js', '/assets/%2F..%2Fprivate/private.js', '/assets/%5c..%5cprivate.js', '//attacker.test/a']) assert.equal(await raw(target), 400, target);
  await symlink(privateDir, path.join(distDir, 'assets', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await request('/assets/escape/private.js')).status, 404);
}));

test('request bodies, numeric pagination and pairing attempts are bounded', async () => fixture(async ({ request, post, owner }) => {
  assert.equal((await request('/api/invoke', { method: 'POST', headers: owner, body: '{}' })).status, 415);
  assert.equal((await request('/api/invoke', { method: 'POST', headers: { ...owner, 'content-type': 'application/json' }, body: '{bad' })).status, 400);
  assert.equal((await post('/api/invoke', { method: 'test.large', payload: { text: 'x'.repeat(2 * 1024 * 1024) } })).status, 413);
  assert.equal((await post('/api/invoke', { method: 'chat.send', requestId: '../invalid' })).status, 400);
  assert.equal((await request('/api/sync/changes?limit=201', { headers: owner })).status, 400);
  assert.equal((await request('/api/sync/changes?after=0&after=1', { headers: owner })).status, 400);
  for (let index = 0; index < 10; index++) assert.equal((await post('/api/pair', { code: 'invalid' }, {})).status, 401);
  const limited = await post('/api/pair', { code: 'invalid' }, {}); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
}));
