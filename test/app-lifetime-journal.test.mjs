import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createAppLifetimeJournal} from '../desktop/app-lifetime-journal.mjs';
async function fixture(t){const directory=await mkdtemp(path.join(process.cwd(),'app-lifetime-journal-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,file:path.join(directory,'app-lifetime.json')};}

test('the journal records process and shutdown categories without sensitive strings',async t=>{
  const {directory,file}=await fixture(t),journal=createAppLifetimeJournal({directory,pid:1234,ppid:1233,lifetimeStatus:'independent'});
  journal.record('uncaught-exception',{errorName:'TypeError',errorCode:'EPIPE',message:'secret message',stack:'secret stack',env:{secret:'token'},path:'secret path'});
  journal.record('child-process-gone',{reason:'killed',processType:'Utility',name:'secret provider command'});journal.record('exit',{code:0});
  const text=await readFile(file,'utf8'),data=JSON.parse(text);assert.ok(!text.includes('secret'));assert.equal(data.sessions[0].pid,1234);assert.equal(data.sessions[0].ppid,1233);assert.deepEqual(data.sessions[0].events.map(e=>e.event),['begin','uncaught-exception','child-process-gone','exit']);assert.equal(data.sessions[0].events[1].errorCode,'EPIPE');
  assert.equal(journal.record('untrusted label',{message:'secret'}),false);
});
test('multiple launches preserve at most twenty sessions and two hundred events',async t=>{
  const {directory,file}=await fixture(t);for(let i=0;i<25;i++){const journal=createAppLifetimeJournal({directory,pid:i+100,ppid:99});journal.record('before-quit');}
  let data=JSON.parse(await readFile(file,'utf8'));assert.equal(data.sessions.length,20);assert.equal(data.sessions.at(-1).pid,124);
  const journal=createAppLifetimeJournal({directory,pid:200,ppid:99});for(let i=0;i<230;i++)journal.record('main-window-close');
  data=JSON.parse(await readFile(file,'utf8'));assert.ok(data.sessions.length<=20);assert.equal(data.sessions.reduce((count,s)=>count+s.events.length,0),200);
});
test('malformed or injected earlier metadata is discarded and cannot add arbitrary strings',async t=>{
  const {directory,file}=await fixture(t);await writeFile(file,JSON.stringify({version:1,sessions:[{id:'11111111-2222-3333-4444-555555555555',pid:100,ppid:99,startedAt:'2026-10-09T00:00:00.000Z',secret:'secret value',events:[{event:'begin',at:'2026-10-09T00:00:00.000Z',lifetimeStatus:'secret string',message:'secret error'},{event:'secret event',at:'2026-10-09T00:00:00.000Z'}]}]}));
  createAppLifetimeJournal({directory,pid:200,ppid:99});const text=await readFile(file,'utf8');assert.ok(!text.includes('secret'));assert.equal(JSON.parse(text).sessions.length,2);
  await writeFile(file,'malformed');createAppLifetimeJournal({directory,pid:201,ppid:99});assert.equal(JSON.parse(await readFile(file,'utf8')).sessions.length,1);
});
test('a journal write failure remains nonfatal to the app',async t=>{
  const {directory,file}=await fixture(t);await writeFile(file,'synthetic blocking file');const journal=createAppLifetimeJournal({directory:file,pid:100,ppid:99});assert.equal(journal.record('exit',{code:1}),false);
});
