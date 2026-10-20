import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status, statusCode: status });
const metadata = row => ({ id: row.id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at });
function normalizedCode(value) {
  if (typeof value !== 'string' || value.length > 40) return '';
  const normalized = value.replace(/[ -]/g, '').toUpperCase();
  return /^[A-F0-9]{16}$/.test(normalized) ? normalized : '';
}

export class DeviceStore {
  constructor({ dataDir, scope, now = () => Date.now() }) {
    if (typeof dataDir !== 'string' || !dataDir || typeof scope !== 'string' || !scope || scope.length > 256) throw fail(500, 'Private device storage needs its data directory and owner scope.');
    this.dataDir = path.resolve(dataDir); this.scope = scope; this.now = now; this.db = null;
  }
  async init() {
    if (this.db) return;
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dataDir, 'cloud-devices.sqlite');
    const db = new DatabaseSync(file);
    try {
      await chmod(file, 0o600);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS pairing_codes(code_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, scope TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER);
        CREATE INDEX IF NOT EXISTS devices_scope ON devices(scope,revoked_at);`);
      this.db = db;
      this.db.prepare('DELETE FROM pairing_codes WHERE expires_at<=? OR scope!=?').run(this.now(), this.scope);
    } catch (error) { db.close(); throw error; }
  }
  ready() { if (!this.db) throw fail(503, 'Private device storage is unavailable.'); }
  createPairingCode() {
    this.ready();
    if (this.db.prepare('SELECT COUNT(*) AS count FROM devices WHERE scope=? AND revoked_at IS NULL').get(this.scope).count >= 32) throw fail(409, 'Revoke an old device before pairing another.');
    const raw = randomBytes(8).toString('hex').toUpperCase();
    const expiresAt = this.now() + 5 * 60 * 1000;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM pairing_codes WHERE scope=? OR expires_at<=?').run(this.scope, this.now());
      this.db.prepare('INSERT INTO pairing_codes VALUES(?,?,?)').run(hash(raw), this.scope, expiresAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { code: raw.match(/.{4}/g).join('-'), expiresAt };
  }
  pair({ code, name = 'Exomina desktop' } = {}) {
    this.ready();
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw fail(400, 'Enter a device name of up to 80 characters.');
    const normalized = normalizedCode(code);
    if (!normalized) throw fail(401, 'The pairing code is invalid, expired, or already used.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.now();
      const pending = this.db.prepare('SELECT expires_at FROM pairing_codes WHERE code_hash=? AND scope=?').get(hash(normalized), this.scope);
      if (!pending || pending.expires_at <= now) throw fail(401, 'The pairing code is invalid, expired, or already used.');
      if (this.db.prepare('SELECT COUNT(*) AS count FROM devices WHERE scope=? AND revoked_at IS NULL').get(this.scope).count >= 32) throw fail(409, 'Revoke an old device before pairing another.');
      this.db.prepare('DELETE FROM pairing_codes WHERE code_hash=?').run(hash(normalized));
      const deviceId = randomUUID(), token = 'exd_' + randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,NULL)').run(deviceId, this.scope, hash(token), name.trim(), now, now);
      this.db.exec('COMMIT');
      return { deviceId, token, name: name.trim() };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  authenticate(token) {
    this.ready();
    if (typeof token !== 'string' || !/^exd_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash=? AND scope=? AND revoked_at IS NULL').get(hash(token), this.scope);
    if (!row) return null;
    const now = this.now();
    if (now - row.last_seen_at >= 60000) { this.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(now, row.id); row.last_seen_at = now; }
    return metadata(row);
  }
  list() { this.ready(); return this.db.prepare('SELECT id,name,created_at,last_seen_at,revoked_at FROM devices WHERE scope=? ORDER BY created_at DESC,id').all(this.scope).map(metadata); }
  revoke(id) {
    this.ready();
    if (typeof id !== 'string' || id.length > 128) throw fail(400, 'Choose a paired device.');
    const found = this.db.prepare('SELECT id FROM devices WHERE id=? AND scope=?').get(id, this.scope);
    if (!found) throw fail(404, 'This paired device was not found.');
    this.db.prepare('UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND scope=?').run(this.now(), id, this.scope);
    return { revoked: true, id };
  }
  close() { this.db?.close(); this.db = null; }
}
