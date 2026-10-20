import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbench, nextOccurrence, branchConversation } from '../desktop/workbench.mjs';
import { Store } from '../desktop/store.mjs';
const fixture = () => { const store=new Store('synthetic');store.save=async()=>{};let now=new Date('2026-10-06T10:00:00Z'),calls=0;const work=new Workbench({store,now:()=>now,execute:async()=>{calls++;return {text:'result',conversationId:'result-chat'};}});return {store,work,calls:()=>calls,setNow:n=>{now=new Date(n);}}; };
const schedule = {name:'Weekly briefing',prompt:'Summarise project progress.',provider:'codex',frequency:'daily',time:'09:00',delivery:'desktop'};
test('daily and weekly schedules advance in local wall-clock time',()=>{
  const after=new Date(2026,9,6,9,0);const next=new Date(nextOccurrence({frequency:'daily',time:'09:00'},after));assert.equal(next.getDate(),7);assert.equal(next.getHours(),9);
  const weekly=new Date(nextOccurrence({frequency:'weekly',time:'08:15',day:after.getDay()},after));assert.equal(weekly.getDate(),13);assert.equal(weekly.getMinutes(),15);
});
test('projects and prompts persist independent instructions and reject duplicate shortcuts',async()=>{
  const f=fixture();const p=await f.work.saveProject({name:'Writing',instructions:'Use German.'});const q=await f.work.saveProject({id:p.id,name:'Writing',instructions:'Use English.'});assert.equal(q.id,p.id);assert.equal(f.work.view().projects.length,1);
  await f.work.savePrompt({name:'Rewrite',shortcut:'/rewrite',text:'Rewrite this.'});await assert.rejects(f.work.savePrompt({name:'Other',shortcut:'rewrite',text:'Other'}),/already/);
  assert.equal(f.work.view().prompts[0].shortcut,'rewrite');
});
test('a due run is claimed before inference and concurrent triggers cannot duplicate it',async()=>{
  const f=fixture();let release;f.work.execute=()=>new Promise(r=>{release=r;});const t=await f.work.saveSchedule(schedule);t.nextRun='2026-10-06T09:59:59Z';let savedBefore=false;f.store.save=async()=>{if(t.last?.status==='running')savedBefore=Date.parse(t.nextRun)>Date.parse('2026-10-06T10:00:00Z');};
  const run=f.work.run(t.id);await new Promise(r=>setImmediate(r));assert.ok(savedBefore);await assert.rejects(f.work.run(t.id,true),/already/);release({text:'ok'});await run;assert.equal(t.last.status,'complete');
});
test('missed tasks skip catch-up after sleep, while manual run works when paused',async()=>{
  const f=fixture();const t=await f.work.saveSchedule(schedule);t.nextRun='2026-10-06T01:00:00Z';await f.work.tick();assert.equal(f.calls(),0);assert.equal(t.last.status,'missed');await f.work.toggle(t.id,false);await f.work.run(t.id,true);assert.equal(f.calls(),1);assert.equal(t.enabled,false);
});
test('disconnected tasks wait briefly, then become missed without sending a request',async()=>{
  const f=fixture();const t=await f.work.saveSchedule(schedule);t.nextRun='2026-10-06T09:59:00Z';f.work.available=()=>false;await f.work.tick();assert.equal(f.calls(),0);f.setNow('2026-10-06T11:00:00Z');await f.work.tick();assert.equal(t.last.status,'missed');
});
test('delivery failures retain the successful chat and never regenerate it',async()=>{
  const f=fixture();f.work.deliver=async()=>{throw Error('Bot disconnected');};const t=await f.work.saveSchedule({...schedule,delivery:'telegram',recipient:'42'});t.nextRun='2026-10-06T09:59:59Z';await f.work.run(t.id);assert.equal(t.last.status,'complete');assert.equal(t.last.delivery,'failed');assert.equal(t.last.conversationId,'result-chat');await f.work.tick();assert.equal(f.calls(),1);
});
test('branching copies only prior messages, resets native sessions, and preserves the original',()=>{
  const f=fixture(),chat=f.store.create('claude');chat.projectId='project';chat.personalization={tone:'warm'};chat.sessions={claude:'private-session'};chat.messages=[{id:'u1',role:'user',content:'A'},{id:'a1',role:'assistant',content:'B'},{id:'u2',role:'user',content:'C',attachments:[{id:'asset',uploadId:'upload'}]},{id:'a2',role:'assistant',content:'D'}];
  const result=branchConversation(f.store,{id:chat.id,messageId:'u2',text:'Changed C'});assert.deepEqual(result.conversation.messages.map(m=>m.content),['A','B']);assert.deepEqual(result.conversation.sessions,{});assert.equal(result.text,'Changed C');assert.equal(result.attachments[0].uploadId,'upload');assert.equal(chat.messages[2].content,'C');assert.equal(result.conversation.projectId,'project');
  result.conversation.messages[0].content='Different';assert.equal(chat.messages[0].content,'A');
});
test('branch after a reply retains that answer and validates editable messages',()=>{
  const f=fixture(),chat=f.store.create('codex');chat.messages=[{id:'u',role:'user',content:'question'},{id:'a',role:'assistant',content:'answer'}];const r=branchConversation(f.store,{id:chat.id,messageId:'a'});assert.equal(r.conversation.messages.length,2);assert.throws(()=>branchConversation(f.store,{id:chat.id,messageId:'a',text:'edit'}),/your messages/);
});
