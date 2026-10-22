import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { WindowsVault } from '../desktop/vault.mjs';
import { prepareWindowsQaOwner } from './native-qa-windows-owner.mjs';

const work = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.verification');

/** Prepare fresh synthetic data for source-app QA with real Windows encryption.
 * This test helper never opens or exports a personal PFX or profile. Its recovery
 * acknowledgement is deliberately simulated and proves nothing about recovery.
 * This file is excluded from the packaged application's files list.
 */
export async function createProtectedQaProfile(label) {
  assert.match(label, /^[a-z][a-z0-9-]{0,40}$/);
  // Elevated CI runners default new files to Administrators; the app refuses those.
  const windowsQaOwner = await prepareWindowsQaOwner();
  await mkdir(work, { recursive: true });
  const output = await mkdtemp(path.join(work, `qa-${label}-`));
  assert.equal(path.dirname(output), work);
  const profile = path.join(output, 'data'), setup = profile + '.setup';
  const probe = path.join(setup, 'recovery-probe');
  await mkdir(profile); await mkdir(probe, { recursive: true });
  await writeFile(path.join(profile, 'synthetic-profile.txt'), 'Synthetic Exomina QA profile. Contains no personal data.');
  const vault = new WindowsVault();
  const prepared = await vault.prepareRecoveryProbe(probe);
  assert.equal(prepared.encrypted, true); assert.equal(prepared.restrictedAccess, true);
  const protection = await vault.protect(profile, { recoveryThumbprint: prepared.thumbprint });
  assert.equal(protection.encrypted, true); assert.equal(protection.restrictedAccess, true);
  await writeFile(path.join(setup, 'recovery-backup.json'), JSON.stringify({
    thumbprint: prepared.thumbprint,
    savedAt: new Date().toISOString(),
    syntheticQaAcknowledgement: true,
    notice: 'TEST ONLY: no recovery PFX was exported or verified. Never use this acknowledgement for personal data.',
  }, null, 2), { mode: 0o600 });
  const report = {
    syntheticOnly: true, realWindowsEfs: true, initialProtection: protection, windowsQaOwner,
    recoveryAcknowledgement: 'Simulated for this fresh synthetic profile only. No PFX export, password handling, or personal recovery test.',
    personalProfileAccessed: false,
  };
  await writeFile(path.join(output, 'profile-preparation.json'), JSON.stringify(report, null, 2));
  return {
    profile, output, report,
    async verify() {
      const result = await vault.verify(profile, { recoveryThumbprint: prepared.thumbprint });
      assert.equal(result.encrypted, true); assert.equal(result.restrictedAccess, true);
      return result;
    },
  };
}
