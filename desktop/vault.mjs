import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const helper = fileURLToPath(new URL('./vault-windows.ps1', import.meta.url)).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const error = message => Object.assign(new Error(message), { code: 'VAULT_UNAVAILABLE' });

/** EFS covers app-owned files written by SQLite, Chromium, and official runtimes.
 * The owner account can transparently decrypt; this is not a malware boundary.
 * Callers must use fixed app directories, never a renderer-supplied arbitrary path.
 */
export class WindowsVault {
  constructor({ platform = process.platform, spawnImpl = spawn, scriptPath = helper } = {}) {
    Object.assign(this, { platform, spawnImpl, scriptPath });
    this.children = new Map(); this.closed = false;
  }
  async request(action, directory, extra = {}) {
    if (this.closed) throw error('The vault helper is closed.');
    if (this.platform !== 'win32') throw error('This vault requires Windows EFS on a local NTFS drive. No unencrypted fallback is enabled.');
    if (typeof directory !== 'string' || !path.win32.isAbsolute(directory) || !/^[A-Za-z]:\\/.test(directory) || /[\x00-\x1f*?]/.test(directory) || directory.slice(2).includes(':') || directory.length > 4096) throw error('Choose a dedicated local app data directory on an NTFS drive.');
    const root = path.win32.normalize(directory).replace(/\\+$/, '');
    if (root.split('\\').length < 3) throw error('The vault cannot protect a drive root or a top-level system directory.');
    const input = JSON.stringify({ action, path: root, ...extra });
    if (Buffer.byteLength(input) > 12000) throw error('The vault request exceeds its limit.');
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return new Promise((resolve, reject) => {
      let settled = false, output = '', bytes = 0;
      // Apply only to this fixed helper process. Do not change the user's or
      // machine's policy; PowerShell still honors higher-priority Group Policy.
      const child = this.spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const finish = (failure, value) => { if (settled) return; settled = true; clearTimeout(timer); this.children.delete(child); if (failure) reject(failure); else resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish(error('Private storage verification timed out. Keep the app closed and retry; protection has not been confirmed.')); }, ['protect', 'fingerprint', 'prepare'].includes(action) ? 10 * 60000 : 60000);
      this.children.set(child, () => { child.kill(); finish(error('The vault helper was closed before verification completed.')); });
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { child.kill(); finish(error('The vault helper returned an invalid response.')); } else output += chunk.toString('utf8'); });
      child.stderr.resume(); // Never surface native certificate, account, path, or password diagnostics.
      child.stdin.on('error', () => finish(error('The vault helper could not receive its request.')));
      child.on('error', () => finish(error('The Windows encryption helper could not start.')));
      child.on('close', code => {
        if (settled) return;
        let response; try { response = JSON.parse(output.trim()); } catch { finish(error('Windows encryption could not be verified. EFS may be unavailable on this edition or drive. No unencrypted fallback is enabled.')); return; }
        if (code !== 0 || response.ok !== true) { const failure = error(typeof response.error === 'string' ? response.error.slice(0, 1000) : 'Windows encryption failed. No unencrypted fallback is enabled.'); if (response.diagnostic && typeof response.diagnostic === 'object') failure.diagnostic = response.diagnostic; finish(failure); return; }
        finish(null, response);
      });
      child.stdin.end(input, 'utf8');
    });
  }
  preflight(directory) { return this.request('preflight', directory); }
  fingerprint(directory, { excludeNames = [] } = {}) {
    if (!Array.isArray(excludeNames) || excludeNames.length > 16 || excludeNames.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..')) throw error('Invalid copy verification exclusions.');
    return this.request('fingerprint', directory, { excludeNames });
  }
  verifyStartup(directory, { recoveryThumbprint } = {}) {
    if (typeof recoveryThumbprint !== 'string' || !/^[A-Fa-f0-9]{40}$/.test(recoveryThumbprint)) throw error('A verified recovery backup is required before opening private storage.');
    return this.request('startup', directory, { recoveryThumbprint: recoveryThumbprint.toUpperCase() });
  }
  close() {
    this.closed = true;
    for (const cancel of [...this.children.values()]) cancel();
  }
  verifyWorkspace(directory, { recoveryThumbprint, capabilityFile, full = false }) {
    if (typeof recoveryThumbprint !== 'string' || !/^[A-Fa-f0-9]{40}$/.test(recoveryThumbprint)) throw error('A verified recovery backup is required before opening the workspace.');
    if (typeof capabilityFile !== 'string' || !/^[A-Za-z]:\\/.test(capabilityFile) || /[\x00-\x1f*?]/.test(capabilityFile) || capabilityFile.slice(2).includes(':')) throw error('Invalid private sandbox capability metadata path.');
    return this.request(full ? 'workspaceVerify' : 'workspaceStartup', directory, { recoveryThumbprint: recoveryThumbprint.toUpperCase(), capabilityFile });
  }
  async verify(directory, { recoveryThumbprint } = {}) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.request('verify', directory, recoveryThumbprint ? { recoveryThumbprint } : {}); }
      catch (failure) {
        // A closing runtime can remove a temporary file after enumeration. Start
        // the complete read-only audit again; never skip an unverified entry.
        const transient = failure.diagnostic?.phase === 'validation' && ['ItemNotFoundException', 'FileNotFoundException', 'DirectoryNotFoundException'].includes(failure.diagnostic?.category);
        if (!transient || attempt >= 2) throw failure;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }
  // Only an empty, dedicated synthetic folder is accepted. This may provision the
  // current user's EFS certificate; it never rotates or removes certificates.
  prepareRecoveryProbe(directory) { return this.request('probe', directory); }
  protect(directory, { recoveryThumbprint } = {}) {
    if (typeof recoveryThumbprint !== 'string' || !/^[A-Fa-f0-9]{40}$/.test(recoveryThumbprint)) throw error('Save the password-protected EFS recovery certificate before protecting personal data.');
    return this.request('protect', directory, { recoveryThumbprint: recoveryThumbprint.toUpperCase() });
  }
  async exportRecovery(probeDirectory, password) {
    if (typeof password !== 'string' || password.length < 16 || password.length > 1024 || /[\x00-\x1f]/.test(password)) throw error('Use a recovery password of 16–1,024 characters without control characters.');
    const result = await this.request('recovery', probeDirectory, { password });
    if (!/^[A-F0-9]{40}$/.test(result.thumbprint || '') || result.algorithm !== 'AES256_SHA256' || typeof result.pfx !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.pfx)) throw error('The encrypted recovery certificate could not be verified.');
    const bytes = Buffer.from(result.pfx, 'base64');
    if (bytes.length < 100 || bytes.length > 1024 * 1024) throw error('The encrypted recovery certificate has an invalid size.');
    return { bytes, thumbprint: result.thumbprint, algorithm: result.algorithm };
  }
  async verifyRecoveryFile(probeDirectory, pfxPath, password) {
    if (typeof pfxPath !== 'string' || !/^[A-Za-z]:\\/.test(pfxPath) || /[\x00-\x1f*?]/.test(pfxPath) || pfxPath.slice(2).includes(':') || !/\.(?:pfx|p12)$/i.test(pfxPath)) throw error('Choose the Windows recovery backup PFX file.');
    if (typeof password !== 'string' || password.length < 1 || password.length > 1024 || /[\x00-\x1f]/.test(password)) throw error('Enter the password you used for this recovery backup.');
    const result = await this.request('verifyRecovery', probeDirectory, { pfxPath, password });
    if (result.verified !== true || !/^[A-F0-9]{40}$/.test(result.thumbprint || '')) throw error('This backup does not verify the current EFS recovery key.');
    return { verified: true, thumbprint: result.thumbprint };
  }
}
