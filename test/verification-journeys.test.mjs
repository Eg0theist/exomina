import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {VerificationJourneys,VERIFICATION_JOURNEYS,compareJourneyFingerprints} from '../desktop/verification-journeys.mjs';

test('catalog supplies reproducible product promises without asserting that tests ran',async()=>{
  const api=new VerificationJourneys({sourceRoot:path.resolve('.')});
  const found=await api.call({action:'catalog',query:'crash'});
  assert.ok(found.journeys.some(j=>j.id==='terminal-crash-recovery'));
  assert.match(found.notice,/not a passing test/);
  for(const journey of VERIFICATION_JOURNEYS){assert.ok(journey.steps.length>=3);assert.ok(journey.sources.length>=4);assert.ok(journey.exclusions.length>=2);}
  await assert.rejects(api.call({action:'inspect',id:'../../account'}),/journey ID/);
});

test('source bytes and build identity show drift without promoting a previous report',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'exomina-journey-'));
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});});
  const journey=VERIFICATION_JOURNEYS.find(j=>j.id==='procedure-acceptance');
  for(const file of journey.sources){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),'synthetic original','utf8');}
  let build={id:'build-1',version:'test'};
  const api=new VerificationJourneys({sourceRoot:root,getBuild:()=>build});
  const first=await api.call({action:'inspect',id:journey.id});
  const baseline={buildId:first.fingerprint.buildId,sources:first.fingerprint.sources};
  assert.equal(first.verification.journeyExecuted,'not_established');assert.equal(first.comparison.status,'not_compared');
  const unchanged=await api.call({action:'inspect',id:journey.id,baseline});assert.equal(unchanged.comparison.status,'same_sources');
  build={id:'build-2'};await writeFile(path.join(root,journey.sources[0]),'changed bytes','utf8');
  const changed=await api.call({action:'inspect',id:journey.id,baseline});
  assert.equal(changed.comparison.status,'needs_recheck');assert.equal(changed.comparison.buildChanged,true);assert.deepEqual(changed.comparison.changed,[journey.sources[0]]);
  await rm(path.join(root,journey.sources[1]));
  assert.equal((await api.call({action:'inspect',id:journey.id,baseline})).comparison.status,'incomplete');
});

test('evidence is looked up from the current chat, never accepted from caller assertions',async()=>{
  const mark={id:'host-file',checkedBy:'exomina',kind:'file',status:'verified',at:'2026-11-07T22:00:00Z',subject:'file report.json',observed:{exists:true,bytes:400}};
  const api=new VerificationJourneys({sourceRoot:path.resolve('.'),getMarks:chat=>chat==='a'?[mark]:[]});
  const a=await api.call({action:'inspect',id:'interrupted-delivery',markIds:['host-file','forged']},'a');
  assert.equal(a.verification.hostPredicates[0].status,'verified');assert.match(a.verification.hostPredicates[0].coverage,/not journey/);
  assert.equal(a.verification.hostPredicates[1].status,'unavailable');assert.equal(a.verification.humanReview,'not_recorded');
  const b=await api.call({action:'inspect',id:'interrupted-delivery',markIds:['host-file']},'b');assert.equal(b.verification.hostPredicates[0].status,'unavailable');
  await assert.rejects(api.call({action:'inspect',id:'interrupted-delivery',markIds:Array(13).fill('x')}),/twelve/);
});

test('a missing baseline source or changed file cannot retain an unchanged label',()=>{
  assert.equal(compareJourneyFingerprints({sources:{a:'1',b:'2'},buildId:'b'},{sources:{a:'1'},buildId:'a'}).status,'needs_recheck');
  assert.equal(compareJourneyFingerprints({sources:{a:null},buildId:null},{sources:{a:null}}).status,'incomplete');
});

test('direct IPC rejects malformed arguments without reading source or outcomes',async()=>{
  const api=new VerificationJourneys({sourceRoot:'invalid-never-opened',getMarks:()=>assert.fail('Malformed args must fail before reading marks.')});
  for(const args of [null,[],{action:'catalog',query:[]},{action:'catalog',id:'update-handover'},{action:'catalog',query:'x'.repeat(301)},{action:'inspect',id:'update-handover',passed:true},{action:'inspect',id:'update-handover',markIds:['same','same']},{action:'inspect',id:'update-handover',baseline:{sources:{'../account':null}}},{action:'inspect',id:'update-handover',baseline:{sources:{'desktop/updates.mjs':'fake'}}}]){
    await assert.rejects(api.call(args),/Choose|argument|query|unique|source paths/);
  }
});
