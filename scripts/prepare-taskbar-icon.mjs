import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bytes=await readFile(path.join(root,'build/icon.ico'));
const sha256=createHash('sha256').update(bytes).digest('hex');
const file=`icon-${sha256.slice(0,16)}.ico`;
await mkdir(path.join(root,'build/shell-icons'),{recursive:true});
await writeFile(path.join(root,'build/shell-icons',file),bytes);
await writeFile(path.join(root,'build/taskbar-icon.json'),JSON.stringify({file,sha256},null,2)+'\n');
console.log(`Prepared Windows taskbar icon ${file}`);
