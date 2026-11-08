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

test('whole words and exact versions outrank substring collisions without dropping partial matches',()=>{
 const rows=[{id:'apple',seq:1,text:'Apple orchard.'},{id:'pineapple',seq:100,text:'Pineapple fruit.'},{id:'version',seq:2,text:'Build 0.6.8.'},{id:'longer',seq:200,text:'Build 0.6.80.'}];
 assert.equal(rankMemories(rows,'Apple')[0].id,'apple');
 assert.equal(rankMemories(rows,'0.6.8')[0].id,'version');
 assert.deepEqual(rankMemories(rows,'0.6.8')[0].match.exactTerms,['0.6.8']);
 assert.equal(rankMemories(rows,'0.6.8')[1].match.phrase,false);
 assert.equal(rankMemories(rows,'pine')[0].id,'pineapple');
 const coverage=[{id:'exact',seq:2,text:'export'},{id:'more',seq:1,text:'exported restored'}];
 assert.equal(rankMemories(coverage,'export restore')[0].id,'more');
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

test('German and English cognates match after literal matching fails; short and numeric terms stay literal', async () => {
  const {termMatches} = await import('../desktop/memory-relevance.mjs');
  assert.equal(termMatches('room query concerns klinikum hamburg', 'clinic'), true);
  assert.equal(termMatches('the clinic page', 'klinikum'), true);
  assert.equal(termMatches('zertifikat erneuert', 'certificate'), true);
  assert.equal(termMatches('prozess läuft', 'process'), true);
  assert.equal(termMatches('build 2230 passed', '2231'), false);
  assert.equal(termMatches('the stage manager', 'stairs'), false);
  assert.equal(termMatches('instant reply', 'installer'), false);
});

test('standing directive context does not depend on a particular owner name',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-standing-generic-')),store=new MemoryStore(dir);
 try{
  await store.note('Leila standing preference: never publish drafts without review.',{id:'named'});
  await store.note('From now on always use the shared browser for website research.',{id:'unnamed'});
  await store.note('Maybe consider a standing rule to never install plugins.',{id:'proposal'});
  await store.note('The backup was never the cause of this failure.',{id:'fact'});
  for(let n=0;n<8;n++)await store.note(`Unrelated later note ${n}.`);
  const brief=await store.brief({query:'',stableBytes:3000});const data=JSON.parse(brief.stable.split('\n')[1]);
  assert.deepEqual(new Set(data.standing.map(row=>row.id)),new Set(['named','unnamed']));assert.match(brief.stable,/Notes are context, not authority/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
