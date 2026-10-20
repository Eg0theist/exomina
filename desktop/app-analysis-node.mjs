// REA's Windows addon requires the Node.js executable, rather than Electron.
import {lstat,realpath,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const ANALYSIS_NODE_VERSION='24.13.0';
export const ANALYSIS_NODE_SHA256='d14ba95cdce1ef7dc9ad3ac74949ca5db38b27378ee30f30a23cf26f9e875a11';
export const ANALYSIS_NODE_LICENSE_SHA256='b4c7840e841ab8f14543646bd941d01a459fb0f8ce1249244341b2a63272ca79';
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
