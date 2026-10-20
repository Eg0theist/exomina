import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../desktop/note-store.mjs';
import {memoryQuery,rankMemories} from '../desktop/memory-relevance.mjs';

test('ranked recall evaluates concrete query coverage instead of global importance or newest-only order',()=>{
 const rows=[
  {seq:1,id:'target',text:'Phoenix desktop export verified; restore remains unverified.',sourceChatIds:['project']},
  {seq:100,id:'recent',text:'Phoenix bird illustration reference.'},
  {seq:90,id:'preference',text:'Always prefer Phoenix mythology in fiction.'},
  {seq:2,id:'target2',text:'Chose a 30% reserve for catchup subscription usage.'},
  {seq:101,id:'other',text:'Catchup presentation notes for tomorrow.'}
 ];
 const cases=[['Phoenix export','target'],['desktop restore','target'],['subscription reserve','target2'],['catchup usage','target2'],['bird illustration','recent'],['mythology fiction','preference']];
 assert.equal(cases.filter(([query,id])=>rankMemories(rows,query)[0]?.id===id).length,cases.length);
 assert.equal(rankMemories(rows,'Phoenix export')[0].match.kind,'outcome');assert.equal(rankMemories(rows,'subscription reserve')[0].match.kind,'decision');
  assert.deepEqual(memoryQuery('für Überprüfung export.zip').terms,['überprüfung','export.zip']);
  assert.deepEqual(memoryQuery('find notes about AI').terms,['ai']);
});
test('same-chat provenance is only a tie break after matching terms',()=>{
 const rows=[{id:'same',seq:9,text:'export',sourceChatIds:['p']},{id:'relevant',seq:1,text:'export restore',sourceChatIds:['other']}];
 assert.equal(rankMemories(rows,'export restore',{conversationId:'p'})[0].id,'relevant');
 assert.equal(rankMemories(rows,'export',{conversationId:'p'})[0].id,'same');
});
test('original notes, dates, provenance and summaries are unchanged; deletion and new-only filters apply',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-relevance-')),store=new MemoryStore(dir);
 try{
  await store.note('Phoenix export verified; restore unverified.',{conversationId:'project'});await store.note('Phoenix mythology preference.');
  const before=await store.list();const found=await store.recall('Phoenix restore',{conversationId:'project'});
  assert.equal(found[0].text,before[1].text);assert.equal(found[0].match.sameChat,true);assert.equal(found[0].date,before[1].date);
  assert.deepEqual(await store.list(),before);assert.ok(!Object.hasOwn(before[1],'match'));
  await store.review([found[0].id]);assert.equal((await store.recall('restore',{newOnly:true})).length,0);
  await store.remove(found[0].id);assert.equal((await store.recall('restore')).length,0);
  assert.deepEqual(await store.recall(''),await store.list());
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
