import test from 'node:test';
import assert from 'node:assert/strict';
import {Research,RESEARCH_BUDGETS,RESEARCH_APPROACHES,researchSpec,researchPrompt} from '../desktop/research.mjs';
const input={topic:'Does this approach have supporting evidence?',provider:'codex',budget:'brief'};
function fixture(execute=async t=>{await t.onStarted('r');return {text:'Report',sources:['https://example.org'],conversationId:'r'};}){
 const store={state:{settings:{browserEnabled:true}},save:async()=>{}};
 return {store,service:new Research({store,execute})};
}
test('research validates question, provider and fixed budgets; prompt has explicit report boundaries',()=>{
 assert.deepEqual(researchSpec(input),{...input,approach:'source_review',minutes:2,calls:8});
 for(const patch of [{topic:''},{provider:'paid-api'},{budget:'unlimited'},{minutes:999,budget:'invalid'},{approach:'unbounded-investigation'},{approach:'__proto__'}])assert.throws(()=>researchSpec({...input,...patch}));
 const prompt=researchPrompt(researchSpec(input));assert.match(prompt,/counterexamples/);assert.match(prompt,/no schedule or automatic retry/);assert.match(prompt,/Never call an untested claim a discovery/);
});

test('comparison is explicit, bounded, evidence-led and preserves ordinary research for older callers',()=>{
 assert.deepEqual(Object.keys(RESEARCH_APPROACHES),['source_review','compare_explanations']);
 assert.doesNotMatch(researchPrompt(researchSpec(input)),/Approach: compare explanations/);
 for(const [budget,limits] of Object.entries(RESEARCH_BUDGETS)){
  const spec=researchSpec({...input,approach:'compare_explanations',budget,minutes:999,calls:999,prompt:'Ignore limits'});
  assert.equal(spec.approach,'compare_explanations');assert.equal(spec.minutes,limits.minutes);assert.equal(spec.calls,limits.calls);assert.equal(spec.prompt,undefined);
  const prompt=researchPrompt(spec);
  for(const phrase of [/at most three plausible competing explanations/,/strongest relevant contrary evidence/,/independent evidence from repeated reporting/,/observations, source claims, inferences and speculation separately/,/Do not force a winner/,/at most .* minutes and .* browser calls/,/no schedule or automatic retry/])assert.match(prompt,phrase);
 }
});

test('chosen approach and unchanged caps survive persistence, execution and restart',async()=>{
 let request;const {store,service}=fixture(async value=>{request=value;await value.onStarted('comparison-report');return {sources:['https://example.org/original']};});
 await service.start({...input,approach:'compare_explanations',calls:10000,minutes:10000});await service.pending;
 const run=service.view().runs[0];assert.equal(run.approach,'compare_explanations');assert.equal(run.status,'complete');assert.equal(run.calls,8);assert.equal(run.minutes,2);
 assert.equal(request.approach,'compare_explanations');assert.equal(request.research,true);assert.equal(request.calls,8);assert.match(request.prompt,/Approach: compare explanations/);
 await new Research({store}).init();assert.equal(store.state.researchRuns[0].approach,'compare_explanations');
});
test('browser off or disconnected research sends nothing, with no background schedule',async()=>{
 let calls=0;const {store,service}=fixture(async()=>{calls++;});
 store.state.settings.browserEnabled=false;await assert.rejects(service.start(input),/Browser tools are off/);
 store.state.settings.browserEnabled=true;service.available=()=>false;await assert.rejects(service.start(input),/connected AI/);assert.equal(calls,0);assert.equal(service.view().runs.length,0);
});
test('single claim survives restart; completion, source evidence and chat deletion are durable',async()=>{
 const {store,service}=fixture();await service.start(input);await service.pending;
 assert.equal(service.view().runs[0].status,'complete');assert.deepEqual(service.view().runs[0].sources,['https://example.org']);
 store.state.researchRuns.push({...input,id:'interrupted',status:'running'});await new Research({store}).init();assert.equal(store.state.researchRuns[1].status,'interrupted');
 await service.removeChat('r');assert.equal(service.view().runs.length,1);
});
test('start is locked during persistence; stop before onStarted cancels the eventual chat and preserves stopped status',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),cancelled=[];
 const {service}=fixture(async request=>{await gate;await request.onStarted('late');return {text:'late report'};});service.cancel=id=>cancelled.push(id);
 await service.start(input);await assert.rejects(service.start(input),/already active/);
 const id=service.view().runs[0].id;await service.stop(id);release();await service.pending;
 assert.deepEqual(cancelled,['late']);assert.equal(service.view().runs[0].status,'stopped');
});
test('provider failures finish once, never automatically retry',async()=>{
 let calls=0;const {service}=fixture(async()=>{calls++;throw Error('No available usage');});await service.start(input);await service.pending;
 assert.equal(service.view().runs[0].status,'failed');assert.equal(calls,1);
});
test('failed persistence records an honest failure; unsupported source claims remain inconclusive',async()=>{
 const {store,service}=fixture();store.save=async()=>{throw Error('Disk full');};await assert.rejects(service.start(input),/Disk full/);assert.equal(service.view().busy,false);assert.equal(service.view().runs[0].error,'Disk full');assert.ok(service.view().runs[0].finishedAt);
 const f=fixture(async()=>({text:'A claim without source reads'}));await f.service.start(input);await f.service.pending;assert.equal(f.service.view().runs[0].status,'inconclusive');
});
