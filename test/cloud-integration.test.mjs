import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer as reserveServer } from 'node:net';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CloudAuth } from '../cloud/auth.mjs';
import { DeviceStore } from '../cloud/devices.mjs';
import { CloudService, serverEncryption } from '../cloud/service.mjs';
import { createCloudServer } from '../cloud/server.mjs';
import { CloudClient } from '../desktop/cloud-client.mjs';
import { Store } from '../desktop/store.mjs';
import { MemoryStore } from '../desktop/note-store.mjs';
import { ArchiveStore } from '../desktop/archive.mjs';

// Synthetic data only. Construct the service classes directly: this does not
// relax, exercise, or bypass the deployment CLI's encrypted-filesystem guard.
const OWNER = 'synthetic-owner@example.test';
const CLIENT_ID = 'synthetic-oidc-client';
const CLIENT_SECRET = 'DO_NOT_EXPORT_SYNTHETIC_OIDC_SECRET';
const NATIVE_SESSION = 'DO_NOT_EXPORT_SYNTHETIC_NATIVE_SESSION';
const API_KEY = 'DO_NOT_EXPORT_SYNTHETIC_API_KEY';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' } });

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'exomina-http-integration-'));
  const clients = [], streams = [], runs = [];
  let auth, devices, service, server;
  t.after(async () => {
    for (const stream of streams) await stream.close();
    for (const device of clients) await device.close();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await service?.close(); devices?.close(); auth?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('exomina-http-integration-'));
    await rm(directory, { recursive: true, force: true });
  });

  // Discover an available loopback port before creating the real auth object,
  // so its origin, redirect URI and owner scope all use the same final URL.
  const reservation = reserveServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-integration-key', alg: 'RS256', use: 'sig' };
  let challenge, nonce, tokenRequests = 0, keyRequests = 0;
  const fetchIdentity = async (target, options = {}) => {
    assert.equal(options.redirect, 'error');
    if (target === 'https://www.googleapis.com/oauth2/v3/certs') {
      keyRequests++; return jsonResponse({ keys: [jwk] });
    }
    assert.equal(target, 'https://oauth2.googleapis.com/token', 'identity fixture must never call another network endpoint');
    assert.equal(options.method, 'POST'); tokenRequests++;
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('code'), 'synthetic-auth-code');
    assert.equal(body.get('redirect_uri'), `${url}/auth/callback`);
    assert.equal(body.get('client_id'), CLIENT_ID);
    assert.equal(body.get('client_secret'), CLIENT_SECRET);
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenge);
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({
      iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'synthetic-owner-subject',
      email: OWNER, email_verified: true, name: 'Synthetic owner', nonce, iat: now, exp: now + 3600,
    })}`;
    const id_token = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
    return jsonResponse({ id_token, access_token: 'DO_NOT_EXPORT_SYNTHETIC_GOOGLE_TOKEN' });
  };
  const dataDir = path.join(directory, 'server');
  auth = new CloudAuth({ dataDir, publicUrl: url, ownerEmail: OWNER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: fetchIdentity, allowLocalHttp: true });
  await auth.init();
  devices = new DeviceStore({ dataDir, scope: auth.scope }); await devices.init();
  service = new CloudService({
    dataDir, vaultKey: randomBytes(32).toString('base64'),
    providerFactory: options => ({
      status: async () => [{ id: 'codex', connected: true, installed: true }],
      subscriptionModels: async () => ({ codex: [] }), cancel() {}, close() {},
      async run(input) {
        runs.push(input.conversationId);
        let reply = 'Synthetic reply: café, 東京, 🦉.';
        if (input.prompt.endsWith('[WAIT_FOR_APPROVAL]')) {
          const allowed = await options.approve({ conversationId: input.conversationId, title: 'Allow the synthetic action?', detail: 'A test action that makes no external changes.' });
          reply = allowed ? 'Synthetic approval completed.' : 'Synthetic approval declined.';
        }
        options.emit({ type: 'chat.delta', conversationId: input.conversationId, text: reply });
        return { text: reply, sessionId: NATIVE_SESSION };
      },
    }),
  });
  await service.init();
  server = createCloudServer({ auth, devices, service, distDir: directory });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');

  const initial = await fetch(`${url}/api/auth/status`);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).authenticated, false);
  const login = await fetch(`${url}/auth/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const identityUrl = new URL(login.headers.get('location'));
  assert.equal(identityUrl.origin, 'https://accounts.google.com');
  nonce = identityUrl.searchParams.get('nonce'); challenge = identityUrl.searchParams.get('code_challenge');
  const loginCookie = login.headers.getSetCookie().find(value => value.startsWith(`${auth.loginCookieName}=`)).split(';')[0];
  const callback = await fetch(`${url}/auth/callback?${new URLSearchParams({ state: identityUrl.searchParams.get('state'), code: 'synthetic-auth-code' })}`, { redirect: 'manual', headers: { Cookie: loginCookie } });
  assert.equal(callback.status, 303, 'the real OIDC callback must verify the signed synthetic identity');
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith(`${auth.cookieName}=`)).split(';')[0];
  const statusResponse = await fetch(`${url}/api/auth/status`, { headers: { Cookie: cookie } });
  const status = await statusResponse.json();
  assert.equal(status.authenticated, true); assert.equal(tokenRequests, 1); assert.equal(keyRequests, 1);
  const phoneHeaders = { Cookie: cookie, Origin: url, 'X-CSRF-Token': status.csrf, 'Content-Type': 'application/json' };
  async function invoke(method, payload = {}, requestId = randomUUID()) {
    const response = await fetch(`${url}/api/invoke`, { method: 'POST', headers: phoneHeaders, body: JSON.stringify({ method, payload, requestId }) });
    const result = await response.json();
    assert.equal(response.status, 200, `${method} should succeed: ${result.error || response.status}`);
    return result;
  }
  async function device(name) {
    const localDir = path.join(directory, name), store = new Store(localDir), memory = new MemoryStore(localDir), archive = new ArchiveStore(localDir);
    await store.init(); await memory.init(); await archive.init();
    const client = new CloudClient({ dataDir: localDir, store, memory, archive, encryption: serverEncryption(randomBytes(32).toString('base64')), allowLocalHttp: true, autoSync: false });
    await client.init();
    let closed = false;
    const value = { client, store, memory, archive, dataDir: localDir, async close() { if (closed) return; closed = true; await client.close(); await store.queue; memory.close(); archive.close(); } };
    clients.push(value);
    const pairing = await invoke('device.pairingCode');
    await client.configure({ url, pairingCode: pairing.code, name });
    return value;
  }
  async function events() {
    const controller = new AbortController();
    const response = await fetch(`${url}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const received = [], waiters = new Set();
    let failure;
    const pump = (async () => {
      let text = ''; const decoder = new TextDecoder();
      try {
        for await (const chunk of response.body) {
          text += decoder.decode(chunk, { stream: true });
          let boundary;
          while ((boundary = text.indexOf('\n\n')) >= 0) {
            const frame = text.slice(0, boundary); text = text.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
            if (!data) continue;
            const event = JSON.parse(data); received.push(event);
            for (const waiter of [...waiters]) if (waiter.predicate(event)) waiter.finish(event);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) { failure = error; for (const waiter of [...waiters]) waiter.reject(error); }
      }
    })();
    const stream = {
      received,
      waitFor(predicate) {
        const previous = received.find(predicate); if (previous) return Promise.resolve(previous);
        if (failure) return Promise.reject(failure);
        return new Promise((resolve, reject) => {
          const waiter = { predicate, finish(event) { clearTimeout(timer); waiters.delete(waiter); resolve(event); }, reject(error) { clearTimeout(timer); waiters.delete(waiter); reject(error); } };
          const timer = setTimeout(() => waiter.reject(new Error('Expected synthetic server event did not arrive.')), 5000);
          waiters.add(waiter);
        });
      },
      async close() { controller.abort(); await pump; for (const waiter of [...waiters]) waiter.reject(new Error('Synthetic event client closed.')); },
    };
    streams.push(stream);
    await stream.waitFor(event => event.type === 'state.changed' && event.reconnected);
    return stream;
  }
  async function finished(id) {
    // chat.complete is emitted before the service's durable final checkpoint.
    // Await that exact job rather than assuming the SSE event means disk sync.
    const run = service.active.get(id); if (run) await run.promise;
    assert.equal(service.active.has(id), false);
  }
  return { directory, url, auth, service, runs, invoke, device, events, finished, phoneHeaders, cookie };
}

test('real owner HTTP login, paired desktops and hosted service synchronize chats and notes without sharing credentials', { timeout: 30000 }, async t => {
  const f = await fixture(t), first = await f.device('desktop-one'), second = await f.device('desktop-two');
  const deviceToken = first.client.token;
  const unauthorized = await fetch(`${f.url}/api/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'bootstrap' }) });
  assert.equal(unauthorized.status, 401); await unauthorized.arrayBuffer();
  const withoutCsrf = await fetch(`${f.url}/api/invoke`, { method: 'POST', headers: { Cookie: f.cookie, Origin: f.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'memory.add', payload: { text: 'Must not be saved' } }) });
  assert.equal(withoutCsrf.status, 403); await withoutCsrf.arrayBuffer();
  const wrongRole = await fetch(`${f.url}/api/invoke`, { method: 'POST', headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'device.list' }) });
  assert.equal(wrongRole.status, 403); await wrongRole.arrayBuffer();
  assert.equal((await f.invoke('device.list')).devices.length, 2);

  const events = await f.events();
  const requestId = randomUUID(), input = { provider: 'codex', text: 'A phone-origin chat: café and 東京.' };
  const sent = await f.invoke('chat.send', input, requestId);
  assert.deepEqual(await f.invoke('chat.send', input, requestId), sent, 'a repeated HTTP request must not run a second model job');
  await events.waitFor(event => event.type === 'chat.complete' && event.conversationId === sent.conversationId);
  await f.finished(sent.conversationId);
  await first.client.sync(); await second.client.sync();
  const expectedReply = 'Synthetic reply: café, 東京, 🦉.';
  for (const desktop of [first, second]) {
    assert.equal(desktop.store.conversation(sent.conversationId).messages[1].content, expectedReply);
    assert.deepEqual(desktop.store.conversation(sent.conversationId).sessions, {});
    const persisted = JSON.parse(await readFile(path.join(desktop.dataDir, 'state.json'), 'utf8'));
    assert.equal(persisted.conversations.find(chat => chat.id === sent.conversationId).messages[1].content, expectedReply);
  }
  assert.equal(f.runs.filter(id => id === sent.conversationId).length, 1);
  const local = first.store.create('codex'); local.title = 'Desktop-origin synthetic chat';
  local.messages.push({ role: 'user', content: 'This starts on the desktop.' }); local.sessions = { codex: NATIVE_SESSION };
  await first.store.save(); await first.client.sync(); await second.client.sync();
  const phoneChat = await f.invoke('conversations.get', { id: local.id });
  assert.equal(phoneChat.messages[0].content, local.messages[0].content);
  assert.equal(second.store.conversation(local.id).messages[0].id, local.messages[0].id);
  assert.equal('sessions' in phoneChat, false);

  await first.memory.note('Desktop note: use metric units.', { id: 'synthetic-desktop-note' });
  await first.client.sync(); await second.client.sync();
  assert.equal((await f.invoke('memory.search', { query: 'metric' }))[0].id, 'synthetic-desktop-note');
  const phoneNotes = await f.invoke('memory.add', { text: 'Phone note: café and 東京.' });
  const phoneNote = phoneNotes.find(note => note.text.startsWith('Phone note:'));
  await first.client.sync(); await second.client.sync();
  assert.equal((await second.memory.list()).find(note => note.id === phoneNote.id).text, phoneNote.text);
  await first.memory.remove('synthetic-desktop-note'); await first.client.sync(); await second.client.sync();
  assert.equal((await f.invoke('memory.search', { query: 'metric' })).length, 0);
  assert.equal((await second.memory.list()).some(note => note.id === 'synthetic-desktop-note'), false);
  await f.invoke('memory.delete', { id: phoneNote.id }); await first.client.sync(); await second.client.sync();
  assert.deepEqual(await first.memory.list(), []); assert.deepEqual(await second.memory.list(), []);
  assert.equal(f.service.syncStore.get('note', phoneNote.id).deleted, true);

  await first.archive.importDocuments([{ provider: 'claude', kind: 'memory', title: 'Synthetic imported context', text: 'A synthetic saved memory with Unicode: 🦉.', sourceId: 'synthetic-import', sourceFile: 'C:\\synthetic-private\\export.json' }]);
  await first.client.sync(); await second.client.sync();
  assert.equal((await f.invoke('bootstrap')).archive.documents, 1);
  assert.match(second.archive.exportDocuments()[0].text, /🦉/);
  const exported = await f.invoke('data.export', { scope: 'all', format: 'json' });
  assert.equal(exported.mimeType, 'application/json');
  const document = JSON.parse(exported.content);
  assert.equal(document.chats.length, 2); assert.equal(document.documents.length, 1);
  assert.equal(document.documents[0].sourceFile, 'export.json');
  for (const secret of [CLIENT_SECRET, NATIVE_SESSION, API_KEY, deviceToken, f.cookie.split('=')[1], f.phoneHeaders['X-CSRF-Token'], 'DO_NOT_EXPORT_SYNTHETIC_GOOGLE_TOKEN']) {
    assert.equal(exported.content.includes(secret), false, 'export must exclude credentials and runtime secrets');
  }
  for (const field of ['settings', 'connections', 'sessions', 'workspace', 'devices', 'csrf']) assert.equal(field in document, false);
  assert.equal(JSON.stringify(document.chats).includes('sessions'), false);
  const savedDevice = await readFile(path.join(first.dataDir, 'cloud-connection.json'), 'utf8');
  assert.equal(savedDevice.includes(deviceToken), false);

  await first.close(); await second.close();
  const afterDesktop = await f.invoke('chat.send', { provider: 'codex', text: 'Continue after both desktop clients have closed.' });
  await f.finished(afterDesktop.conversationId);
  assert.equal((await f.invoke('conversations.get', { id: afterDesktop.conversationId })).messages[1].content, expectedReply);
  const boot = await f.invoke('bootstrap');
  assert.deepEqual(boot.activeRuns, []); assert.equal(boot.runtime.executor.online, true);
  assert.equal(boot.runtime.capabilities.desktopControl, false); assert.equal(boot.runtime.capabilities.nativeBrowser, false);
  const disk = JSON.parse(await readFile(path.join(f.service.dataDir, 'state.json'), 'utf8'));
  assert.equal(disk.conversations.find(chat => chat.id === afterDesktop.conversationId).messages[1].content, expectedReply);
});

test('a real phone SSE reconnect recovers and resolves the same hosted approval without cancelling or rerunning its job', { timeout: 30000 }, async t => {
  const f = await fixture(t), desktop = await f.device('desktop');
  const original = await f.events();
  const { conversationId } = await f.invoke('chat.send', { provider: 'codex', text: '[WAIT_FOR_APPROVAL]' });
  const approval = await original.waitFor(event => event.type === 'approval' && event.conversationId === conversationId);
  assert.equal(typeof approval.id, 'string'); assert.ok(Date.parse(approval.expiresAt) > Date.now());
  await original.close();
  const disconnected = await f.invoke('bootstrap');
  assert.deepEqual(disconnected.activeRuns, [{ conversationId }]);
  assert.equal(disconnected.approvals[0].id, approval.id);
  assert.equal(f.service.active.has(conversationId), true, 'closing the phone event stream must not cancel its hosted job');
  const reconnected = await f.events();
  const restored = await f.invoke('bootstrap');
  assert.equal(restored.approvals.length, 1); assert.equal(restored.approvals[0].id, approval.id);
  assert.equal('finish' in restored.approvals[0], false);
  await f.invoke('approval.respond', { id: restored.approvals[0].id, approved: true });
  await reconnected.waitFor(event => event.type === 'approval.resolved' && event.id === approval.id);
  await reconnected.waitFor(event => event.type === 'chat.complete' && event.conversationId === conversationId);
  await f.finished(conversationId);
  const finished = await f.invoke('bootstrap');
  assert.deepEqual(finished.activeRuns, []); assert.deepEqual(finished.approvals, []);
  assert.equal((await f.invoke('conversations.get', { id: conversationId })).messages[1].content, 'Synthetic approval completed.');
  assert.equal(f.runs.filter(id => id === conversationId).length, 1);
  await desktop.client.sync();
  assert.equal(desktop.store.conversation(conversationId).messages[1].content, 'Synthetic approval completed.');
  const fresh = new Store(desktop.dataDir); await fresh.init();
  assert.equal(fresh.conversation(conversationId).messages[1].content, 'Synthetic approval completed.');
});
