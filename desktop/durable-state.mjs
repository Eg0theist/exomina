import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

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
    handle=await fs.open(tmp,'wx',0o600);await handle.writeFile(text,'utf8');await handle.sync();await handle.close();handle=null;
    await fs.rename(tmp,file);
    // POSIX supports directory fsync. Windows may reject directory handles;
    // flushed file bytes and independent snapshots are still retained there.
    let directory;
    try{directory=await fs.open(path.dirname(file),'r');await directory.sync();}
    catch(error){if(!['EPERM','EACCES','EINVAL','EISDIR','ENOTSUP'].includes(error.code))throw error;}
    finally{await directory?.close();}
  }finally{await handle?.close();await fs.rm(tmp,{force:true}).catch(()=>{});}
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

export async function backupState(dir,text){
  parseState(text);
  let previous;
  try{previous=await fs.readFile(path.join(dir,'state.backup.1.json'),'utf8');parseState(previous);}
  catch(error){if(error.code&&error.code!=='ENOENT')throw error;previous=null;}
  if(previous!==null)await durableReplace(path.join(dir,'state.backup.2.json'),previous);
  await durableReplace(path.join(dir,'state.backup.1.json'),text);
}
