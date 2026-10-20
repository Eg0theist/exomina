import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath,stat,lstat,chmod,mkdir} from 'node:fs/promises';
import path from 'node:path';
const execute=promisify(execFile);
// lsblk --inverse lists the backing devices below each mounted device. Every
// branch must cross an encryption mapping before reaching plaintext storage.
// A crypt node protects everything below it; an unencrypted leaf never passes.
function isEncrypted(nodes,depth=0){
  if(!Array.isArray(nodes)||!nodes.length||depth>64)return false;
  return nodes.every(node=>node&&typeof node==='object'&&(node.type==='crypt'||isEncrypted(node.children,depth+1)));
}
export async function verifyEncryptedStorage(dataDir,{platform=process.platform,run=execute}={}){
  if(platform!=='linux')throw Error('The production cloud service requires Linux encrypted storage. Desktop protection is configured separately.');
  const target=await realpath(dataDir),info=await stat(target);if(!info.isDirectory())throw Error('The private data path must be a directory.');
  const mount=JSON.parse((await run('findmnt',['--json','--target',target,'--output','SOURCE,FSTYPE,TARGET,OPTIONS'],{timeout:10000,maxBuffer:65536})).stdout).filesystems?.[0];
  if(!mount||!String(mount.options).split(',').includes('rw'))throw Error('Private storage must be mounted and writable.');
  let verified=false;
  if(mount.fstype==='fuse.gocryptfs')verified=true;
  else{
    const device=String(mount.source||'').split('[')[0];
    if(device.startsWith('/dev/')){const tree=JSON.parse((await run('lsblk',['--json','--inverse','--output','NAME,TYPE',device],{timeout:10000,maxBuffer:65536})).stdout);verified=isEncrypted(tree.blockdevices);}
  }
  if(!verified)throw Error('Private storage is not on a verified LUKS or gocryptfs encrypted mount. The server will not start on plaintext storage.');
  if(process.getuid&&info.uid!==process.getuid())throw Error('The service account must own its private data directory.');
  await chmod(target,0o700);return {protected:true,mechanism:mount.fstype==='fuse.gocryptfs'?'gocryptfs':'LUKS',dataDir:target};
}

/** Run before opening databases or starting native tools. Verify the temporary
 * subdirectory separately, so a nested plaintext mount cannot bypass the guard. */
export async function preparePrivateTemporaryStorage(dataDir,{verify=verifyEncryptedStorage,env=process.env}={}){
  const storage=await verify(dataDir);
  const root=storage.dataDir;
  if(storage.protected!==true||!path.isAbsolute(root))throw Error('Private storage has not been verified.');
  const temporary=path.join(root,'runtime-tmp');
  await mkdir(temporary,{recursive:true,mode:0o700});
  if((await lstat(temporary)).isSymbolicLink())throw Error('The private temporary directory must not be a symbolic link.');
  const resolved=await realpath(temporary),relative=path.relative(root,resolved);
  if(relative!== 'runtime-tmp')throw Error('The temporary directory must remain inside verified private storage.');
  const checked=await verify(resolved);
  if(checked.protected!==true||checked.dataDir!==resolved)throw Error('Private temporary storage could not be verified.');
  env.TEMP=env.TMP=env.TMPDIR=resolved;
  return {storage,tempDir:resolved};
}
