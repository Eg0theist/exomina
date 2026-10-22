import {createRequire} from 'node:module';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

// Electron virtualizes app.asar as a directory. Package verification must read
// its actual bytes, just like the elevated installer does.
const raw=process.versions.electron?createRequire(import.meta.url)('original-fs'):fs;
const io=raw.promises,MAX_INVENTORY=16*1024**2,MAX_FILES=100000,MAX_BYTES=16*1024**3;
export const UPDATE_INVENTORY='exomina.release-integrity.json';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function packagePath(value){
 if(typeof value!=='string'||value.length>500||value.includes('\\')||value.startsWith('/')||value.split('/').some(part=>!part||part==='.'||part==='..'||/[<>:"|?*\x00-\x1f]/.test(part)||/[. ]$/.test(part)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([.]|$)/i.test(part)))throw Error('Unsafe update package path.');
 if(/^(Private|data|Workspace|Source)(\/|$)/i.test(value))throw Error('An update must contain program files only.');return value;
}
async function plain(file){
 let cursor=path.resolve(file);while(true){const info=await io.lstat(cursor);if(info.isSymbolicLink())throw Error('Linked update paths are not allowed.');const parent=path.dirname(cursor);if(parent===cursor)return;cursor=parent;}
}
async function fileHash(file,info){
 const handle=await io.open(file,'r');try{
  const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.size!==info.size)throw Error('An update program file changed during verification.');
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(128*1024);let total=0;
  while(true){const{bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>info.size)throw Error('An update program file changed during verification.');hash.update(buffer.subarray(0,bytesRead));}
  const after=await handle.stat();if(total!==info.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('An update program file changed during verification.');return hash.digest('hex');
 }finally{await handle.close();}
}
export async function packageInventory(root){
 await plain(root);const files=[],seen=new Set();let total=0;
 async function walk(relative=''){
  for(const name of(await io.readdir(path.join(root,relative))).sort()){
   const rel=packagePath(relative?relative+'/'+name:name),file=path.join(root,...rel.split('/')),info=await io.lstat(file),key=rel.toLowerCase();
   if(seen.has(key))throw Error('Duplicate Windows update package path.');seen.add(key);
   if(info.isSymbolicLink()||info.isFile()&&info.nlink!==1)throw Error('Linked update program files are not allowed.');
   if(info.isDirectory()){await walk(rel);continue;}
   if(!info.isFile())throw Error('An update program entry is not a regular file.');
   if(key==='debug.log')continue;
   total+=info.size;if(total>MAX_BYTES||files.length>=MAX_FILES)throw Error('The update package exceeds its size limit.');
   files.push({path:rel,size:info.size,sha256:await fileHash(file,info)});
  }
 }await walk();return files;
}
/** inventorySha256 must come from a publisher-authenticated signed release. */
export async function verifyPackageInventory(root,{inventorySha256,buildId}){
 if(!/^[a-f0-9]{64}$/.test(inventorySha256||''))throw Error('The release has no authenticated program inventory.');
 await plain(root);const file=path.join(root,UPDATE_INVENTORY),info=await io.lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>MAX_INVENTORY)throw Error('Invalid update program inventory.');
 const bytes=await io.readFile(file);if(bytes.length!==info.size||digest(bytes)!==inventorySha256)throw Error('The update program inventory failed its authentication check.');
 const inventory=JSON.parse(bytes.toString('utf8'));
 if(inventory?.format!==1||inventory.buildId!==buildId||!Array.isArray(inventory.files)||!inventory.files.length||inventory.files.length>MAX_FILES)throw Error('Invalid update program inventory.');
 const expected=new Map();for(const entry of inventory.files){
  const name=packagePath(entry.path),key=name.toLowerCase();if(key===UPDATE_INVENTORY||key==='debug.log'||expected.has(key)||!Number.isSafeInteger(entry.size)||entry.size<0||! /^[a-f0-9]{64}$/.test(entry.sha256||''))throw Error('Invalid authenticated update inventory entry.');expected.set(key,entry);
 }
 const actual=await packageInventory(root),self=actual.find(entry=>entry.path===UPDATE_INVENTORY);
 if(!self||self.sha256!==inventorySha256||actual.length!==expected.size+1)throw Error('The update program inventory differs from the authenticated release.');
 for(const entry of actual){if(entry===self)continue;const known=expected.get(entry.path.toLowerCase());if(!known||known.path!==entry.path||known.size!==entry.size||known.sha256!==entry.sha256)throw Error('The update program file changed: '+entry.path);}
 for(const required of['Exomina.exe','exomina.build.json','resources/app.asar','resources/app.asar.unpacked/scripts/install-windows.ps1','resources/app.asar.unpacked/desktop/update-runner.ps1'])if(!expected.has(required.toLowerCase()))throw Error('The authenticated update package is incomplete: '+required);
 // Include the authenticated inventory itself in the installer receipt. Its
 // existing expected-manifest pipeline then rejects any later copied mutation.
 return{inventory,files:actual,receipt:JSON.stringify({format:1,files:actual})};
}
