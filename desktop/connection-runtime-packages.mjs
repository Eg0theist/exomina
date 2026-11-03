import {createHash,createPublicKey,verify,timingSafeEqual} from 'node:crypto';
import {mkdir,lstat,readdir,readFile,open,chmod} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createGunzip} from 'node:zlib';
import {Readable} from 'node:stream';
import path from 'node:path';

// npm's public registry signing authority, published at /-/npm/v1/keys.
// A new signing authority requires an app update, never trust an archive's key.
export const NPM_RUNTIME_KEY={id:'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',key:'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g=='};
export const RUNTIME_LIMIT=900*1024*1024;
export const connectionVersion=value=>typeof value==='string'&&/^\d+\.\d+\.\d+$/.test(value)?value:null;
export function runtimeTarget(id,platform=process.platform,arch=process.arch){
  if(!['codex','claude'].includes(id)||!['win32','darwin','linux'].includes(platform)||!['x64','arm64'].includes(arch))throw Error('This connection update is not available for this platform.');
  return {id,platform,arch,package:id==='codex'?'@openai/codex':`@anthropic-ai/claude-code-${platform}-${arch}`};
}
export async function registryFetch(url,{fetcher=fetch,binary=false,limit=binary?400*1024*1024:2*1024*1024}={}){
  const parsed=new URL(url);
  if(parsed.origin!=='https://registry.npmjs.org'||parsed.username||parsed.password||parsed.hash||parsed.search)throw Error('Untrusted connection update address.');
  const response=await fetcher(parsed.href,{redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',headers:{Accept:binary?'application/octet-stream':'application/json','User-Agent':'Exomina-connection-updates'},signal:AbortSignal.timeout(binary?180000:20000)});
  if(!response.ok)throw Error(`The official package registry returned ${response.status}. The current connection was kept.`);
  if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('Connection update download is too large.');}
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('Connection update download is too large.');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);return binary?bytes:JSON.parse(bytes.toString('utf8'));
}
export function verifiedManifest(value,name,version,{platform,arch,key=NPM_RUNTIME_KEY}={}){
  if(!value||value.name!==name||value.version!==version||typeof version!=='string'||!/^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:win32|darwin|linux)-(?:x64|arm64))?$/.test(version))throw Error('The registry returned a different connection package or version.');
  const integrity=value.dist?.integrity,match=typeof integrity==='string'&&integrity.match(/^sha512-([A-Za-z0-9+/]{86}==)$/);
  const expected=`https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
  if(!match||value.dist.tarball!==expected||!Number.isSafeInteger(value.dist.unpackedSize)||value.dist.unpackedSize<1||value.dist.unpackedSize>RUNTIME_LIMIT)throw Error('The connection release has no verifiable package download.');
  const publicKey=createPublicKey({key:Buffer.from(key.key,'base64'),format:'der',type:'spki'}),message=Buffer.from(`${name}@${version}:${integrity}`);
  if(!Array.isArray(value.dist.signatures)||!value.dist.signatures.some(signature=>{try{return signature.keyid===key.id&&typeof signature.sig==='string'&&signature.sig.length<512&&verify('sha256',message,publicKey,Buffer.from(signature.sig,'base64'));}catch{return false;}}))throw Error('Connection package registry signature verification failed. The current connection was kept.');
  if(platform&&(!Array.isArray(value.os)||!value.os.includes(platform)||!Array.isArray(value.cpu)||!value.cpu.includes(arch)))throw Error('The downloaded connection targets a different operating system or processor.');
  return {name,version,url:expected,integrity,unpackedSize:value.dist.unpackedSize};
}
export function verifyRuntimeBytes(bytes,manifest){
  const expected=Buffer.from(manifest.integrity.slice(7),'base64'),actual=createHash('sha512').update(bytes).digest();
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw Error('Connection package checksum verification failed. The current connection was kept.');
}
export async function downloadRuntimePackage(manifest,file,{fetcher=fetch,limit=400*1024*1024}={}){
  const url=new URL(manifest.url);if(url.origin!=='https://registry.npmjs.org'||url.username||url.password||url.hash||url.search)throw Error('Untrusted connection update address.');
  const response=await fetcher(url.href,{redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',headers:{Accept:'application/octet-stream','User-Agent':'Exomina-connection-updates'},signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw Error(`The official package registry returned ${response.status}. The current connection was kept.`);
  if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('Connection update download is too large.');}
  const output=await open(file,'wx',0o600),hash=createHash('sha512');let size=0;
  try{for await(const part of response.body){size+=part.length;if(size>limit)throw Error('Connection update download is too large.');hash.update(part);let offset=0;while(offset<part.length){const result=await output.write(part,offset,part.length-offset);if(!result.bytesWritten)throw Error('Connection download write failed.');offset+=result.bytesWritten;}}}finally{await output.close();}
  const expected=Buffer.from(manifest.integrity.slice(7),'base64'),actual=hash.digest();if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw Error('Connection package checksum verification failed. The current connection was kept.');
  return {bytes:size};
}
export function safePackagePath(value){
  if(typeof value!=='string'||value.length>500||!value.startsWith('package/')||/[\\\x00-\x1f\x7f:]/.test(value))throw Error('Unsafe connection archive path.');
  const parts=value.replace(/\/$/,'').split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)))throw Error('Unsafe connection archive path.');
  return parts.join('/');
}
export async function plainDirectory(directory){
  const absolute=path.resolve(directory),root=path.parse(absolute).root;let current=root;
  for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const entry=await lstat(current);if(!entry.isDirectory()||entry.isSymbolicLink())throw Error('A connection folder was replaced by a link or another file.');}
}
function tarNumber(bytes){const value=bytes.toString('ascii').replace(/\0.*$/s,'').trim();if(!/^[0-7]+$/.test(value||'0'))throw Error('Invalid connection archive number.');const number=parseInt(value||'0',8);if(!Number.isSafeInteger(number)||number<0)throw Error('Invalid connection archive size.');return number;}
function tarText(bytes){return bytes.toString('utf8').replace(/\0.*$/s,'');}
function paxPath(bytes){
  let offset=0,result;
  while(offset<bytes.length){const space=bytes.indexOf(32,offset),length=Number(bytes.subarray(offset,space).toString('ascii'));if(space<offset||!Number.isSafeInteger(length)||length<5||offset+length>bytes.length||bytes[offset+length-1]!==10)throw Error('Invalid connection archive metadata.');const record=bytes.subarray(space+1,offset+length-1).toString('utf8'),equal=record.indexOf('='),key=record.slice(0,equal);if(equal<1||['linkpath','size'].includes(key))throw Error('Unsupported connection archive metadata.');if(key==='path'){if(result!==undefined)throw Error('Duplicate archive path metadata.');result=record.slice(equal+1);}offset+=length;
  }return result;
}
/** Bounded streaming TAR extraction. No lifecycle scripts, shell, symlinks,
 * hardlinks, devices, or pre-existing destinations can be admitted. */
export async function extractRuntimePackage(bytes,directory,{limit=RUNTIME_LIMIT}={}){
  await plainDirectory(directory);if((await readdir(directory)).length)throw Error('Connection extraction requires an empty folder.');
  const source=typeof bytes==='string'?createReadStream(bytes):Readable.from([bytes]),stream=source.pipe(createGunzip()),iterator=stream[Symbol.asyncIterator]();source.on('error',error=>stream.destroy(error));let buffer=Buffer.alloc(0),expanded=0,total=0,entries=0,zeroBlocks=0,ended=false,pendingPath;
  const seen=new Set(),kinds=new Map();
  async function take(size,consume){let left=size;while(left){if(!buffer.length){const next=await iterator.next();if(next.done)throw Error('Truncated connection archive.');expanded+=next.value.length;if(expanded>limit+8*1024*1024)throw Error('Connection archive expands beyond its size limit.');buffer=next.value;}const length=Math.min(left,buffer.length),part=buffer.subarray(0,length);if(consume)await consume(part);buffer=buffer.subarray(length);left-=length;}}
  async function block(size){const chunks=[];await take(size,part=>chunks.push(part));return Buffer.concat(chunks);}
  try{
    while(!ended){
      const header=await block(512);
      if(header.every(value=>value===0)){zeroBlocks++;if(zeroBlocks===2)ended=true;continue;}
      if(zeroBlocks)throw Error('Unexpected data after connection archive terminator.');
      if(++entries>5000)throw Error('Too many connection archive entries.');
      let checksum=0;for(let i=0;i<512;i++)checksum+=i>=148&&i<156?32:header[i];if(tarNumber(header.subarray(148,156))!==checksum)throw Error('Connection archive header checksum failed.');
      const size=tarNumber(header.subarray(124,136)),type=String.fromCharCode(header[156]||48),padding=(512-size%512)%512;
      if(size>limit||total+size>limit)throw Error('Connection archive expands beyond its size limit.');
      if(type==='x'){if(pendingPath!==undefined||size>16384)throw Error('Invalid connection archive metadata.');pendingPath=paxPath(await block(size));await take(padding);continue;}
      if(!['0','5'].includes(type)||tarText(header.subarray(157,257)))throw Error('Connection archive links and special entries are not allowed.');
      const prefix=tarText(header.subarray(345,500)),name=safePackagePath(pendingPath??((prefix?prefix+'/':'')+tarText(header.subarray(0,100))));pendingPath=undefined;
      const key=name.toLowerCase();if(seen.has(key))throw Error('Duplicate connection archive entry.');seen.add(key);
      const segments=key.split('/');for(let i=1;i<segments.length;i++)if(kinds.get(segments.slice(0,i).join('/'))==='file')throw Error('Conflicting connection archive paths.');
      const destination=path.join(directory,...name.split('/'));if(type==='5'){if(size)throw Error('Connection archive directory has data.');await mkdir(destination,{recursive:true});kinds.set(key,'directory');}
      else{
        total+=size;await mkdir(path.dirname(destination),{recursive:true});await plainDirectory(path.dirname(destination));const file=await open(destination,'wx',0o600);
        try{await take(size,async part=>{let offset=0;while(offset<part.length){const result=await file.write(part,offset,part.length-offset);if(!result.bytesWritten)throw Error('Connection extraction write failed.');offset+=result.bytesWritten;}});}finally{await file.close();}
        if(process.platform!=='win32')await chmod(destination,(tarNumber(header.subarray(100,108))&0o111)?0o755:0o644);
        kinds.set(key,'file');
      }
      await take(padding);
    }
    if(pendingPath!==undefined)throw Error('Incomplete connection archive metadata.');
    if(buffer.some(value=>value!==0))throw Error('Unexpected data after connection archive terminator.');
    for await(const chunk of { [Symbol.asyncIterator]:()=>iterator }){expanded+=chunk.length;if(expanded>limit+8*1024*1024||chunk.some(value=>value!==0))throw Error('Unexpected data after connection archive terminator.');}
    return {bytes:total,entries};
  }finally{source.destroy();stream.destroy();}
}
export function runtimeProgram(target){
  if(target.id==='claude')return target.platform==='win32'?'claude.exe':'claude';
  const cpu=target.arch==='arm64'?'aarch64':'x86_64',triple=target.platform==='win32'?`${cpu}-pc-windows-msvc`:target.platform==='darwin'?`${cpu}-apple-darwin`:`${cpu}-unknown-linux-musl`;
  return `vendor/${triple}/codex/${target.platform==='win32'?'codex.exe':'codex'}`;
}
export async function runtimeInventory(directory){
  await plainDirectory(directory);const files=[];let size=0;
  async function visit(relative){for(const entry of await readdir(path.join(directory,relative),{withFileTypes:true})){const name=relative?relative+'/'+entry.name:entry.name,file=path.join(directory,...name.split('/')),info=await lstat(file);if(info.isSymbolicLink())throw Error('A managed connection contains a link.');if(info.isDirectory())await visit(name);else if(info.isFile()){
    if(files.length>=5000||(size+=info.size)>RUNTIME_LIMIT)throw Error('Managed connection is too large.');const hash=createHash('sha256');for await(const part of createReadStream(file))hash.update(part);files.push({path:name,bytes:info.size,sha256:hash.digest('hex')});
  }else throw Error('A managed connection contains a special file.');}}
  await visit('');return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export async function runtimeFileSnapshot(directory){
  await plainDirectory(directory);const files=[];let size=0;
  async function visit(relative){for(const entry of await readdir(path.join(directory,relative),{withFileTypes:true})){const name=relative?relative+'/'+entry.name:entry.name,info=await lstat(path.join(directory,...name.split('/')));if(info.isSymbolicLink())throw Error('A managed connection contains a link.');if(info.isDirectory())await visit(name);else if(info.isFile()){if(files.length>=5000||(size+=info.size)>RUNTIME_LIMIT)throw Error('Managed connection is too large.');files.push([name,info.size,info.mtimeMs,info.ctimeMs,info.ino]);}else throw Error('A managed connection contains a special file.');}}
  await visit('');return JSON.stringify(files.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0));
}
export async function inspectRuntimePackage(directory,target,version){
  const manifest=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8')),expected=target.id==='codex'?`${version}-${target.platform}-${target.arch}`:version;
  if(manifest.name!==target.package||manifest.version!==expected||!manifest.os?.includes(target.platform)||!manifest.cpu?.includes(target.arch))throw Error('The extracted connection package does not match its verified release.');
  let program=runtimeProgram(target);
  // Both layouts have been used by the official native Codex packages.
  if(target.id==='codex'&&!await lstat(path.join(directory,program)).then(entry=>entry.isFile()&&!entry.isSymbolicLink(),()=>false))program=program.replace('/codex/','/bin/');
  const command=path.join(directory,...program.split('/')),info=await lstat(command);if(!info.isFile()||info.isSymbolicLink())throw Error('The verified connection executable is missing.');
  if(target.platform!=='win32'&&!(info.mode&0o111))throw Error('The verified connection executable has no executable permission.');
  const files=await runtimeInventory(directory);
  return {command,files};
}
