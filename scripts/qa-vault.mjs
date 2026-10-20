import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WindowsVault } from '../desktop/vault.mjs';

const work = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = await mkdtemp(path.join(work, 'qa-vault-'));
const probe = path.join(fixture, 'probe'), data = path.join(fixture, 'data'), outside = path.join(fixture, 'outside');
await Promise.all([mkdir(probe), mkdir(path.join(data, 'nested'), { recursive: true }), mkdir(outside)]);
await writeFile(path.join(data, 'nested', 'synthetic.txt'), 'Synthetic Exomina privacy test.');
const vault = new WindowsVault(); const report = { syntheticOnly: true, preflight: null, probe: null, protected: null, futureWrites: null, reparseRejected: false };
try {
  report.preflight = await vault.preflight(data);
  if (process.argv.includes('--preflight-only')) { console.log(JSON.stringify(report, null, 2)); }
  else {
    const prepared = await vault.prepareRecoveryProbe(probe); report.probe = { encrypted: prepared.encrypted, restrictedAccess: prepared.restrictedAccess, files: prepared.files };
    // No real private certificate export occurs in this QA. Only synthetic data
    // is protected with the probe's certificate; personal setup requires a saved PFX.
    report.protected = await vault.protect(data, { recoveryThumbprint: prepared.thumbprint });
    await writeFile(path.join(data, 'future.txt'), 'Synthetic future write.');
    const db = new DatabaseSync(path.join(data, 'synthetic.sqlite'));
    try { db.exec("PRAGMA journal_mode=WAL; CREATE TABLE qa(text TEXT); INSERT INTO qa VALUES('SYNTHETIC_SQLITE_ENCRYPTION');"); report.futureWrites = await vault.verify(data); }
    finally { db.close(); }
    assert.equal(await readFile(path.join(data, 'nested', 'synthetic.txt'), 'utf8'), 'Synthetic Exomina privacy test.');
    await symlink(outside, path.join(data, 'link'), 'junction');
    try { await vault.preflight(data); } catch (error) { report.reparseRejected = /link|junction|placeholder/.test(error.message); }
    assert.equal(report.reparseRejected, true); await unlink(path.join(data, 'link'));
    if (process.argv.includes('--keep')) { report.fixture = fixture; report.dataDir = data; report.probeDir = probe; report.thumbprint = prepared.thumbprint; await writeFile(path.join(fixture, 'result.json'), JSON.stringify(report, null, 2)); }
    console.log(JSON.stringify(report, null, 2));
  }
} finally {
  assert.equal(path.dirname(path.resolve(fixture)), work); assert.ok(path.basename(fixture).startsWith('qa-vault-'));
  if (!process.argv.includes('--keep')) await rm(fixture, { recursive: true, force: true });
}
