import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assessNotes,assessmentDetails} from '../desktop/memory-correction.mjs';
import {MemoryStore} from '../desktop/note-store.mjs';

const cases=JSON.parse(await readFile(new URL('./fixtures/memory-predicate-cases.json',import.meta.url),'utf8'));
const at='2026-11-07T10:00:00Z';
for(const fixture of cases)test(fixture.name,()=>{
  const notes=[{id:'note',seq:1,text:fixture.text,createdAt:at}];
  const marks=[{id:'mark',at,kind:fixture.kind,subject:fixture.subject,observed:fixture.observed,status:'verified'},...(fixture.extraMarks||[])];
  const result=assessNotes(notes,marks).get('note');
  assert.equal(result?.claim,fixture.expected);
  if(fixture.expected==='reported')assert.equal(result?.checks.length,0);
  else assert.match(assessmentDetails(result).check,/only these named conditions were checked/);
});

test('CI note does not supersede an installation claim with the same SHA',()=>{
  const notes=[{id:'older',seq:1,text:'Build ab12cd34 installed.',createdAt:at},{id:'newer',seq:2,text:'Commit ab12cd34 CI checks failed.',createdAt:at}];
  assert.equal(assessNotes(notes).get('older').later.length,0);
});

test('adjacent test results do not turn an unmerged PR or running CI into completion',()=>{
  const mark={id:'mark',at,kind:'github_pr_merged',subject:'team/app#17 merged',observed:{},status:'verified'};
  assert.equal(assessNotes([{id:'note',seq:1,text:'PR17 adds a cache; 18 tests passed.',createdAt:at}],[mark]).get('note')?.claim,undefined);
  const ci={...mark,kind:'github_checks',subject:'checks on team/app@ab12cd34'};
  const result=assessNotes([{id:'note',seq:1,text:'Commit ab12cd34 CI checks running.',createdAt:at}],[ci]).get('note');
  assert.notEqual(result?.claim,'checked');
});

test('checks in another repository do not establish CI or merge conditions sharing a commit',()=>{
  for(const [text,kind,subject,observed] of [
    ['Commit team/alpha@ab12cd34 CI checks passed.','github_checks','checks on team/beta@ab12cd34',{}],
    ['PR17 team/alpha#17 merged ab12cd34.','github_pr_merged','team/beta#17 merged',{mergeCommit:'ab12cd34'}]
  ])assert.equal(assessNotes([{id:'note',seq:1,text,createdAt:at}],[{id:'mark',at,kind,subject,observed,status:'verified'}]).get('note').claim,'reported');
});

test('a later successful installation never retroactively verifies an earlier claim',()=>{
  const result=assessNotes([{id:'note',seq:1,text:'Build ab12cd34 installed.',createdAt:at}],[{id:'later',at:'2026-11-07T11:00:00Z',kind:'update_installed',status:'verified',subject:'installed build ab12cd34',observed:{buildId:'ab12cd34'}}]).get('note');
  assert.equal(result.claim,'reported');assert.equal(result.checks.length,0);
  assert.equal(result.later[0].reason,'observation');assert.equal(result.later[0].check,'later');
  assert.match(assessmentDetails(result).later,/does not verify the earlier time/);
});

test('later host observation retains its permanent receipt and exact predicate',()=>{
  const result=assessNotes([{id:'note',seq:1,text:'Build ab12cd34 staged, not installed.',createdAt:at}],[{id:'host-receipt',at:'2026-11-07T11:00:00Z',kind:'update_installed',status:'verified',subject:'installed build ab12cd34',observed:{buildId:'ab12cd34'}}]);
  assert.equal(result.get('note').later[0].check,'host-receipt');
  assert.deepEqual(assessmentDetails(result.get('note')).relations[0],{
    kind:'check',source:null,markId:'host-receipt',identifier:'hex:ab12cd3',predicate:'update_installed',earlierState:'staged',laterState:'done',observedAt:'2026-11-07T11:00:00Z',notice:'Same identifier and compatible outcome predicate; inspect both sources before reusing a historical claim.'
  });
});

test('recall exposes typed evidence and inspectable source relations without rewriting source text',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'exomina-memory-predicate-'));const store=new MemoryStore(directory);
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const earlier=await store.note('Build ab12cd34 staged, not installed.');
  await store.note('Build ab12cd34 installed; actual voice remains untested.');
  const before=await store.list();
  const page=JSON.parse((await store.call('memory_recall',{query:'ab12cd34 staged'})).content[0].text);
  const entry=page.results.find(item=>item.id===earlier.id);
  assert.equal(entry.assessment.relations[0].source.seq,2);
  assert.equal(entry.assessment.relations[0].predicate,'update_installed');
  assert.deepEqual(await store.list(),before);
});
