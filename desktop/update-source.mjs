// Release source snapshots contain build inputs only, never user profiles or account stores.
import {readdir,lstat,readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const SOURCE_FOLDER='exomina-source';
const ROOTS=new Set(['desktop','src','scripts','test','public','build']);
const FILES=new Set(['package.json','package-lock.json','index.html','preview.html','vite.config.mjs','README.md','LICENSE','PRIVATE-BETA.md','FEEDBACK.md','PROVIDER-TOOLS.md','PUBLIC-UPDATES.md','VALIDATION.txt','THIRD-PARTY-NOTICES.txt','SECURITY-AUDIT.txt']);
export function sourcePath(value){
  if(typeof value!=='string'||value.length>400||value.includes('\\')||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'||/[<>:"|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(p)))throw Error('Invalid release source path.');
  if(!FILES.has(value)&&!ROOTS.has(value.split('/')[0]))throw Error('The file is outside the release source inputs.');
  if(/(^|\/)(?:Private|accounts|data|node_modules|\.git|\.verification|release|repair-backups|__pycache__)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:sqlite\w*|db|log|pfx|p12|key|pem|pyc)$/i.test(value))throw Error('Private or generated files cannot enter a source snapshot.');
  return value;
}
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function plainPath(file){
  let cursor=path.resolve(file);
  while(true){const info=await lstat(cursor).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(info?.isSymbolicLink())throw Error('Linked source or update paths are not allowed.');const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
}
export async function sourceTree(root){
  await plainPath(root);const files=new Map();let total=0;
  async function walk(relative){
    const target=path.join(root,relative),info=await lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!info)return;
    if(info.isSymbolicLink()||info.isFile()&&info.nlink>1)throw Error('Linked release source inputs are not allowed.');
    if(info.isDirectory()){for(const name of (await readdir(target)).sort()){const child=relative?relative+'/'+name:name;try{sourcePath(child);}catch{continue;}await walk(child);}return;}
    sourcePath(relative);if(!info.isFile()||info.size>32*1024**2)throw Error('A release source input is not a bounded regular file.');
    total+=info.size;if(total>256*1024**2||files.size>=12000)throw Error('Release source inputs exceed the snapshot limit.');files.set(relative,await readFile(target));
  }
  for(const item of [...ROOTS,...FILES])await walk(item);
  return files;
}
export const treeHash=files=>digest(JSON.stringify([...files].sort(([a],[b])=>a.localeCompare(b)).map(([file,bytes])=>[file,digest(bytes)])));
export async function writeTree(root,files){
  await plainPath(root);await mkdir(root,{recursive:true});
  for(const [file,bytes]of files){sourcePath(file);const target=path.join(root,...file.split('/'));await plainPath(target);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});}
}
export async function snapshotSource(root,destination,release){
  const files=await sourceTree(root);if(!files.has('package.json')||!files.has('desktop/main.mjs'))throw Error('The release source snapshot is incomplete.');
  await writeTree(path.join(destination,'files'),files);
  const manifest={format:1,release,treeHash:treeHash(files),files:[...files].map(([file,bytes])=>({path:file,size:bytes.length,sha256:digest(bytes)}))};
  await writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
export async function readSnapshot(root){
  await plainPath(root);await plainPath(path.join(root,'manifest.json'));
  if((await lstat(path.join(root,'manifest.json'))).size>8*1024**2)throw Error('Release source manifest exceeds its size limit.');
  const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
  if(manifest.format!==1||!Array.isArray(manifest.files)||manifest.files.length>12000||typeof manifest.release?.id!=='string'||! /^[\w-]{8,64}$/.test(manifest.release.id))throw Error('Invalid release source manifest.');
  const files=await sourceTree(path.join(root,'files'));
  if(files.size!==manifest.files.length)throw Error('Release source file inventory differs.');
  const seen=new Set();
  for(const entry of manifest.files){sourcePath(entry.path);const key=entry.path.toLowerCase();if(seen.has(key))throw Error('Duplicate release source path.');seen.add(key);const bytes=files.get(entry.path);if(!bytes||bytes.length!==entry.size||digest(bytes)!==entry.sha256)throw Error('Release source failed its integrity check: '+entry.path);}
  if(treeHash(files)!==manifest.treeHash)throw Error('Release source tree failed its integrity check.');
  return {manifest,files};
}
