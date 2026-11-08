import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionPolicy } from '../desktop/permissions.mjs';
import { workflowDelivery } from '../desktop/workflow-delivery.mjs';
import { MessagingHub, TelegramBridge, DiscordBridge } from '../desktop/messaging.mjs';

function fixture() {
  const settings={permissionMode:'full',permissionRules:[],messaging:{telegram:{enabled:true,paired:[{id:'user',chatKey:'paired'}]}}};
  const policy=new PermissionPolicy({getSettings:()=>settings});let prompts=0,sends=0;
  const hub=new MessagingHub({dataDir:'synthetic',getSettings:()=>settings,saveSettings:async patch=>Object.assign(settings,patch)});
  hub.bridges.set('telegram',{send:async()=>{sends++;}});hub.generations.set('telegram',1);
  let request;
  const callbacks=workflowDelivery({policy,getSettings:()=>settings,getHub:()=>hub,requestApproval:async r=>{prompts++;request=r;return true;}});
  const binding={runId:'run',taskId:'task',name:'Report',channel:'telegram',recipient:'paired',sha256:'hash',bytes:6};
  return {settings,hub,callbacks,binding,counts:()=>({prompts,sends}),request:()=>request};
}
test('full access still requires an exact one-time delivery review and respects deny rules',async()=>{
  const f=fixture();const key=f.callbacks.checkDelivery(f.binding);
  assert.equal(await f.callbacks.approveDelivery({...f.binding,text:'report'}),true);
  assert.equal(f.request().requireConfirmation,true);assert.equal(f.request().action.target,'telegram:paired');
  assert.match(f.request().detail,/report/);assert.equal(f.request().input.runId,'run');
  assert.deepEqual(f.counts(),{prompts:1,sends:0});
  f.settings.permissionRules=[{effect:'deny',tool:'workflow_delivery',match:'telegram:paired'}];
  assert.throws(()=>f.callbacks.checkDelivery(f.binding),/Blocked/);
  await assert.rejects(f.callbacks.approveDelivery({...f.binding,text:'report'}),/Blocked/);
  assert.deepEqual(f.counts(),{prompts:1,sends:0});assert.ok(key);
});
test('global read-only blocks delivery, and policy or connector changes invalidate authorization',()=>{
  const f=fixture(),key=f.callbacks.checkDelivery(f.binding);
  f.settings.permissionMode='ask';assert.notEqual(f.callbacks.checkDelivery(f.binding),key);
  f.settings.permissionMode='read-only';assert.throws(()=>f.callbacks.checkDelivery(f.binding),/blocks/);
  f.settings.permissionMode='full';f.hub.generations.set('telegram',2);assert.notEqual(f.callbacks.checkDelivery(f.binding),key);
  f.settings.messaging.telegram.enabled=false;assert.throws(()=>f.callbacks.checkDelivery(f.binding),/no longer paired/);
});
test('unpairing or policy revocation after the first report chunk stops later chunks',async()=>{
  for(const revoke of ['pairing','policy']){
    const f=fixture(),authorization=f.callbacks.checkDelivery(f.binding);let parts=0;
    f.hub.bridges.set('telegram',{send:async(_key,part)=>{
      assert.ok(part.length<=4000);parts++;
      if(revoke==='pairing')f.hub.revoking.add('telegram:user');
      else f.settings.permissionMode='read-only';
    }});
    await assert.rejects(f.callbacks.deliver({name:'Report',delivery:'telegram',recipient:'paired',binding:f.binding,authorization},'x'.repeat(9000)),/no longer paired|blocks/);
    assert.equal(parts,1);
  }
});
test('both bridges recheck authorization after rate-limit waits before another network request',async()=>{
  for(const Bridge of [TelegramBridge,DiscordBridge]){
    let allowed=true,calls=0;
    const bridge=new Bridge({token:'synthetic-token',fetchImpl:async()=>{calls++;return new Response(JSON.stringify({ok:false,error_code:429,retry_after:0.01}),{status:429});},delayImpl:async()=>{allowed=false;}});
    await assert.rejects(bridge.send('paired','Report',{validate:()=>allowed}),/authorization changed/);
    assert.equal(calls,1);bridge.stop();
  }
});
