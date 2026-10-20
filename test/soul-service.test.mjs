import test from 'node:test';
import assert from 'node:assert/strict';
import {reflectSoul,changeSoulFromSettings,assertStatedQuote} from '../desktop/soul-service.mjs';
import {normalizePersonalization,applySoul} from '../desktop/personalization.mjs';

function fixture(initial={}){
  let value=normalizePersonalization(initial),privateChat=false,approvals=0,saves=0,events=0;
  const ctx={isPrivate:()=>privateChat,getPersonalization:()=>value,setPersonalization:next=>{value=next;},save:async()=>{saves++;},approve:async()=>{approvals++;return {approved:true};},changed:()=>{events++;}};
  return {ctx,get value(){return value;},set value(next){value=next;},set privateChat(next){privateChat=next;},get counts(){return {approvals,saves,events};}};
}
test('ordinary learning, requested seeding and consolidation persist without approval or hourly count cap',async()=>{
  const f=fixture();
  await reflectSoul({action:'seed',traits:[{text:'Use flowing prose.',evidence:'The user requested prose.',source:'stated'},{text:'Welcome critical engagement.',evidence:'The user asked for pushback.',source:'stated'}]},f.ctx);
  for(let i=0;i<8;i++)await reflectSoul({action:'add',text:`Durable observation ${i}.`,evidence:`Interaction ${i}.`},f.ctx);
  const ids=f.value.soul.traits.slice(0,2).map(item=>item.id);
  const result=await reflectSoul({action:'consolidate',ids,traits:[{text:'Use flowing prose and welcome critical engagement.',evidence:'Combines the two user requests.'}],evidence:'The two requests concern how to converse.'},f.ctx);
  assert.equal(f.value.soul.traits.length,9);assert.equal(f.value.soul.traits[0].source,'stated');
  assert.deepEqual(f.counts,{approvals:0,saves:10,events:10});assert.ok(result.budget.used<result.budget.budget);
  assert.equal(f.value.soul.history.length,10);
});
test('private chats and disabled souls prevent both inspection and mutation',async()=>{
  const f=fixture();f.privateChat=true;
  await assert.rejects(reflectSoul({action:'add',text:'x',evidence:'y'},f.ctx),/private chats/);
  await assert.rejects(reflectSoul({action:'inspect'},f.ctx),/private chats/);
  f.privateChat=false;f.value={...f.value,soul:{...f.value.soul,enabled:false}};
  await assert.rejects(reflectSoul({action:'add',text:'x',evidence:'y'},f.ctx),/switched off/);
  assert.deepEqual(f.counts,{approvals:0,saves:0,events:0});
});
test('core changes still require approval and preserve changes made while approval is open',async()=>{
  const f=fixture();let called=0;
  f.ctx.approve=async()=>{
    called++;f.value={...f.value,soul:applySoul(f.value.soul,{action:'add',text:'Learned in another chat.',evidence:'New interaction.'}).soul};
    return {approved:true};
  };
  await reflectSoul({action:'rename',text:'Vesper Two'},f.ctx);
  assert.equal(called,1);assert.equal(f.value.soul.name,'Vesper Two');assert.equal(f.value.soul.traits.length,1);
  f.ctx.approve=async()=>({approved:false});
  await reflectSoul({action:'essence',text:'A changed character.'},f.ctx);
  assert.notEqual(f.value.soul.essence,'A changed character.');assert.equal(f.counts.saves,1);
});
test('stale consolidation ids leave current settings untouched',async()=>{
  const f=fixture({soul:{traits:[{id:'a',text:'One.',evidence:'Observed.'},{id:'b',text:'Two.',evidence:'Observed.'}]}});
  const before=JSON.stringify(f.value);
  await assert.rejects(reflectSoul({action:'consolidate',ids:['a','missing'],traits:[{text:'Both.',evidence:'Overlap.'}],evidence:'Overlap.'},f.ctx),/stale/);
  assert.equal(JSON.stringify(f.value),before);assert.deepEqual(f.counts,{approvals:0,saves:0,events:0});
});

test('stated evidence is checked against actual user text and Settings edits use current state',async()=>{
  assert.throws(()=>assertStatedQuote({quote:'invented user words'},['A real user message.']),/actual user message/);
  assert.doesNotThrow(()=>assertStatedQuote({quote:'real user message'},['A real user message.']));
  const f=fixture();f.ctx.verifyStated=entry=>assertStatedQuote(entry,['Please keep the meaning clear.']);
  await assert.rejects(reflectSoul({action:'add',source:'stated',text:'Invented preference.',evidence:'Pretended evidence.',quote:'Invented quote'},f.ctx),/actual user message/);
  assert.equal(f.counts.saves,0);
  await reflectSoul({action:'add',source:'stated',text:'Keep meaning clear.',evidence:'Direct instruction.',quote:'keep the meaning clear'},f.ctx);
  const next=changeSoulFromSettings(f.value,{action:'patch',patch:{name:'Vesper New'}});
  assert.equal(next.soul.traits[0].text,'Keep meaning clear.');assert.equal(next.soul.name,'Vesper New');
});
test('inspection reads evidence without creating a save or change event',async()=>{
 const f=fixture();const result=await reflectSoul({action:'inspect'},f.ctx);
 assert.ok(result.content[0].text.includes('history'));assert.deepEqual(f.counts,{approvals:0,saves:0,events:0});
});
