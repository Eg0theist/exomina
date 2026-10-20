import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CloudClient, cloudEndpoint, portablePayload } from '../desktop/cloud-client.mjs';
import { Store } from '../desktop/store.mjs';
import { MemoryStore } from '../desktop/note-store.mjs';
import { ArchiveStore } from '../desktop/archive.mjs';
import { DeviceStore } from '../cloud/devices.mjs';
import { SyncStore } from '../cloud/sync-store.mjs';
import { createCloudServer } from '../cloud/server.mjs';
import { AssetStore } from '../desktop/assets.mjs';

function testEncryption() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), data]); },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); },
  };
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-client-test-'));
  const devices = new DeviceStore({ dataDir: path.join(dir, 'server'), scope: 'synthetic-owner' }); await devices.init();
  const syncStore = new SyncStore({ dataDir: path.join(dir, 'server') }); await syncStore.init();
  const auth = { secure: false, publicUrl: '', ensureConfigured() {}, requireOwner() { throw Object.assign(new Error('Owner sign-in required.'), { status: 401 }); } };
  const service = { syncStore, invoke: async () => ({}), subscribe: () => () => {} };
  const server = createCloudServer({ auth, devices, service, distDir: dir }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`; auth.publicUrl = url;
  const clients = [];
  async function device(name, overrides = {}) {
    const dataDir = path.join(dir, name), store = new Store(dataDir), memory = new MemoryStore(dataDir), archive = new ArchiveStore(dataDir), assets = new AssetStore(dataDir);
    await store.init(); await memory.init(); await archive.init(); await assets.init();
    const encryption = testEncryption();
    const options = { dataDir, store, memory, archive, assets, encryption, allowLocalHttp: true, autoSync: false, ...overrides };
    const client = new CloudClient(options); await client.init();
    const value = { client, store, memory, archive, assets, options, dataDir }; clients.push(value);
    await client.configure({ url, pairingCode: devices.createPairingCode().code, name });
    return value;
  }
  t.after(async () => {
    for (const value of clients) { await value.client.close(); value.memory.close(); value.archive.close(); value.assets.close(); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); syncStore.close(); devices.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await rm(dir, { recursive: true, force: true });
  });
  return { dir, devices, syncStore, service, server, url, device };
}
function chat(store, content = 'Synthetic conversation') {
  const value = store.create('codex'); value.title = 'Synthetic chat'; value.messages.push({ role: 'user', content }); return value;
}

test('private endpoints reject insecure origins and portable payloads omit native sessions and device configuration', () => {
  for (const value of ['http://example.com', 'http://127.0.0.1:3000', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?token=secret']) assert.throws(() => cloudEndpoint(value));
  assert.equal(cloudEndpoint('http://127.0.0.1:3000', true), 'http://127.0.0.1:3000');
  const data = portablePayload('chat', { title: 'Chat', provider: 'claude', sessions: { claude: 'private-runtime-id' }, workspace: 'C:\\private', token: 'private-token', messages: [{ id: 'm1', role: 'user', content: 'Synthetic', localPath: 'C:\\private' }] });
  assert.equal(JSON.stringify(data).includes('private'), false);
});

test('basic_text blocks pairing before the request and preserves existing connection bytes on reload',async t=>{
 const f=await fixture(t),a=await f.device('protected-device');
 const before=await readFile(a.client.file,'utf8');let requests=0;
 const blocked={...a.options.encryption,getSelectedStorageBackend:()=> 'basic_text'};
 a.client.encryption=blocked;a.client.fetchImpl=async()=>{requests++;throw Error('must not pair');};
 await assert.rejects(a.client.configure({url:f.url,pairingCode:'synthetic'}),error=>error.code==='SECRET_STORAGE_UNAVAILABLE');
 assert.equal(requests,0);assert.equal(await readFile(a.client.file,'utf8'),before);
 await a.client.close();a.client=new CloudClient({...a.options,encryption:blocked});await a.client.init();
 assert.equal(a.client.status().configured,false);assert.match(a.client.status().error,/encryption is unavailable/);
 assert.equal(await readFile(a.client.file,'utf8'),before);
});

test('chat title ownership, pins and archive state make a two-device round trip without exposing runtime metadata', async t => {
  const f=await fixture(t),a=await f.device('organization-a'),b=await f.device('organization-b');
  const original=chat(a.store);Object.assign(original,{title:'My manual title',titleSource:'manual',pinned:true,archived:true,sessions:{codex:'private-native'}});await a.store.save();
  await a.client.sync();await b.client.sync();
  const received=b.store.conversation(original.id);assert.equal(received.title,'My manual title');assert.equal(received.titleSource,'manual');assert.equal(received.pinned,true);assert.equal(received.archived,true);assert.deepEqual(received.sessions,{});
  received.archived=false;received.pinned=false;await b.store.save();await b.client.sync();await a.client.sync();
  assert.equal(a.store.conversation(original.id).archived,false);assert.equal(a.store.conversation(original.id).pinned,false);assert.equal(a.store.conversation(original.id).titleSource,'manual');
});

test('two desktop devices pair and synchronize chats, notes and archives through the authenticated HTTP service', async t => {
  const f = await fixture(t), a = await f.device('desktop-a'), b = await f.device('desktop-b');
  const original = chat(a.store); original.sessions = { codex: 'private-native-session' };
  await a.memory.note('Synthetic shared memory.', { id: 'note-1', createdAt: '2026-10-05T00:00:00.000Z' });
  await a.archive.importDocuments([{ provider: 'claude', kind: 'conversation', sourceId: 'import-1', title: 'Synthetic import', text: '[user]\nSynthetic history', sourceFile: 'C:\\private\\export.json' }]);
  await a.client.sync(); await b.client.sync();
  const received = b.store.conversation(original.id);
  assert.equal(received.messages[0].content, original.messages[0].content);
  assert.equal(received.messages[0].id, original.messages[0].id);
  assert.deepEqual(received.sessions, {});
  assert.equal((await b.memory.list())[0].text, 'Synthetic shared memory.');
  assert.equal(b.archive.exportDocuments()[0].text, '[user]\nSynthetic history');
  assert.equal(b.archive.exportDocuments()[0].sourceFile, 'export.json');
  assert.equal(JSON.stringify(f.syncStore.get('chat', original.id)).includes('private-native-session'), false);
  const sequence = f.syncStore.maxSeq(); await a.client.sync(); await b.client.sync(); assert.equal(f.syncStore.maxSeq(), sequence, 'no-op sync must not create revisions');
  assert.equal(a.client.status().state, 'synced');
  a.store.conversation(original.id).title = 'A local rename waiting to sync';
  assert.equal(a.client.status().state, 'waiting');
  await a.client.sync(); assert.equal(a.client.status().state, 'synced');
  const saved = await readFile(path.join(a.dataDir, 'cloud-connection.json'), 'utf8');
  assert.equal(saved.includes(a.client.token), false);
  assert.equal(JSON.stringify(a.client.status()).includes(a.client.token), false);
  f.devices.revoke(b.client.config.deviceId);
  await assert.rejects(b.client.sync(), /no longer authorized/);
});

test('images publish before chat references, cross devices both ways, and polling reads no unchanged image bytes', async t => {
  const f=await fixture(t),a=await f.device('image-desktop'),b=await f.device('image-phone');
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lscAAAAASUVORK5CYII=';
  const first=await a.assets.put(png),original=chat(a.store,'An attached generated image');original.messages[0].attachments=[{...first,kind:'image',name:'generated.png',localPath:'C:\\private\\generated.png',dataBase64:png}];await a.store.save();
  await a.client.sync();const events=f.syncStore.changes(0).events;assert.ok(events.find(x=>x.kind==='asset').seq<events.find(x=>x.kind==='chat').seq);await b.client.sync();
  const received=b.store.conversation(original.id);assert.equal(received.messages[0].attachments[0].kind,'image');assert.equal((await b.assets.get(first.id)).dataBase64,png);assert.equal(JSON.stringify(received).includes('dataBase64'),false);assert.equal(JSON.stringify(received).includes('private'),false);
  // A second supported image container models image creation on the other device.
  const jpeg=Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,0,255,217]);const second=await b.assets.put(jpeg);
  received.messages.push({role:'assistant',content:'Image created from the phone session',attachments:[{...second,kind:'image',name:'phone.jpg'}]});await b.store.save();await b.client.sync();await a.client.sync();assert.equal((await a.assets.get(second.id)).dataBase64,jpeg.toString('base64'));assert.equal(a.store.conversation(original.id).messages.at(-1).attachments[0].id,second.id);
  const sequence=f.syncStore.maxSeq();a.assets.export=async()=>{throw Error('Unchanged image bytes must not be loaded.');};b.assets.export=async()=>{throw Error('Unchanged image bytes must not be loaded.');};await a.client.sync();await b.client.sync();assert.equal(f.syncStore.maxSeq(),sequence);
  await a.client.close();a.client=new CloudClient(a.options);await a.client.init();await a.client.sync();assert.equal(f.syncStore.maxSeq(),sequence);assert.equal(a.client.status().state,'synced');
  // Chat deletion does not prematurely collect an image another chat may reference.
  b.store.state.conversations=[];await b.store.save();await b.client.sync();await a.client.sync();assert.equal(a.assets.index().length,2);
  await b.assets.remove(second.id);await b.client.sync();await a.client.sync();assert.equal(await a.assets.get(second.id),null);assert.equal(f.syncStore.get('asset',second.id).deleted,true);
});

test('offline chat conflicts preserve both edits and remote tombstones never restore the deleted ID', async t => {
  const f = await fixture(t), a = await f.device('desktop-a'), b = await f.device('desktop-b');
  const original = chat(a.store, 'Base'); await a.client.sync(); await b.client.sync();
  a.store.conversation(original.id).messages[0].content = 'Edit on A'; await a.client.sync();
  b.store.conversation(original.id).messages[0].content = 'Offline edit on B'; await b.client.sync();
  assert.equal(b.store.conversation(original.id).messages[0].content, 'Edit on A');
  const recovered = b.store.state.conversations.find(item => item.id !== original.id);
  assert.match(recovered.title, /recovered copy/); assert.equal(recovered.messages[0].content, 'Offline edit on B');
  assert.equal(f.syncStore.get('chat', recovered.id).deleted, false);
  await a.client.sync(); assert.equal(a.store.conversation(recovered.id).messages[0].content, 'Offline edit on B');
  a.store.state.conversations = a.store.state.conversations.filter(item => item.id !== original.id); await a.client.sync();
  b.store.conversation(original.id).messages[0].content = 'Unsynced text after deletion'; await b.client.sync();
  assert.equal(f.syncStore.get('chat', original.id).deleted, true);
  assert.equal(b.store.state.conversations.some(item => item.id === original.id), false);
  assert.ok(b.store.state.conversations.some(item => item.messages[0].content === 'Unsynced text after deletion'));
  await b.client.sync(); await a.client.sync();
  assert.equal(f.syncStore.get('chat', original.id).deleted, true);
  assert.equal(a.store.state.conversations.some(item => item.id === original.id), false);
});

test('an acknowledged write with a lost HTTP response replays its durable operation once after restart', async t => {
  const f = await fixture(t); let loseNext = true;
  const a = await f.device('desktop-a', { fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/api/sync/apply') && loseNext) { loseNext = false; await response.arrayBuffer(); throw new Error('Synthetic lost acknowledgement'); }
    return response;
  } });
  const value = chat(a.store); await assert.rejects(a.client.sync(), /Could not reach/);
  assert.equal(f.syncStore.maxSeq(), 1); assert.equal(a.client.db.prepare('SELECT COUNT(*) AS n FROM pending').get().n, 1);
  await a.client.close(); a.client = new CloudClient({ ...a.options, fetchImpl: fetch }); await a.client.init();
  await a.client.sync();
  assert.equal(f.syncStore.maxSeq(), 1); assert.equal(a.client.db.prepare('SELECT COUNT(*) AS n FROM pending').get().n, 0);
  assert.equal(f.syncStore.get('chat', value.id).payload.messages[0].content, 'Synthetic conversation');
});

test('sync pauses during local work, refuses unavailable encryption before pairing and treats active remote chats as retryable', async t => {
  const f = await fixture(t); let busy = true, fetches = 0;
  const a = await f.device('desktop-a', { isBusy: () => busy, fetchImpl: (...args) => { fetches++; return fetch(...args); } });
  chat(a.store); const before = fetches; await a.client.sync(); assert.equal(fetches, before);
  busy = false;
  f.service.beforeSync = () => { throw Object.assign(new Error('This chat is active.'), { code: 409 }); };
  await assert.rejects(a.client.sync(), /currently active/);
  assert.equal(a.store.state.conversations.length, 1, 'an active-chat lock must not create a conflict fork');
  delete f.service.beforeSync; await a.client.sync(); assert.equal(f.syncStore.maxSeq(), 1);
  const previous = a.client.encryption; a.client.encryption = { isEncryptionAvailable: () => false };
  const count = fetches; await assert.rejects(a.client.configure({ url: f.url, pairingCode: 'synthetic' }), /encryption is unavailable/); assert.equal(fetches, count); a.client.encryption = previous;
});

test('memory deletion propagates durably and initial sync follows multiple event pages', async t => {
  const f = await fixture(t), a = await f.device('desktop-a'), b = await f.device('desktop-b');
  for (let index = 0; index < 205; index++) await a.memory.note(`Synthetic note ${index}`, { id: `note-${index}`, createdAt: '2026-10-05T00:00:00.000Z' });
  await a.client.sync(); await b.client.sync(); assert.equal((await b.memory.list('', 1000)).length, 205);
  await a.memory.remove('note-0'); await a.client.sync(); await b.client.sync();
  assert.equal((await b.memory.list('', 1000)).length, 204);
  assert.equal(f.syncStore.get('note', 'note-0').deleted, true);
  await b.client.sync(); assert.equal(f.syncStore.get('note', 'note-0').deleted, true);
});

test('an edit arriving during transfer stays waiting until the next pass uploads it', async t => {
  const f = await fixture(t); let a, changed = false;
  a = await f.device('desktop-a', { fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.includes('/api/sync/changes') && !changed) { changed = true; a.store.state.conversations[0].title = 'Rename during transfer'; }
    return response;
  } });
  const original = chat(a.store); await a.client.sync();
  assert.equal(a.client.status().state, 'waiting');
  assert.equal(f.syncStore.get('chat', original.id).payload.title, 'Synthetic chat');
  await a.client.sync(); assert.equal(a.client.status().state, 'synced');
  assert.equal(f.syncStore.get('chat', original.id).payload.title, 'Rename during transfer');
});

test('remote archive tombstones remove the imported local record and do not re-upload it', async t => {
  const f = await fixture(t), a = await f.device('desktop-a');
  await a.archive.importDocuments([{ provider: 'claude', kind: 'memory', title: 'Synthetic', text: 'Synthetic imported memory.' }]);
  await a.client.sync(); const entity = f.syncStore.list('archive').entities[0];
  f.syncStore.apply({ deviceId: 'synthetic-owner', operationId: 'delete-archive', expectedRevision: entity.revision, type: 'delete', entity: { kind: 'archive', id: entity.id } });
  await a.client.sync(); assert.equal(a.archive.exportDocuments().length, 0);
  await a.client.sync(); assert.equal(f.syncStore.get('archive', entity.id).deleted, true);
});

test('unchanged archives require no full exports across polls or restart, while new provenance and deletion invalidate correctly', async t => {
  const f = await fixture(t), a = await f.device('desktop-a'), b = await f.device('desktop-b');
  const docs = Array.from({ length: 3 }, (_, index) => ({ provider: 'claude', kind: 'conversation', sourceId: `synthetic-${index}`, title: `Synthetic ${index}`, text: `Synthetic history ${index}:` + 'x'.repeat(128 * 1024), sourceFile: 'first.json' }));
  await a.archive.importDocuments(docs);
  const originalExport = a.archive.exportDocument.bind(a.archive); let exports = 0;
  a.archive.exportDocument = id => { exports++; return originalExport(id); };
  a.archive.exportDocuments = () => { throw new Error('Full archive scanning is not permitted during sync.'); };
  await a.client.sync(); assert.equal(exports, 3); exports = 0;
  await a.client.sync(); a.client.status(); assert.equal(exports, 0);
  await a.client.close(); a.archive.close(); await a.archive.init();
  a.client = new CloudClient(a.options); await a.client.init(); await a.client.sync(); assert.equal(exports, 0, 'the metadata cache must persist across restarts');
  await a.archive.importDocuments([{ ...docs[0], sourceFile: 'second.json' }]);
  assert.equal(a.client.status().state, 'waiting'); await a.client.sync(); assert.equal(exports, 1, 'only the record with changed provenance may load its text');
  assert.equal(f.syncStore.list('archive').entities.length, 4, 'changed archive provenance becomes a new immutable version');
  await b.client.sync();
  const removed = a.archive.findDocumentForSync(docs[0]); a.archive.removeDocument(removed);
  assert.equal(a.client.status().state, 'waiting'); await a.client.sync(); await b.client.sync();
  assert.equal(b.archive.findDocumentForSync(docs[0]), null);
  assert.equal(f.syncStore.list('archive').entities.filter(value => value.deleted).length, 2, 'deletion covers both immutable versions of the same local record');
});
