import test from 'node:test';
import assert from 'node:assert/strict';
import {AppNavigation} from '../desktop/app-navigation.mjs';

function fixture(){const ui={conversationId:'chat',page:'chat',settingsSection:'general'},events=[];let live=true;const broker=new AppNavigation({getNavigation:()=>ui,isLive:()=>live,send:event=>events.push(event),timeoutMs:30});return {ui,events,broker,stop:()=>live=false};}
test('navigation emits a scoped request and accepts only its observed page/section',async()=>{
  const f=fixture(),promise=f.broker.request({destination:'settings:appearance',expected:{...f.ui}},'chat'),request=f.events[0];
  assert.equal(request.type,'app.control.navigate');assert.equal(request.conversationId,'chat');
  assert.throws(()=>f.broker.acknowledge({requestId:'forged',conversationId:'chat',confirmed:true}),/no longer pending/);
  f.broker.acknowledge({requestId:request.requestId,conversationId:'chat',confirmed:true,page:'settings',settingsSection:'appearance'});
  assert.deepEqual(await promise,{confirmed:true,destination:'settings:appearance'});assert.equal(f.broker.pending.size,0);
});
test('wrong chat, switched pages, unsupported destination and private UI fail before dispatch',()=>{
  const f=fixture();assert.throws(()=>f.broker.request({destination:'settings:appearance',expected:{...f.ui}},'other'),/navigation changed/);
  assert.throws(()=>f.broker.request({destination:'settings:appearance',expected:{...f.ui,page:'tools'}},'chat'),/navigation changed/);
  assert.throws(()=>f.broker.request({destination:'settings:secret',expected:{...f.ui}},'chat'),/Unknown/);
  f.ui.private=true;assert.throws(()=>f.broker.request({destination:'chat',expected:{...f.ui}},'chat'),/navigation changed/);assert.equal(f.events.length,0);
});
test('a wrong page acknowledgment and a stopped owner cannot claim navigation success',async()=>{
  const f=fixture(),promise=f.broker.request({destination:'tools',expected:{...f.ui}},'chat');
  f.broker.acknowledge({requestId:f.events[0].requestId,conversationId:'chat',confirmed:true,page:'chat'});await assert.rejects(promise,/not confirmed/);
  const next=f.broker.request({destination:'tools',expected:{...f.ui}},'chat');f.stop();f.broker.acknowledge({requestId:f.events[1].requestId,conversationId:'chat',confirmed:true,page:'tools'});await assert.rejects(next,/stopped/);
});
test('missing renderer acknowledgment times out and releases pending state',async()=>{
  const f=fixture();await assert.rejects(f.broker.request({destination:'tools',expected:{...f.ui}},'chat'),/did not acknowledge/);assert.equal(f.broker.pending.size,0);
});
test('only a valid pending acknowledgment updates the observed location before resolving',async()=>{
  const ui={conversationId:'chat',page:'chat',settingsSection:'general'},events=[],observed=[];
  const broker=new AppNavigation({getNavigation:()=>ui,isLive:()=>true,send:event=>events.push(event),onConfirmed:value=>{Object.assign(ui,value);observed.push(value);}});
  assert.throws(()=>broker.acknowledge({requestId:'forged',conversationId:'chat',confirmed:true,page:'tools'}),/no longer pending/);assert.equal(observed.length,0);
  const result=broker.request({destination:'settings:appearance',expected:{...ui}},'chat');
  broker.acknowledge({requestId:events[0].requestId,conversationId:'chat',confirmed:true,page:'settings',settingsSection:'appearance'});
  await result;assert.equal(ui.page,'settings');assert.equal(ui.settingsSection,'appearance');assert.equal(observed.length,1);
});
