import { mkdir, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export const ANTIGRAVITY_SETTINGS = Object.freeze({
  useG1Credits: false,
  permissions: {
    allow: ['mcp(exomina/*)'],
    deny: ['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', 'unsandboxed(*)'],
  },
});

const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const prepared = new Map(), turns = new Map(), blockedProfiles = new Map();
async function verifyDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !equalPath(path.resolve(directory), await realpath(directory))) throw new Error('Antigravity configuration must use an ordinary Exomina-owned directory.');
}
async function ownedDirectory(directory) { await mkdir(directory, { recursive: true, mode: 0o700 }); await verifyDirectory(directory); }
async function configFile(file, value) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Antigravity configuration cannot use a redirected file.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
}

/** HOME is a fresh protected Exomina profile, authenticated only by Google's
 * own CLI flow. No existing Google files or credentials are read or copied. */
export async function prepareAntigravityProfile(dataDir) {
  const home = path.resolve(dataDir, 'antigravity-home');
  const key = process.platform === 'win32' ? home.toLowerCase() : home;
  if (!prepared.has(key)) {
    const ready = (async () => {
      for (const directory of [home, path.join(home, '.gemini', 'antigravity-cli'), path.join(home, '.gemini', 'config')]) await ownedDirectory(directory);
      await configFile(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), ANTIGRAVITY_SETTINGS);
      await configFile(path.join(home, '.gemini', 'config', 'mcp_config.json'), { mcpServers: {} });
      return home;
    })().catch(error => { prepared.delete(key); throw error; });
    prepared.set(key, ready);
  }
  return prepared.get(key);
}

/** Google's CLI has no sign-out command. Its sign-in lives only in this Exomina-owned profile, so removing the profile signs out. */
export async function resetAntigravityProfile(dataDir) {
  const home = path.resolve(dataDir, 'antigravity-home'), key = process.platform === 'win32' ? home.toLowerCase() : home;
  if (turns.has(key)) throw new Error('Stop the Gemini reply or close its sign-in window before signing out.');
  try { await verifyDirectory(home); } catch (error) { if (error.code === 'ENOENT') { prepared.delete(key); return false; } throw error; }
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  prepared.delete(key);
  return true;
}

export function antigravityEnvironment(base, home, { manualSignIn = false } = {}) {
  const isolated = { ...base, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
  };
  // Google documents a manual URL/code flow for remote terminals. Select that
  // native flow only in the explicit sign-in window, where the user reads and
  // pastes the code themselves. Ordinary metadata and replies stay unchanged.
  // Do not inherit an unrelated terminal's SSH state into this desktop host.
  for (const key of Object.keys(isolated)) if (['SSH_CLIENT', 'SSH_TTY', 'SSH_CONNECTION'].includes(key.toUpperCase())) delete isolated[key];
  if (manualSignIn) isolated.SSH_TTY = 'exomina-manual-oauth';
  return isolated;
}

/** The CLI management command verifies global MCP discovery. A shared profile
 * therefore runs one turn at a time, including tool-free helpers. Locks span
 * adapter/manager instances; a queued turn can be stopped before it launches. */
export async function acquireAntigravityTurn(dataDir, state, { idleOnly = false } = {}) {
  const home = await prepareAntigravityProfile(dataDir), key = process.platform === 'win32' ? home.toLowerCase() : home;
  const previous = turns.get(key);
  if (blockedProfiles.has(key)) throw Object.assign(new Error('Antigravity could not confirm that its previous process stopped. Restart Exomina before using this connection again.'), { handoffUnsafe: true });
  if (idleOnly && previous) throw new Error('Stop the Antigravity reply or close its sign-in window before opening another sign-in.');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const entry = { promise: (previous?.promise || Promise.resolve()).then(() => gate), blocked: false };
  turns.set(key, entry);
  entry.promise.then(() => { if (turns.get(key) === entry) turns.delete(key); });
  const unlock = () => { if (blockedProfiles.get(key) === entry) blockedProfiles.delete(key); release(); };
  let cancelWait;
  const cancelled = new Promise((_, reject) => { cancelWait = () => reject(new Error('Stopped.')); });
  state.adapterCancel = cancelWait;
  try { if (state.cancelled) throw new Error('Stopped.'); await Promise.race([previous?.promise || Promise.resolve(), cancelled]); if (state.cancelled) throw new Error('Stopped.'); }
  catch (error) { unlock(); state.adapterCancel = null; throw error; }
  const settingsFile = path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), config = path.join(home, '.gemini', 'config', 'mcp_config.json');
  let closed = false;
  return { path: home,
    async configure(value) {
      await verifyDirectory(home); await verifyDirectory(path.dirname(settingsFile)); await verifyDirectory(path.dirname(config));
      await configFile(settingsFile, ANTIGRAVITY_SETTINGS);
      await configFile(config, value || { mcpServers: {} });
    },
    block() { blockedProfiles.set(key, entry); },
    async close() { if (closed) return; closed = true; try { await verifyDirectory(home); await verifyDirectory(path.dirname(config)); await configFile(config, { mcpServers: {} }); } finally { unlock(); } },
  };
}
