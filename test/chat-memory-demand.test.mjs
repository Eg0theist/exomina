import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatMemoryDemand} from '../desktop/chat-memory-demand.mjs';
import {ChatMemoryCompactor} from '../desktop/chat-memory-compactor.mjs';

const models=[{provider:'codex',model:'light',role:'light',available:true,efforts:['low']},{provider:'claude',model:'light',role:'light',available:true,efforts:['low']}];
function setup({enabled=true,active=true,over=true,provider='codex',oversize=false}={}){
 const runs=new Map(active?[['current',{selection:{provider}}]]:[]);
 const counts={calls:0,claims:0,built:0,aborts:0};
 const pending=Array.from({length:85_000},(_,id)=>({id,chatId:'current',token:'job-'+id,state:'ready'}));
 const demand=new ChatMemoryDemand({getRun:id=>runs.get(id),enabled:()=>enabled,getStats:async()=>({viewBytes:over?200:50,turnHigh:100})});
 const tree={async readyJobs(limit,{chatId}){counts.claims++;return pending.filter(j=>j.chatId===chatId&&j.state==='ready').slice(0,limit).map(j=>{j.state='running';return j;});},async sourceTask(){return {source:[{text:'synthetic'}],maxBytes:512};},async commitSummary(j){j.state='built';counts.built++;return {committed:true};},async failJob(j){j.state='failed';}};
 const worker=new ChatMemoryCompactor({tree,concurrency:1,enabled:()=>enabled,available:()=>models,chooseModel:(choices,id)=>demand.choose(choices,id),beforeRequest:(job,model)=>demand.reserve(job,model),summarize:async({model})=>{counts.calls++;assert.equal(model.provider,provider);return oversize?'x'.repeat(700):'A retained decision.';}});
 return {worker,demand,runs,counts,pending};
}
test('85,000 queued jobs spend nothing while idle, disabled, under budget or notified for another chat',async()=>{
 for(const options of [{active:false},{enabled:false},{over:false},{provider:'unsupported'}]){const f=setup(options);f.worker.notify('current');await f.worker.drain();assert.equal(f.counts.calls,0);assert.equal(f.counts.claims,0);await f.worker.close();}
 const f=setup();f.worker.notify('old');f.worker.notify();await f.worker.drain();assert.equal(f.counts.calls,0);await f.worker.close();
});
test('active on-demand compression stays on the selected subscription and caps all calls at four per reply',async()=>{
 for(const provider of ['codex','claude']){const f=setup({provider});f.worker.notify('current');await f.worker.drain();assert.equal(f.counts.calls,4);assert.equal(f.counts.built,4);assert.equal(f.worker.stats().concurrency,1);f.worker.notify('current');await f.worker.drain();assert.equal(f.counts.calls,4);f.runs.set('current',{selection:{provider}});f.worker.notify('current');await f.worker.drain();assert.equal(f.counts.calls,8);await f.worker.close();}
});
test('oversize retries count toward the same four-request cap',async()=>{const f=setup({oversize:true});f.worker.notify('current');await f.worker.drain();assert.equal(f.counts.calls,4);assert.equal(f.counts.built,0);await f.worker.close();});
test('an ended or switched reply invalidates an already chosen provider lease',async()=>{
 const f=setup();const choice=await f.demand.choose(models,'current');f.runs.delete('current');assert.equal(await f.demand.reserve({chatId:'current'},choice),false);f.runs.set('current',{selection:{provider:'claude'}});assert.equal(await f.demand.reserve({chatId:'current'},choice),false);await f.worker.close();
});
test('stopping a reply aborts its helper without preventing later replies in that chat',async()=>{
 const f=setup();let signal;f.worker.summarize=async request=>{f.counts.calls++;signal=request.signal;return new Promise(()=>{});};f.worker.notify('current');await new Promise(setImmediate);f.runs.delete('current');await f.worker.stopChat('current');assert.equal(signal.aborted,true);assert.equal(f.worker.stats().running,0);f.runs.set('current',{selection:{provider:'codex'}});f.worker.summarize=async()=>{f.counts.calls++;return 'Saved.';};f.worker.notify('current');await f.worker.drain();assert.equal(f.counts.calls,5);await f.worker.close();
});
