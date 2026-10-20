import { lstat, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReplyExport } from './reply-export.mjs';

/** Invoked by the user's Save reply control, with a native file chooser. */
export async function saveReplyExport(input, { chooseFile, excludePrivate }) {
  const value = createReplyExport(input), extension = input.format;
  const result = await chooseFile({ title: 'Save reply', defaultPath: value.filename, properties: ['showOverwriteConfirmation'], filters: [{ name: { docx: 'Word document', xlsx: 'Excel workbook', md: 'Markdown', txt: 'Plain text' }[extension], extensions: [extension] }] });
  if (result.canceled) return { path: null };
  if (typeof result.filePath !== 'string' || !path.isAbsolute(result.filePath)) throw Error('Choose an absolute destination for the file.');
  const appended = path.extname(result.filePath).toLowerCase() !== '.' + extension;
  const requested = appended ? result.filePath + '.' + extension : result.filePath;
  if (/[<>:"|?*\u0000-\u001f]/.test(path.basename(requested))) throw Error('Choose a regular filename without reserved characters.');
  const parent = await realpath(path.dirname(requested)), target = path.join(parent, path.basename(requested));
  await excludePrivate(parent); await excludePrivate(target);
  const existing = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw Error('Choose a regular file destination, not a link or folder.');
  if (existing && appended) throw Error('The completed filename already exists. Choose that full filename in Save reply so the file chooser can confirm its replacement.');
  // Replacing a sibling file is atomic; never follow a destination link or leave
  // a truncated document behind after a write failure.
  const temporary = path.join(parent, '.exomina-export-' + randomUUID() + '.tmp');
  let failure;
  try {
    await writeFile(temporary, value.bytes, { flag: 'wx', mode: 0o600 });
    try { await rename(temporary, target); }
    catch (error) {
      if (!['EPERM','EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 80));
      await rename(temporary, target);
    }
  } catch (error) { failure = error; }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT' && !failure) failure = error; }); }
  if (failure) {
    if (['EPERM','EBUSY','EACCES'].includes(failure.code)) throw new Error('Could not save the file. Close it in the app using it, or choose another writable location.', { cause: failure });
    throw failure;
  }
  return { path: target };
}
