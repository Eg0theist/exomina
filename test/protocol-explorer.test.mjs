import test from 'node:test';
import assert from 'node:assert/strict';
import {exploreProtocol} from '../desktop/protocol-explorer.mjs';
import {WorkflowJournal} from '../desktop/workflow-journal.mjs';
import {pendingUpdateReceipt,settleUpdateReceipts} from '../desktop/update-completion.mjs';

test('finite protocols exhaust their stated bounds and deliberate broken variants produce counterexamples',()=>{
  for(const id of ['delivery','installation']){
    const result=exploreProtocol(id);assert.equal(result.status,'satisfied_in_model');assert.ok(result.states>=3);assert.ok(result.transitions>=36);assert.match(result.meaning,/not proof/);
  }
  for(const [model,broken,violation] of [['delivery','skip-final-authorization','effect-with-stale-approval'],['delivery','replay-unknown','unknown-effect-replayed'],['installation','trust-staged-mark','installation-without-matching-host-installed-mark']]){
    const result=exploreProtocol(model,{broken});assert.equal(result.status,'counterexample');assert.equal(result.violation,violation);assert.ok(result.trace.length>0);
  }
  assert.equal(exploreProtocol('delivery',{maxStates:2}).status,'inconclusive');
  assert.throws(()=>exploreProtocol('delivery',{maxStates:1000000}),/20,000/);
});

// Replay the model's high-consequence boundaries through the production class.
// Saves below are an atomic in-memory stand-in. Durable disk and real process
// termination are exercised by workflow-journal-crash.test.mjs separately.
async function fixture({revokeAt,editAt,lostAck=false}={}){
  const task={id:'task',name:'Report',prompt:'Synthetic report',provider:'test',delivery:'telegram',recipient:'synthetic'},store={state:{schedules:[task],workflowRuns:[]}};
  let epoch=0,sends=0,persisted=null,run,commitCount=0;
  const journal=new WorkflowJournal({store,save:async()=>{commitCount++;persisted=structuredClone(store.state);if(commitCount===revokeAt)epoch++;if(commitCount===editAt)task.recipient='changed';},
    approve:async()=>true,check:()=>String(epoch),deliver:async()=>{sends++;if(lostAck)throw Error('Synthetic lost acknowledgment');}});
  run=journal.begin(task,'now');await journal.commit();await journal.generated(run,{text:'Synthetic report body'});
  return {store,journal,run,get sends(){return sends;},get persisted(){return persisted;}};
}

test('production replay blocks permission or destination changes after durable checkpoint',async()=>{
  for(const mode of ['revokeAt','editAt']){
    const f=await fixture({[mode]:3});const result=await f.journal.resume(f.run.id);
    assert.equal(result.delivery.status,'blocked');assert.equal(f.sends,0);
  }
});

test('production replay retains lost acknowledgment and requires reconciliation before another approval',async()=>{
  const f=await fixture({lostAck:true}),first=await f.journal.resume(f.run.id);
  assert.equal(first.delivery.status,'unknown');assert.equal(f.sends,1);
  await assert.rejects(f.journal.resume(f.run.id),/Reconcile/);assert.equal(f.sends,1);
  await assert.rejects(f.journal.cancel(f.run.id),/uncertain/);
  await f.journal.resolve(f.run.id,{resolution:'not_sent',evidence:'Synthetic recipient was inspected and no report was present.'});
  assert.equal(f.sends,1);assert.equal(f.run.delivery.status,'pending');
});

test('production receipt replay exhausts the model host-kind-status-build combinations',()=>{
  for(const host of [false,true])for(const kind of ['file','update_staged','update_installed'])for(const status of ['verified','contradicted','unavailable'])for(const matching of [false,true]){
    const messages=[{pendingUpdate:pendingUpdateReceipt({id:'approved-build'})}],mark={id:'mark',checkedBy:host?'exomina':'agent',kind,status,observed:{buildId:matching?'approved-build':'other-build'},at:new Date().toISOString()};
    assert.equal(settleUpdateReceipts(messages,mark),host&&kind==='update_installed'&&status==='verified'&&matching);
  }
});
