import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeChatTitle,chatMetadata,prepareConversationTitle,updateConversation,orderedPins,compareChats,movePinnedConversation} from '../desktop/chat-management.mjs';
import {Store} from '../desktop/store.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('new chats use a neutral pending title, while legacy and manual names stay unchanged', () => {
  const chat = new Store('.').create('codex');
  assert.equal(chat.title, 'New chat'); assert.equal(chat.titleSource, 'pending');
  assert.deepEqual(chatMetadata(chat), {pinned:false,archived:false,titleSource:'pending'});
  for (const old of [{id:'a',title:'My chosen name',messages:[]}, {id:'b',title:'New chat',titleSource:'manual',messages:[]}, {id:'c',title:'Long original request',messages:[{role:'user'}]}]) {
    const before=JSON.stringify(old); prepareConversationTitle(old); assert.equal(JSON.stringify(old),before);
  }
  assert.equal(prepareConversationTitle({title:'New chat',messages:[]}).titleSource,'pending');
  assert.deepEqual(chatMetadata({title:'Old chat'}),{});
});

test('manual titles are bounded single-line Unicode text and can be changed during a reply', () => {
  const chat={id:'a',title:'New chat',titleSource:'pending'};
  updateConversation(chat,'rename',{title:'  Meine   🌙 Planung  '},{active:true});
  assert.equal(chat.title,'Meine 🌙 Planung');assert.equal(chat.titleSource,'manual');
  assert.equal(normalizeChatTitle('🌙'.repeat(80)),'🌙'.repeat(80));
  for(const title of ['', ' '.repeat(20), 'x'.repeat(81), 'line\nline', 'bad\u202etext', null]) assert.throws(()=>normalizeChatTitle(title),/single-line/);
});

test('pin and archive are strict flags; active chats cannot be archived and transcripts survive restore', () => {
  const chat={id:'a',messages:[{id:'m',role:'user',content:'Keep this history'}]}, messages=chat.messages;
  updateConversation(chat,'pin',{pinned:true},{active:true});assert.equal(chat.pinned,true);
  assert.throws(()=>updateConversation(chat,'archive',{archived:true},{active:true}),/Stop this chat/);
  updateConversation(chat,'archive',{archived:true});assert.equal(chat.archived,true);assert.equal(chat.messages,messages);
  updateConversation(chat,'archive',{archived:false});assert.equal(chat.archived,false);assert.equal(chat.pinned,true);
  for(const [action,payload] of [['pin',{pinned:'true'}],['archive',{archived:1}],['delete',{}]]) assert.throws(()=>updateConversation(chat,action,payload));
});

test('manual pin order survives replies, skips archived pins and appends newly pinned chats',()=>{
  const chats=[{id:'a',pinned:true,updatedAt:'2026-10-13'},{id:'b',pinned:true,updatedAt:'2026-10-14'},{id:'archived',pinned:true,archived:true,updatedAt:'2026-10-12'},{id:'new',pinned:false,updatedAt:'2026-10-15'}];
  orderedPins(chats);
  const order=()=>chats.filter(c=>c.pinned&&!c.archived).sort(compareChats).map(c=>c.id);
  assert.deepEqual(order(),['b','a']);
  chats[0].updatedAt='2026-10-16';assert.deepEqual(order(),['b','a']);
  movePinnedConversation(chats,{id:'a',direction:'up'});assert.deepEqual(order(),['a','b']);
  const metadata=chats.map(chatMetadata);assert.equal(metadata[0].pinnedOrder,0);assert.equal(metadata[1].pinnedOrder,1);
  movePinnedConversation(chats,{id:'a',direction:'up'});assert.deepEqual(order(),['a','b']);
  updateConversation(chats[3],'pin',{pinned:true},{conversations:chats});assert.deepEqual(order(),['a','b','new']);
  movePinnedConversation(chats,{id:'b',direction:'down'});assert.deepEqual(order(),['a','new','b']);
  updateConversation(chats[3],'pin',{pinned:false},{conversations:chats});assert.equal(chatMetadata(chats[3]).pinnedOrder,undefined);
  assert.throws(()=>movePinnedConversation(chats,{id:'new',direction:'up'}),/Pin this chat/);
  assert.throws(()=>movePinnedConversation(chats,{id:'a',direction:'sideways'}),/up or down/);
});

test('dropping pins before and after distant targets preserves other lists and transcript recency',()=>{
  const chats = [
    {id:'a',pinned:true,pinnedOrder:0,updatedAt:'2026-10-10'},
    {id:'x',pinned:true,archived:true,pinnedOrder:1,updatedAt:'2026-10-09'},
    {id:'b',pinned:true,pinnedOrder:2,updatedAt:'2026-10-11'},
    {id:'c',pinned:true,pinnedOrder:3,updatedAt:'2026-10-12'},
    {id:'y',pinned:true,archived:true,pinnedOrder:4,updatedAt:'2026-10-08'},
    {id:'recent',updatedAt:'2026-10-17'}, {id:'older',updatedAt:'2026-10-16'}
  ];
  const order=archived=>chats.filter(chat=>chat.pinned&&!!chat.archived===archived).sort(compareChats).map(chat=>chat.id);
  const dates=chats.map(chat=>chat.updatedAt);
  movePinnedConversation(chats,{id:'c',targetId:'a',placement:'before'});
  assert.deepEqual(order(false),['c','a','b']);
  assert.deepEqual(order(true),['x','y']);
  assert.equal(chats.find(chat=>chat.id==='x').pinnedOrder,1);
  movePinnedConversation(chats,{id:'c',targetId:'b',placement:'after'});
  assert.deepEqual(order(false),['a','b','c']);
  movePinnedConversation(chats,{id:'a',targetId:'c',placement:'after'});
  assert.deepEqual(order(false),['b','c','a']);
  movePinnedConversation(chats,{id:'y',targetId:'x',placement:'before'});
  assert.deepEqual(order(true),['y','x']);
  assert.deepEqual(order(false),['b','c','a']);
  assert.deepEqual(chats.map(chat=>chat.updatedAt),dates);
  assert.deepEqual(chats.filter(chat=>!chat.pinned).sort(compareChats).map(chat=>chat.id),['recent','older']);
  const before=JSON.stringify(chats);
  movePinnedConversation(chats,{id:'b',targetId:'b',placement:'after'});
  assert.equal(JSON.stringify(chats),before);
});

test('stale, cross-list and malformed pin drops are rejected without changing saved order',()=>{
  const chats=[{id:'a',pinned:true},{id:'b',pinned:true,archived:true},{id:'c',pinned:false}];
  const before=JSON.stringify(chats);
  for(const payload of [
    {id:'a',targetId:'b',placement:'before'}, {id:'a',targetId:'c',placement:'after'},
    {id:'a',targetId:'missing',placement:'before'}, {id:'c',targetId:'a',placement:'after'},
    {id:'a',targetId:'a',placement:'middle'}, {id:'a',targetId:'a',placement:'before',direction:'up'}
  ]) { assert.throws(()=>movePinnedConversation(chats,payload)); assert.equal(JSON.stringify(chats),before); }
});

test('drag order is durable across store reloads and subsequent replies',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-pin-order-'));
  try {
    const store=new Store(dir);await store.init();
    const chats=['a','b','c'].map((id,pinnedOrder)=>({id,pinned:true,pinnedOrder,provider:'codex',title:id,updatedAt:'2026-10-10',messages:[],sessions:{}}));
    store.state.conversations=chats;
    movePinnedConversation(chats,{id:'c',targetId:'a',placement:'before'});await store.save();
    const restored=new Store(dir);await restored.init();
    assert.deepEqual(restored.state.conversations.sort(compareChats).map(chat=>chat.id),['c','a','b']);
    restored.conversation('b').updatedAt='2026-10-17';await restored.save();
    const afterReply=new Store(dir);await afterReply.init();
    assert.deepEqual(afterReply.state.conversations.sort(compareChats).map(chat=>chat.id),['c','a','b']);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    assert.match(path.basename(dir),/^exomina-pin-order-/);
    await rm(dir,{recursive:true,force:true});
  }
});
