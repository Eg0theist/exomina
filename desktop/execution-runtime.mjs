// The background terminal host must not run from Exomina's program folder.
// Windows cannot rename a folder while a program inside it is running, and the
// updater swaps the whole program folder. So the host runs from a private,
// content-addressed copy: the verified bundled Node.js runtime plus the few
// modules the host imports. Every file is hashed against its source before use.
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile,readdir,mkdir,rename,rm,lstat,stat} from 'node:fs/promises';

export const EXECUTION_RUNTIME_MODULES=['execution-daemon.mjs','execution-host.mjs','execution-protocol.mjs','terminal-pty.mjs','path-policy.mjs'];
export const EXECUTION_RUNTIME_PACKAGES=['@lydell/node-pty','@lydell/node-pty-win32-x64'];
const MAX_FILE=128*1024*1024,MAX_FILES=400;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const unpacked=value=>value.replace(/app\.asar(?=[\\/])/u,'app.asar.unpacked');
const exists=async file=>{try{await lstat(file);return true;}catch{return false;}};

async function packageFiles(directory,relative=''){
  const out=[];for(const entry of await readdir(path.join(directory,relative),{withFileTypes:true})){
    const name=path.join(relative,entry.name);if(entry.isSymbolicLink())throw Error('The terminal runtime cannot include links.');
    if(entry.isDirectory())out.push(...await packageFiles(directory,name));else if(entry.isFile())out.push(name);
    if(out.length>MAX_FILES)throw Error('The terminal runtime package is unexpectedly large.');
  }return out;
}

/** Lists source → runtime-relative pairs. Native packages come from the
 * unpacked folder when present, because a plain Node.js host cannot read asar. */
export async function executionRuntimeSources({desktopDir=fileURLToPath(new URL('.',import.meta.url)),node}){
  const appRoot=path.dirname(desktopDir),entries=[{source:node,target:'node.exe'}];
  for(const name of EXECUTION_RUNTIME_MODULES)entries.push({source:path.join(desktopDir,name),target:path.join('desktop',name)});
  for(const name of EXECUTION_RUNTIME_PACKAGES){
    const packed=path.join(appRoot,'node_modules',name),directory=await exists(unpacked(packed))?unpacked(packed):packed;
    for(const file of await packageFiles(directory))entries.push({source:path.join(directory,file),target:path.join('node_modules',name,file)});
  }
  return entries;
}

async function hashed(entries){
  const files=[];for(const entry of entries){const bytes=await readFile(entry.source);if(bytes.length>MAX_FILE)throw Error('A terminal runtime file is too large.');files.push({...entry,bytes,sha256:sha(bytes)});}
  files.sort((a,b)=>a.target.localeCompare(b.target));
  const digest=sha(files.map(file=>file.target.replaceAll('\\','/')+'\0'+file.sha256).join('\n'));
  return {files,digest};
}

async function matches(directory,files){
  for(const file of files){const target=path.join(directory,file.target);try{const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||info.size!==file.bytes.length||sha(await readFile(target))!==file.sha256)return false;}catch{return false;}}
  return true;
}

/** Removes runtime copies no longer in use. A copy whose node.exe is still
 * running cannot be renamed on Windows, so a failed rename means "in use". */
export async function pruneExecutionRuntimes(base,keep=[]){
  let names=[];try{names=await readdir(base);}catch{return [];}
  const removed=[];for(const name of names){
    if(keep.includes(name))continue;const from=path.join(base,name);
    try{const trash=name.startsWith('.trash-')?from:path.join(base,'.trash-'+randomUUID());if(trash!==from)await rename(from,trash);await rm(trash,{recursive:true,force:true});removed.push(name);}catch{}
  }
  return removed;
}

/** Returns {command,daemon,runtime} for a verified private copy, creating it if needed. */
export async function stageExecutionRuntime({root,entries,keep=[]}){
  const base=path.join(root,'runtime');await mkdir(base,{recursive:true,mode:0o700});
  const {files,digest}=await hashed(entries),name=digest.slice(0,24),directory=path.join(base,name);
  if(!await matches(directory,files)){
    const staging=path.join(base,'.staging-'+randomUUID());
    try{
      for(const file of files){const target=path.join(staging,file.target);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,file.bytes,{mode:0o600,flag:'wx'});}
      if(!await matches(staging,files))throw Error('The terminal runtime copy did not verify.');
      // A stale or tampered copy that is not in use is replaced; one in use stays and fails the check.
      if(await exists(directory)){const trash=path.join(base,'.trash-'+randomUUID());await rename(directory,trash);await rm(trash,{recursive:true,force:true}).catch(()=>{});}
      await rename(staging,directory);
    }finally{await rm(staging,{recursive:true,force:true}).catch(()=>{});}
    if(!await matches(directory,files))throw Error('The terminal runtime copy changed after staging.');
  }
  await pruneExecutionRuntimes(base,[name,...keep]);
  const command=path.join(directory,'node.exe'),daemon=path.join(directory,'desktop','execution-daemon.mjs');
  if(!(await stat(command)).isFile())throw Error('The terminal runtime is incomplete.');
  return {command,daemon,runtime:name};
}
