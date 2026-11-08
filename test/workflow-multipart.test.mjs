import test from 'node:test';
import assert from 'node:assert/strict';
import {MessagingHub,TelegramBridge,DiscordBridge} from '../desktop/messaging.mjs';
import {WorkflowJournal} from '../desktop/workflow-journal.mjs';
import {workflowDelivery} from '../desktop/workflow-delivery.mjs';
import {PermissionPolicy} from '../desktop/permissions.mjs';
import {deliveryContract,deliveryPart,recordDeliveryProgress} from '../desktop/delivery-contract.mjs';

function fixture(channel='telegram',fetchImpl) {
  const task={id:'task',name:'Report',prompt:'Synthetic report',provider:'codex',delivery:channel,recipient:'1234'};
  const settings={permissionMode:'full',messaging:{[channel]:{enabled:true,paired:[{id:'owner',chatKey:'1234'}]}}};
  const store={state:{schedules:[task],workflowRuns:[]}};
  let disk,posts=0;
  const f={store,settings,posts:()=>posts,disk:()=>structuredClone(disk),beforeSave:null};
  const hub=new MessagingHub({dataDir:'synthetic',getSettings:()=>settings,saveSettings:async()=>{}});
  const Bridge=channel==='telegram'?TelegramBridge:DiscordBridge;
  const bridge=new Bridge({token:'synthetic',fetchImpl:async(url,options)=>{
    posts++;
    if(fetchImpl)return fetchImpl({url,options,posts,f});
    return new Response(JSON.stringify(channel==='telegram'?{ok:true,result:{message_id:posts}}:{id:String(posts)}),{status:200});
  }});
  hub.bridges.set(channel,bridge);hub.generations.set(channel,1);
  const callbacks=workflowDelivery({policy:new PermissionPolicy({getSettings:()=>settings}),getSettings:()=>settings,getHub:()=>hub,requestApproval:async()=>true});
  const options={store,save:async()=>{await f.beforeSave?.();disk=structuredClone(store.state);},check:callbacks.checkDelivery,approve:callbacks.approveDelivery,deliver:callbacks.deliver};
  f.journal=new WorkflowJournal(options);f.hub=hub;f.bridge=bridge;
  f.ready=async()=>{const run=f.journal.begin(task,'planned');await f.journal.generated(run,{text:'x'.repeat(9000),conversationId:'synthetic'});return run;};
  f.restore=async()=>{store.state=structuredClone(disk);f.journal=new WorkflowJournal(options);await f.journal.restore();return f.journal.runs()[0];};
  return f;
}

for(const channel of ['telegram','discord'])test(`${channel} records durable per-part dispatch and provider message references`,async()=>{
  const f=fixture(channel,({posts,f})=>{
    const parts=f.disk().workflowRuns[0].delivery.attempts[0].parts;
    assert.equal(parts.at(-1).status,'dispatching');
    assert.equal(parts.length,posts);
    for(const part of parts.slice(0,-1))assert.equal(part.status,'acknowledged');
    return new Response(JSON.stringify(channel==='telegram'?{ok:true,result:{message_id:posts}}:{id:String(posts)}),{status:200});
  });
  const run=await f.ready();await f.journal.resume(run.id);
  assert.equal(run.delivery.status,'sent');
  const attempt=run.delivery.attempts[0];assert.deepEqual(attempt.contract,deliveryContract(channel));
  assert.ok(attempt.parts.length>1);assert.ok(attempt.parts.every(p=>p.status==='acknowledged'&&p.messageId));
  assert.equal((await f.restore()).delivery.attempts[0].parts.length,f.posts());
  f.bridge.stop();
});

test('lost acknowledgement preserves accepted prefix and uncertain part across restart without replay',async()=>{
  const f=fixture('telegram',({posts})=>{
    if(posts===2)throw Error('Synthetic lost acknowledgement');
    return new Response(JSON.stringify({ok:true,result:{message_id:111}}),{status:200});
  });
  const run=await f.ready();await f.journal.resume(run.id);
  const recovered=await f.restore();assert.equal(recovered.delivery.status,'unknown');
  assert.deepEqual(recovered.delivery.attempts[0].parts.map(p=>p.status),['acknowledged','dispatching']);
  assert.equal(recovered.delivery.attempts[0].parts[0].messageId,'111');
  await assert.rejects(f.journal.resume(run.id),/Reconcile/);assert.equal(f.posts(),2);f.bridge.stop();
});

test('missing provider ID is uncertain and halts later report parts',async()=>{
  const f=fixture('discord',()=>new Response('{}',{status:200}));const run=await f.ready();await f.journal.resume(run.id);
  assert.equal(run.delivery.status,'unknown');assert.equal(f.posts(),1);
  assert.equal(run.delivery.attempts[0].parts[0].status,'dispatching');f.bridge.stop();
});

test('failed progress commit blocks the next network call and poisons the journal',async()=>{
  const f=fixture(),run=await f.ready();
  f.beforeSave=()=>{if(run.delivery.attempts?.[0]?.parts[0]?.status==='acknowledged')throw Error('Synthetic disk full');};
  await assert.rejects(f.journal.resume(run.id),/storage failed/);assert.equal(f.posts(),1);
  f.beforeSave=null;
  const recovered=await f.restore();assert.equal(recovered.delivery.status,'unknown');
  assert.equal(recovered.delivery.attempts[0].parts[0].status,'dispatching');f.bridge.stop();
});

test('revocation during progress commit prevents another network request',async()=>{
  const f=fixture(),run=await f.ready();
  f.beforeSave=()=>{if(run.delivery.attempts?.[0]?.parts[0]?.status==='acknowledged')f.settings.permissionMode='read-only';};
  await f.journal.resume(run.id);assert.equal(run.delivery.status,'unknown');assert.equal(f.posts(),1);
  assert.equal(run.delivery.attempts[0].parts.length,1);f.bridge.stop();
});

test('new owner-approved attempt retains earlier multipart evidence',async()=>{
  let fail=true;const f=fixture('telegram',({posts})=>{if(fail&&posts===2)throw Error('Lost acknowledgement');return new Response(JSON.stringify({ok:true,result:{message_id:posts}}),{status:200});});
  const run=await f.ready();await f.journal.resume(run.id);const first=structuredClone(run.delivery.attempts[0]);
  await f.journal.resolve(run.id,{resolution:'not_sent',evidence:'Owner checked all destination messages and removed incomplete delivery.'});
  fail=false;await f.journal.resume(run.id);assert.equal(run.delivery.attempts.length,2);assert.deepEqual(run.delivery.attempts[0],first);assert.equal(run.delivery.status,'sent');f.bridge.stop();
});

test('out-of-order or mismatched progress cannot be recorded as acknowledged',()=>{
  const attempt={parts:[]},part=deliveryPart('Report',0,2);
  assert.throws(()=>recordDeliveryProgress(attempt,{...part,status:'acknowledged',messageId:'1'},'now'),/does not match/);
  recordDeliveryProgress(attempt,{...part,status:'dispatching'},'now');
  assert.throws(()=>recordDeliveryProgress(attempt,{...part,status:'acknowledged',sha256:'a'.repeat(64),messageId:'1'},'now'),/does not match/);
  assert.throws(()=>recordDeliveryProgress(attempt,{...part,index:1,status:'dispatching'},'now'),/Out-of-order/);
});
