import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../desktop/memory.mjs';
async function store(t){const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-recall-'));const s=new MemoryStore(dir);t.after(async()=>{s.close();await rm(dir,{recursive:true,force:true})});await s.init();return s;}
const recall=async(s,args)=>{const r=await s.call('memory_recall',args);assert.equal(r.isError,false);return JSON.parse(r.content[0].text);};
test('memory_recall pages broad queries and follows nextOffset without gaps or repeats',async t=>{
 const s=await store(t);for(let n=1;n<=120;n++)await s.note(`Launch note ${n}: ${'x'.repeat(200)}`);await s.note('Unrelated');
 const first=await recall(s,{query:'launch'});assert.equal(first.results.length,20);assert.equal(first.total,120);assert.equal(first.offset,0);assert.equal(first.nextOffset,20);
 const seen=new Set();let page=first,pages=0;
 while(true){pages++;assert.ok(JSON.stringify(page).length<26000);for(const r of page.results){assert.ok(!seen.has(r.id));seen.add(r.id);}if(page.nextOffset===null)break;page=await recall(s,{query:'launch',offset:page.nextOffset,limit:50});}
 assert.equal(seen.size,120);assert.ok(pages>=3);
 // The UI search keeps its unpaged array.
 assert.equal((await s.recall('launch')).length,120);
});
test('memory_recall keeps each page within the character budget and truncates long source lists',async t=>{
 const s=await store(t);const chats=Array.from({length:40},(_,n)=>`chat-${n}`);
 for(let n=1;n<=60;n++){await s.note(`Budget note ${n} ${'y'.repeat(250)}`);}
 const many=await s.note('Budget shared note');for(const c of chats)await s.note('Budget shared note',{conversationId:c});
 const page=await recall(s,{query:'budget',limit:50});assert.ok(page.results.length<50);assert.ok(JSON.stringify(page.results).length<=24000);assert.equal(page.nextOffset,page.results.length);
 const shared=(await recall(s,{query:'budget shared note'})).results.find(r=>r.id===many.id);assert.equal(shared.sourceChatIds.length,8);assert.equal(shared.sourceChatCount,40);
});
test('memory_recall rejects invalid paging arguments',async t=>{
 const s=await store(t);await s.note('Anything');
 for(const args of [{query:'a',offset:-1},{query:'a',limit:0},{query:'a',limit:51},{query:'a',offset:1.5}])await assert.rejects(()=>s.call('memory_recall',args),/valid/);
 assert.ok(s.definitions.find(d=>d.name==='memory_recall').inputSchema.properties.offset);
});
