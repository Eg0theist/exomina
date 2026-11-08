import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {MemoryStore} from '../desktop/note-store.mjs';

async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'memory-chain-regression-')),store=new MemoryStore(dir);await store.init();t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return store;}
const add=(store,id,text)=>store.note(text,{id});
const correct=(store,id,otherId)=>store.recordEvidence({id,otherId,action:'superseded'});

test('recall and relevant context follow a multi-step correction whose successors omit the original query',async t=>{
  const store=await fixture(t);
  await add(store,'a','Mistral Relay uses the south endpoint.');await add(store,'b','Correction: that endpoint is west.');await add(store,'c','Final correction: that endpoint is east.');
  await correct(store,'a','b');await correct(store,'b','c');
  const before=await store.list(),[row]=await store.recall('Mistral Relay');
  assert.equal(row.id,'a');assert.equal(row.evidence.supersededBy.id,'c');assert.equal(row.evidence.supersession.status,'resolved');
  assert.deepEqual(row.evidence.supersession.links.map(link=>[link.olderId,link.newerId]),[['a','b'],['b','c']]);
  const brief=await store.brief({query:'Mistral Relay',stableBytes:0});assert.match(brief.relevant,/that endpoint is east/);assert.match(brief.relevant,/Mistral Relay/);assert.match(brief.relevant,/"hops":2/);
  assert.deepEqual(await store.list(),before,'following corrections preserves all original notes');
});

test('divergent correction branches remain ambiguous and convergence is resolved',async t=>{
  const store=await fixture(t);for(const [id,text]of [['a','Winterglass endpoint is north.'],['b','One correction says east.'],['c','Another correction says west.'],['d','Owner resolved both corrections to south.']])await add(store,id,text);
  await correct(store,'a','b');await correct(store,'a','c');let [row]=await store.recall('Winterglass');
  assert.equal(row.evidence.supersededBy,null);assert.equal(row.evidence.supersession.status,'ambiguous');assert.deepEqual(new Set(row.evidence.supersession.terminalCandidates.map(item=>item.id)),new Set(['b','c']));
  const brief=await store.brief({query:'Winterglass',stableBytes:0});assert.match(brief.relevant,/No single current correction/);assert.match(brief.relevant,/east/);assert.match(brief.relevant,/west/);
  await correct(store,'b','d');await correct(store,'c','d');[row]=await store.recall('Winterglass');assert.equal(row.evidence.supersededBy.id,'d');assert.equal(row.evidence.supersession.links.length,4);
});

test('deleted intermediate notes cannot bridge correction inheritance or expose their text',async t=>{
  const store=await fixture(t);await add(store,'a','Nightjar limit is 3.');await add(store,'b','Private intermediate text.');await add(store,'c','Final limit is 5.');await correct(store,'a','b');await correct(store,'b','c');await store.remove('b');
  const [row]=await store.recall('Nightjar');assert.equal(row.evidence.supersededBy,null);assert.equal(row.evidence.supersession.status,'unresolved');assert.deepEqual(row.evidence.supersession.unavailableTargets,['b']);assert.equal(row.evidence.supersession.links[0].unavailable,true);assert.doesNotMatch(JSON.stringify(row),/Private intermediate|Final limit/);
});

test('an unavailable branch prevents a surviving correction being declared uniquely current',async t=>{
 const store=await fixture(t);await add(store,'source','Cloudberry original interval is 12.');await add(store,'removed','Removed private interval correction.');await add(store,'live','A separate correction says interval 19.');
 await correct(store,'source','removed');await correct(store,'source','live');await store.remove('removed');
 const [row]=await store.recall('Cloudberry');assert.equal(row.evidence.supersededBy,null);assert.equal(row.evidence.supersession.status,'unresolved');assert.deepEqual(row.evidence.supersession.unavailableTargets,['removed']);assert.equal(row.evidence.supersession.terminalCandidates[0].id,'live');assert.doesNotMatch(JSON.stringify(row),/Removed private/);
 const brief=await store.brief({query:'Cloudberry',stableBytes:0});assert.match(brief.relevant,/No single current correction/);assert.match(brief.relevant,/unavailable/);
});

test('cycles and excessive correction paths are unresolved rather than a false current result',async t=>{
  const store=await fixture(t);await add(store,'a','Cyclic source sentinel.');await add(store,'b','Second cyclic source.');await correct(store,'a','b');await assert.rejects(correct(store,'b','a'),/cycle/);
  // Corrupt legacy data is still read conservatively; normal writes reject this cycle.
  store.db.prepare('INSERT INTO note_relations VALUES(?,?,?,?)').run('b','a','superseded','2026-01-01T00:00:00.000Z');
  const [cyclic]=await store.recall('sentinel');assert.equal(cyclic.evidence.supersededBy,null);assert.equal(cyclic.evidence.supersession.status,'unresolved');assert.equal(cyclic.evidence.supersession.reason,'cycle');
  const notes=[];for(let i=0;i<67;i++){const id=`chain-${i}`;await add(store,id,i===0?'Longpath sentinel marker.':`Unrelated correction ${i}.`);notes.push(id);if(i)await correct(store,notes[i-1],id);}
  const [long]=await store.recall('Longpath');assert.equal(long.evidence.supersededBy,null);assert.equal(long.evidence.supersession.status,'unresolved');assert.equal(long.evidence.supersession.truncated,true);assert.ok(long.evidence.supersession.links.length<=128);
});

test('historical date applicability is preserved while an explicit correction replaces a factual error',async t=>{
  const store=await fixture(t),entity=await store.knowledgeOperation({action:'define',name:'Redwood',type:'project'});
  await add(store,'a','Redwood retention before August is 20 days.');await add(store,'b','Redwood correction: historical retention before August was 25 days.');
  for(const noteId of ['a','b'])await store.knowledgeOperation({action:'link',noteId,entityId:entity.id,predicate:'retention',validTo:'2026-08-01'});
  await correct(store,'a','b');const rows=await store.recall('Redwood',{asOf:'2026-07-01'});assert.equal(rows[0].id,'b');assert.ok(rows.every(row=>row.knowledge[0].applicable));assert.equal((await store.recall('Redwood',{asOf:'2026-09-01'})).length,0);
});

test('a correction valid only later does not silently replace a valid historical record',async t=>{
 const store=await fixture(t),entity=await store.knowledgeOperation({action:'define',name:'Hawthorn',type:'project'});
 await add(store,'earlier','Hawthorn export format in June was text.');await add(store,'later','Hawthorn export format from July is binary.');
 await store.knowledgeOperation({action:'link',noteId:'earlier',entityId:entity.id,predicate:'export format',validTo:'2026-07-01'});
 await store.knowledgeOperation({action:'link',noteId:'later',entityId:entity.id,predicate:'export format',validFrom:'2026-07-01'});
 await correct(store,'earlier','later');const [historical]=await store.recall('Hawthorn',{asOf:'2026-06-15'});
 assert.equal(historical.id,'earlier');assert.equal(historical.evidence.supersededBy,null);assert.equal(historical.evidence.supersession.status,'outside-validity');assert.equal(historical.evidence.supersession.terminalCandidates[0].knowledge[0].applicable,false);
 assert.equal((await store.recall('Hawthorn',{asOf:'2026-07-15'}))[0].id,'later');
});
