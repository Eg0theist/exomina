import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../desktop/store.mjs';
import {durableReplace} from '../desktop/durable-state.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('the store retains a digest and backups keep the preceding durable generation',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'exomina-digest-'));
  try{
    const store=new Store(dir);await store.init();const chat=store.create('codex');chat.messages.push({role:'user',content:'Previous durable generation'});await store.save();
    assert.equal(store.lastDurable,undefined);assert.match(store.lastDurableHash,/^[a-f0-9]{64}$/);
    chat.messages[0].content='Latest generation';store.lastBackupAt=0;await store.save();
    assert.equal(JSON.parse(await readFile(path.join(dir,'state.backup.1.json'),'utf8')).conversations[0].messages[0].content,'Previous durable generation');
    assert.equal(JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).conversations[0].messages[0].content,'Latest generation');
    const reopened=new Store(dir);await reopened.init();await reopened.save();assert.equal(reopened.completedWrites,0);assert.equal(reopened.lastDurable,undefined);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('a slow write and 500 tool saves retain one writer and commit the latest state before callers resolve',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'exomina-backpressure-')),gate=deferred(),started=deferred();let writes=0,resolved=false;
  try{
    const store=new Store(dir,{writeState:async(file,text)=>{writes++;if(writes===1){started.resolve();await gate.promise;}await durableReplace(file,text);}});await store.init();
    const chat=store.create('codex');chat.messages.push({role:'assistant',content:'Synthetic tool output. '.repeat(10000)});
    const first=store.save();await started.promise;
    const saves=[];for(let i=0;i<500;i++){chat.title='Revision '+i;saves.push(store.save());}
    assert.equal(writes,1);assert.ok(saves.every(p=>p===first));assert.equal(store.pendingSave,true);first.then(()=>resolved=true);await Promise.resolve();assert.equal(resolved,false);
    gate.resolve();await Promise.all(saves);assert.equal(writes,2);assert.equal(store.saving,false);assert.equal(store.pendingSave,false);assert.equal(JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).conversations[0].title,'Revision 499');
  }finally{gate.resolve();await rm(dir,{recursive:true,force:true});}
});
test('a failed disk write rejects waiting calls and a subsequent save can recover',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'exomina-backpressure-'));let fail=true;
  try{
    const store=new Store(dir,{writeState:async(file,text)=>{if(fail)throw Object.assign(Error('Synthetic disk failure'),{code:'EIO'});await durableReplace(file,text);}});await store.init();
    store.create('codex');await assert.rejects(store.save(),/disk failure/);assert.equal(store.saving,false);fail=false;await store.save();assert.equal(JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).conversations.length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('messages added during an active write receive IDs and reach disk before queued saves resolve',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'exomina-save-ids-')),gate=deferred(),started=deferred();let writes=0;
  try{
    const store=new Store(dir,{writeState:async(file,text)=>{if(++writes===1){started.resolve();await gate.promise;}await durableReplace(file,text);}});await store.init();
    const chat=store.create('codex');chat.messages.push({role:'user',content:'First'});const first=store.save();await started.promise;
    const added={role:'assistant',content:'Added during the flush'};chat.messages.push(added);const queued=store.save();assert.equal(typeof added.id,'string','IDs remain synchronous even behind a slow flush');gate.resolve();await queued;
    const saved=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8'));
    assert.equal(queued,first);assert.equal(saved.conversations[0].messages[1].content,added.content);assert.equal(typeof added.id,'string');assert.equal(saved.conversations[0].messages[1].id,added.id);
  }finally{gate.resolve();await rm(dir,{recursive:true,force:true});}
});

test('saving unchanged state does not rewrite or rotate backups; later changes still commit',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'exomina-save-noop-'));let writes=0,backups=0;
  try{
    const store=new Store(dir,{writeState:async(file,text)=>{writes++;await durableReplace(file,text);},writeBackup:async()=>{backups++;}});await store.init();
    const chat=store.create('codex');await store.save();store.lastBackupAt=0;await store.save();
    assert.equal(writes,1);assert.equal(backups,1);assert.equal(store.completedWrites,1);
    chat.title='Changed after the skipped save';await store.save();assert.equal(writes,2);assert.equal(backups,2);
    const restored=new Store(dir);await restored.init();assert.equal(restored.conversation(chat.id).title,chat.title);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('recovery repairs a corrupt primary before an unchanged save can be skipped',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'exomina-save-recovery-'));
  try{
    const store=new Store(dir);await store.init();const chat=store.create('codex');chat.title='Recover this';await store.save();
    await writeFile(path.join(dir,'state.json'),'{broken','utf8');
    const restored=new Store(dir);await restored.init();assert.ok(restored.recovery);
    assert.equal(JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).conversations[0].title,'Recover this');
    await restored.save();assert.equal(JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).conversations[0].title,'Recover this');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('private-only changes skip disk and backups while the next public edit still persists',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'exomina-save-private-'));let writes=0,backups=0;
  try{
    const store=new Store(dir,{writeState:async(file,text)=>{writes++;await durableReplace(file,text);},writeBackup:async()=>{backups++;}});await store.init();
    const chat=store.create('codex');await store.save();const temporary=store.create('codex',{isPrivate:true});temporary.messages.push({role:'user',content:'PRIVATE_ONLY_TEXT'});store.lastBackupAt=0;await store.save();
    assert.equal(writes,1);assert.equal(backups,1);assert.doesNotMatch(await readFile(path.join(dir,'state.json'),'utf8'),/PRIVATE_ONLY_TEXT/);
    chat.title='A public edit';await store.save();assert.equal(writes,2);assert.equal(backups,2);assert.equal(JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).conversations[0].title,chat.title);
  }finally{await rm(dir,{recursive:true,force:true});}
});
