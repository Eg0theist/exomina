import fs,{readFile,writeFile,link,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';

const operations=new Map();
function accessState(file,operation){
  const absolute=path.resolve(file),key=process.platform==='win32'?absolute.toLowerCase():absolute;
  const result=(operations.get(key)||Promise.resolve()).then(operation);
  const settled=result.then(()=>{},()=>{});
  operations.set(key,settled);
  settled.then(()=>{if(operations.get(key)===settled)operations.delete(key);});
  return result;
}

// Async Windows reads can briefly block replacement even after reading the
// bytes. Serialize our own readers with writers; external locks stay bounded.
export function readUpdateState(file){
  return accessState(file,async()=>{try{return JSON.parse(await readFile(file,'utf8'));}catch{return null;}});
}

/** Publish a complete updater record, preserving the exclusive initial claim. */
export function writeUpdateState(file,value,{claim=false}={}){
  return accessState(file,async()=>{
    const temporary=file+'.'+randomUUID()+'.tmp';
    try{
      await writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});
      // Never remove the destination to work around a sharing violation: that
      // would let another updater claim it while the first handoff is active.
      if(claim){await link(temporary,file);return;}
      const waits=[10,20,40,80,160,250,250];
      for(let attempt=0;;attempt++){
        try{await rename(temporary,file);return;}
        catch(error){
          // Windows can refuse replacement while a status reader or scanner has
          // the old record open. Keep both complete files and retry briefly.
          if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=waits.length)throw error;
          await delay(waits[attempt]);
        }
      }
    // A scanner holding a temporary must not turn a published claim into a
    // reported failure, or hide the original replacement error.
    }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
  });
}
