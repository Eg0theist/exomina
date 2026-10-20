import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { DeviceStore } from '../cloud/devices.mjs';

async function fixture(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-device-test-'));
  const stores = []; let now = Date.now();
  const open = async (scope = 'synthetic-owner-origin') => { const store = new DeviceStore({ dataDir: dir, scope, now: () => now }); stores.push(store); await store.init(); return store; };
  try { await run(await open(), open, milliseconds => { now += milliseconds; }); }
  finally { for (const store of stores) store.close(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('exomina-device-test-')); await rm(dir, { recursive: true, force: true }); }
}

test('device pairing is one-use, stores only credential hashes, persists, and revokes', async () => fixture(async (store, open, advance) => {
  const pending = store.createPairingCode();
  assert.match(pending.code, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
  assert.ok(pending.expiresAt > Date.now());
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM pairing_codes').all()).includes(pending.code.replaceAll('-', '')), false);
  const paired = store.pair({ code: pending.code.toLowerCase(), name: 'Synthetic desktop' });
  assert.match(paired.token, /^exd_[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM devices').all()).includes(paired.token), false);
  assert.throws(() => store.pair({ code: pending.code }), error => error.status === 401);
  const first = store.authenticate(paired.token); assert.equal(first.id, paired.deviceId); assert.equal(first.name, 'Synthetic desktop');
  assert.equal('token_hash' in first, false); assert.equal('token' in store.list()[0], false);
  advance(60001); assert.ok(store.authenticate(paired.token).lastSeenAt > first.lastSeenAt);
  store.close(); const reopened = await open(); assert.equal(reopened.authenticate(paired.token).id, paired.deviceId);
  reopened.revoke(paired.deviceId); assert.equal(reopened.authenticate(paired.token), null);
  assert.ok(reopened.list()[0].revokedAt); assert.deepEqual(reopened.revoke(paired.deviceId), { revoked: true, id: paired.deviceId });
}));

test('new codes invalidate old codes; expiration, scope, and malformed inputs fail closed', async () => fixture(async (store, open, advance) => {
  const old = store.createPairingCode(), current = store.createPairingCode();
  assert.throws(() => store.pair({ code: old.code }), error => error.status === 401);
  advance(300000); assert.throws(() => store.pair({ code: current.code }), error => error.status === 401);
  assert.throws(() => store.pair({ code: 'bad' }), error => error.status === 401);
  assert.throws(() => store.pair({ code: 'bad', name: '\u0000' }), error => error.status === 400);
  assert.equal(store.authenticate('exd_bad'), null);
  const paired = store.pair({ code: store.createPairingCode().code });
  const changedOwner = await open('different-owner-or-origin');
  assert.equal(changedOwner.authenticate(paired.token), null); assert.deepEqual(changedOwner.list(), []);
  assert.throws(() => changedOwner.revoke(paired.deviceId), error => error.status === 404);
}));

test('at most 32 active devices can be paired and revocation frees a slot', async () => fixture(async store => {
  for (let index = 0; index < 32; index++) store.pair({ code: store.createPairingCode().code, name: `Synthetic ${index}` });
  assert.throws(() => store.createPairingCode(), error => error.status === 409);
  store.revoke(store.list()[0].id); const next = store.pair({ code: store.createPairingCode().code });
  assert.ok(store.authenticate(next.token)); assert.equal(store.list().filter(item => item.revokedAt === null).length, 32);
}));
