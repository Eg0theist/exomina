import path from 'node:path';

/** Native filename representation only. Existing path/access validation stays
 * with the caller. SQLite needs Windows extended paths for journal suffixes
 * even when Node's filesystem calls can already access the same file. */
export function sqlitePath(file,platform=process.platform){
  if(platform!=='win32'||file===':memory:'||file==='')return file;
  return path.win32.toNamespacedPath(path.win32.resolve(file));
}
