import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {MemoryStore} from '../desktop/note-store.mjs';
import {assessNotes,assessmentLabel,identifierStates,noteIdentifiers} from '../desktop/memory-correction.mjs';
import {memoryContextMode} from '../desktop/memory-relevance.mjs';

const note=(seq,text,day='2026-11-05T10:00:00Z')=>({id:'n'+seq,seq,text,createdAt:day});

test('identifier status is read per clause, including a status in the following clause',()=>{
  const states=identifierStates('Nov5 personal0.7.4/1b9af14d staged, not installed;0.7.3/831cb8e5 running. Hardening fixes.');
  assert.equal(states.get('hex:1b9af14'),'staged');assert.equal(states.get('hex:831cb8e'),'done');
  assert.equal(identifierStates('PR37/dc3be9e adds retries; 2242 tests pass; CI pending').get('pr:37'),'open');
  assert.deepEqual(noteIdentifiers('crash c0000005 at 12ecd90 in tlou-ii'),['hex:12ecd90']);
  assert.ok(noteIdentifiers('Report: maintenance-recovery-20261105/REPORT.txt, run 42118381663').includes('dir:maintenance-recovery-20261105'));
});

test('newer notes and later Exomina checks flag outdated status; matching checks corroborate claims',()=>{
  const notes=[note(1,'Build 1b9af14d staged, not installed.'),note(2,'PR 41 opened; CI pending.'),note(3,'Build 1b9af14d installed and running.','2026-11-05T12:00:00Z'),note(4,'Build 7cb00e88 installed.'),note(5,'Unrelated cooking note.')];
  const marks=[
    {id:'m1',at:'2026-11-05T11:59:00Z',kind:'update_installed',status:'verified',subject:'installed build 1b9af14d-cbab',observed:{buildId:'1b9af14d-cbab-48ce'}},
    {id:'m2',at:'2026-11-05T13:00:00Z',kind:'github_pr_merged',status:'verified',subject:'owner/repo#41 merged',observed:{mergeCommit:'fd5cb483c3f1'}},
    {id:'m3',at:'2026-11-05T09:59:00Z',kind:'update_installed',status:'contradicted',subject:'installed build 7cb00e88',observed:{buildId:'aaaa1111'}},
    {id:'m4',at:'2026-11-05T10:05:00Z',kind:'process_running',status:'verified',subject:'process 5 (node.exe)'}];
  const result=assessNotes(notes,marks);
  assert.equal(result.get('n1').later[0].seq,3);assert.equal(result.get('n1').later[0].state,'done');
  assert.equal(result.get('n2').later.find(item=>item.reason==='check').state,'done');
  assert.equal(result.get('n3').claim,'checked');assert.equal(result.get('n3').later.length,0);
  assert.equal(result.get('n4').claim,'contradicted');
  assert.equal(result.has('n5'),false);
  const label=assessmentLabel(result.get('n1'));assert.match(label.later,/#3 reports 1b9af14 as done, here staged/);
  assert.match(assessmentLabel(result.get('n3')).check,/^Exomina-verified: installed build/);
  assert.match(assessmentLabel(result.get('n4')).check,/^Contradicted/);
});

test('only announced corrections link to older notes on the same specific topic',()=>{
  const notes=[note(1,'Firefox otnguo2n profile: prefs.js stale, 9999 empty temp files; cleanup suggests saves unblocked.'),note(2,'Kylon pricing reviewed for teams.'),
    note(3,'Nov6 correction: prefs.js value in otnguo2n came from a manual change; temp cleanup does not prove saves unblocked.'),
    note(4,'Source batch adds memory correction links for otnguo2n prefs.js cleanup review.')];
  const result=assessNotes(notes,[]);
  assert.deepEqual(result.get('n1').later.map(item=>[item.seq,item.reason]),[[3,'correction']]);
  assert.equal(result.has('n2'),false);
  assert.equal(result.get('n1').later.some(item=>item.seq===4),false);
});

test('brief: request-matched notes bring their newer record, stable part is request-independent, wake is unchanged',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-brief-test-'));const store=new MemoryStore(dir);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  await store.note('Alex authorizes packaging and installing requested updates without reaffirmation.');
  await store.note('Personal 0.7.4/1b9af14d staged, not installed. Disk guard and retry fixes.');
  for(let n=0;n<30;n++)await store.note(`Suno album track ${n}: orchestral choir arrangement, audio unheard.`);
  await store.note('Nov5: personal 0.7.4/1b9af14d installed; no waiting update.');
  for(let n=0;n<8;n++)await store.note(`TabGain popup detail ${n} for Firefox.`);
  store.setOutcomeSource(()=>[{id:'m1',at:new Date(Date.now()-1000).toISOString(),kind:'update_installed',status:'verified',subject:'installed build 1b9af14d',observed:{buildId:'1b9af14d'}}]);
  const before=(await store.run(['wake'])).text;
  const brief=await store.brief({query:'Is the disk guard build staged or installed?'});
  const relevant=JSON.parse(brief.relevant.slice(brief.relevant.indexOf('\n')+1));
  const staged=relevant.findIndex(item=>/staged, not installed/.test(item.text)),installed=relevant.findIndex(item=>/installed; no waiting/.test(item.text));
  assert.ok(staged>=0&&installed===staged+1,'the newer status follows the older one');
  assert.match(relevant[staged].later,/reports 1b9af14 as done/);
  assert.match(relevant[installed].check,/Exomina-verified/);
  assert.equal(relevant.some(item=>/Suno/.test(item.text)),false);
  const stable=JSON.parse(brief.stable.slice(brief.stable.indexOf('\n')+1));
  assert.ok(stable.standing.some(item=>/without reaffirmation/.test(item.text)));
  assert.equal(stable.recent.length,6);
  assert.ok(brief.stats.bytes<8000);
  const other=await store.brief({query:'Suno choir arrangement'});
  assert.equal(other.stable,brief.stable,'stable part stays cacheable across requests');
  assert.match(other.relevant,/Suno album track/);
  assert.equal((await store.brief({query:''})).relevant,'');
  // Resumed session: repeats become a one-line reference, new matches are sent in full.
  assert.match(brief.relevantDelta(brief.relevantSeqs),/^Still matching and shown in your previous turn: #/);
  assert.ok(brief.relevantDelta(brief.relevantSeqs).length<120);
  assert.match(other.relevantDelta(brief.relevantSeqs),/Suno album track/);
  assert.equal((await store.run(['wake'])).text,before,'chronological wake is not changed by the correction pass');
  const page=JSON.parse((await store.call('memory_recall',{query:'1b9af14d staged'})).content[0].text);
  assert.match(page.results.find(item=>/staged, not installed/.test(item.text)).assessment.later,/as done/);
});

test('memory context mode defaults to relevant and accepts only known modes',()=>{
  assert.equal(memoryContextMode({}),'relevant');assert.equal(memoryContextMode({memoryContext:'chronological'}),'chronological');assert.equal(memoryContextMode({memoryContext:'x'}),'relevant');
});

test('progress links join "designed, not built" to the later note that reports it built, without shared IDs', () => {
  const notes = [
    {id: 'a', seq: 1, date: '2026-11-05', text: 'Nov5 routing design proposed, not built: light/balanced/deep tiers atop routing lanes; reuse handoff briefing at each switch.'},
    {id: 'b', seq: 2, date: '2026-11-05', text: 'Nov5 Source: model-tiers.mjs shared tier classifier; titles try light model; host switchBriefing on model change. 2230 pass.'},
    {id: 'c', seq: 3, date: '2026-11-05', text: 'Nov5 Source: unrelated terminal recovery added; 2231 pass.'},
    {id: 'd', seq: 4, date: '2026-11-05', text: 'Nov5 purple was never the cause of the light tier briefing complaint; still proposed, not built.'},
  ];
  const result = assessNotes(notes, []);
  assert.deepEqual(result.get('a').later.map(item => [item.seq, item.reason]), [[2, 'progress']]);
  assert.match(assessmentLabel(result.get('a')).later, /#2 reports this work as built/);
  assert.equal(result.get('b'), undefined);
});
