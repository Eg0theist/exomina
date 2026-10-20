import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { SyncStore } from '../cloud/sync-store.mjs';
import { validateImageAsset } from '../desktop/assets.mjs';

const createdAt = '2026-10-05T12:00:00.000Z';
const note = (id, value, operationId = id, expectedRevision) => ({ deviceId: 'desktop', operationId, ...(expectedRevision === undefined ? {} : { expectedRevision }), type: 'put', entity: { kind: 'note', id, payload: { text: value, createdAt } } });
const archive = (id, text = 'Synthetic archive text.') => ({ deviceId: 'desktop', operationId: id, type: 'put', entity: { kind: 'archive', id, payload: { kind: 'conversation', title: 'Synthetic export', provider: 'claude', text, sourceFile: 'conversations.json', sourceId: 'source-1', rawJson: '{"synthetic":true}' } } });
async function fixture(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-sync-test-'));
  const stores = [];
  const open = async () => { const store = new SyncStore({ dataDir: dir }); stores.push(store); await store.init(); return store; };
  try { await run(await open(), open, dir); }
  finally {
    for (const store of stores) store.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('exomina-sync-test-'));
    await rm(dir, { recursive: true, force: true });
  }
}

test('operations persist across reopen, replay exact metadata, and reject changed operation IDs', async () => fixture(async (store, open) => {
  const input = note('note-a', 'Synthetic ä 中文.');
  const first = store.apply(input);
  assert.equal(first.seq, 1); assert.equal(first.revision, 1); assert.equal(first.duplicate, false);
  assert.equal(Object.hasOwn(first.entity, 'payload'), false);
  const replay = store.apply({ ...input, entity: { payload: { createdAt, text: 'Synthetic ä 中文.' }, id: 'note-a', kind: 'note' } });
  assert.deepEqual(replay, { ...first, duplicate: true }); assert.equal(store.maxSeq(), 1);
  assert.throws(() => store.apply(note('note-a', 'Different', 'note-a')), error => error.code === 409 && error.current.revision === 1 && !('payload' in error.current));
  store.close(); const reopened = await open();
  assert.deepEqual(reopened.apply(input), replay);
  assert.equal(reopened.get('note', 'note-a').payload.text, 'Synthetic ä 中文.');
  const secondDevice = reopened.apply({ ...input, deviceId: 'phone', expectedRevision: 1 });
  assert.equal(secondDevice.revision, 2); assert.equal(secondDevice.duplicate, false);
}));

test('chat organization metadata is strict and omitted legacy fields remain omitted', async () => fixture(async store => {
  const put=(id,payload)=>store.apply({deviceId:'desktop',operationId:id,type:'put',entity:{kind:'chat',id,payload:{title:'Synthetic',provider:'codex',messages:[],...payload}}});
  put('legacy',{});assert.equal(Object.hasOwn(store.get('chat','legacy').payload,'pinned'),false);assert.equal(Object.hasOwn(store.get('chat','legacy').payload,'titleSource'),false);
  for(const [id,payload] of [['bad-pin',{pinned:'true'}],['bad-archive',{archived:1}],['bad-source',{titleSource:'system'}]]) assert.throws(()=>put(id,payload),/Invalid chat/);
  put('modern',{pinned:true,archived:false,titleSource:'manual'});const value=store.get('chat','modern').payload;
  assert.equal(value.pinned,true);assert.equal(value.archived,false);assert.equal(value.titleSource,'manual');
}));

test('optimistic revisions prevent stale updates across independent store connections', async () => fixture(async (desktop, open) => {
  desktop.apply(note('shared', 'Original'));
  const phone = await open();
  const changed = phone.apply({ ...note('shared', 'Phone edit', 'phone-edit', 1), deviceId: 'phone' });
  assert.equal(changed.revision, 2);
  assert.throws(() => desktop.apply(note('shared', 'Stale desktop edit', 'desktop-edit', 1)), error => error.code === 409 && error.current.revision === 2);
  assert.throws(() => desktop.apply(note('shared', 'No revision', 'missing-revision')), error => error.code === 409);
  assert.equal(desktop.get('note', 'shared').payload.text, 'Phone edit'); assert.equal(desktop.maxSeq(), 2);
  assert.throws(() => desktop.apply(note('absent', 'Unknown revision', 'absent-edit', 3)), error => error.code === 409);
}));

test('deletion purges current payload, retains metadata-only history, and never resurrects a deleted ID', async () => fixture(async store => {
  const marker = 'PRIVATE_SYNTHETIC_DELETION_MARKER';
  const initial = note('erasable', marker); const first = store.apply(initial);
  const deletion = { deviceId: 'phone', operationId: 'delete-1', expectedRevision: 1, type: 'delete', entity: { kind: 'note', id: 'erasable' } };
  const deleted = store.apply(deletion);
  assert.equal(deleted.revision, 2); assert.equal(deleted.entity.deleted, true); assert.equal(deleted.entity.bytes, 0); assert.equal(deleted.entity.checksum, null);
  assert.equal(store.get('note', 'erasable').payload, null);
  assert.deepEqual(store.apply(initial), { ...first, duplicate: true });
  assert.equal(store.get('note', 'erasable').deleted, true, 'Replaying a historical create only acknowledges it, never restores it.');
  for (const revision of [undefined, 0, 1, 2]) assert.throws(() => store.apply(note('erasable', 'Offline resurrection', `resurrect-${revision}`, revision)), error => error.code === 409 && error.current.deleted);
  const repeatedDelete = store.apply({ ...deletion, operationId: 'delete-2', expectedRevision: 2 });
  assert.equal(repeatedDelete.duplicate, true); assert.equal(store.maxSeq(), 2);
  assert.equal(store.list('note').entities[0].deleted, true);
  for (const table of ['sync_entities', 'sync_events', 'sync_operations']) assert.equal(JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()).includes(marker), false, `${table} must not retain the deleted text.`);
  assert.equal(store.db.prepare('SELECT payload FROM sync_entities').get().payload, null);
  assert.equal(store.changes(0).events.every(event => !('payload' in event)), true);
}));

test('archives preserve raw source, remain immutable, and deduplicate only identical IDs and checksums', async () => fixture(async store => {
  const input = archive('archive-1'); input.entity.payload.sourceFile = 'C:\\Users\\private\\Downloads\\conversations.json';
  input.entity.payload.sources = [{ sourceFile: 'artifacts/111/version/page.md', sourceUrl: 'https://example.test/chat', sourceId: 'origin' }];
  const first = store.apply(input);
  const read = store.get('archive', 'archive-1');
  assert.equal(read.payload.rawJson, '{"synthetic":true}'); assert.equal(read.payload.sourceFile, 'conversations.json');
  assert.equal(read.payload.sources[0].sourceFile, 'artifacts/111/version/page.md');
  const duplicate = store.apply({ ...input, deviceId: 'phone', operationId: 'repeat-import', expectedRevision: 0 });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.seq, first.seq);
  const changed = archive('archive-1', 'Changed text'); changed.operationId = 'changed-archive'; changed.expectedRevision = 1;
  assert.throws(() => store.apply(changed), error => error.code === 409 && /immutable/.test(error.message));
  const distinct = store.apply(archive('archive-2'));
  assert.equal(distinct.duplicate, false); assert.equal(store.list('archive').entities.length, 2);
}));

test('chat messages require stable IDs and strip device sessions, credentials, and local paths', async () => fixture(async store => {
  const chat = { deviceId: 'desktop', operationId: 'chat-create', type: 'put', entity: { kind: 'chat', id: 'chat-1', payload: {
    title: 'Synthetic chat', provider: 'custom', createdAt, sessions: { codex: 'PRIVATE_NATIVE_SESSION' }, codexToolFingerprint: 'LOCAL_FINGERPRINT', workspace: 'C:\\private', apiKey: 'PRIVATE_SYNTHETIC_API_KEY',
    messages: [{ id: 'message-1', role: 'user', content: 'Synthetic user text', provider: 'custom', sessionId: 'PRIVATE_MESSAGE_SESSION', localPath: 'C:\\private', attachments: [{ id: 'attachment-1', sha256: 'a'.repeat(64), bytes: 100, name: 'C:\\private\\image.png', mimeType: 'image/png', data: 'MUST_NOT_STORE_INLINE_BINARY' }] }, { id: 'message-2', role: 'assistant', content: 'Synthetic assistant text' }],
  } } };
  store.apply(chat);
  const payload = store.get('chat', 'chat-1').payload;
  assert.equal(payload.messages[0].attachments[0].name, 'image.png');
  assert.equal(JSON.stringify(payload).includes('PRIVATE_'), false); assert.equal(JSON.stringify(payload).includes('C:\\private'), false); assert.equal(JSON.stringify(payload).includes('MUST_NOT_STORE'), false);
  const bad = structuredClone(chat); bad.operationId = 'missing-message-id'; bad.entity.id = 'chat-2'; delete bad.entity.payload.messages[0].id;
  assert.throws(() => store.apply(bad), /message ID/);
  bad.entity.payload.messages[0].id = 'message-2'; assert.throws(() => store.apply(bad), /distinct stable ID/);
  const reused = structuredClone(chat); reused.entity.payload.apiKey = 'DIFFERENT_PRIVATE_KEY';
  assert.throws(() => store.apply(reused), error => error.code === 409, 'Even changes to stripped fields cannot reuse a committed operation ID.');
}));

test('event and entity pagination is bounded and snapshot plus tail has no update/delete gaps', async () => fixture(async store => {
  for (let index = 0; index < 205; index++) store.apply(note(`note-${String(index).padStart(3, '0')}`, `Synthetic ${index}`));
  const first = store.changes(0, 200); assert.equal(first.events.length, 200); assert.equal(first.cursor, 200); assert.equal(first.hasMore, true);
  const second = store.changes(first.cursor, 200); assert.equal(second.events.length, 5); assert.equal(second.cursor, 205); assert.equal(second.hasMore, false);
  assert.deepEqual(store.changes(205), { events: [], cursor: 205, hasMore: false });
  let page = store.list('note', 37), count = page.entities.length;
  while (page.hasMore) { page = store.list('note', 37, page.cursor); count += page.entities.length; }
  assert.equal(count, 205);
  const baseline = store.snapshot(50); assert.equal(baseline.snapshotSeq, 205);
  const merged = new Map(baseline.entities.map(entity => [entity.id, entity]));
  store.apply(note('note-150', 'Changed during baseline', 'during-edit', 1));
  store.apply({ deviceId: 'phone', operationId: 'during-delete', type: 'delete', expectedRevision: 1, entity: { kind: 'note', id: 'note-160' } });
  store.apply(note('note-999', 'Created during baseline', 'during-create'));
  page = baseline;
  while (page.hasMore) { page = store.snapshot(50, page.cursor); assert.equal(page.snapshotSeq, 205); for (const entity of page.entities) merged.set(entity.id, entity); }
  for (const event of store.changes(baseline.snapshotSeq).events) merged.set(event.id, event);
  assert.equal(merged.get('note-150').revision, 2); assert.equal(merged.get('note-160').deleted, true); assert.equal(merged.get('note-999').revision, 1); assert.equal(merged.size, 206);
  assert.throws(() => store.changes(0, 201), /page limit/); assert.throws(() => store.list('note', 201), /page limit/);
  assert.throws(() => store.snapshot(20, 'invalid'), /snapshot cursor/); assert.throws(() => store.changes(9999), error => error.code === 409);
  assert.throws(() => store.list('note', 10, 0), /list cursor/);
}));

test('uploaded file references sync as file metadata without device paths or bytes', async () => fixture(async store => {
  const id = 'b'.repeat(64);
  store.apply({ deviceId: 'desktop', operationId: 'file-chat', type: 'put', entity: { kind: 'chat', id: 'file-chat', payload: { title: 'Uploaded file', provider: 'claude', messages: [{ id: 'm1', role: 'user', content: '', attachments: [{ id, sha256: id, bytes: 12, kind: 'file', mimeType: 'application/octet-stream', name: 'notes.md', relativePath: 'PRIVATE_PATH', uploadId: 'PRIVATE_HANDLE', dataBase64: 'PRIVATE_BYTES' }] }] } } });
  const file = store.get('chat', 'file-chat').payload.messages[0].attachments[0];
  assert.equal(file.kind, 'file'); assert.equal(file.name, 'notes.md'); assert.equal(JSON.stringify(file).includes('PRIVATE'), false);
}));

test('size, Unicode note, timestamp and attachment-reference limits fail before mutation', async () => fixture(async store => {
  store.apply(note('unicode-limit', '中'.repeat(93)));
  assert.throws(() => store.apply(note('too-long', '中'.repeat(94))), /oversized note text/);
  assert.throws(() => store.apply(note('multiline', 'first\nsecond')), /single-line/);
  const badDate = note('bad-date', 'Synthetic'); badDate.entity.payload.createdAt = '2026-02-31'; assert.throws(() => store.apply(badDate), /createdAt/);
  const large = archive('too-large', 'x'.repeat(32 * 1024 * 1024)); assert.throws(() => store.apply(large), error => error.code === 413);
  const attachment = { deviceId: 'desktop', operationId: 'bad-attachment', type: 'put', entity: { kind: 'chat', id: 'bad-chat', payload: { messages: [{ id: 'one', role: 'user', content: '', attachments: [{ id: 'asset', sha256: 'b'.repeat(64), bytes: 32 * 1024 * 1024 + 1, name: 'file', mimeType: 'application/octet-stream' }] }] } } };
  assert.throws(() => store.apply(attachment), /attachment size/);
  assert.equal(store.maxSeq(), 1); assert.equal(store.get('archive', 'too-large'), null);
  const noTimestamp = note('server-time', 'Synthetic'); delete noTimestamp.entity.payload.createdAt;
  store.apply(noTimestamp); assert.match(store.get('note', 'server-time').payload.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(store.apply(noTimestamp).duplicate, true);
}));

test('entity, event, and idempotency writes commit atomically when an insert fails', async () => fixture(async store => {
  store.db.exec("CREATE TRIGGER reject_test_operation BEFORE INSERT ON sync_operations WHEN NEW.operation_id='forced-failure' BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END;");
  assert.throws(() => store.apply(note('rolled-back', 'Must not persist', 'forced-failure')), /synthetic transaction failure/);
  assert.equal(store.get('note', 'rolled-back'), null); assert.equal(store.maxSeq(), 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM sync_operations').get().count, 0);
  store.db.exec('DROP TRIGGER reject_test_operation');
  assert.equal(store.apply(note('rolled-back', 'Must not persist', 'forced-failure')).revision, 1);
}));

test('image assets validate content, deduplicate immutably and expose no bytes in metadata feeds',async()=>fixture(async store=>{
 const dataBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lscAAAAASUVORK5CYII=',meta=validateImageAsset(dataBase64).metadata;
 const payload={mimeType:meta.mimeType,bytes:meta.bytes,sha256:meta.sha256,dataBase64};const input={deviceId:'desktop',operationId:'image1',type:'put',entity:{kind:'asset',id:meta.id,payload}};
 const first=store.apply(input);assert.equal(first.duplicate,false);assert.equal(store.apply({...input,deviceId:'phone',operationId:'same-image'}).duplicate,true);assert.deepEqual(store.get('asset',meta.id).payload,payload);
 for(const feed of [first,store.list('asset'),store.changes(0),store.snapshot()])assert.equal(JSON.stringify(feed).includes(dataBase64),false);
 assert.throws(()=>store.apply({...input,operationId:'bad-hash',entity:{...input.entity,id:'a'.repeat(64)}}),/ID/);assert.throws(()=>store.apply({...input,operationId:'bad-mime',entity:{...input.entity,payload:{...payload,mimeType:'image/jpeg'}}}),/MIME/);
 const chat={deviceId:'desktop',operationId:'image-chat',type:'put',entity:{kind:'chat',id:'image-chat',payload:{messages:[{id:'assistant-image',role:'assistant',content:'Generated image',attachments:[{...meta,kind:'image',name:'image.png',dataBase64,localPath:'C:\\private'}]}]}}};store.apply(chat);const reference=store.get('chat','image-chat').payload.messages[0].attachments[0];assert.equal(reference.kind,'image');assert.equal(reference.id,meta.id);assert.equal('dataBase64' in reference,false);assert.equal('localPath' in reference,false);
 store.apply({deviceId:'phone',operationId:'delete-image',expectedRevision:1,type:'delete',entity:{kind:'asset',id:meta.id}});assert.equal(store.get('asset',meta.id).payload,null);assert.throws(()=>store.apply({...input,operationId:'restore-image',expectedRevision:2}),/deleted/);
 for(const table of ['sync_events','sync_operations'])assert.equal(JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()).includes(dataBase64),false);
}));
