// Claude Code renews its sign-in with a single-use refresh token and holds a
// lock file in its config directory while it saves the result. A forced kill
// inside that window spends the old token without saving the new one, which
// signs the user out. Only the lock's name and age are read, never its content.
import {readdir, stat} from 'node:fs/promises';
import path from 'node:path';

const LOCK = /^\.(?:design_)?oauth_refresh\.lock$/;
// The runtime keeps an active lock fresh; one this old was left by a dead process.
export const REFRESH_LOCK_STALE_MS = 60_000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exited = child => !child || child.exitCode != null || child.signalCode != null;

export async function claudeRefreshActive(home, now = Date.now()) {
  let names;
  try { names = await readdir(home); } catch { return false; }
  for (const name of names) {
    if (!LOCK.test(name)) continue;
    try { if (now - (await stat(path.join(home, name))).mtimeMs < REFRESH_LOCK_STALE_MS) return true; } catch {}
  }
  return false;
}

/** Waits while a renewal is in progress. Returns true if it had to wait. */
export async function waitForClaudeRefresh(home, { maxMs = 15_000, pollMs = 100, until = () => false } = {}) {
  const deadline = Date.now() + maxMs;
  let waited = false;
  while (Date.now() < deadline && !until() && await claudeRefreshActive(home)) { waited = true; await delay(pollMs); }
  return waited;
}

/** Ends a Claude process without cutting a sign-in renewal short.
 * graceMs > 0 first closes stdin and lets a finished process exit by itself. */
export async function settleClaudeProcess(child, { home, kill, graceMs = 0, maxRefreshMs = 15_000 }) {
  if (exited(child)) return;
  if (graceMs > 0) {
    try { child.stdin?.end(); } catch {}
    await new Promise(resolve => {
      const timer = setTimeout(resolve, graceMs);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (exited(child)) return;
  }
  await waitForClaudeRefresh(home, { maxMs: maxRefreshMs, until: () => exited(child) });
  if (!exited(child)) kill(child);
}
