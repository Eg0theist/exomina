import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {CloudService} from '../cloud/service.mjs';
import {finishPendingChatMemoryDeletes} from '../desktop/delete-conversation.mjs';
const fixtureRoot=os.tmpdir();
async function fixture(t){const dir=await mkdtemp(path.join(fixtureRoot,'cloud-fixture-'));const service=new CloudService({dataDir:dir,vaultKey:randomBytes(32).toString('base64'),providerFactory:options=>({status:async()=>[{id:'codex',connected:true,installed:true}],subscriptionModels:async()=>({codex:[]}),cancel(){},close(){},run:async input=>{await options.callTool('memory_note',{text:'Reusable synthetic preference'},input.conversationId);return {text:'Synthetic reply'};}})});await service.init();t.after(async()=>{await service.close();assert.ok(path.resolve(dir).startsWith(fixtureRoot+path.sep+'cloud-fixture-'));await rm(dir,{recursive:true,force:true});});return service;}
async function send(service){const response=await service.invoke('chat.send',{provider:'codex',text:'Synthetic request'},{requestId:randomUUID()});await Promise.all([...service.active.values()].map(run=>run.promise));return response.conversationId;}
test('server deletion preserves reused notes and publishes precise deletion and provenance updates',async t=>{
  const s=await fixture(t),first=await send(s),second=await send(s),note=(await s.memory.list())[0];assert.deepEqual(new Set(note.sourceChatIds),new Set([first,second]));
  assert.equal((await s.invoke('conversations.memoryStats',{id:first})).shared,1);
  const kept=await s.invoke('conversations.delete',{id:first,deleteMemories:true});assert.equal(kept.deletedMemories,0);assert.deepEqual((await s.memory.getNote(note.id)).sourceChatIds,[second]);assert.deepEqual(s.syncStore.get('note',note.id).payload.sourceChatIds,[second]);
  const deleted=await s.invoke('conversations.delete',{id:second,deleteMemories:true});assert.equal(deleted.deletedMemories,1);assert.equal(await s.memory.getNote(note.id),null);assert.equal(s.syncStore.get('note',note.id).deleted,true);
});
test('server default deletion keeps notes, and manually keeping a note prevents later linked deletion',async t=>{
  const s=await fixture(t),first=await send(s),note=(await s.memory.list())[0];await s.invoke('conversations.delete',{id:first});assert.ok(await s.memory.getNote(note.id));
  const second=await send(s);await s.invoke('memory.add',{text:note.text});assert.equal((await s.memory.getNote(note.id)).chatOwned,false);
  const result=await s.invoke('conversations.delete',{id:second,deleteMemories:true});assert.equal(result.deletedMemories,0);assert.ok(await s.memory.getNote(note.id));
});
test('server publication failure keeps a retryable request and the exact shared-note update',async t=>{
  const s=await fixture(t),first=await send(s),second=await send(s),note=(await s.memory.list())[0],publish=s.publishMemoryChanges.bind(s);s.publishMemoryChanges=async()=>{throw Error('Synthetic sync publication failure');};
  const result=await s.invoke('conversations.delete',{id:first,deleteMemories:true});assert.equal(result.memoryDeletionPending,true);assert.equal(s.syncStore.get('chat',first).deleted,true);assert.ok(s.store.state.pendingChatMemoryDeletes.includes(first));s.publishMemoryChanges=publish;
  await finishPendingChatMemoryDeletes({store:s.store,memory:s.memory,onChanges:(id,changes)=>s.publishMemoryChanges(id,changes)});assert.deepEqual(s.syncStore.get('note',note.id).payload.sourceChatIds,[second]);assert.deepEqual(s.store.state.pendingChatMemoryDeletes,[]);
});
