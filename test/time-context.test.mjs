import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {elapsed,localDay,localStamp,timeContext} from '../desktop/time-context.mjs';
import {recentConversation} from '../desktop/context.mjs';
import {chatViewBlocks,formatChatView} from '../desktop/chat-memory-context.mjs';
import {ChatMemoryTree} from '../desktop/chat-memory-tree.mjs';
import {MemoryStore} from '../desktop/memory.mjs';

const qaRoot=process.platform==='win32'?'C:\\Program Files\\Exomina\\Workspace\\.exomina-qa-temp':process.env.TMPDIR;
const local=(day,hour=12,minute=0)=>new Date(2026,9,day,hour,minute);

test('elapsed time is rounded into plain words',()=>{
  const now=local(27,12);
  assert.equal(elapsed(local(27,11,59),now),'1 minute ago');
  assert.equal(elapsed(local(27,11,53),now),'7 minutes ago');
  assert.equal(elapsed(local(26,12),now),'24 hours ago');assert.equal(elapsed(local(25,18,30),now),'2 days ago');
  assert.equal(elapsed(local(11,12),now),'16 days ago');
  assert.equal(elapsed(new Date(2026,7,1),now),'13 weeks ago');
  assert.equal(elapsed('not a date',now),null);
  assert.equal(localStamp(local(3,9,5)),'2026-10-03 09:05');
});

test('the time block gives now, chat age and the gap before this message',()=>{
  const messages=[{role:'user',content:'old'},{role:'user',content:'a',createdAt:local(11,10).toISOString()},{role:'assistant',content:'b',createdAt:local(25,18,30).toISOString()}];
  const text=timeContext(messages,local(27,12));
  assert.match(text,/now \w{3} 2026-10-27 12:00/);
  assert.match(text,/this chat began 2026-10-11 \(16 days ago\)/);
  assert.match(text,/previous message was 2026-10-25 18:30 \(2 days ago\)/);
  assert.doesNotMatch(timeContext([],local(27)),/chat began/);
});

test('recent messages carry their local time',()=>{
  const entries=JSON.parse(recentConversation([{id:'a',role:'user',content:'hi',createdAt:local(13,8,15).toISOString()},{id:'b',role:'assistant',content:'legacy'}]));
  assert.equal(entries[0].at,'2026-10-13 08:15');
  assert.equal('at' in entries[1],false);
});

test('chat view lines mark each new day and stay append-stable',()=>{
  const entry=(id,day)=>({id,count:1,text:`Line ${id}`,date:day&&local(day).toISOString()});
  const base=[entry(0,11),entry(1,11),entry(2,null),entry(3,13),entry(4,13),entry(5,13),entry(6,27),entry(7,27)];
  const view=formatChatView({entries:base});
  assert.deepEqual(view.lines.slice(0,4),['0+1|(2026-10-11) Line 0','1+1|Line 1','2+1|Line 2','3+1|(2026-10-13) Line 3']);
  assert.equal(view.lines[6],'6+1|(2026-10-27) Line 6');
  const grown=formatChatView({entries:[...base,entry(8,27),entry(9,28)]});
  assert.equal(grown.lines[8],'8+1|Line 8');assert.equal(grown.lines[9],'9+1|(2026-10-28) Line 9');
  const before=chatViewBlocks(view.lines),after=chatViewBlocks(grown.lines);
  assert.deepEqual(after.slice(0,3),before.slice(0,3));
});

test('tree view entries report the first known time in their range',async()=>{
  await mkdir(qaRoot,{recursive:true});const dir=await mkdtemp(path.join(qaRoot,'time-tree-'));const tree=await new ChatMemoryTree(dir).init();
  try{
    await tree.append('chat',{key:'legacy',text:'undated',role:'user',kind:'message',createdAt:null,metadata:{}});
    await tree.append('chat',{key:'dated',text:'dated',role:'assistant',kind:'message',createdAt:local(13,9).toISOString(),metadata:{}});
    const view=await tree.view('chat');
    assert.equal(view.entries.find(e=>e.id===0&&e.count===1)?.date??null,null);
    const dated=view.entries.find(e=>e.id+e.count===2);assert.equal(localDay(dated.date),'2026-10-13');
  }finally{await tree.close();await rm(dir,{recursive:true,force:true});}
});

test('shared notes and note deltas carry their local day',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-memory-time-'));const store=new MemoryStore(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  await store.init();await store.note('First synthetic note.');const version=store.meta();await store.note('Second synthetic note.');
  const wake=JSON.parse((await store.run(['wake'])).text),today=localDay(new Date());
  assert.ok(wake.notes.every(note=>note.date===today));
  assert.deepEqual((store.appendedSince?store:store.notes||store).appendedSince(version).map(note=>note.date),[today]);
});
