import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../desktop/note-store.mjs';
import {rankMemories} from '../desktop/memory-relevance.mjs';

async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-knowledge-')),store=new MemoryStore(dir);await store.init();t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return store;}
const op=(store,input)=>store.knowledgeOperation(input);
const entity=(store,name='Aurora',aliases=['Old Lantern'])=>op(store,{action:'define',name,type:'project',aliases});
const note=(store,id,text)=>store.note(text,{id,conversationId:'synthetic-project'});
const link=(store,noteId,entityId,extra={})=>op(store,{action:'link',noteId,entityId,predicate:'status',...extra});

test('explicit entity aliases retrieve linked originals with dates and source provenance',async t=>{
 const store=await fixture(t);await note(store,'original','The desktop export passed its local acceptance.');const before=await store.list();const e=await entity(store);await link(store,'original',e.id);
 const rows=await store.recall('Old Lantern');assert.equal(rows[0].id,'original');assert.deepEqual(rows[0].sourceChatIds,['synthetic-project']);assert.deepEqual(rows[0].match.entities,['Aurora']);assert.equal(rows[0].knowledge[0].entity.type,'project');assert.equal(rows[0].knowledge[0].basis,'owner-recorded annotation; not external verification');assert.deepEqual(await store.list(),before);
 const brief=await store.brief({query:'Old Lantern',stableBytes:0});assert.match(brief.relevant,/desktop export/);assert.match(brief.relevant,/owner-recorded annotation/);
});

test('same alias preserves distinct typed identities and exact token boundaries',async t=>{
 const store=await fixture(t);const a=await entity(store,'Aurora',['ACME']),b=await entity(store,'Acme Research',['ACME']);await note(store,'a','Research archive at the northern site.');await note(store,'b','The southern facility uses a different archive.');await link(store,'a',a.id);await link(store,'b',b.id);
 const result=await op(store,{query:'ACME'});assert.equal(result.entities.length,2);assert.equal(result.ambiguous,true);const rows=await store.recall('ACME');assert.equal(rows.length,2);assert.ok(rows.every(row=>row.match.ambiguousEntity));assert.equal((await store.recall('acmecology')).length,0);
});

test('validity uses explicit inclusive start and exclusive end, never the note recording date',async t=>{
 const store=await fixture(t);const e=await entity(store);await note(store,'old','Aurora exports use format v1.');await note(store,'new','Aurora exports use format v2.');await link(store,'old',e.id,{validFrom:'2026-01-01',validTo:'2026-06-01'});await link(store,'new',e.id,{validFrom:'2026-06-01'});
 assert.deepEqual((await store.recall('Old Lantern',{asOf:'2026-05-31'})).map(row=>row.id),['old']);assert.deepEqual((await store.recall('Aurora',{asOf:'2026-06-01'})).map(row=>row.id),['new']);assert.equal((await store.recall('Old Lantern')).length,2);
 await assert.rejects(()=>link(store,'old',e.id,{validFrom:'2026-06-01',validTo:'2026-01-01'}),/follow/);await assert.rejects(()=>store.recall('Aurora',{asOf:'2026-02-31'}),/ISO/);
});

test('changed source invalidates fact annotation until explicitly reviewed and relinked',async t=>{
 const store=await fixture(t);const e=await entity(store);await note(store,'a','A locally reviewed status.');await link(store,'a',e.id);await store.applySyncedNote({id:'a',text:'A different synchronized claim.',createdAt:'2026-05-01T00:00:00Z'});
 const result=await op(store,{noteId:'a'});assert.equal(result.facts[0].stale,true);assert.equal(result.facts[0].applicable,false);assert.equal((await store.recall('Old Lantern',{asOf:'2026-07-01'})).length,0);await link(store,'a',e.id);assert.equal((await op(store,{noteId:'a'})).facts[0].stale,false);
});

test('dependency impact is transitive, cycles refused and deleted notes cannot leak',async t=>{
 const store=await fixture(t);for(const id of ['source','draft','report'])await note(store,id,`Synthetic ${id} original.`);await op(store,{action:'depends',sourceId:'source',dependentId:'draft'});await op(store,{action:'depends',sourceId:'draft',dependentId:'report'});
 assert.deepEqual((await op(store,{noteId:'source'})).dependents.map(row=>row.id),['report','draft']);await assert.rejects(()=>op(store,{action:'depends',sourceId:'report',dependentId:'source'}),/cycle/);await store.remove('draft');assert.deepEqual((await op(store,{noteId:'source'})).dependents,[]);
});

test('delete and clear remove fact links; tombstones do not resurrect annotations',async t=>{
 const store=await fixture(t);const e=await entity(store);await note(store,'a','A synthetic retained original.');await link(store,'a',e.id);await store.remove('a');await store.applySyncedNote({id:'a',text:'A stale restored note.',createdAt:'2026-05-01T00:00:00Z'});assert.equal((await store.recall('Old Lantern')).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_fact_links').get().n,0);await store.clear();assert.equal((await op(store,{})).entities.length,0);
});

test('chat-note deletion purges annotations without altering shared independent sources',async t=>{
 const store=await fixture(t);const e=await entity(store);await note(store,'owned','Only one synthetic chat owns this.');await link(store,'owned',e.id);await store.deleteChatNotes('synthetic-project');assert.equal((await store.recall('Old Lantern')).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_fact_links').get().n,0);
});

test('knowledge tool is read-only even if callers smuggle mutation fields',async t=>{
 const store=await fixture(t);const result=await store.call('memory_knowledge',{action:'define',name:'Intruder',type:'person'},()=>{throw Error('not used');});assert.equal(result.isError,false);assert.equal((await op(store,{})).entities.length,0);assert.ok(store.definitions.some(tool=>tool.name==='memory_knowledge'));
});

test('annotations persist across store reopen and forgotten entities leave originals intact',async t=>{
 const store=await fixture(t);const e=await entity(store);await note(store,'a','Original remains after annotation removal.');await link(store,'a',e.id);const dir=path.dirname(store.dir);store.close();const reopened=new MemoryStore(dir);await reopened.init();t.after(()=>reopened.close());assert.equal((await reopened.recall('Old Lantern'))[0].id,'a');await op(reopened,{action:'forget',id:e.id});assert.equal((await reopened.recall('Old Lantern')).length,0);assert.equal((await reopened.getNote('a')).text,'Original remains after annotation removal.');reopened.close();
});

test('new-only filtering and correction precedence also cover alias candidates',async t=>{
 const store=await fixture(t);const e=await entity(store);await note(store,'old','Previous wording.');await note(store,'new','Current corrected wording.');await link(store,'old',e.id);await link(store,'new',e.id);await store.recordEvidence({id:'old',otherId:'new',action:'superseded'});const rows=await store.recall('Old Lantern');assert.equal(rows[0].id,'new');assert.equal(rows[1].evidence.supersededBy.id,'new');await store.review(['new']);assert.deepEqual((await store.recall('Old Lantern',{newOnly:true})).map(row=>row.id),['old']);
});

test('bounded held-out alias/validity comparison preserves baseline literal recall and handles distractors',async t=>{
 const store=await fixture(t),cases=[];
 // Independent task instances: aliases, surface wording, and historical dates differ.
 for(const [index,alias] of ['Morgenstern','Copper Finch','Nacre','Kite Lab','Juniper','灰色'].entries()){
  const e=await entity(store,`Project ${index}`,[alias]);await note(store,`historical-${index}`,`Version ${index} used the legacy import layout.`);await note(store,`current-${index}`,`Version ${index+1} uses the reviewed import layout.`);await link(store,`historical-${index}`,e.id,{validTo:'2026-07-01'});await link(store,`current-${index}`,e.id,{validFrom:'2026-07-01'});cases.push([alias,'2026-06-30',`historical-${index}`],[alias,'2026-07-01',`current-${index}`]);
 }
 for(let n=0;n<12;n++)await note(store,`distractor-${n}`,`Unrelated import layout task ${n}.`);
 const originals=await store.list();const baseline=cases.filter(([query,,expected])=>rankMemories(originals,query)[0]?.id===expected).length;let candidate=0;for(const [query,asOf,expected] of cases)if((await store.recall(query,{asOf}))[0]?.id===expected)candidate++;
 assert.equal(baseline,0);assert.equal(candidate,12);assert.equal((await store.recall('Unrelated import layout task 11'))[0].id,'distractor-11');assert.deepEqual(await store.list(),originals);
});

test('knowledge pagination covers entities and notes without omissions or duplication',async t=>{
 const store=await fixture(t);for(let n=0;n<23;n++){const e=await entity(store,`Entity ${n}`,['Common Alias']);await note(store,`n${n}`,`Independent original number ${n}.`);await link(store,`n${n}`,e.id);}
 const ids=[],notes=[];let offset=0;while(true){const page=await op(store,{query:'Common Alias',offset,limit:7});ids.push(...page.entities.map(item=>item.id));notes.push(...page.notes.map(item=>item.id));if(page.nextOffset===null)break;offset=page.nextOffset;}
 assert.equal(ids.length,23);assert.equal(new Set(ids).size,23);assert.equal(notes.length,23);assert.equal(new Set(notes).size,23);await assert.rejects(()=>op(store,{offset:-1}),/valid knowledge page/);
});

test('a fully named entity disambiguates an embedded alias while a separate alias mention stays ambiguous',async t=>{
 const store=await fixture(t),organization=await entity(store,'Falcon Works',['Meridian']),project=await entity(store,'Meridian platform',['Meridian']);
 await note(store,'org','The company archive is in zone 2.');await note(store,'project','The platform archive is in zone 8.');await link(store,'org',organization.id);await link(store,'project',project.id);
 let rows=await store.recall('Where is the Meridian platform archive?');assert.equal(rows[0].id,'project');assert.deepEqual(rows[0].match.entities,['Meridian platform']);assert.equal(rows[0].match.ambiguousEntity,false);assert.ok(rows[0].knowledge[0].entity.matchedAs.some(binding=>binding.kind==='name'&&binding.text==='Meridian platform'));
 rows=await store.recall('Where is Meridian archive?');assert.ok(rows.every(row=>row.match.ambiguousEntity));assert.equal(rows.length,2);
 const both=await op(store,{query:'Compare Meridian platform and Meridian archives'});assert.equal(both.entities.length,2);assert.equal(both.ambiguous,true);
});

test('alias-bound recall and prompt context explicitly carry the owner-recorded alias relationship',async t=>{
 const store=await fixture(t),e=await entity(store,'Tamarind system',['Sandpiper']);await note(store,'source','The reviewed port is 6812.');await link(store,'source',e.id);
 const [row]=await store.recall('Sandpiper');assert.deepEqual(row.knowledge[0].entity.aliases,['Sandpiper']);assert.deepEqual(row.knowledge[0].entity.matchedAs,[{text:'Sandpiper',kind:'alias'}]);
 const brief=await store.brief({query:'Sandpiper',stableBytes:0});assert.match(brief.relevant,/Sandpiper/);assert.match(brief.relevant,/Tamarind system/);assert.match(brief.relevant,/owner-recorded annotation/);
});
