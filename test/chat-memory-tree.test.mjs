import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {ChatMemoryTree} from '../desktop/chat-memory-tree.mjs';

const qaRoot=process.platform==='win32'?'C:\\Program Files\\Exomina\\Workspace\\.exomina-qa-temp':process.env.TMPDIR;
if(!qaRoot)throw Error('Set TMPDIR to an isolated synthetic test directory.');
process.env.TEMP=qaRoot;process.env.TMP=qaRoot;process.env.TMPDIR=qaRoot;
const fixture=async(options={})=>{await mkdir(qaRoot,{recursive:true});const dir=await mkdtemp(path.join(qaRoot,'chat-tree-'));return {dir,tree:await new ChatMemoryTree(dir,options).init()};};
const event=(id,text='short synthetic text')=>({key:`event-${id}`,text,role:id%2?'assistant':'user',kind:'message',createdAt:new Date(1700000000000+id*1000).toISOString(),metadata:{attachmentIds:[`synthetic-${id}`]}});
const coverage=(view,total)=>{let next=0;for(const entry of view.entries){assert.equal(entry.id,next);assert.equal(entry.id%entry.count,0);assert.equal(Number.isInteger(Math.log2(entry.count)),true);next+=entry.count;}assert.equal(next,total);assert.equal(Buffer.byteLength(view.text,'utf8'),view.bytes);};
const finish=async(tree,chatId)=>{for(let rounds=0;rounds<1000;rounds++){const jobs=await tree.readyJobs(8,{chatId});if(!jobs.length)return;for(const job of jobs){const source=await tree.sourceTask(job);const text=job.count===1?'faithful synthetic leaf facts':'preserved synthetic range '+job.id+' through '+(job.id+job.count-1)+' with user and assistant attribution';assert.equal((await tree.commitSummary(job,(source.prefix?source.prefix+' ':'')+text)).committed,true);}}throw Error('Synthetic drain did not finish.');};

test('retry deadlines survive restart, cannot be bypassed by new messages, and retain exact originals', async () => {
  const { dir, tree } = await fixture(); const now = 1000;
  await tree.append('chat', event(0, 'Exact original correction. '.repeat(60)));
  const [job] = await tree.readyJobs(1, { now });
  await tree.failJob(job, 'Operational failure.', { retryAt: now + 60_000 });
  await tree.append('chat', event(1, 'New source event.'));
  assert.equal((await tree.readyJobs(8, { now })).length, 0);
  assert.equal(await tree.nextRetry({ chatId: 'chat' }), now + 60_000);
  await tree.close(); const reopened = await new ChatMemoryTree(dir).init();
  try {
    assert.equal((await reopened.readyJobs(8, { now: now + 59_999 })).length, 0);
    const [retry] = await reopened.readyJobs(8, { now: now + 60_000 });
    assert.equal(retry.id, 0); assert.notEqual(retry.token, job.token);
    assert.equal((await reopened.commitSummary(job, 'Stale.')).stale, true);
    await reopened.commitSummary(retry, 'Correction retained.');
    assert.equal((await reopened.zoom('chat', 0)).text, 'Exact original correction. '.repeat(60));
    assert.equal(await reopened.nextRetry(), 0); assert.equal((await reopened.audit('chat')).valid, true);
  } finally { await reopened.close(); }
});

test('a paused job is deferred without losing its source or requiring another chat message',async()=>{
  const {tree}=await fixture();
  try{
    await tree.append('chat',event(0,'An important user decision. '.repeat(40)));
    const [job]=await tree.readyJobs(1);assert.ok(job);
    assert.equal((await tree.deferJob(job)).deferred,true);
    assert.equal((await tree.commitSummary(job,'stale response')).stale,true);
    const [resumed]=await tree.readyJobs(1);assert.ok(resumed);assert.notEqual(resumed.token,job.token);
    assert.equal((await tree.commitSummary(resumed,'[user/message] An important user decision.')).committed,true);
    assert.equal((await tree.audit('chat')).valid,true);
  }finally{await tree.close();}
});

test('bulky tool output builds searchable entries and parent ranges without summary requests',async()=>{
  const {tree}=await fixture();
  try{
    for(let id=0;id<8;id++)await tree.append('chat',{...event(id,'dump '.repeat(3000)),role:'tool',kind:'echo'});
    assert.equal((await tree.readyJobs(8)).length,0);
    assert.match((await tree.view('chat')).text,/search-only tool output|kept out of summaries/);
    assert.equal((await tree.zoom('chat',0)).totalCharacters,15000);
    assert.equal((await tree.audit('chat')).valid,true);
  }finally{await tree.close();}
});

test('tool calls and output get excerpts and tool-only ranges get counted notes without summary requests',async()=>{
  const {tree}=await fixture();
  try{
    const call=(id,name)=>({...event(id,`${name}\n${JSON.stringify({command:'synthetic '.repeat(120)})}`),role:'tool',kind:'tool'});
    const output=(id,status)=>({...event(id,'line of synthetic output\n'.repeat(60)),role:'tool',kind:'echo',metadata:{tool:'shell',status}});
    await tree.sync('chat',[call(0,'workspace_shell'),output(1,'done'),call(2,'workspace_shell'),output(3,'error')]);
    assert.equal((await tree.readyJobs(8)).length,0);
    const leaves=(await tree.zoom('chat',0,2)).children;
    assert.match(leaves[0].text,/^\[tool\/tool\] workspace_shell \{"command":"synthetic .* … \(excerpt of [\d,]+ characters; conversation_zoom for the whole\)$/);
    assert.match(leaves[1].text,/^\[tool\/echo\] line of synthetic output/);
    assert.equal((await tree.stats('chat')).builtNodes,7);
    const note=(await tree.zoom('chat',0,4)).children.map(child=>child.text);
    assert.match(note[0],/^\[tool steps\] 1 call: workspace_shell×1; 1 output\. Inputs and outputs: conversation_zoom\. First call: workspace_shell/);
    assert.match(note[0],/ Last output: ….*line of synthetic output$/);
    assert.match(note[1],/1 output, 1 error\./);
    for(const node of [...leaves,...(await tree.zoom('chat',0,4)).children])assert.equal(Buffer.byteLength(node.text)<=512,true);
    assert.equal((await tree.zoom('chat',0)).text.startsWith('workspace_shell\n'),true);
    assert.equal((await tree.audit('chat')).valid,true);
  }finally{await tree.close();}
});

test('a range mixing conversation with tool traffic still waits for a model summary',async()=>{
  const {tree}=await fixture();
  try{
    await tree.sync('chat',[{...event(0,'echo output '.repeat(60)),role:'tool',kind:'echo'},{...event(1,'An assistant explanation that matters. '.repeat(20)),role:'assistant',kind:'assistant'}]);
    const jobs=await tree.readyJobs(8);assert.deepEqual(jobs.map(job=>[job.id,job.count]),[[1,1]]);
    await tree.commitSummary(jobs[0],'[assistant/assistant] explained what matters');
    const [parent]=await tree.readyJobs(8);assert.deepEqual([parent.id,parent.count],[0,2]);
  }finally{await tree.close();}
});

test('queued tool-only jobs from before the rule are caught up page by page, cascading to parents',async()=>{
  const {dir,tree}=await fixture();
  await tree.sync('chat',Array.from({length:8},(_,id)=>({...event(id,'synthetic output '.repeat(60)),role:'tool',kind:id%2?'echo':'tool'})));
  await tree.close();
  // Rewind to the state an earlier build left: every leaf queued as a model job, no parents.
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(path.join(dir,'chat-memory','tree.sqlite'));
  db.exec("UPDATE tree_nodes SET text=NULL,content_hash=NULL,built_as=NULL WHERE chat_id='chat'; DELETE FROM tree_nodes WHERE chat_id='chat' AND count>1; INSERT INTO tree_jobs(chat_id,id,count,source_hash) SELECT chat_id,id,count,source_hash FROM tree_nodes WHERE chat_id='chat'; UPDATE tree_chats SET built_count=0,node_count=8 WHERE chat_id='chat'; UPDATE tree_view_entries SET bytes=40 WHERE chat_id='chat'; UPDATE tree_views SET bytes=320 WHERE chat_id='chat';");
  db.close();
  const reopened=await new ChatMemoryTree(dir).init();
  try{
    assert.equal((await reopened.stats('chat')).jobs.ready,8);
    let cursor=null,pages=0,classified=0;
    do{const page=await reopened.classifyDeterministic('chat',{limit:3,cursor});cursor=page.cursor;classified+=page.classified;pages++;}while(cursor);
    assert.equal(classified,8);assert.equal(pages,3);
    const stats=await reopened.stats('chat');assert.equal(stats.jobs.ready,0);assert.equal(stats.builtNodes,15);
    assert.match((await reopened.zoom('chat',0,8)).children[0].text,/^\[tool steps\] 2 calls: tool×2; 2 outputs/);
    // One complete pass is recorded, so later replies skip the scan; removing the chat forgets it.
    assert.equal(await reopened.deterministicPending('chat'),false);
    await reopened.removeChat('chat');assert.equal(await reopened.deterministicPending('chat'),true);
  }finally{await reopened.close();}
});

test('a budget too small for a useful excerpt queues a summary job instead of an oversized entry',async()=>{
  const {tree}=await fixture({maxSummaryBytes:100,turnHigh:2000,turnLow:1000,compactionHigh:1000,compactionLow:500});
  try{
    await tree.append('chat',{...event(0,'shell\n'+'x'.repeat(300)),role:'tool',kind:'tool'});
    assert.deepEqual((await tree.readyJobs(8)).map(job=>[job.id,job.count]),[[0,1]]);
    assert.equal((await tree.audit('chat')).valid,true);
  }finally{await tree.close();}
});

test('immutable unique events retain exact Unicode, metadata and source dates across restart',async()=>{
  const {dir,tree}=await fixture();const original=event(0,'é 😀 exact original\nsecond line');
  try{
    assert.deepEqual(await tree.append('chat',original),{chatId:'chat',id:0,appended:true});
    assert.equal((await tree.append('chat',{...original,metadata:{attachmentIds:['synthetic-0']}})).appended,false);
    await assert.rejects(tree.append('chat',{...original,text:'changed'}),/immutable/);
    const before=await tree.view('chat');assert.match(before.text,/0\+1 \[user\/message\]/);coverage(before,1);
    const zoom=await tree.zoom('chat',0);assert.equal(zoom.text,original.text);assert.deepEqual(zoom.metadata,original.metadata);assert.equal(zoom.date,original.createdAt);
    await tree.close();const restarted=await new ChatMemoryTree(dir).init();try{assert.deepEqual(await restarted.view('chat'),before);assert.equal((await restarted.zoom('chat',0)).sourceHash,zoom.sourceHash);assert.equal((await restarted.append('chat',event(1))).id,1);}finally{await restarted.close();}
  }finally{await tree.close();}
});

test('short exact leaves and joined parents are built without model jobs within 512 UTF-8 bytes',async()=>{
  const {tree}=await fixture();try{await tree.sync('chat',[event(0,'a'),event(1,'b'),event(2,'c'),event(3,'d')]);assert.equal((await tree.readyJobs(8)).length,0);const stats=await tree.stats('chat');assert.equal(stats.nodes,7);assert.equal(stats.builtNodes,7);assert.equal((await tree.zoom('chat',0,4)).children.every(child=>!child.pending),true);assert.equal((await tree.audit('chat')).valid,true);assert.equal((await tree.zoom('chat',1)).text,'b');}finally{await tree.close();}
});

test('long pending leaves expose opaque placeholders and exact paginated originals, never partial source',async()=>{
  const {tree}=await fixture();const text='Private synthetic original 😀 '.repeat(2000);try{await tree.append('chat',event(0,text));const view=await tree.view('chat');assert.equal(view.entries[0].pending,true);assert.equal(view.text.includes('Private synthetic original'),false);let result='',offset=0;do{const page=await tree.zoom('chat',0,1,{offset,limit:37});result+=page.text;offset=page.nextOffset;}while(offset!==null);assert.equal(result,text);const [job]=await tree.readyJobs(1);const task=await tree.sourceTask(job);assert.equal(task.source[0].text,text);assert.equal(task.context.length,0);assert.equal(task.prefix,'[user/message]');await assert.rejects(tree.commitSummary(job,'😀'.repeat(128)),/512 UTF-8/);assert.equal((await tree.view('chat')).entries[0].pending,true);assert.equal((await tree.commitSummary(job,'😀'.repeat(120))).committed,true);assert.equal(Buffer.byteLength((await tree.view('chat')).entries[0].text)<=512,true);assert.equal((await tree.zoom('chat',0)).text,text.slice(0,16000));}finally{await tree.close();}
});

test('jobs become ready only after both children commit; contextual views never include future or pending source',async()=>{
  const {tree}=await fixture();try{await tree.sync('chat',[event(0,'A'.repeat(900)),event(1,'B'.repeat(900)),event(2,'future exact source')]);const jobs=await tree.readyJobs(8);assert.deepEqual(jobs.map(job=>job.count),[1,1]);assert.equal((await tree.sourceTask(jobs[0])).context.length,0);assert.equal((await tree.sourceTask(jobs[1])).context.length,0);await tree.commitSummary(jobs[0],'A'.repeat(300));assert.equal((await tree.readyJobs(8)).length,0);const second=await tree.sourceTask(jobs[1]);assert.equal(second.context.length,1);assert.equal(second.context[0].id,0);await tree.commitSummary(jobs[1],'B'.repeat(300));const [parent]=await tree.readyJobs(8);assert.equal(parent.count,2);const task=await tree.sourceTask(parent);assert.equal(task.source.length,2);assert.equal(task.source.every(source=>!source.pending),true);assert.equal(task.context.every(source=>source.id+source.count<=2),true);await tree.commitSummary(parent,'The user and assistant each supplied synthetic content.');assert.equal((await tree.audit('chat')).valid,true);}finally{await tree.close();}
});

test('claims are unique, rejected results are stale, and failures retry only after a new event or explicit resume',async()=>{
  const {tree}=await fixture();try{await tree.append('chat',event(0,'long '.repeat(200)));const [first]=await tree.readyJobs(1);assert.equal((await tree.readyJobs(1)).length,0);await tree.failJob(first,new Error('synthetic failure'));assert.equal((await tree.readyJobs(1)).length,0);await tree.append('chat',event(0,'long '.repeat(200)));assert.equal((await tree.readyJobs(1)).length,0);await tree.append('chat',event(1));const [second]=await tree.readyJobs(1);assert.notEqual(second.token,first.token);assert.deepEqual(await tree.commitSummary(first,'old'),{committed:false,stale:true});await tree.failJob(second,'unavailable');assert.equal((await tree.readyJobs(1)).length,0);await tree.resume('chat');const [third]=await tree.readyJobs(1);assert.equal(third.attempt,3);await tree.commitSummary(third,'retained details');assert.equal((await tree.stats('chat')).jobs.failed,0);}finally{await tree.close();}
});

test('a failed early leaf stops context at its first hole even when later leaves and a parent finish',async()=>{
  const {tree}=await fixture();try{
    await tree.sync('chat',[event(0,'known prefix'),event(1,'blocked '.repeat(200)),event(2,'later built '.repeat(25)),event(3,'later long source '.repeat(100))]);
    const jobs=await tree.readyJobs(8),blocked=jobs.find(job=>job.id===1),later=jobs.find(job=>job.id===3);
    await tree.failJob(blocked,'synthetic unavailable source');
    const leafTask=await tree.sourceTask(later);
    assert.deepEqual(leafTask.context.map(entry=>entry.id),[0]);assert.equal(leafTask.contextEnd,1);assert.equal(leafTask.contextPending,true);
    await tree.commitSummary(later,'later completed summary '.repeat(12));
    const [parent]=await tree.readyJobs(8);assert.deepEqual([parent.id,parent.count],[2,2]);
    const parentTask=await tree.sourceTask(parent);
    assert.deepEqual(parentTask.context.map(entry=>entry.id),[0]);assert.equal(parentTask.contextEnd,1);assert.equal(parentTask.source.every(entry=>!entry.pending),true);
    await tree.commitSummary(parent,'Later user and assistant details stay separate from the unfinished source.');
    await tree.resume('chat');const [retry]=await tree.readyJobs(8);assert.equal(retry.id,1);
    await tree.commitSummary(retry,'The previously unavailable source was summarized.');
    assert.equal((await tree.audit('chat')).valid,true);
  }finally{await tree.close();}
});

test('failed leaves cannot block later work and chronological context still stops at the first gap',async()=>{
  const {tree}=await fixture();try{
    await tree.sync('chat',Array.from({length:24},(_,id)=>event(id,'long synthetic source '.repeat(60))));
    const first=await tree.readyJobs(24);assert.deepEqual(first.map(job=>job.id),[0,1,2,3,4,5,6,7]);
    assert.equal((await tree.readyJobs(24)).length,0);
    for(const job of first)await tree.failJob(job,'synthetic provider failure');
    const later=await tree.readyJobs(24);assert.deepEqual(later.map(job=>job.id),[8,9,10,11,12,13,14,15]);
    const eighth=later[0];
    const task=await tree.sourceTask(eighth);assert.deepEqual(task.context,[]);assert.equal(task.contextEnd,0);
    await tree.resume('chat');const retries=await tree.readyJobs(24);assert.deepEqual(retries.map(job=>job.id),[0,1,2,3,4,5,6,7]);
    await tree.commitSummary(retries[0],'The earliest source now completed.');
    const ninth=later[1];
    const nextTask=await tree.sourceTask(ninth);assert.deepEqual(nextTask.context.map(entry=>entry.id),[0]);assert.equal(nextTask.contextEnd,1);
    assert.equal((await tree.view('chat')).text.includes('conversation_zoom'),true);
  }finally{await tree.close();}
});

test('restart reclaims unfinished jobs without rebuilding or changing either persistent view',async()=>{
  const {dir,tree}=await fixture({turnHigh:1700,turnLow:1100,compactionHigh:1000,compactionLow:700});try{await tree.sync('chat',Array.from({length:8},(_,id)=>event(id,'x'.repeat(265))));const [running]=await tree.readyJobs(1);const turn=await tree.view('chat'),compact=await tree.view('chat',{kind:'compaction'});await tree.close();const restarted=await new ChatMemoryTree(dir,{turnHigh:1700,turnLow:1100,compactionHigh:1000,compactionLow:700}).init();try{assert.deepEqual(await restarted.view('chat'),turn);assert.deepEqual(await restarted.view('chat',{kind:'compaction'}),compact);const [claimed]=await restarted.readyJobs(1);assert.equal(claimed.id,running.id);assert.notEqual(claimed.token,running.token);assert.deepEqual(await restarted.commitSummary(running,'stale after crash'),{committed:false,stale:true});await restarted.failJob(claimed);await restarted.resume('chat');await finish(restarted,'chat');coverage(await restarted.view('chat'),8);coverage(await restarted.view('chat',{kind:'compaction'}),8);}finally{await restarted.close();}}finally{await tree.close();}
});

test('at T=10 hysteresis merges the oldest highest-due built sibling pair first',async()=>{
  const options={turnHigh:2900,turnLow:2700,compactionHigh:10000,compactionLow:5000};const {tree}=await fixture(options);try{await tree.sync('chat',Array.from({length:10},(_,id)=>event(id,'x'.repeat(260))));const before=await tree.view('chat');assert.equal(before.bytes<options.turnHigh,true);assert.equal(before.entries.length,10);const pairs=await tree.readyJobs(5);assert.deepEqual(pairs.map(job=>[job.id,job.count]),[[0,2],[2,2],[4,2],[6,2],[8,2]]);for(const pair of pairs)await tree.commitSummary(pair,'s'.repeat(100));assert.equal((await tree.view('chat')).entries.length,10);await tree.append('chat',event(10,'x'.repeat(260)));const after=await tree.view('chat');assert.deepEqual(after.entries.map(entry=>[entry.id,entry.count]),[[0,2],...Array.from({length:9},(_,index)=>[index+2,1])]);assert.equal(after.bytes<=options.turnLow,true);assert.equal(after.compacting,false);const compact=await tree.view('chat',{kind:'compaction'});assert.equal(compact.entries.length,11);coverage(after,11);coverage(compact,11);}finally{await tree.close();}
});

test('default 128k/64k and 32k/16k views compact independently with full 0-based source coverage',async()=>{
  const {dir,tree}=await fixture();try{await tree.sync('large',Array.from({length:260},(_,id)=>event(id,'x'.repeat(480))));const waiting=await tree.stats('large');assert.equal(waiting.viewBytes>128000,true);assert.equal(waiting.overBudget,true);await finish(tree,'large');const stats=await tree.stats('large');assert.equal(stats.viewBytes<=64000,true);assert.equal(stats.compactionBytes<=16000,true);assert.equal(stats.overBudget,false);assert.equal(stats.totalMessages,260);const turn=await tree.view('large'),compact=await tree.view('large',{kind:'compaction'});coverage(turn,260);coverage(compact,260);assert.equal((await tree.audit('large')).valid,true);assert.notDeepEqual(turn.entries,compact.entries);await tree.close();const restarted=await new ChatMemoryTree(dir).init();try{assert.deepEqual(await restarted.view('large'),turn);await restarted.append('large',event(260,'tail'));const appended=await restarted.view('large');assert.deepEqual(appended.entries.slice(0,-1),turn.entries);coverage(appended,261);}finally{await restarted.close();}}finally{await tree.close();}
});

test('summary context stays bounded when unavailable parents leave a persistent view over budget',async()=>{
  const {tree}=await fixture({turnHigh:10000,turnLow:5000,compactionHigh:1000,compactionLow:500});try{await tree.sync('chat',Array.from({length:12},(_,id)=>event(id,'x'.repeat(300))));const jobs=await tree.readyJobs(12);const last=jobs.at(-1),task=await tree.sourceTask(last);assert.equal(task.contextBytes<=1000,true);assert.equal(task.contextTruncated,true);assert.equal(task.context.every(entry=>entry.id+entry.count<=last.id+last.count),true);assert.equal(task.context.every(entry=>!entry.text.includes('Summary pending')),true);coverage(await tree.view('chat',{kind:'compaction'}),12);}finally{await tree.close();}
});

test('explicit deletion invalidates claims and removes only the selected conversation',async()=>{
  const {tree}=await fixture();try{await tree.append('remove',event(0,'x'.repeat(900)));await tree.append('keep',event(0,'retained'));const [job]=await tree.readyJobs(1,{chatId:'remove'});assert.equal((await tree.removeChat('remove')).removed,true);assert.deepEqual(await tree.commitSummary(job,'late'),{committed:false,stale:true});assert.equal((await tree.stats('remove')).total,0);assert.equal((await tree.zoom('keep',0)).text,'retained');assert.equal((await tree.clear()).removedChats,1);assert.equal((await tree.stats('keep')).total,0);}finally{await tree.close();}
});

test('invalid ranges and Unicode are rejected; absent source dates remain unknown',async()=>{
  const {tree}=await fixture();try{await tree.append('chat',{key:'undated',text:'unknown date',role:'tool',kind:'result'});assert.equal((await tree.zoom('chat',0)).date,null);assert.deepEqual(await tree.date('chat',0),{chatId:'chat',id:0,count:1,first:null,last:null});assert.equal((await tree.append('chat',{key:'undated',text:'unknown date',role:'tool',kind:'result'})).appended,false);await assert.rejects(tree.zoom('chat',1,2),/aligned/);await assert.rejects(tree.zoom('chat',0,3),/power-of-two/);await assert.rejects(tree.append('chat',{key:'bad',text:'\uD800'}),/Unicode/);await assert.rejects(tree.zoom('chat',100),/does not exist/);const next=await tree.append('chat',event(1,'after rejection'));assert.equal(next.id,1);}finally{await tree.close();}
});

test('original export cursor reads complete indexed rows and keeps its snapshot across later appends',async()=>{
  const {tree}=await fixture();try{
    const inputs=[event(0,'original zero '.repeat(3000)),event(1,'original one'),event(2,'original two')];
    await tree.sync('chat',inputs);
    const first=await tree.originals('chat',{limit:1});assert.equal(first.snapshot,3);assert.equal(first.nextOffset,1);assert.equal(first.originals[0].text,inputs[0].text);assert.equal(first.originals[0].sourceHash,(await tree.zoom('chat',0)).sourceHash);
    await tree.append('chat',event(3,'new source outside the captured snapshot'));
    const second=await tree.originals('chat',{offset:first.nextOffset,limit:128,through:first.snapshot});assert.equal(second.total,3);assert.deepEqual(second.originals.map(row=>row.id),[1,2]);assert.equal(second.nextOffset,null);assert.deepEqual(second.originals[0].metadata,inputs[1].metadata);
    assert.equal((await tree.originals('chat')).total,4);await assert.rejects(tree.originals('chat',{through:5}),/snapshot/);await assert.rejects(tree.originals('chat',{offset:4,through:3}),/snapshot/);assert.deepEqual((await tree.originals('unknown')).originals,[]);
  }finally{await tree.close();}
});

test('cached job counters remain consistent through claims, failure, resume, completion and restart',async()=>{
  const {dir,tree}=await fixture();try{
    await tree.sync('chat',[event(0,'long '.repeat(200)),event(1,'long '.repeat(200)),event(2,'long '.repeat(200))]);
    assert.deepEqual((await tree.stats('chat')).jobs,{ready:3,running:0,failed:0});
    const [first,second]=await tree.readyJobs(2);assert.deepEqual((await tree.stats('chat')).jobs,{ready:1,running:2,failed:0});
    await tree.failJob(first,'fixture');assert.deepEqual((await tree.stats('chat')).jobs,{ready:1,running:1,failed:1});
    await tree.resume('chat');assert.deepEqual((await tree.stats('chat')).jobs,{ready:2,running:1,failed:0});
    await tree.commitSummary(second,'x'.repeat(300));assert.deepEqual((await tree.stats('chat')).jobs,{ready:2,running:0,failed:0});
    const [running]=await tree.readyJobs(1);assert.equal(running.id,0);await tree.close();
    const restarted=await new ChatMemoryTree(dir).init();try{assert.deepEqual((await restarted.stats('chat')).jobs,{ready:2,running:0,failed:0});await finish(restarted,'chat');assert.deepEqual((await restarted.stats('chat')).jobs,{ready:0,running:0,failed:0});await restarted.removeChat('chat');assert.equal((await restarted.stats('chat')).pendingJobs,0);}finally{await restarted.close();}
  }finally{await tree.close();}
});
