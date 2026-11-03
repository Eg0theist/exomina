import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, readdir, rename, rm } from 'node:fs/promises';

const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;

export const chatAnalysisFolder = (dataDir, kind, id) => path.join(dataDir, kind, createHash('sha256').update(String(id)).digest('hex'));

// Detach first so a crash or a partial Windows deletion cannot reopen a damaged project.
// onDetached persists the owner's metadata before any file is removed.
export async function removeChatAnalysisData(dataDir, kind, id, { folder, onDetached = async () => {}, requireExisting = false, remove = rm } = {}) {
  if (!['app-analysis', 'ghidra-workspaces'].includes(kind) || typeof id !== 'string' || !id) throw Error('Choose a chat before clearing saved analysis.');
  const hash = createHash('sha256').update(id).digest('hex'), logicalStorage = path.resolve(dataDir, kind);
  if (canonical(folder || chatAnalysisFolder(dataDir, kind, id)) !== canonical(path.join(logicalStorage, hash))) throw Error('Analysis cleanup escaped its chat storage folder.');
  let root, storage;
  try {
    root = await realpath(dataDir); storage = path.join(root, kind);
    const info = await lstat(path.join(dataDir, kind));
    if (!info.isDirectory() || info.isSymbolicLink() || canonical(await realpath(path.join(dataDir, kind))) !== canonical(storage)) throw Error('Saved analysis cleanup cannot follow storage links or path aliases.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; if (requireExisting) throw Error('The saved analysis folder is missing; its metadata was kept.'); return { deleted: false, pending: [] }; }
  const target = path.join(storage, hash), prefix = `.${hash}.deleting-`;
  const tombstones = (await readdir(storage)).filter(name => name.startsWith(prefix) && /^[a-f0-9-]{36}$/i.test(name.slice(prefix.length))).map(name => path.join(storage, name));
  const active = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!active && !tombstones.length) {
    if (requireExisting) throw Error('The saved analysis folder is missing; its metadata was kept.');
    await onDetached({ pending: [] }); return { deleted: false, pending: [] };
  }
  async function inspect(directory, base = directory) {
    const info = await lstat(directory), actual = canonical(await realpath(directory));
    if (!info.isDirectory() || info.isSymbolicLink() || actual !== canonical(directory) || path.dirname(base) !== storage) throw Error('Saved analysis cleanup cannot follow links or path aliases.');
    for (const name of await readdir(directory)) {
      if (kind === 'ghidra-workspaces' && /^Exomina\.lock~?$/i.test(name)) throw Error('A saved Ghidra project is open or has an uncleared lock. Close it in Ghidra before deleting.');
      const file = path.join(directory, name), entry = await lstat(file), resolved = canonical(await realpath(file));
      if (entry.isSymbolicLink() || resolved !== canonical(file) || !resolved.startsWith(canonical(base) + path.sep) || (!entry.isDirectory() && (!entry.isFile() || entry.nlink > 1))) throw Error('Saved analysis contains linked or unsupported entries; cleanup was skipped.');
      if (entry.isDirectory()) await inspect(file, base);
    }
  }
  for (const directory of [...(active ? [target] : []), ...tombstones]) await inspect(directory);
  let detached;
  if (active) {
    if (!sameIdentity(active, await lstat(target))) throw Error('Saved analysis changed before cleanup.');
    detached = path.join(storage, prefix + randomUUID());
    await rename(target, detached); tombstones.push(detached);
  }
  try { await onDetached({ pending: tombstones }); }
  catch (error) {
    if (detached) {
      try { await rename(detached, target); }
      catch (rollback) { throw Object.assign(Error(`Analysis metadata could not be saved and its folder could not be restored. Preserved at ${detached}. ${rollback.message}`), { analysisDetached: true, cleanupDirectory: detached }); }
    }
    throw Object.assign(error, { analysisDetached: false });
  }
  for (const directory of tombstones) {
    try { await inspect(directory); await remove(directory, { recursive: true, force: false }); }
    catch (error) { throw Object.assign(Error(`Saved analysis was detached safely, but cleanup is incomplete at ${directory}. Use Delete saved ${kind === 'app-analysis' ? 'reports' : 'projects'} again to retry. ${error.message}`), { analysisDetached: true, cleanupDirectory: directory }); }
  }
  return { deleted: true, pending: [] };
}
