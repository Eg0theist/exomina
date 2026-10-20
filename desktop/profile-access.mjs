import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,lstat,readdir,chmod,realpath} from 'node:fs/promises';
import {WindowsVault} from './vault.mjs';

const scriptPath=fileURLToPath(new URL('./profile-windows.ps1',import.meta.url)).replace(`app.asar${path.sep}`,`app.asar.unpacked${path.sep}`);
const failure=message=>Object.assign(new Error(message),{code:'PROFILE_ACCESS_UNAVAILABLE'});

export class WindowsProfileAccess extends WindowsVault {
  constructor(options={}){super({scriptPath,...options});}
  async request(action,directory){try{return await super.request(action,directory);}catch(error){throw failure(/^(Windows encryption|The Windows encryption helper|This vault requires|The vault helper)/i.test(error.message)?'Windows profile access could not be verified. Keep existing app files unchanged and check local folder permissions.':error.message);}}
  inspect(directory){return this.request('inspect',directory);}
  prepare(directory){return this.request('prepare',directory);}
  verify(directory){return this.request('verify',directory);}
}

/** Restrict only dedicated app-owned Unix profile trees. Never follow links or
 * change another owner's files; keep owner executable bits for native runtimes.
 */
export async function prepareUnixProfile(directory,{uid=process.getuid?.(),fs={mkdir,lstat,readdir,chmod,realpath},prepare=true,verify=false,allowedLinks=[]}={}){
  const root=path.resolve(directory);
  if(!path.isAbsolute(directory)||root===path.parse(root).root||uid===undefined)throw failure('Use a dedicated private app data directory.');
  // Native macOS /var aliases may be system-owned. User-owned links and the
  // profile root itself cannot redirect profile creation or permission changes.
  for(let ancestor=root;;ancestor=path.dirname(ancestor)){
    let entry;try{entry=await fs.lstat(ancestor);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(entry?.isSymbolicLink()&&(ancestor===root||entry.uid===uid))throw failure('Private storage cannot pass through a user-owned symbolic link. Existing data was not changed.');
    if(ancestor===path.dirname(ancestor))break;
  }
  if(prepare)await fs.mkdir(root,{recursive:true,mode:0o700});
  const entries=[],pending=[root];
  while(pending.length){
    const location=pending.pop(),entry=await fs.lstat(location);
    // Chromium's own singleton locks are symlinks on Unix. Fixed app paths may
    // admit owner-created lock entries; they are never followed or chmodded.
    if(entry.isSymbolicLink()){
      if(location===root||entry.uid!==uid||!allowedLinks.includes(location))throw failure('Private storage contains a symbolic link or unsupported file type. Existing data was not changed.');
      entries.push({location,entry,link:true});continue;
    }
    if(!entry.isDirectory()&&!entry.isFile())throw failure('Private storage contains a symbolic link or unsupported file type. Existing data was not changed.');
    if(entry.uid!==uid)throw failure('A private profile entry belongs to another owner. Existing data was not changed.');
    if(entry.isFile()&&entry.nlink!==1)throw failure('Private storage contains a hard-linked file. Existing data was not changed.');
    if(entries.length>=200000)throw failure('The private profile exceeds its verification limit.');
    entries.push({location,entry});
    if(entry.isDirectory())for(const name of await fs.readdir(location))pending.push(path.join(location,name));
  }
  if(prepare)for(const {location,entry,link}of entries){if(link)continue;const desired=entry.isDirectory()?0o700:0o600|(entry.mode&0o100);if((entry.mode&0o777)!==desired)await fs.chmod(location,desired);}
  let restrictedAccess=true;
  for(const {location,entry,link}of entries){const current=await fs.lstat(location);if(current.isSymbolicLink()!==!!link||current.uid!==uid||current.ino!==entry.ino||current.dev!==entry.dev)throw failure('A private profile entry changed during verification. Existing data was preserved.');if(!link&&(current.mode&0o077)!==0)restrictedAccess=false;}
  if((prepare||verify)&&!restrictedAccess)throw failure('Private app file permissions could not be confirmed.');
  return {restrictedAccess,rootEncrypted:false,anyEncrypted:false,efsAvailable:false,entries:entries.length};
}
