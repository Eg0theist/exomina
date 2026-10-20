import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chatMetadata } from './chat-management.mjs';
import { requireProtectedSecretStorage, encryptProtectedSecret, decryptProtectedSecret } from './secret-storage.mjs';

const KINDS = new Set(['chat', 'note', 'archive', 'asset']);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const fileName = value => /^(?:[A-Za-z]:|[\\/])/.test(value || '') ? String(value).replace(/^[A-Za-z]:/, '').split(/[\\/]/).filter(Boolean).at(-1) || '' : String(value || '');
const text = value => typeof value === 'string' ? value : '';
function dates(target, source, keys = ['createdAt', 'updatedAt']) { for (const key of keys) if (timestamp(source[key])) target[key] = timestamp(source[key]); return target; }
function source(source) {
  const result = { title: text(source.title), sourceFile: fileName(source.sourceFile), sourceId: text(source.sourceId) };
  try { const url = new URL(source.sourceUrl); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) result.sourceUrl = url.href; } catch { /* No public source URL. */ }
  return dates(result, source, ['updatedAt']);
}

/** Only portable, user-owned records cross devices. Runtime sessions, settings,
 * workspaces, browser state and credentials are deliberately not part of this format. */
export function portablePayload(kind, value) {
  if (kind === 'chat') return dates({ title: text(value.title) || 'New chat', provider: text(value.provider), ...chatMetadata(value), messages: (value.messages || []).map(message => {
    const result = { id: message.id, role: message.role, content: text(message.content) };
    if (typeof message.provider === 'string') result.provider = message.provider;
    if (typeof message.error === 'string') result.error = message.error;
    if (Array.isArray(message.attachments)) result.attachments = message.attachments.map(item => ({ id: item.id, sha256: item.sha256, bytes: item.bytes, mimeType: item.mimeType, name: fileName(item.name), ...(['image','video','file'].includes(item.kind) ? { kind: item.kind } : {}) }));
    return dates(result, message);
  }) }, value);
  if (kind === 'note') {const note={text:text(value.text)};if((value.sourceChatIds===undefined)!==(value.chatOwned===undefined))throw Error('Memory source chats and ownership must be supplied together.');if(value.sourceChatIds!==undefined){if(!Array.isArray(value.sourceChatIds)||value.sourceChatIds.length>10000||value.sourceChatIds.some(id=>!validId(id)))throw Error('Invalid memory source chats.');note.sourceChatIds=[...new Set(value.sourceChatIds)].sort();}if(value.chatOwned!==undefined){if(typeof value.chatOwned!=='boolean')throw Error('Invalid memory ownership.');note.chatOwned=value.chatOwned;}return dates(note,{createdAt:value.createdAt||value.date},['createdAt']);}
  if (kind === 'asset') return { mimeType: value.mimeType, bytes: value.bytes, sha256: value.sha256, dataBase64: value.dataBase64 };
  if (kind === 'archive') {
    const result = { kind: value.kind, provider: text(value.provider) || 'unknown', title: text(value.title) || 'Imported context', text: text(value.text), ...source(value) };
    if (typeof value.rawJson === 'string') result.rawJson = value.rawJson;
    if (Array.isArray(value.sources)) result.sources = value.sources.map(source);
    return result;
  }
  throw new Error('Unknown sync record kind.');
}
const recordHash = value => value.hash || digest(value.payload);

export function cloudEndpoint(value, allowLocalHttp = false) {
  let url; try { url = new URL(value); } catch { throw new Error('Enter the complete HTTPS address of your private Exomina server.'); }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Use the server origin without credentials, a path, or a query.');
  if (url.protocol !== 'https:' && !(allowLocalHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Private sync requires HTTPS.');
  return url.origin;
}

export class CloudClient {
  constructor({ dataDir, encryption, store, memory, archive, assets = null, emit = () => {}, isBusy = () => false, fetchImpl = fetch,
    allowLocalHttp = false, autoSync = true, intervalMs = 15000 }) {
    Object.assign(this, { dataDir: path.resolve(dataDir), encryption, store, memory, archive, assets, emit, isBusy, fetchImpl, allowLocalHttp, autoSync, intervalMs });
    this.config = null; this.token = ''; this.db = null; this.controllers = new Set(); this.running = null; this.closed = false; this.lastError = ''; this.lastSync = null;
  }
  async init() {
    if (this.db) return;
    await mkdir(this.dataDir, { recursive: true });
    this.file = path.join(this.dataDir, 'cloud-connection.json');
    this.db = new DatabaseSync(path.join(this.dataDir, 'cloud-client.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,local_id TEXT NOT NULL,revision INTEGER NOT NULL,checksum TEXT,local_hash TEXT,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS entities_local ON entities(kind,local_id);
      CREATE TABLE IF NOT EXISTS archive_versions(local_id TEXT PRIMARY KEY,version TEXT NOT NULL,cloud_id TEXT NOT NULL,local_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,local_id TEXT NOT NULL,local_hash TEXT,PRIMARY KEY(kind,id));`);
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !validId(saved.deviceId) || typeof saved.encryptedToken !== 'string') throw new Error();
      saved.url = cloudEndpoint(saved.url, this.allowLocalHttp); this.config = saved;
      this.token = decryptProtectedSecret(this.encryption, Buffer.from(saved.encryptedToken, 'base64'));
      if (!/^exd_[A-Za-z0-9_-]{43}$/.test(this.token)) throw new Error();
    } catch (error) {
      if (error.code !== 'ENOENT') { this.config = null; this.token = ''; this.lastError = error.code?.startsWith('SECRET_STORAGE_') ? error.message : 'Private sync could not unlock its connection. Unlock secure credential storage or pair this device again on this user account.'; }
    }
    this.lastSync = this.meta('lastSync') || null;
    this.lastFingerprint = this.meta('lastFingerprint') || null;
    if (this.autoSync) {
      this.timer = setInterval(() => this.sync().catch(() => {}), this.intervalMs); this.timer.unref?.();
      queueMicrotask(() => { if (!this.closed) this.sync().catch(() => {}); });
    }
  }
  meta(key, value) { if (value !== undefined) this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, String(value)); return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  fingerprint() {
    // Detect edits made outside this client before claiming that data is synced.
    // Archive source hashes avoid repeatedly loading complete imported text.
    return digest({ chats: this.store.state.conversations.filter(chat => chat.private !== true).map(chat => [chat.id, portablePayload('chat', chat)]),
      notes: this.memory.db?.prepare('SELECT id,created_at,text,deleted,chat_owned,source_recorded FROM notes ORDER BY id').all() || [],
      noteSources:this.memory.db?.prepare('SELECT note_id,chat_id FROM note_chats ORDER BY note_id,chat_id').all()||[],
      archive: this.archive.syncIndex(), assets: this.assets?.index() || [] });
  }
  status() {
    const enabled = Boolean(this.config && this.token), paused = Boolean(this.isBusy());
    const pendingCount = this.db?.prepare('SELECT COUNT(*) AS n FROM pending').get().n || 0;
    const dirty = enabled && (!this.lastFingerprint || this.lastFingerprint !== this.fingerprint());
    const state = !enabled ? 'disabled' : this.running ? 'syncing' : paused || this.reconfiguring ? 'waiting' : this.lastError ? (/Could not reach/.test(this.lastError) ? 'offline' : 'error') : dirty || pendingCount ? 'waiting' : 'synced';
    return { enabled, state, pendingCount, lastSyncedAt: this.lastSync, configured: enabled, connected: enabled, url: this.config?.url || '', deviceId: this.config?.deviceId || '', deviceName: this.config?.name || '', syncing: Boolean(this.running), paused, lastSync: this.lastSync, error: this.lastError };
  }
  guard() { if (this.closed) throw new Error('Private sync is closed.'); if (this.isBusy()) throw Object.assign(new Error('Private sync is paused while a chat is running.'), { paused: true }); }
  async request(route, { body, pairing = false, url = this.config?.url } = {}) {
    if (this.closed) throw new Error('Private sync is closed.');
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const headers = { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) };
      if (!pairing) { if (!this.token) throw new Error(); headers.Authorization = `Bearer ${this.token}`; }
      const response = await this.fetchImpl(url + route, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 34 * 1024 * 1024) { controller.abort(); throw new Error(); } chunks.push(chunk); }
      let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error(); }
      if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'This device is no longer authorized. Pair it again from your private server.' : response.status === 409 ? 'This record changed or is currently active on another device. Try again after it finishes.' : `Private sync returned HTTP ${response.status}.`), { status: response.status, conflict: Boolean(value?.current) });
      return value;
    } catch (error) { if (error.status) throw error; throw new Error('Could not reach your private Exomina server. Check its address and connection.'); }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  changingConnection(operation) {
    if (this.closed) return Promise.reject(new Error('Private sync is closed.'));
    if (this.reconfiguring) return Promise.reject(new Error('Private sync connection settings are already changing.'));
    this.reconfiguring = Promise.resolve().then(operation).finally(() => { this.reconfiguring = null; });
    return this.reconfiguring;
  }
  configure(input) { return this.changingConnection(() => this.configureConnection(input)); }
  async configureConnection({ url, pairingCode, name = 'Exomina desktop' }) {
    if (!this.db) await this.init();
    if (this.running) await this.running.catch(() => {});
    const endpoint = cloudEndpoint(url, this.allowLocalHttp);
    if (typeof pairingCode !== 'string' || pairingCode.length > 200 || !pairingCode.trim()) throw new Error('Enter the pairing code from your signed-in private server.');
    requireProtectedSecretStorage(this.encryption);
    const result = await this.request('/api/pair', { pairing: true, url: endpoint, body: { code: pairingCode.trim(), name: text(name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) || 'Exomina desktop' } });
    if (this.closed) throw new Error('Private sync is closed.');
    if (!validId(result.deviceId) || !/^exd_[A-Za-z0-9_-]{43}$/.test(result.token)) throw new Error('The server returned invalid pairing information.');
    const config = { version: 1, url: endpoint, deviceId: result.deviceId, name: text(result.name) || name, encryptedToken: encryptProtectedSecret(this.encryption, result.token).toString('base64') };
    const temp = this.file + '.' + randomUUID() + '.tmp'; await writeFile(temp, JSON.stringify(config), { mode: 0o600 }); await rename(temp, this.file);
    if (this.meta('origin') !== endpoint) { this.db.exec('DELETE FROM entities; DELETE FROM pending; DELETE FROM archive_versions; DELETE FROM meta;'); this.meta('origin', endpoint); this.lastSync = null; this.lastFingerprint = null; }
    this.config = config; this.token = result.token; this.lastError = ''; this.emit({ type: 'state.changed' });
    if (this.autoSync) setTimeout(() => { if (!this.closed) this.sync().catch(() => {}); }, 0).unref?.();
    return this.status();
  }
  disconnect() { return this.changingConnection(() => this.disconnectConnection()); }
  async disconnectConnection() {
    for (const controller of this.controllers) controller.abort();
    if (this.running) await this.running.catch(() => {});
    this.config = null; this.token = ''; this.lastError = ''; await unlink(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    this.emit({ type: 'state.changed' }); return this.status();
  }
  records(kind) { return this.db.prepare('SELECT * FROM entities' + (kind ? ' WHERE kind=?' : '')).all(...(kind ? [kind] : [])); }
  record(kind, id) { return this.db.prepare('SELECT * FROM entities WHERE kind=? AND id=?').get(kind, id); }
  remember(entity, localId, localHash) {
    this.db.prepare('INSERT OR REPLACE INTO entities(kind,id,local_id,revision,checksum,local_hash,deleted) VALUES(?,?,?,?,?,?,?)').run(entity.kind, entity.id, localId || entity.id, entity.revision, entity.checksum || null, localHash || null, entity.deleted ? 1 : 0);
  }
  async localRecords() {
    // Avoid rewriting all local state on every poll. Only older transcripts need
    // a save here to receive durable message IDs before their first transfer.
    if (this.store.state.conversations.some(chat => chat.messages.some(message => !message.id))) await this.store.save();
    const values = new Map();
    // Immutable image bytes are read only for new transfers; polls compare the
    // bounded metadata index and retain assets independently of chat deletion.
    for (const entry of this.assets?.index() || []) {
      const saved = this.record('asset', entry.id);
      const value = { kind: 'asset', id: entry.id, localId: entry.id, hash: entry.sha256 };
      if (!saved || saved.deleted || saved.local_hash !== entry.sha256) value.payload = portablePayload('asset', await this.assets.export(entry.id));
      values.set('asset:' + entry.id, value);
    }
    // Private chats never leave this device through sync.
    for (const chat of this.store.state.conversations) if (chat.private !== true) values.set('chat:' + chat.id, { kind: 'chat', id: chat.id, localId: chat.id, payload: portablePayload('chat', chat) });
    for (const note of await this.memory.list('', 10000000)) values.set('note:' + note.id, { kind: 'note', id: note.id, localId: note.id, payload: portablePayload('note', note) });
    const known = this.records('archive'), byCloudId = new Map(known.map(row => [row.id, row]));
    const versions = new Map(this.db.prepare('SELECT * FROM archive_versions').all().map(row => [row.local_id, row]));
    for (const entry of this.archive.syncIndex()) {
      const cached = versions.get(entry.id), saved = cached && byCloudId.get(cached.cloud_id);
      if (cached?.version === entry.version && saved && !saved.deleted && saved.local_hash === cached.local_hash) {
        values.set('archive:' + saved.id, { kind: 'archive', id: saved.id, localId: entry.id, hash: cached.local_hash });
        continue;
      }
      const document = this.archive.exportDocument(entry.id); if (!document) continue;
      const payload = portablePayload('archive', document), hash = digest(payload);
      const linked = known.find(row => row.local_id === document.id && row.local_hash === hash && !row.deleted);
      const id = linked?.id || 'arc-' + hash;
      this.db.prepare('INSERT OR REPLACE INTO archive_versions VALUES(?,?,?,?)').run(entry.id, entry.version, id, hash);
      values.set('archive:' + id, { kind: 'archive', id, localId: document.id, payload, hash });
    }
    return values;
  }
  sync() {
    if (this.running) return this.running;
    if (!this.config || !this.token || this.closed || this.reconfiguring || this.isBusy()) return Promise.resolve(this.status());
    this.running = this.performSync().catch(error => {
      if (!error.paused && !this.closed) this.lastError = error.message;
      throw error;
    }).finally(() => { this.running = null; if (!this.closed) this.emit({ type: 'state.changed' }); }).then(() => this.status());
    return this.running;
  }
  async performSync() {
    this.guard();
    // Replay uncertain acknowledgements before comparing state. The exact request
    // and operation ID survive a crash or a dropped HTTP response.
    for (const pending of this.db.prepare("SELECT * FROM pending ORDER BY CASE WHEN kind='asset' THEN 0 ELSE 1 END").all()) { this.guard(); await this.sendPending(pending); }
    const local = await this.localRecords(), originalRecords = this.records(); this.guard();
    const localArchiveIds = new Set([...local.values()].filter(value => value.kind === 'archive').map(value => value.localId));
    for (const value of local.values()) {
      this.guard();
      const previous = this.record(value.kind, value.id), hash = recordHash(value);
      if (previous?.local_hash === hash && !previous.deleted) continue;
      if (previous?.deleted) { await this.applyRemote(await this.get(value.kind, value.id)); continue; }
      // A new provenance version is a new immutable archive record.
      if (value.kind === 'archive' && previous) value.id = 'arc-' + hash;
      await this.put(value, hash);
    }
    for (const previous of originalRecords) {
      this.guard();
      if (previous.deleted || !previous.local_hash || (previous.kind === 'archive' ? localArchiveIds.has(previous.local_id) : local.has(previous.kind + ':' + previous.id))) continue;
      await this.enqueue({ operationId: randomUUID(), expectedRevision: previous.revision, type: 'delete', entity: { kind: previous.kind, id: previous.id } }, previous.local_id, null);
    }
    // A pull always follows local change detection; an offline edit is never
    // overwritten merely because the remote event arrived first.
    let cursor = Number(this.meta('cursor') || 0);
    for (let page = 0; page < 10000; page++) {
      this.guard(); const changes = await this.request(`/api/sync/changes?after=${cursor}&limit=200`); this.guard();
      if (!Array.isArray(changes.events) || !Number.isSafeInteger(changes.cursor) || changes.cursor < cursor || (changes.hasMore && changes.cursor === cursor)) throw new Error('The server returned invalid sync pagination.');
      for (const event of changes.events) {
        this.guard(); this.validateMetadata(event);
        const previous = this.record(event.kind, event.id);
        if (!previous || event.revision > previous.revision) await this.applyRemote(await this.get(event.kind, event.id));
      }
      cursor = changes.cursor; this.meta('cursor', cursor);
      if (!changes.hasMore) break;
      if (page === 9999) throw new Error('Private sync needs another pass to finish the initial transfer.');
    }
    this.lastSync = new Date().toISOString(); this.meta('lastSync', this.lastSync); this.lastError = '';
    const finalLocal = await this.localRecords(); this.guard();
    const finalArchiveIds = new Set([...finalLocal.values()].filter(value => value.kind === 'archive').map(value => value.localId));
    const clean = [...finalLocal.values()].every(value => { const saved = this.record(value.kind, value.id); return saved && !saved.deleted && saved.local_hash === recordHash(value); }) &&
      this.records().every(saved => saved.deleted || (saved.kind === 'archive' ? finalArchiveIds.has(saved.local_id) : finalLocal.has(saved.kind + ':' + saved.id)));
    this.lastFingerprint = clean ? this.fingerprint() : null; this.meta('lastFingerprint', this.lastFingerprint || '');
    return this.status();
  }
  validateMetadata(value) { if (!value || !KINDS.has(value.kind) || !validId(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.deleted !== 'boolean') throw new Error('The server returned invalid sync metadata.'); }
  async get(kind, id) { const result = await this.request(`/api/sync/get?kind=${kind}&id=${encodeURIComponent(id)}`); this.validateMetadata(result); if (result.kind !== kind || result.id !== id) throw new Error('The server returned the wrong sync record.'); return result; }
  async put(value, hash = recordHash(value)) {
    const previous = this.record(value.kind, value.id);
    return this.enqueue({ operationId: randomUUID(), expectedRevision: previous?.revision || 0, type: 'put', entity: { kind: value.kind, id: value.id, payload: value.payload } }, value.localId, hash);
  }
  async enqueue(body, localId, localHash) {
    this.db.prepare('INSERT OR REPLACE INTO pending VALUES(?,?,?,?,?)').run(body.entity.kind, body.entity.id, JSON.stringify(body), localId, localHash);
    return this.sendPending(this.db.prepare('SELECT * FROM pending WHERE kind=? AND id=?').get(body.entity.kind, body.entity.id));
  }
  async sendPending(pending) {
    try {
      const result = await this.request('/api/sync/apply', { body: JSON.parse(pending.body) });
      this.validateMetadata(result.entity);
      if (result.entity.kind !== pending.kind || result.entity.id !== pending.id) throw new Error('The server acknowledged the wrong sync record.');
      this.db.exec('BEGIN IMMEDIATE');
      try { this.remember(result.entity, pending.local_id, pending.local_hash); this.db.prepare('DELETE FROM pending WHERE kind=? AND id=?').run(pending.kind, pending.id); this.db.exec('COMMIT'); }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) {
      if (error.status !== 409 || !error.conflict) throw error;
      const current = await this.get(pending.kind, pending.id);
      await this.applyRemote(current);
      this.db.prepare('DELETE FROM pending WHERE kind=? AND id=?').run(pending.kind, pending.id);
    }
  }
  async recover(kind, current) {
    const recoveryKey = `recovery:${kind}:${current.id}:${digest(portablePayload(kind, current))}`;
    const recoveryId = this.meta(recoveryKey) || randomUUID(); this.meta(recoveryKey, recoveryId);
    if (kind === 'chat') {
      let copy = this.store.state.conversations.find(item => item.id === recoveryId);
      if (!copy) { copy = { ...portablePayload('chat', current), id: recoveryId, title: (text(current.title) || 'New chat') + ' (recovered copy)', sessions: {}, updatedAt: new Date().toISOString() }; this.store.state.conversations.unshift(copy); await this.store.save(); }
      const payload = portablePayload(kind, copy);
      if (this.record(kind, copy.id)?.local_hash !== digest(payload)) await this.put({ kind, id: copy.id, localId: copy.id, payload });
    } else if (kind === 'note') {
      await this.memory.note(current.text, { id: recoveryId, createdAt: current.date || current.createdAt });
      const payload = portablePayload(kind, current);
      if (this.record(kind, recoveryId)?.local_hash !== digest(payload)) await this.put({ kind, id: recoveryId, localId: recoveryId, payload });
    }
  }
  async applyRemote(remote) {
    this.guard(); this.validateMetadata(remote);
    const previous = this.record(remote.kind, remote.id);
    if (previous && previous.revision > remote.revision) return;
    const kind = remote.kind;
    const existing = kind === 'chat' ? this.store.state.conversations.find(item => item.id === remote.id) : kind === 'note' ? (await this.memory.list('', 10000000)).find(item => item.id === remote.id) : null;
    this.guard();
    const localHash = existing ? digest(portablePayload(kind, existing)) : null;
    const payload = remote.deleted ? null : portablePayload(kind, remote.payload);
    const incomingHash = payload ? (kind === 'asset' ? payload.sha256 : digest(payload)) : null;
    // A conflicting server deletion wins the original ID. Unsynced local text is
    // preserved at a new ID rather than resurrecting that tombstone.
    if (existing && localHash !== previous?.local_hash && localHash !== incomingHash) await this.recover(kind, existing);
    this.guard();
    let localId = previous?.local_id || remote.id, baseline = incomingHash;
    if (kind === 'asset') {
      if (!this.assets) throw new Error('Image synchronization requires an image store on this device.');
      if (remote.deleted) await this.assets.remove(remote.id); else await this.assets.import({ ...payload, id: remote.id });
    } else if (kind === 'chat') {
      if (!remote.deleted && this.assets) {
        const available = new Set(this.assets.index().map(item => item.id));
        for (const attachment of payload.messages.flatMap(message => message.attachments || [])) if (['image','video'].includes(attachment.kind) && !available.has(attachment.id)) {
          const image = await this.get('asset', attachment.id); await this.applyRemote(image); available.add(attachment.id);
        }
      }
      const index = this.store.state.conversations.findIndex(item => item.id === remote.id);
      if (remote.deleted) { if (index >= 0) this.store.state.conversations.splice(index, 1); }
      else {
        // Keep this device's upload locations when a synced edit replaces a chat.
        // Local paths and upload handles never travel to another device.
        const local = new Map((index >= 0 ? this.store.state.conversations[index].messages : []).flatMap(message => message.attachments || []).filter(item => item.uploadId && item.relativePath).map(item => [item.id, item]));
        const chat = { ...payload, id: remote.id, sessions: {}, messages: payload.messages.map(message => ({ ...message, ...(message.attachments ? { attachments: message.attachments.map(item => local.has(item.id) ? { ...item, uploadId: local.get(item.id).uploadId, relativePath: local.get(item.id).relativePath } : item) } : {}) })) };
        if (index >= 0) this.store.state.conversations[index] = chat; else this.store.state.conversations.unshift(chat);
      }
      await this.store.save();
    } else if (kind === 'note') {
      await this.memory.applySyncedNote({ id: remote.id, deleted: remote.deleted, ...(payload || {}) });
    } else if (remote.deleted) {
      if (previous?.local_id && !this.records('archive').some(row => row.id !== remote.id && row.local_id === previous.local_id && !row.deleted)) await this.archive.removeDocument(previous.local_id);
    } else {
      let match = this.archive.findDocumentForSync(payload);
      if (!match) { await this.archive.importDocuments([payload]); match = this.archive.findDocumentForSync(payload); }
      const actual = match && this.archive.exportDocument(match);
      if (!actual) throw new Error('The imported archive record could not be located.');
      localId = actual.id; baseline = digest(portablePayload('archive', actual));
      const version = this.archive.syncIndex().find(row => row.id === localId)?.version;
      if (version) this.db.prepare('INSERT OR REPLACE INTO archive_versions VALUES(?,?,?,?)').run(localId, version, remote.id, baseline);
    }
    this.remember(remote, localId, remote.deleted ? null : baseline);
    this.emit({ type: 'state.changed' });
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await this.running?.catch(() => {}); await this.reconfiguring?.catch(() => {}); this.token = ''; this.db?.close(); this.db = null;
  }
}
