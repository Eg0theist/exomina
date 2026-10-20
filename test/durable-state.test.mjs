import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {durableReplace,backupState,readRecoverableState,parseState} from '../desktop/durable-state.mjs';
import {Store} from '../desktop/store.mjs';
const snapshot=text=>JSON.stringify({settings:{provider:'codex'},conversations:[{id:'chat',messages:[{id:'message',role:'user',content:text}]}]});
async function fixture(task){const dir=await mkdtemp(path.join(tmpdir(),'exomina-durable-state-'));try{await task(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('the actual all-zero crash failure recovers a full chat and preserves damaged evidence',()=>fixture(async dir=>{
  const saved=snapshot('Completed work');await backupState(dir,saved);await writeFile(path.join(dir,'state.json'),Buffer.alloc(saved.length));
  const result=await readRecoverableState(dir);assert.equal(result.state.conversations[0].messages[0].content,'Completed work');assert.equal(result.recovery.backup,'state.backup.1.json');
  assert.deepEqual(await readFile(path.join(dir,result.recovery.preservedFile)),Buffer.alloc(saved.length));assert.equal(await readFile(path.join(dir,'state.json'),'utf8'),saved);
}));
test('invalid newest backup falls back to the independent earlier generation',()=>fixture(async dir=>{
  await backupState(dir,snapshot('Earlier complete reply'));await backupState(dir,snapshot('Latest complete reply'));
  await writeFile(path.join(dir,'state.backup.1.json'),'truncated');await writeFile(path.join(dir,'state.json'),'truncated');
  const result=await readRecoverableState(dir);assert.equal(result.state.conversations[0].messages[0].content,'Earlier complete reply');assert.equal(result.recovery.backup,'state.backup.2.json');
}));
test('damaged storage without valid recovery never becomes an empty profile',()=>fixture(async dir=>{
  await writeFile(path.join(dir,'state.json'),Buffer.alloc(256));await writeFile(path.join(dir,'state.backup.1.json'),'{} broken');
  await assert.rejects(readRecoverableState(dir),/Preserve state.json/);assert.deepEqual(await readFile(path.join(dir,'state.json')),Buffer.alloc(256));
}));
test('a missing primary also recovers retained chats; a fresh folder starts normally',()=>fixture(async dir=>{
  assert.equal((await readRecoverableState(dir)).state,null);await backupState(dir,snapshot('Retained chat'));assert.equal((await readRecoverableState(dir)).state.conversations.length,1);
}));
test('successful durable replacements leave complete JSON and no temporary files',()=>fixture(async dir=>{
  const file=path.join(dir,'state.json');await durableReplace(file,snapshot('First'));await durableReplace(file,snapshot('Second'));assert.equal(parseState(await readFile(file,'utf8')).conversations[0].messages[0].content,'Second');assert.deepEqual(await readdir(dir),['state.json']);
}));
test('valid JSON with an unusable state structure is rejected',()=>{
  for(const value of ['null','[]','{"settings":[]}','{"conversations":{}}','{"conversations":[{"id":"chat"}]}'])assert.throws(()=>parseState(value));
});
test('a missing primary with damaged backups never creates a fresh empty profile',()=>fixture(async dir=>{
  await writeFile(path.join(dir,'state.backup.1.json'),Buffer.alloc(50));await assert.rejects(readRecoverableState(dir),/Preserve state.json/);
}));
test('Store commits queued snapshots and reopens a crash-damaged profile from its protected backup',()=>fixture(async dir=>{
  const store=new Store(dir);await store.init();const chat=store.create('codex');chat.messages.push({role:'user',content:'Work checkpoint'});await store.save();
  chat.messages.push({role:'assistant',content:'Saved result'});const first=store.save();chat.messages.push({role:'user',content:'Continue'});const second=store.save();await Promise.all([first,second]);
  assert.equal(JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).conversations[0].messages.length,3);
  await writeFile(path.join(dir,'state.json'),Buffer.alloc(1024));const reopened=new Store(dir);await reopened.init();assert.equal(reopened.state.conversations[0].messages[0].content,'Work checkpoint');assert.ok(reopened.recovery);
  reopened.state.conversations[0].messages.push({role:'user',content:'Retry'});await reopened.save();assert.equal(JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).conversations[0].messages.length,2);
}));
