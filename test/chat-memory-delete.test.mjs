import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../desktop/memory.mjs';
import {Store} from '../desktop/store.mjs';
import {portablePayload} from '../desktop/cloud-client.mjs';
import {ChatDeletionCoordinator,deleteSavedConversation,finishPendingChatMemoryDeletes} from '../desktop/delete-conversation.mjs';
const fixtureRoot=os.tmpdir();
async function fixture(t){const dir=await mkdtemp(path.join(fixtureRoot,'fixture-')),memory=new MemoryStore(dir),store=new Store(dir);await memory.init();await store.init();t.after(async()=>{await store.queue;memory.close();assert.ok(path.resolve(dir).startsWith(fixtureRoot+path.sep+'fixture-'));await rm(dir,{recursive:true,force:true});});return {dir,memory,store};}
const saved=(memory,text,id)=>memory.call('memory_note',{text},async()=>true,id);

test('approved notes record their actual source chat; denied notes add no provenance',async t=>{
  const {memory}=await fixture(t),result=await saved(memory,'Source-linked preference','chat-a');
  assert.deepEqual(result.savedNote.sourceChatIds,['chat-a']);assert.equal(result.savedNote.chatOwned,true);
  assert.deepEqual(await memory.chatNoteStats('chat-a'),{linked:1,deletable:1,shared:0,independent:0});
  await assert.rejects(memory.call('memory_note',{text:'Must not be saved'},async()=>false,'chat-b'),/declined/);
  assert.equal((await memory.chatNoteStats('chat-b')).linked,0);
});
test('deduplicated notes used by another chat survive deletion until the final linked chat is deleted',async t=>{
  const {memory}=await fixture(t),first=await saved(memory,'Shared preference','chat-a'),second=await saved(memory,'Shared preference','chat-b');assert.equal(first.savedNote.id,second.savedNote.id);
  assert.deepEqual(second.savedNote.sourceChatIds,['chat-a','chat-b']);assert.equal((await memory.chatNoteStats('chat-a')).deletable,0);
  const result=await memory.deleteChatNotes('chat-a');assert.deepEqual(result.deletedNoteIds,[]);assert.equal(result.preserved,1);
  assert.deepEqual((await memory.getNote(first.savedNote.id)).sourceChatIds,['chat-b']);
  assert.deepEqual((await memory.deleteChatNotes('chat-b')).deletedNoteIds,[first.savedNote.id]);assert.equal(await memory.getNote(first.savedNote.id),null);
  await memory.applySyncedNote({...second.savedNote});assert.equal(await memory.getNote(first.savedNote.id),null);
});
test('unlinked older notes and manually saved notes remain after a related chat is removed',async t=>{
  const {memory,dir}=await fixture(t),legacy=await memory.note('Older independent note'),other=await memory.note('Unrelated note');
  await saved(memory,'Older independent note','chat-a');const created=await saved(memory,'Now deliberately kept','chat-a');await memory.note('Now deliberately kept',{manual:true});
  const result=await memory.deleteChatNotes('chat-a');assert.equal(result.deletedNoteIds.length,0);assert.equal(result.preserved,2);
  for(const id of [legacy.id,other.id,created.savedNote.id])assert.ok(await memory.getNote(id));
  const detached=await memory.getNote(legacy.id);assert.deepEqual(detached.sourceChatIds,[]);assert.equal(detached.chatOwned,false);
  const receiver=new MemoryStore(path.join(dir,'receiver'));await receiver.init();try{await receiver.applySyncedNote({...detached,...portablePayload('note',detached)});assert.deepEqual((await receiver.getNote(detached.id)).sourceChatIds,[]);}finally{receiver.close();}
});
test('deleting linked originals invalidates cached summaries and prevents stale resurrection',async t=>{
  const {memory}=await fixture(t);for(let n=0;n<8;n++)await saved(memory,'Original '+n,n<4?'chat-a':'chat-b');
  const pending=JSON.parse((await memory.run(['nap'])).text);await memory.run(['nap',pending.range,'Old combined memory summary',pending.version]);
  assert.equal(JSON.parse((await memory.run(['zoom','1-8'])).text).summary,'Old combined memory summary');
  const deleted=await memory.deleteChatNotes('chat-a');assert.equal(deleted.deletedNoteIds.length,4);
  const zoom=JSON.parse((await memory.run(['zoom','1-8'])).text);assert.equal(zoom.summary,null);assert.equal(zoom.notes.length,4);assert.ok(zoom.notes.every(note=>!['Original 0','Original 1','Original 2','Original 3'].includes(note.text)));
  assert.ok(memory.db.prepare('SELECT text FROM notes WHERE id=?').get(deleted.deletedNoteIds[0]).text==='');
});
test('memory provenance survives sync and validates IDs and ownership without changing legacy payloads',async t=>{
  const {memory}=await fixture(t);assert.deepEqual(portablePayload('note',{text:'Legacy',createdAt:'2026-10-05T00:00:00Z'}),{text:'Legacy',createdAt:'2026-10-05T00:00:00.000Z'});
  await memory.applySyncedNote({id:'remote-note',text:'Remote',createdAt:'2026-10-05T00:00:00Z',sourceChatIds:['chat-b','chat-a'],chatOwned:true});
  assert.deepEqual(portablePayload('note',await memory.getNote('remote-note')).sourceChatIds,['chat-a','chat-b']);
  await assert.rejects(memory.applySyncedNote({id:'bad',text:'No',sourceChatIds:['bad\0id'],chatOwned:true}),/valid source/);
  await assert.rejects(memory.applySyncedNote({id:'bad',text:'No',sourceChatIds:['chat-a'],chatOwned:'yes'}),/ownership/);
  assert.equal(await memory.getNote('bad'),null);
});
test('unchecked chat deletion preserves notes while checked deletion removes only exclusive linked notes',async t=>{
  const {memory,store}=await fixture(t),chat=store.create('codex');const note=await saved(memory,'Retain this note',chat.id);await store.save();
  await deleteSavedConversation({store,memory,id:chat.id});assert.equal(store.state.conversations.length,0);assert.ok(await memory.getNote(note.savedNote.id));
  const next=store.create('codex'),exclusive=await saved(memory,'Exclusive new note',next.id);await saved(memory,'Retain this note',next.id);
  const result=await deleteSavedConversation({store,memory,id:next.id,deleteMemories:true});assert.equal(result.deletedMemories,1);assert.equal(await memory.getNote(exclusive.savedNote.id),null);assert.ok(await memory.getNote(note.savedNote.id));
});
test('active work and invalid checkbox values cannot delete shared notes',async t=>{
  const {memory,store}=await fixture(t),chat=store.create('codex');const note=await saved(memory,'Keep while running',chat.id);
  await assert.rejects(deleteSavedConversation({store,memory,id:chat.id,deleteMemories:true,anyActive:true}),/Stop active/);
  await assert.rejects(deleteSavedConversation({store,memory,id:chat.id,deleteMemories:'yes'}),/Choose whether/);
  await assert.rejects(deleteSavedConversation({store,memory,id:chat.id,active:true}),/Stop this chat/);
  assert.ok(store.conversation(chat.id));assert.ok(await memory.getNote(note.savedNote.id));
});
test('a failed durable chat save leaves both chat and linked notes intact',async t=>{
  const {memory,store}=await fixture(t),chat=store.create('codex');const note=await saved(memory,'Preserve on save failure',chat.id),save=store.save.bind(store);store.save=async()=>{throw Error('Synthetic storage failure');};
  await assert.rejects(deleteSavedConversation({store,memory,id:chat.id,deleteMemories:true}),/storage failure/);store.save=save;
  assert.ok(store.conversation(chat.id));assert.ok(await memory.getNote(note.savedNote.id));assert.equal(store.state.pendingChatMemoryDeletes,undefined);
});
test('an interrupted note deletion persists its intent and resumes after a fresh store load',async t=>{
  const {dir,memory,store}=await fixture(t),chat=store.create('codex'),note=await saved(memory,'Delete after interruption',chat.id),remove=memory.deleteChatNotes.bind(memory);memory.deleteChatNotes=async()=>{throw Error('Synthetic note lock');};
  const result=await deleteSavedConversation({store,memory,id:chat.id,deleteMemories:true});assert.equal(result.memoryDeletionPending,true);assert.ok(await memory.getNote(note.savedNote.id));memory.deleteChatNotes=remove;
  const loaded=new Store(dir);await loaded.init();assert.deepEqual(loaded.state.pendingChatMemoryDeletes,[chat.id]);assert.equal(loaded.state.conversations.length,0);
  const recovered=await finishPendingChatMemoryDeletes({store:loaded,memory});assert.equal(recovered[0].deletedNoteIds.length,1);assert.equal(await memory.getNote(note.savedNote.id),null);assert.deepEqual(loaded.state.pendingChatMemoryDeletes,[]);
});
test('a late storage failure retains tombstone IDs for idempotent recovery and sync',async t=>{
  const {memory,store}=await fixture(t),chat=store.create('codex'),note=await saved(memory,'Delete and publish a tombstone',chat.id),save=store.save.bind(store);let writes=0;store.save=async()=>{if(++writes===2)throw Error('Synthetic late failure');return save();};
  const result=await deleteSavedConversation({store,memory,id:chat.id,deleteMemories:true});assert.equal(result.memoryDeletionPending,true);assert.deepEqual(result.memoryChanges.deletedNoteIds,[note.savedNote.id]);store.save=save;
  let published;await finishPendingChatMemoryDeletes({store,memory,onChanges:async(_id,changes)=>{published=changes.deletedNoteIds;}});assert.deepEqual(published,[note.savedNote.id]);assert.deepEqual(store.state.pendingChatMemoryDeletes,[]);
});
test('pending deletion failures are reported and never prevent unrelated chats from opening',async t=>{
  const {memory,store}=await fixture(t),live=store.create('codex');store.state.pendingChatMemoryDeletes=['gone-chat',live.id];let reported=0;memory.deleteChatNotes=async()=>{throw Error('Synthetic persistent lock');};
  const results=await finishPendingChatMemoryDeletes({store,memory,onError:()=>reported++});assert.equal(reported,1);assert.equal(results[0].pending,true);assert.ok(store.conversation(live.id));assert.deepEqual(store.state.pendingChatMemoryDeletes,['gone-chat',live.id]);
});

test('publication failures replay deleted and detached note IDs before clearing the request',async t=>{
  const {memory,store}=await fixture(t),chat=store.create('codex'),exclusive=await saved(memory,'Exclusive receipt',chat.id),shared=await saved(memory,'Shared receipt',chat.id);await saved(memory,'Shared receipt','other-chat');const manual=await memory.note('Manual receipt');await saved(memory,'Manual receipt',chat.id);
  const pending=await deleteSavedConversation({store,memory,id:chat.id,deleteMemories:true,onChanges:async()=>{assert.ok(store.state.pendingChatMemoryDeletes.includes(chat.id));throw Error('Synthetic publication failure');}});
  assert.equal(pending.memoryDeletionPending,true);assert.equal(await memory.getNote(exclusive.savedNote.id),null);assert.deepEqual((await memory.getNote(shared.savedNote.id)).sourceChatIds,['other-chat']);
  let published;await finishPendingChatMemoryDeletes({store,memory,onChanges:async(_id,changes)=>published=changes});assert.deepEqual(published.deletedNoteIds,[exclusive.savedNote.id]);assert.deepEqual(new Set(published.updatedNoteIds),new Set([shared.savedNote.id,manual.id]));assert.deepEqual(await memory.pendingChatNoteDeletions(),[]);
});
test('durable SQL receipts recover even if the store request was already cleared',async t=>{
  const {memory,store}=await fixture(t),chat=store.create('codex'),note=await saved(memory,'Receipt after cleared store request',chat.id);store.state.conversations=[];await store.save();await memory.deleteChatNotes(chat.id);
  let changes;await finishPendingChatMemoryDeletes({store,memory,onChanges:async(_id,result)=>changes=result});assert.deepEqual(changes.deletedNoteIds,[note.savedNote.id]);assert.deepEqual(await memory.pendingChatNoteDeletions(),[]);
});
test('rollback preserves concurrent chats and unrelated pending requests',async t=>{
  const {memory,store}=await fixture(t),chat=store.create('codex');let other;const save=store.save.bind(store);store.save=async()=>{other=store.create('claude');store.state.pendingChatMemoryDeletes.push('other-request');throw Error('Synthetic concurrent failure');};
  await assert.rejects(deleteSavedConversation({store,memory,id:chat.id,deleteMemories:true}),/concurrent failure/);store.save=save;assert.ok(store.conversation(chat.id));assert.ok(store.conversation(other.id));assert.deepEqual(store.state.pendingChatMemoryDeletes,['other-request']);
});
test('recovery rollback preserves requests queued while a save was in progress',async t=>{
  const {memory,store}=await fixture(t);store.state.pendingChatMemoryDeletes=['gone'];const save=store.save.bind(store);store.save=async()=>{store.state.pendingChatMemoryDeletes.push('new-request');throw Error('Synthetic concurrent recovery failure');};
  const result=await finishPendingChatMemoryDeletes({store,memory});store.save=save;assert.equal(result[0].pending,true);assert.deepEqual(new Set(store.state.pendingChatMemoryDeletes),new Set(['gone','new-request']));
});
test('deletion reservations prevent run-start races and release their locks on failure',async t=>{
  const {memory,store}=await fixture(t),chat=store.create('codex');let entered,finish;const reached=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>finish=resolve),coordinator=new ChatDeletionCoordinator();
  const operation=deleteSavedConversation({store,memory,id:chat.id,deleteMemories:true,coordinator,beforeDelete:async()=>{entered();await wait;throw Error('Synthetic preflight failure');}});await reached;assert.throws(()=>coordinator.assertCanStart(),/Wait for chat deletion/);assert.throws(()=>coordinator.assertCanStart(chat.id),/Wait/);finish();await assert.rejects(operation,/preflight failure/);assert.doesNotThrow(()=>coordinator.assertCanStart());
  const release=coordinator.reserve(chat.id,{deleteMemories:false});assert.throws(()=>coordinator.assertCanStart(chat.id),/Wait/);assert.doesNotThrow(()=>coordinator.assertCanStart('unrelated-chat'));release();
  const running=new ChatDeletionCoordinator(()=>[chat.id]);assert.throws(()=>running.reserve(chat.id,{deleteMemories:true}),/Stop this chat/);
});
test('legacy sync clears unverifiable ownership while preserving the note and stable legacy payload',async t=>{
  const {memory}=await fixture(t),created=await saved(memory,'Created before a legacy sync edit','chat-a'),id=created.savedNote.id;
  await memory.applySyncedNote({id,text:created.savedNote.text,createdAt:created.savedNote.createdAt});
  const note=await memory.getNote(id);assert.equal(note.chatOwned,undefined);assert.equal(note.sourceChatIds,undefined);assert.deepEqual(portablePayload('note',note),{text:note.text,createdAt:note.createdAt});
  await memory.deleteChatNotes('chat-a');assert.ok(await memory.getNote(id));await assert.rejects(memory.applySyncedNote({id:'partial',text:'Invalid partial provenance',chatOwned:true}),/together/);
});
