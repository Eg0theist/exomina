import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

// The main process also forwards keyboard input to the window. Whole-library
// work therefore runs in slices that return to the event loop in between.
const SLICE_MS=6,CHUNK_CHARS=1<<19;
export const yieldToEvents=()=>new Promise(resolve=>setImmediate(resolve));

/** JSON.stringify(state) as an array of ~512K-character chunks, byte-identical
 * when joined. Conversation and message arrays are captured up front, and each
 * message serializes atomically, so concurrent edits cannot duplicate or skip
 * entries; later edits arrive through the store's pending save. */
export async function serializeState(state,{omit=()=>false}={}){
  const chunks=[];let current=[],size=0,sliceAt=performance.now();
  const push=text=>{current.push(text);size+=text.length;if(size>=CHUNK_CHARS){chunks.push(current.join(''));current=[];size=0;}};
  const pause=async()=>{if(performance.now()-sliceAt<SLICE_MS)return;await yieldToEvents();sliceAt=performance.now();};
  const field=(key,value,first)=>{const json=JSON.stringify(value);if(json===undefined)return first;push((first?'':',')+JSON.stringify(key)+':'+json);return false;};
  const conversations=(state.conversations||[]).filter(c=>!omit(c)).map(c=>[c,Array.isArray(c?.messages)?[...c.messages]:null]);
  push('{');let first=true;
  for(const key of Object.keys(state)){
    if(key!=='conversations'||!Array.isArray(state.conversations)){first=field(key,state[key],first);continue;}
    push((first?'':',')+'"conversations":[');first=false;
    for(let i=0;i<conversations.length;i++){
      const [conversation,messages]=conversations[i];
      if(!messages||typeof conversation.toJSON==='function'){push((i?',':'')+(JSON.stringify(conversation)??'null'));await pause();continue;}
      push(i?',{':'{');let inner=true;
      for(const name of Object.keys(conversation)){
        if(name!=='messages'){inner=field(name,conversation[name],inner);continue;}
        push((inner?'':',')+'"messages":[');inner=false;
        for(let j=0;j<messages.length;j++){push((j?',':'')+(JSON.stringify(messages[j])??'null'));await pause();}
        push(']');
      }
      push('}');await pause();
    }
    push(']');
  }
  push('}');if(current.length)chunks.push(current.join(''));
  return chunks;
}

/** SHA-256 of chunked text, yielding between chunks. */
export async function digestChunks(chunks){
  const hash=createHash('sha256');
  for(const chunk of chunks){hash.update(chunk);await yieldToEvents();}
  return hash.digest('hex');
}

/** SHA-256 of a file read in the background, without decoding it as a string. */
export function digestFile(file){
  return new Promise((resolve,reject)=>{
    const hash=createHash('sha256');
    createReadStream(file,{highWaterMark:1<<20}).on('data',chunk=>hash.update(chunk)).on('error',reject).on('end',()=>resolve(hash.digest('hex')));
  });
}

// A complete library starts with "{" and ends with "}". This catches the
// all-zero and truncated files left by power loss without parsing 70 MB.
async function looksComplete(file){
  let handle;
  try{
    handle=await fs.open(file,'r');const {size}=await handle.stat();if(size<2)return false;
    const edge=Math.min(size,64),head=Buffer.alloc(edge),tail=Buffer.alloc(edge);
    await handle.read(head,0,edge,0);await handle.read(tail,0,edge,size-edge);
    const start=head.toString('latin1').trimStart(),end=tail.toString('latin1').trimEnd();
    return start.startsWith('{')&&end.endsWith('}')&&!start.includes('\0')&&!end.includes('\0');
  }catch(error){if(error.code==='ENOENT')return false;throw error;}
  finally{await handle?.close();}
}

export function validateState(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||
    (value.settings!==undefined&&(!value.settings||typeof value.settings!=='object'||Array.isArray(value.settings)))||
    (value.conversations!==undefined&&(!Array.isArray(value.conversations)||value.conversations.some(c=>!c||typeof c.id!=='string'||!Array.isArray(c.messages)))))throw Error('Invalid chat-storage structure.');
  return value;
}
export function parseState(text){return validateState(JSON.parse(text));}

/** Flush bytes before replacing a name. A renamed buffered file alone is not
 * durable through a power failure. Keep independent known-good generations. */
export async function durableReplace(file,text){
  const tmp=path.join(path.dirname(file),'state.'+randomUUID()+'.tmp');
  let handle;
  try{
    handle=await fs.open(tmp,'wx',0o600);
    if(typeof text==='string')await handle.writeFile(text,'utf8');
    else for(const chunk of text)await handle.write(chunk,null,'utf8');
    await handle.sync();await handle.close();handle=null;
    await fs.rename(tmp,file);
    // POSIX supports directory fsync. Windows may reject directory handles;
    // flushed file bytes and independent snapshots are still retained there.
    let directory;
    try{directory=await fs.open(path.dirname(file),'r');await directory.sync();}
    catch(error){if(!['EPERM','EACCES','EINVAL','EISDIR','ENOTSUP'].includes(error.code))throw error;}
    finally{await directory?.close();}
  }finally{await handle?.close();await fs.rm(tmp,{force:true}).catch(()=>{});}
}

// Only durableReplace and backupFromFile create these names, and their
// finally blocks remove them unless the process dies first.
const ORPHANED_TEMP=/^state\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

/** Deletes temporaries left by a crash during a write or backup. Call once at
 * startup before the first save; the single-instance lock means no writer is
 * active. A temporary was never committed, so state.json and the backups stay
 * authoritative. Failures are skipped so cleanup never blocks startup. */
export async function removeOrphanedTemps(dir){
  let names;
  try{names=await fs.readdir(dir);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const removed=[];
  for(const name of names.filter(name=>ORPHANED_TEMP.test(name))){
    try{await fs.rm(path.join(dir,name));removed.push(name);}catch{}
  }
  return removed;
}

export async function readRecoverableState(dir){
  const file=path.join(dir,'state.json');let original,primaryError;
  try{original=await fs.readFile(file,'utf8');return{state:parseState(original),text:original};}
  catch(error){if(error.code&&error.code!=='ENOENT')throw error;primaryError=error;}
  let backupFound=false;
  for(const name of ['state.backup.1.json','state.backup.2.json']){
    let text,state;
    try{text=await fs.readFile(path.join(dir,name),'utf8');backupFound=true;state=parseState(text);}
    catch(error){if(error.code&&error.code!=='ENOENT')throw error;continue;}
    let preservedFile;
    if(original!==undefined){preservedFile='state.corrupt-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.json';
      await durableReplace(path.join(dir,preservedFile),original);}
    await durableReplace(file,text);
    return{state,text,recovery:{backup:name,preservedFile}};
  }
  if(primaryError?.code==='ENOENT'&&!backupFound)return{state:null,text:null};
  throw Error('App data could not be read. Preserve state.json and repair it before continuing: '+primaryError.message);
}

/** Rotates backups from the durable primary with file operations. The copy is
 * verified against the digest the writer last committed before it replaces
 * backup 1; the previous backup 1 becomes backup 2 by rename. */
export async function backupFromFile(dir,file,digest){
  const tmp=path.join(dir,'state.'+randomUUID()+'.tmp');
  try{
    await fs.copyFile(file,tmp,fs.constants.COPYFILE_EXCL);
    if(await digestFile(tmp)!==digest)throw Error('Chat storage changed outside the writer. Preserve state.json and restart before saving.');
    const handle=await fs.open(tmp,'r+');try{await handle.sync();}finally{await handle.close();}
    const first=path.join(dir,'state.backup.1.json');
    if(await looksComplete(first))await fs.rename(first,path.join(dir,'state.backup.2.json'));
    await fs.rename(tmp,first);
  }finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
}

export async function backupState(dir,text){
  if(typeof text!=='string')text=text.join('');
  parseState(text);
  let previous;
  try{previous=await fs.readFile(path.join(dir,'state.backup.1.json'),'utf8');parseState(previous);}
  catch(error){if(error.code&&error.code!=='ENOENT')throw error;previous=null;}
  if(previous!==null)await durableReplace(path.join(dir,'state.backup.2.json'),previous);
  await durableReplace(path.join(dir,'state.backup.1.json'),text);
}
