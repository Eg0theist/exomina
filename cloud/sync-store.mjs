import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateImageAsset, MAX_ASSET_BYTES } from '../desktop/assets.mjs';

const KINDS = new Set(['chat', 'note', 'archive', 'asset']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const LIMITS = { chat: 16 * 1024 * 1024, note: 64 * 1024, archive: 32 * 1024 * 1024, asset: 28 * 1024 * 1024 };
const DIGEST = /^[a-f0-9]{64}$/;

export class SyncError extends Error {
  constructor(message, code = 400, current = null) { super(message); this.name = 'SyncError'; this.code = code; this.current = current; }
}
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
function identifier(value, label) { if (typeof value !== 'string' || !ID.test(value)) throw new SyncError(`Invalid ${label}.`); return value; }
function kindName(value) { if (!KINDS.has(value)) throw new SyncError('Entity kind must be chat, note, archive, or asset.'); return value; }
function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new SyncError(`Invalid ${label}.`); return value; }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new SyncError(`${label} must be a JSON object.`); return value; }
function text(value, label, maxBytes, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new SyncError(`Invalid or oversized ${label}.`);
  return value;
}
function date(value, label) {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) || !Number.isFinite(Date.parse(value))) throw new SyncError(`Invalid ${label}.`);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new SyncError(`Invalid ${label}.`);
  return new Date(value).toISOString();
}
function optional(target, source, key, validate) { if (Object.hasOwn(source, key) && source[key] !== undefined) target[key] = validate(source[key], key); }
function timestampFields(target, source, keys = ['createdAt', 'updatedAt']) { for (const key of keys) optional(target, source, key, date); }

/** Stable JSON, with no toJSON hooks or prototype-sensitive assignments. */
function canonical(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 150000 || depth > 48) throw new SyncError('Payload is too deeply nested or has too many values.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(entry => visit(entry, depth + 1)).join(',') + ']';
    object(item, 'Payload value');
    return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + visit(item[key], depth + 1)).join(',') + '}';
  };
  return visit(value, 0);
}
function sourceFile(value) {
  const valid = text(value, 'sourceFile', 4096);
  // Preserve archive-relative provenance, not a device's absolute local path.
  return /^(?:[A-Za-z]:|[\\/])/.test(valid) ? valid.replace(/^[A-Za-z]:/, '').split(/[\\/]/).filter(Boolean).at(-1) || '' : valid;
}
function sourceUrl(value) {
  const valid = text(value, 'sourceUrl', 8192);
  if (!valid) return '';
  let url; try { url = new URL(valid); } catch { throw new SyncError('Invalid sourceUrl.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new SyncError('Invalid sourceUrl.');
  return url.href;
}
function provenance(value) {
  object(value, 'Archive source'); const result = {};
  optional(result, value, 'title', item => text(item, 'source title', 4000));
  optional(result, value, 'sourceFile', sourceFile);
  optional(result, value, 'sourceUrl', sourceUrl);
  optional(result, value, 'sourceId', item => text(item, 'sourceId', 4096));
  timestampFields(result, value, ['updatedAt', 'importedAt']);
  return result;
}
function sanitize(kind, payload, id) {
  object(payload, 'Entity payload');
  if (kind === 'asset') {
    try { const checked = validateImageAsset(payload.dataBase64, { ...payload, id }); return { mimeType: checked.metadata.mimeType, bytes: checked.metadata.bytes, sha256: checked.metadata.sha256, dataBase64: checked.buffer.toString('base64') }; }
    catch (error) { throw new SyncError(error.message); }
  }
  if (kind === 'note') {
    const note = text(payload.text, 'note text', 280);
    if (!note.trim() || /[\r\n]/.test(note)) throw new SyncError('Notes must be nonempty, single-line text of at most 280 UTF-8 bytes.');
    const result = { text: note };
    if((payload.sourceChatIds===undefined)!==(payload.chatOwned===undefined))throw new SyncError('Memory source chats and ownership must be supplied together.');
    optional(result,payload,'sourceChatIds',value=>{if(!Array.isArray(value)||value.length>10000)throw new SyncError('Invalid memory source chats.');return [...new Set(value.map(id=>identifier(id,'memory source chat')))].sort();});
    optional(result,payload,'chatOwned',value=>{if(typeof value!=='boolean')throw new SyncError('Invalid memory ownership.');return value;});
    timestampFields(result, payload, ['createdAt']); return result;
  }
  if (kind === 'chat') {
    if (!Array.isArray(payload.messages) || payload.messages.length > 10000) throw new SyncError('A chat requires at most 10,000 messages.');
    const ids = new Set();
    const messages = payload.messages.map(message => {
      object(message, 'Chat message'); const id = identifier(message.id, 'message ID');
      if (ids.has(id)) throw new SyncError('Every message in a chat must have a distinct stable ID.'); ids.add(id);
      if (!['user', 'assistant', 'system', 'tool'].includes(message.role)) throw new SyncError('Invalid message role.');
      const result = { id, role: message.role, content: text(message.content, 'message content', 8 * 1024 * 1024) };
      optional(result, message, 'provider', item => text(item, 'message provider', 100));
      optional(result, message, 'error', item => text(item, 'message error', 8000));
      timestampFields(result, message);
      if (message.attachments !== undefined) {
        if (!Array.isArray(message.attachments) || message.attachments.length > 20) throw new SyncError('A message supports at most 20 attachment references.');
        result.attachments = message.attachments.map(attachment => {
          object(attachment, 'Attachment reference');
          if (typeof attachment.sha256 !== 'string' || !DIGEST.test(attachment.sha256)) throw new SyncError('Attachment references require a SHA-256 checksum.');
          const result = { id: identifier(attachment.id, 'attachment ID'), sha256: attachment.sha256, bytes: integer(attachment.bytes, 'attachment size', 0, 32 * 1024 * 1024), name: sourceFile(attachment.name || ''), mimeType: text(attachment.mimeType, 'attachment MIME type', 150) };
          if (attachment.kind !== undefined) { if (!['image','video','file'].includes(attachment.kind) || attachment.id !== attachment.sha256 || (attachment.kind === 'image' && !['image/png','image/jpeg','image/webp'].includes(result.mimeType)) || (attachment.kind === 'video' && result.mimeType !== 'video/mp4') || (attachment.kind === 'file' && result.mimeType !== 'application/octet-stream') || result.bytes < 1 || result.bytes > MAX_ASSET_BYTES) throw new SyncError('Invalid attachment reference.'); result.kind = attachment.kind; }
          return result;
        });
      }
      return result;
    });
    const result = { title: text(payload.title, 'chat title', 4000, 'New chat'), provider: text(payload.provider, 'chat provider', 100, ''), messages };
    for (const key of ['pinned', 'archived']) optional(result, payload, key, value => { if (typeof value !== 'boolean') throw new SyncError(`Invalid chat ${key} state.`); return value; });
    optional(result, payload, 'titleSource', value => { if (!['pending', 'model', 'auto', 'manual'].includes(value)) throw new SyncError('Invalid chat title source.'); return value; });
    timestampFields(result, payload); return result;
  }
  if (!['memory', 'conversation', 'instructions', 'project', 'artifact'].includes(payload.kind)) throw new SyncError('Invalid archive document kind.');
  const result = {
    kind: payload.kind, provider: text(payload.provider, 'archive provider', 100, 'unknown'),
    title: text(payload.title, 'archive title', 4000, 'Imported context'), text: text(payload.text, 'archive text', LIMITS.archive),
  };
  optional(result, payload, 'sourceFile', sourceFile); optional(result, payload, 'sourceUrl', sourceUrl);
  optional(result, payload, 'sourceId', item => text(item, 'sourceId', 4096));
  optional(result, payload, 'rawJson', item => text(item, 'raw JSON', LIMITS.archive));
  timestampFields(result, payload, ['createdAt', 'updatedAt', 'importedAt']);
  if (payload.sources !== undefined) {
    if (!Array.isArray(payload.sources) || payload.sources.length > 1000) throw new SyncError('An archive document supports at most 1,000 source references.');
    result.sources = payload.sources.map(provenance);
  }
  return result;
}
function metadata(row) {
  if (!row) return null;
  return { kind: row.kind, id: row.id, revision: row.revision, seq: row.seq, deleted: Boolean(row.deleted), checksum: row.checksum, bytes: row.bytes, updatedAt: row.updated_at };
}
const pageLimit = value => integer(value ?? 100, 'page limit', 1, 200);

/** Single-owner persistence only. Authentication and device authorization belong to the HTTP service. */
export class SyncStore {
  constructor({ dataDir }) {
    if (typeof dataDir !== 'string' || !dataDir) throw new SyncError('A sync data directory is required.');
    this.dataDir = path.resolve(dataDir); this.file = path.join(this.dataDir, 'cloud-sync.sqlite'); this.db = null;
  }
  async init() {
    if (this.db) return this;
    await mkdir(this.dataDir, { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS sync_schema(version INTEGER NOT NULL);
        INSERT INTO sync_schema(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sync_schema);
        CREATE TABLE IF NOT EXISTS sync_entities(
          kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, seq INTEGER NOT NULL,
          deleted INTEGER NOT NULL, checksum TEXT, bytes INTEGER NOT NULL, payload TEXT, updated_at TEXT NOT NULL,
          PRIMARY KEY(kind,id)
        );
        CREATE INDEX IF NOT EXISTS sync_entities_seq ON sync_entities(seq);
        CREATE TABLE IF NOT EXISTS sync_events(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
          deleted INTEGER NOT NULL, checksum TEXT, bytes INTEGER NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_operations(
          device_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
          result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(device_id,operation_id)
        );`);
      const versions = db.prepare('SELECT version FROM sync_schema').all();
      if (versions.length !== 1 || versions[0].version !== 1) throw new SyncError('Unsupported sync database version. Preserve this database before upgrading.', 500);
      this.db = db; return this;
    } catch (error) { db.close(); throw error; }
  }
  ready() { if (!this.db) throw new SyncError('The sync store is not open.', 503); }
  close() { this.db?.close(); this.db = null; }
  current(kind, id) { return this.db.prepare('SELECT * FROM sync_entities WHERE kind=? AND id=?').get(kind, id); }
  maxSeq() { this.ready(); return this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM sync_events').get().seq; }

  /** Mutations acknowledge metadata only; historical payloads never enter the event/idempotency tables. */
  apply(input) {
    this.ready(); object(input, 'Sync command'); object(input.entity, 'Entity');
    const deviceId = identifier(input.deviceId, 'device ID'), operationId = identifier(input.operationId, 'operation ID');
    const kind = kindName(input.entity.kind), id = identifier(input.entity.id, 'entity ID');
    if (!['put', 'delete'].includes(input.type)) throw new SyncError('Command type must be put or delete.');
    const expected = input.expectedRevision === undefined ? null : integer(input.expectedRevision, 'expected revision');
    if (input.type === 'delete' && input.entity.payload !== undefined) throw new SyncError('Delete commands must not include entity payloads.');
    let normalized = null, raw = null;
    if (input.type === 'put') {
      raw = canonical(input.entity.payload);
      if (Buffer.byteLength(raw, 'utf8') > LIMITS[kind]) throw new SyncError(`The ${kind} payload exceeds its ${LIMITS[kind] / (1024 * 1024)} MiB limit.`, 413);
      normalized = sanitize(kind, input.entity.payload, id);
    }
    const requestHash = hash(canonical({ type: input.type, kind, id, expectedRevision: expected, payload: raw }));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT request_hash,result_json FROM sync_operations WHERE device_id=? AND operation_id=?').get(deviceId, operationId);
      if (previous) {
        if (previous.request_hash !== requestHash) throw new SyncError('This operation ID was already used for a different command.', 409, metadata(this.current(kind, id)));
        const result = { ...JSON.parse(previous.result_json), duplicate: true }; this.db.exec('COMMIT'); return result;
      }
      const existing = this.current(kind, id), now = new Date().toISOString();
      if (existing?.deleted && input.type === 'put') throw new SyncError('This entity was deleted. Recovery requires a new entity ID.', 409, metadata(existing));
      if (!existing && input.type === 'delete') throw new SyncError('This entity does not exist.', 404);
      if (!existing && expected !== null && expected !== 0) throw new SyncError('The expected revision does not exist.', 409);
      if (kind === 'note' && normalized && !normalized.createdAt) normalized.createdAt = existing?.payload ? JSON.parse(existing.payload).createdAt : now;
      const payload = normalized ? canonical(normalized) : null;
      const checksum = payload === null ? null : hash(payload);
      const bytes = payload === null ? 0 : Buffer.byteLength(payload, 'utf8');
      if (bytes > LIMITS[kind]) throw new SyncError('The normalized entity exceeds its size limit.', 413);
      const archiveDuplicate = ['archive','asset'].includes(kind) && existing && !existing.deleted && input.type === 'put' && existing.checksum === checksum;
      if (existing && !archiveDuplicate && expected !== existing.revision) throw new SyncError('This entity changed. Refresh it before applying your edit.', 409, metadata(existing));
      if (['archive','asset'].includes(kind) && existing && input.type === 'put' && !archiveDuplicate) throw new SyncError('Archive documents and image assets are immutable. Import changed content with a new entity ID.', 409, metadata(existing));
      let result;
      if (archiveDuplicate || existing?.deleted) result = { seq: existing.seq, revision: existing.revision, entity: metadata(existing), duplicate: true };
      else {
        const revision = (existing?.revision || 0) + 1, deleted = input.type === 'delete' ? 1 : 0;
        const inserted = this.db.prepare('INSERT INTO sync_events(kind,id,revision,deleted,checksum,bytes,updated_at) VALUES(?,?,?,?,?,?,?)').run(kind, id, revision, deleted, checksum, bytes, now);
        const seq = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(seq)) throw new SyncError('The event sequence exceeded its supported range.', 500);
        this.db.prepare(`INSERT INTO sync_entities(kind,id,revision,seq,deleted,checksum,bytes,payload,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,seq=excluded.seq,deleted=excluded.deleted,checksum=excluded.checksum,bytes=excluded.bytes,payload=excluded.payload,updated_at=excluded.updated_at`).run(kind, id, revision, seq, deleted, checksum, bytes, payload, now);
        result = { seq, revision, entity: metadata(this.current(kind, id)), duplicate: false };
      }
      this.db.prepare('INSERT INTO sync_operations(device_id,operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?,?)').run(deviceId, operationId, requestHash, JSON.stringify(result), now);
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(kind, id) {
    this.ready(); const row = this.current(kindName(kind), identifier(id, 'entity ID'));
    return row ? { ...metadata(row), payload: row.deleted ? null : JSON.parse(row.payload) } : null;
  }
  changes(after = 0, limit = 100) {
    this.ready(); integer(after, 'event cursor'); const cap = pageLimit(limit);
    if (after > this.maxSeq()) throw new SyncError('The event cursor is ahead of this store. Start a new snapshot.', 409);
    const rows = this.db.prepare('SELECT * FROM sync_events WHERE seq>? ORDER BY seq LIMIT ?').all(after, cap + 1);
    const events = rows.slice(0, cap).map(metadata);
    return { events, cursor: events.at(-1)?.seq ?? after, hasMore: rows.length > cap };
  }
  list(kind, limit = 100, afterId = '') {
    this.ready(); kindName(kind); const cap = pageLimit(limit);
    if (afterId !== '') identifier(afterId, 'list cursor');
    const rows = this.db.prepare('SELECT kind,id,revision,seq,deleted,checksum,bytes,updated_at FROM sync_entities WHERE kind=? AND id>? ORDER BY id LIMIT ?').all(kind, afterId, cap + 1);
    const entities = rows.slice(0, cap).map(metadata);
    return { entities, cursor: rows.length > cap ? entities.at(-1).id : null, hasMore: rows.length > cap };
  }
  /** A bounded baseline, followed by changes(snapshotSeq), converges without holding a long SQLite transaction. */
  snapshot(limit = 100, cursor = null) {
    this.ready(); const cap = pageLimit(limit); let cutoff = this.maxSeq(), afterKind = '', afterId = '';
    if (cursor !== null) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (parsed.version !== 1) throw new Error();
        cutoff = integer(parsed.seq, 'snapshot sequence'); afterKind = kindName(parsed.kind); afterId = identifier(parsed.id, 'snapshot entity cursor');
      } catch { throw new SyncError('Invalid snapshot cursor.'); }
      if (cutoff > this.maxSeq()) throw new SyncError('The snapshot cursor is ahead of this store. Start a new snapshot.', 409);
    }
    const rows = this.db.prepare(`SELECT kind,id,revision,seq,deleted,checksum,bytes,updated_at FROM sync_entities
      WHERE seq<=? AND (kind>? OR (kind=? AND id>?)) ORDER BY kind,id LIMIT ?`).all(cutoff, afterKind, afterKind, afterId, cap + 1);
    const entities = rows.slice(0, cap).map(metadata), last = entities.at(-1), hasMore = rows.length > cap;
    return { entities, snapshotSeq: cutoff, cursor: hasMore ? Buffer.from(JSON.stringify({ version: 1, seq: cutoff, kind: last.kind, id: last.id })).toString('base64url') : null, hasMore };
  }
}
