import {readdir,readFile,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const digest=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
export async function verifyVendorBinaries(build,source){
 const files=[];
 async function walk(relative){
  for(const entry of await readdir(path.join(build,'resources/app.asar.unpacked',relative),{withFileTypes:true})){
   const name=path.join(relative,entry.name),packed=path.join(build,'resources/app.asar.unpacked',name);
   if(entry.isSymbolicLink())throw Error('Linked vendor artifact is not allowed: '+name);
   if(entry.isDirectory())await walk(name);
   else if(/\.(?:exe|dll|node|pyd)$/i.test(entry.name)){
    const original=path.join(source,name),info=await lstat(original);if(!info.isFile()||info.isSymbolicLink())throw Error('Vendor source is not a regular file: '+name);
    const sha256=await digest(original);if(sha256!==await digest(packed))throw Error('Packaged vendor bytes differ from prepared source: '+name);files.push({path:name.replaceAll('\\','/'),sha256});
   }
  }
 }
 for(const relative of ['vendor','node_modules'])await walk(relative);
 for(const entry of await readdir(build,{withFileTypes:true}))if(entry.isFile()&&/\.dll$/i.test(entry.name)){
  const original=path.join(source,'node_modules/electron/dist',entry.name),sha256=await digest(original);
  if(sha256!==await digest(path.join(build,entry.name)))throw Error('Electron library was modified: '+entry.name);files.push({path:entry.name,sha256});
 }
 if(!files.length)throw Error('No vendor binaries were verified.');return {passed:true,files};
}
