// REA's Windows addon requires the Node.js executable, rather than Electron.
import {lstat,realpath,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const ANALYSIS_NODE_VERSION='24.22.1';
export const ANALYSIS_NODE_SHA256='d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5';
export const ANALYSIS_NODE_LICENSE_SHA256='ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9';
const bundledDirectory=fileURLToPath(new URL('../vendor/analysis-node/',import.meta.url)).replace(/app\.asar(?=[\\/])/u,'app.asar.unpacked');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const samePath=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();

export async function analysisNodeExecutable(directory=bundledDirectory){
  if(process.platform!=='win32'||process.arch!=='x64')throw Error('This native analysis runtime requires Windows x64.');
  let ancestor=path.resolve(directory);
  while(true){const metadata=await lstat(ancestor);if(metadata.isSymbolicLink()||!metadata.isDirectory()||!samePath(await realpath(ancestor),ancestor))throw Error('The bundled analysis runtime cannot follow links or aliases.');const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
  const read=async(name,max)=>{const file=path.join(directory,name),before=await lstat(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink>1||before.size>max||!samePath(await realpath(file),file))throw Error('The bundled analysis runtime file is invalid.');const bytes=await readFile(file),after=await lstat(file);if(after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('The bundled analysis runtime changed during verification.');return bytes;};
  const manifest=JSON.parse((await read('manifest.json',16000)).toString('utf8'));
  if(manifest.schemaVersion!==1||manifest.version!==ANALYSIS_NODE_VERSION||manifest.platform!=='win32'||manifest.architecture!=='x64'||manifest.executable!=='node.exe'||manifest.executableSha256!==ANALYSIS_NODE_SHA256||manifest.license!=='LICENSE'||manifest.licenseSha256!==ANALYSIS_NODE_LICENSE_SHA256)throw Error('The bundled analysis runtime manifest does not match the pinned distribution.');
  const binary=await read('node.exe',128*1024*1024);if(hash(binary)!==ANALYSIS_NODE_SHA256)throw Error('The bundled analysis runtime checksum does not match the verified Node.js distribution.');
  const license=await read('LICENSE',1024*1024);if(hash(license)!==manifest.licenseSha256)throw Error('The bundled analysis runtime license checksum changed.');
  return path.join(directory,'node.exe');
}
