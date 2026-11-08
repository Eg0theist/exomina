import path from 'node:path';
import { mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {sqlitePath} from './sqlite-path.mjs';

const ZERO = '0'.repeat(64), hash = value => createHash('sha256').update(value).digest('hex');
const canonicalScope = scope => {
  if (scope === undefined || scope === null) return 'local';
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some(key => !['organizationId', 'clientId'].includes(key)) || typeof scope.organizationId !== 'string' || !scope.organizationId || typeof scope.clientId !== 'string' || !scope.clientId) throw Error('Outcome archives need an exact host organization and client scope.');
  return JSON.stringify({ organizationId: scope.organizationId, clientId: scope.clientId });
};
const bucketFor = (chatId, scope) => { if (typeof chatId !== 'string' || !chatId || chatId.length > 200) throw Error('Invalid outcome archive chat.'); return hash(JSON.stringify([chatId, canonicalScope(scope)])); };
const lineHash = (bucket, sequence, previous, payload) => hash(JSON.stringify([bucket, sequence, previous, payload]));
const bounded = (value, fallback, maximum, label) => { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw Error(`Invalid archive ${label}.`); return value; };

/** Local durable receipts. Hash chains expose damaged history, not trusted owner identity. */
export class OutcomeJournal {
  constructor({ dir, maxBytes = 128 * 1024 * 1024, maxRecords = 100_000 }) { this.dir = path.resolve(dir); this.file = path.join(this.dir, 'outcomes.sqlite'); this.maxBytes = maxBytes; this.maxRecords = maxRecords; }
  async init() {
    await mkdir(this.dir, { recursive: true });
    const folder = await lstat(this.dir); if (!folder.isDirectory() || folder.isSymbolicLink()) throw Error('The outcome archive directory must not be a link.');
    try { const file = await lstat(this.file); if (!file.isFile() || file.isSymbolicLink()) throw Error('The outcome archive file must not be a link.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.db = new DatabaseSync(sqlitePath(this.file));
    this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS buckets(bucket TEXT PRIMARY KEY,chat TEXT NOT NULL,scope TEXT NOT NULL,anchor_seq INTEGER NOT NULL,anchor_hash TEXT NOT NULL,last_seq INTEGER NOT NULL,last_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(bucket TEXT NOT NULL,seq INTEGER NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(bucket,seq),UNIQUE(bucket,id));');
    return this;
  }
  ready() { if (!this.db) throw Error('The outcome archive is unavailable.'); }
  head(chatId, scope) { this.ready(); return this.db.prepare('SELECT * FROM buckets WHERE bucket=?').get(bucketFor(chatId, scope)); }
  transaction(work) { this.ready(); this.db.exec('BEGIN IMMEDIATE'); try { const result = work(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  append(chatId, scope, mark) {
    if (!mark || typeof mark !== 'object' || mark.checkedBy !== 'exomina' || typeof mark.id !== 'string' || mark.id.length > 80 || !['verified', 'contradicted', 'unavailable', 'refused'].includes(mark.status) || !Number.isFinite(Date.parse(mark.at))) throw Error('Only host-observed outcome receipts can enter the archive.');
    const payload = JSON.stringify(mark), bytes = Buffer.byteLength(payload, 'utf8'); if (bytes > 64 * 1024) throw Error('The outcome receipt exceeds the archive record limit.');
    const bucket = bucketFor(chatId, scope);
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM receipts WHERE bucket=? AND id=?').get(bucket, mark.id);
      if (previous) { if (previous.payload !== payload) throw Error('An existing archived receipt cannot be changed.'); return { sequence: previous.seq, hash: previous.hash }; }
      const total = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM receipts').get().bytes;
      if (total + bytes > this.maxBytes) throw Error('The outcome archive reached its storage limit. Export or prune records in archive controls before recording more outcomes.');
      let head = this.head(chatId, scope);
      if (!head) { this.db.prepare('INSERT INTO buckets VALUES(?,?,?,?,?,?,?)').run(bucket, chatId, canonicalScope(scope), 0, ZERO, 0, ZERO); head = this.head(chatId, scope); }
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM receipts WHERE bucket=?').get(bucket).count;
      if (count >= this.maxRecords) throw Error('This chat reached its outcome archive record limit. Export or prune records before continuing.');
      const tail = this.db.prepare('SELECT seq,hash FROM receipts WHERE bucket=? ORDER BY seq DESC LIMIT 1').get(bucket);
      if (head.last_seq !== (tail?.seq ?? head.anchor_seq) || head.last_hash !== (tail?.hash ?? head.anchor_hash)) throw Error('The outcome archive tail changed. Inspect its integrity before recording more receipts.');
      const sequence = head.last_seq + 1, digest = lineHash(bucket, sequence, head.last_hash, payload);
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)').run(bucket, sequence, mark.id, payload, head.last_hash, digest, bytes);
      this.db.prepare('UPDATE buckets SET last_seq=?,last_hash=? WHERE bucket=?').run(sequence, digest, bucket);
      return { sequence, hash: digest };
    });
  }
  get(chatId, scope, id) {
    this.ready(); const row = this.db.prepare('SELECT * FROM receipts WHERE bucket=? AND id=?').get(bucketFor(chatId, scope), id);
    if (!row) return null;
    if (lineHash(row.bucket, row.seq, row.previous_hash, row.payload) !== row.hash) throw Error('An archived outcome receipt failed its integrity check.');
    return JSON.parse(row.payload);
  }
  verify(chatId, scope) {
    const head = this.head(chatId, scope); if (!head) return { status: 'empty', checked: 0, anchorSequence: 0, headSequence: 0 };
    let previous = head.anchor_hash, sequence = head.anchor_seq, checked = 0;
    for (const row of this.db.prepare('SELECT * FROM receipts WHERE bucket=? ORDER BY seq').iterate(head.bucket)) {
      if (row.seq !== sequence + 1 || row.previous_hash !== previous || lineHash(head.bucket, row.seq, previous, row.payload) !== row.hash) return { status: 'damaged', checked, failedSequence: row.seq, anchorSequence: head.anchor_seq, headSequence: head.last_seq };
      sequence = row.seq; previous = row.hash; checked++;
    }
    return { status: sequence === head.last_seq && previous === head.last_hash ? 'consistent' : 'damaged', checked, anchorSequence: head.anchor_seq, headSequence: head.last_seq, headHash: head.last_hash, notice: 'Local hash-chain consistency only. The desktop owner can rewrite the database and checkpoints. Pruned history before the anchor is not present.' };
  }
  view(chatId, scope, { offset = 0, limit = 20, exportRows = false } = {}) {
    offset = bounded(offset, 0, 1_000_000, 'offset'); limit = bounded(limit, 20, 50, 'limit'); if (!limit) throw Error('Archive limit must be at least one.');
    const head = this.head(chatId, scope), integrity = this.verify(chatId, scope);
    if (integrity.status === 'damaged') throw Error('The outcome archive is damaged. Preserve it for inspection; its records are not being presented as verified evidence.');
    const total = head ? this.db.prepare('SELECT COUNT(*) AS count FROM receipts WHERE bucket=?').get(head.bucket).count : 0;
    const rows = head ? this.db.prepare('SELECT * FROM receipts WHERE bucket=? ORDER BY seq DESC LIMIT ? OFFSET ?').all(head.bucket, limit, offset) : [];
    return { marks: rows.map(row => JSON.parse(row.payload)), total, offset, nextOffset: offset + limit < total ? offset + limit : null, archive: { integrity, retainedFrom: head ? head.anchor_seq + 1 : null, ...(exportRows ? { format: 'exomina-outcome-chain-v1', chatId, scope: canonicalScope(scope), rows: rows.map(row => ({ sequence: row.seq, previousHash: row.previous_hash, hash: row.hash, mark: JSON.parse(row.payload) })) } : {}) } };
  }
  prune(chatId, scope, throughSequence) {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1) throw Error('Choose the exact final sequence to prune.');
    return this.transaction(() => {
      const head = this.head(chatId, scope); if (!head || this.verify(chatId, scope).status !== 'consistent') throw Error('A consistent archive is required before pruning.');
      const anchor = this.db.prepare('SELECT seq,hash FROM receipts WHERE bucket=? AND seq=?').get(head.bucket, throughSequence); if (!anchor) throw Error('The selected archive sequence is unavailable.');
      const removed = this.db.prepare('DELETE FROM receipts WHERE bucket=? AND seq<=?').run(head.bucket, throughSequence).changes;
      this.db.prepare('UPDATE buckets SET anchor_seq=?,anchor_hash=? WHERE bucket=?').run(anchor.seq, anchor.hash, head.bucket);
      return { removed, anchorSequence: anchor.seq, anchorHash: anchor.hash, notice: 'Older receipts were removed explicitly. The retained chain begins at this checkpoint.' };
    });
  }
  deleteChat(chatId, scope) { return this.transaction(() => { const bucket = bucketFor(chatId, scope), result = this.db.prepare('DELETE FROM receipts WHERE bucket=?').run(bucket); this.db.prepare('DELETE FROM buckets WHERE bucket=?').run(bucket); return { removed: result.changes }; }); }
  deleteConversation(chatId) { return this.transaction(() => { const result = this.db.prepare('DELETE FROM receipts WHERE bucket IN (SELECT bucket FROM buckets WHERE chat=?)').run(chatId); this.db.prepare('DELETE FROM buckets WHERE chat=?').run(chatId); return { removed: result.changes }; }); }
  close() { this.db?.close(); this.db = null; }
}
