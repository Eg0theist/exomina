import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseChatLink } from './chat-links.mjs';

/** Resolve a local link without interpreting it as a command. */
export async function chatFileTarget(input, { workspace, excludePrivate }, { allowMissing = false } = {}) {
  const link = parseChatLink(input);
  if (link?.kind !== 'file') throw new Error('This link does not point to a local file or folder.');
  const file = path.resolve(workspace, link.path);
  await excludePrivate(file);
  let info;
  try {
    const actual = await realpath(file);
    await excludePrivate(actual);
    info = await stat(actual);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      if (allowMissing) return { path: file, missing: true, directory: false };
      throw new Error(`This path no longer exists: ${file}`);
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error(`Windows could not access this path: ${file}`);
    throw error;
  }

  if (!info.isDirectory() && !info.isFile()) throw new Error('This link does not point to a file or folder.');
  return { path: file, directory: info.isDirectory(), missing: false };
}

/** Opening a file is available only through the explicit context-menu action. */
export async function chatFileAction(input, options, action) {
  if (!['show', 'open', 'copy'].includes(action)) throw new Error('Choose a supported file action.');
  const target = await chatFileTarget(input, options, { allowMissing: action === 'copy' });
  if (action === 'copy') {
    options.clipboard.writeText(target.path);
    return { path: target.path, action: 'copied-path' };
  }
  if (target.directory || action === 'open') {
    const error = await options.shell.openPath(target.path);
    if (error) throw new Error(`${target.directory ? 'Explorer could not open this folder' : 'The default app could not open this file'}: ${error}`);
    return { path: target.path, action: target.directory ? 'opened-folder' : 'opened-file' };
  }
  options.shell.showItemInFolder(target.path);
  return { path: target.path, action: 'revealed-file' };
}

/** A normal file-link click reveals its location without launching the file. */
export async function openChatLink(input, options) {
  const link = parseChatLink(input);
  if (!link) throw new Error('This link is not a supported web address or file path.');
  if (link.kind !== 'file') { await options.shell.openExternal(link.url); return {}; }
  return chatFileAction(input, options, 'show');
}
