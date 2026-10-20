import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {MemoryStore} from '../desktop/note-store.mjs';
import {memoryConflicts} from '../desktop/memory-evidence.mjs';

test('confirmation and correction links preserve source notes, demote stale recall and survive reopening',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-evidence-test-'));assert.equal(path.dirname(dir),os.tmpdir());t.after(()=>rm(dir,{recursive:true,force:true}));let store=new MemoryStore(dir);
 const first=await store.note('Catchup allowance reserve is 50%.',{conversationId:'earlier'}),second=await store.note('Catchup allowance reserve is 30%.',{conversationId:'correction'});const before=await store.list();
 assert.equal((await store.quality('catchup allowance')).conflicts.length,1);
 await store.recordEvidence({id:first.id,otherId:second.id,action:'superseded'});await store.recordEvidence({id:second.id,action:'confirm'});
 assert.equal((await store.recall('catchup allowance reserve'))[0].id,second.id);assert.equal((await store.recall('50%'))[0].evidence.supersededBy.text,before[0].text);assert.deepEqual(await store.list(),before);assert.equal(store.wake().corrections[0].newerId,second.id);
 await assert.rejects(store.recordEvidence({id:second.id,otherId:first.id,action:'superseded'}),/cycle/);store.close();store=new MemoryStore(dir);await store.init();assert.ok((await store.recall('30%'))[0].evidence.confirmedAt);await store.recordEvidence({id:first.id,otherId:second.id,action:'clear'});assert.equal(store.wake().corrections,undefined);store.close();
});
test('different topic quantities do not become proven contradictions or erase source material',()=>{const a={id:'a',text:'Phoenix export preview size is 256 MB.'},b={id:'b',text:'Phoenix export preview size is 512 MB.'},c={id:'c',text:'Bird illustration uses 12 GB.'};const pairs=memoryConflicts([a,b,c]);assert.equal(pairs.length,1);assert.match(pairs[0].notice,/Possible/);assert.equal(memoryConflicts([a,b],{ignored:new Set(['a:b'])}).length,0);});
test('historical project facts rank above distractors in representative recall queries',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-evidence-queries-'));assert.equal(path.dirname(dir),os.tmpdir());const store=new MemoryStore(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const facts=[['reserve','Alex intended 30% allowance left; catchup protects that reserve.'],['phone','Phone relay uses Tailscale Serve: tailnet-only HTTPS. PC must stay awake.'],['backup','Context import has a 256 MB JSON limit; attachment contents require a separate transfer.'],['orchestration','Automatic orchestration reviews evidence, requests revisions and advances dependencies. Human review optional.'],['model','Luna produced 706 bytes against a 512-byte summary limit. Sol saved 12 summaries.']];const ids=new Map();for(const[k,text]of facts)ids.set(k,(await store.note(text)).id);
 for(const text of ['A phone illustration in purple.','A model railway planned for next month.','Book review notes about automatic writing.','A data transfer cable was misplaced.'])await store.note(text);
 const queries=[['allowance reserve','reserve'],['Tailscale relay','phone'],['JSON import 256','backup'],['orchestration evidence revisions','orchestration'],['Luna summary bytes','model']];for(const[q,k]of queries)assert.equal((await store.recall(q))[0].id,ids.get(k),q);
});
