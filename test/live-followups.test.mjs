import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFollowups } from '../desktop/live-followups.mjs';
import { ConversationTools } from '../desktop/conversation-tools.mjs';
import { recentConversation } from '../desktop/context.mjs';
import { handoffContext } from '../desktop/model-preferences.mjs';

function fixture(overrides = {}) {
  const run = { message: { id: 'main-reply', content: 'Working on original task.', activity: [{ kind: 'tool', name: 'build', status: 'running', output: 'Compiling' }] }, cancelled: false };
  const chat = { id: 'chat', messages: [{ role: 'user', content: 'Finish the original task.' }, run.message] }, events = [], stopped = [];
  let current = run;
  const agent = new LiveFollowups({ getRun: id => id === 'chat' ? current : null, getChat: () => chat, prepare: async p => ({ selection: { provider: 'claude', model: 'sonnet' }, prompt: p.text, attachments: [] }),
    steer: async () => false, execute: async () => ({ text: 'The build is still compiling.' }), save: async () => {}, emit: e => events.push(e), stop: id => stopped.push(id), ...overrides });
  return { agent, run, chat, events, stopped, finish: () => { current = null; }, send: text => agent.send({ conversationId: 'chat', text, provider: 'claude' }) };
}
async function settle(f) { await Promise.all([...f.agent.pending.values()].map(w => w.promise)); }

test('question answers retain their card id in the accepted follow-up for restart recovery',async()=>{
  const f=fixture();const result=await f.agent.send({conversationId:'chat',text:'A saved card answer.',provider:'claude',questionId:'card-id'});
  assert.equal(f.run.message.followups[0].id,result.followup);assert.equal(f.run.message.followups[0].questionId,'card-id');await settle(f);
});

test('usage handoffs retain delivered corrections and parallel answers', () => {
  const f = fixture();
  f.run.message.followups = [{ text: 'Keep the existing filenames.', mode: 'live', status: 'delivered' }, { text: 'What does the warning mean?', answer: 'It concerns bundle size.', mode: 'parallel', status: 'answered' }];
  const checkpoint = JSON.parse(handoffContext(f.run.message).split('Handoff checkpoint:\n').at(-1).trim());
  assert.equal(checkpoint.followups[0].question, 'Keep the existing filenames.');
  assert.equal(checkpoint.followups[1].answer, 'It concerns bundle size.');
});

test('long history snapshots retain the latest task and work without truncating the JSON', () => {
  const f = fixture();
  f.chat.messages.unshift(...Array.from({ length: 12 }, () => ({ role: 'assistant', content: 'Earlier history. '.repeat(9000) })));
  f.run.message.followups = Array.from({ length: 20 }, () => ({ text: 'Old question. '.repeat(9000), answer: 'Old answer. '.repeat(9000) }));
  const text = f.agent.snapshot(f.chat, f.run.message), snapshot = JSON.parse(text);
  assert.ok(text.length <= 80000); assert.match(snapshot.messages.at(-1).content, /Working on original task/);
  assert.match(snapshot.messages.at(-2).content, /Finish the original task/); assert.equal(snapshot.work[0].output, 'Compiling');
});

test('live delivery preserves the active task while a brief parallel reply answers immediately', async () => {
  let inputs = [], calls = 0;
  const f = fixture({ steer: async (...args) => { inputs.push(args); return true; }, execute: async () => { calls++; return {text:'The build is still running.'}; } });
  await f.send('How far along is the build?'); await settle(f);
  assert.equal(inputs.length, 1); assert.equal(calls, 1); assert.deepEqual(f.stopped, []);
  assert.equal(f.run.cancelled, false); assert.equal(f.run.message.followups[0].status, 'answered');assert.equal(f.run.message.followups[0].deliveredToMain,true);
  assert.equal(f.chat.messages.length, 2); assert.equal(f.events.at(-1).messageId, 'main-reply');
});

test('a slow native steer does not hold up the parallel answer or lose a related direction',async()=>{
  let release,delivered,answers=0;
  const f=fixture({steer:async(_parent,prepared)=>{delivered=prepared.prompt;return new Promise(resolve=>release=resolve);},execute:async()=>{answers++;return {text:'I will include this direction in the current task.'};}});
  await f.send('Also preserve the existing setting.');
  while(!f.run.message.followups[0].answer)await new Promise(resolve=>setImmediate(resolve));
  assert.match(f.run.message.followups[0].answer,/include this direction/);assert.match(delivered,/preserve the existing setting/);assert.equal(answers,1);
  assert.equal(f.run.message.followups[0].taskStatus,'pending');assert.equal(f.run.cancelled,false);
  release(true);await settle(f);assert.equal(f.run.message.followups[0].deliveredToMain,true);assert.deepEqual(f.stopped,[]);
});

test('a failed native steer still answers in parallel and leaves changes for the main task',async()=>{
  const f=fixture({steer:async()=>{throw Error('Synthetic steer unavailable');},execute:async()=>({text:'The requested change is tracked.'})});
  await f.send('Apply one more connected change.');await settle(f);
  assert.equal(f.run.message.followups[0].status,'answered');assert.match(f.run.message.followups[0].deliveryError,/steer unavailable/);
  assert.equal(f.agent.unresolved(f.run).length,1);assert.equal(f.run.cancelled,false);
});

test('stopping a parallel answer keeps an already delivered direction in the main task',async()=>{
  let release;const f=fixture({steer:async()=>true,execute:()=>new Promise(resolve=>release=resolve)});
  const sent=await f.send('Keep this connected change.');while(!release)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.run.message.followups[0].deliveredToMain,true);assert.equal(f.agent.cancelOne('chat',sent.followup),true);
  release({text:'Late answer'});await settle(f);assert.equal(f.run.message.followups[0].taskStatus,'pending');assert.equal(f.agent.unresolved(f.run).length,1);assert.equal(f.run.cancelled,false);
});

test('a parallel answer finishes before the original task and streams into its own record', async () => {
  let release, request;
  const f = fixture({ execute: input => { request = input; return new Promise(resolve => { release = resolve; }); } });
  const result = await f.send('What does the warning mean?');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.agent.parent(result.followup), 'chat'); assert.equal(f.run.cancelled, false);
  f.agent.handle({ type: 'chat.delta', conversationId: result.followup, text: 'It concerns bundle size.' });
  assert.equal(f.run.message.followups[0].answer, 'It concerns bundle size.');
  assert.match(request.prompt, /Compiling/); assert.match(request.prompt, /Finish the original task/);
  release({ text: 'It concerns bundle size.' }); await settle(f);
  assert.equal(f.run.message.followups[0].status, 'answered'); assert.equal(f.run.message.content, 'Working on original task.');
  assert.deepEqual(f.stopped, []); assert.equal(f.agent.busy, false);
});

test('an answer can complete after the original task naturally finishes', async () => {
  let release;
  const f = fixture({ execute: () => new Promise(resolve => { release = resolve; }) });
  await f.send('Explain the result.'); while (!release) await new Promise(resolve => setImmediate(resolve));
  f.finish(); release({ text: 'Explanation.' }); await settle(f);
  assert.equal(f.run.message.followups[0].status, 'answered'); assert.equal(f.events.at(-1).messageId, 'main-reply');
});

test('stop cancels the parallel answer without retaining a late successful result', async () => {
  let release;
  const f = fixture({ execute: () => new Promise(resolve => { release = resolve; }) });
  const sent = await f.send('A question.'); while (!release) await new Promise(resolve => setImmediate(resolve));
  f.agent.cancel('chat'); release({ text: 'Late result.' }); await settle(f);
  assert.deepEqual(f.stopped, [sent.followup]); assert.equal(f.run.message.followups[0].status, 'failed');
  assert.equal(f.run.message.followups[0].answer, undefined);
});

test('native delivery failures stay visible without retrying actions or stopping the task', async () => {
  let calls = 0;
  const f = fixture({ steer: async () => { throw Error('Active turn changed.'); }, execute: async () => { calls++; return {text:'Question answered from visible progress.'}; } });
  await f.send('Question.'); await settle(f);
  assert.equal(calls, 1); assert.equal(f.run.message.followups[0].deliveryError, 'Active turn changed.');assert.equal(f.run.message.followups[0].status,'answered');assert.equal(f.agent.unresolved(f.run).length,1);assert.deepEqual(f.stopped, []);
});

test('stopping one side answer leaves the original task and other answers active', async () => {
  const releases = new Map();
  const f = fixture({ execute: input => new Promise(resolve => releases.set(input.conversationId, resolve)) });
  const first = await f.send('First question.'), second = await f.send('Second question.');
  while (releases.size < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.agent.cancelOne('another-chat', first.followup), false);
  assert.equal(f.agent.cancelOne('chat', first.followup), true);
  assert.deepEqual(f.stopped, [first.followup]); assert.equal(f.run.cancelled, false);
  releases.get(first.followup)({ text: 'Discard this late answer.' }); releases.get(second.followup)({ text: 'Keep this answer.' }); await settle(f);
  assert.equal(f.run.message.followups[0].status, 'failed'); assert.equal(f.run.message.followups[1].status, 'answered');
});

test('storage failure returns the draft without leaving a stranded in-progress item', async () => {
  const f = fixture({ save: async () => { throw Error('Save failed.'); } });
  await assert.rejects(f.send('Question.'), /Save failed/);
  assert.equal(f.agent.busy, false); assert.deepEqual(f.run.message.followups, []);
});

test('follow-up questions and answers survive history searches and provider handoffs', async () => {
  const f = fixture(); await f.send('Explain the purple widget.'); await settle(f);
  const tools = new ConversationTools({ getConversations: () => [f.chat] });
  const search = await tools.call('conversation_search', { query: 'purple widget' }, 'chat');
  assert.equal(JSON.parse(search.content[0].text).results[0].message.id, 'main-reply');
  const read = await tools.call('conversation_read', { messageId: 'main-reply' }, 'chat');
  assert.match(JSON.parse(read.content[0].text).text, /The build is still compiling/);
  assert.match(recentConversation(f.chat.messages), /purple widget/);
});

test('a parallel proposal is incorporated by the main task before completion', async () => {
  const f=fixture(),sent=await f.send('Implement a borderless window.'), calls=[];
  const result=await f.agent.beforeComplete('chat',{text:'Original task result.'},async request=>{
    calls.push(request);const item=request.items[0];
    assert.equal(item.status,'answered');assert.equal(item.taskStatus,'working');
    assert.match(request.prompt,/Implement a borderless window/);
    assert.match(request.prompt,/parallel answer does not implement/);
    await f.agent.update('chat',{id:item.id,status:'handled',summary:'Implemented and verified the borderless window.'});
    return {text:'Original task and borderless window completed.'};
  });
  assert.equal(calls.length,1);assert.match(result.text,/borderless window completed/);
  const item=f.run.message.followups[0];assert.equal(item.id,sent.followup);assert.equal(item.taskStatus,'handled');
  assert.equal(f.run.message.activity.find(step=>step.followupId===item.id).status,'done');
  assert.equal(f.run.acceptingFollowups,false);assert.equal(f.agent.inputs.size,0);
});

test('native work already acknowledged does not cause an extra provider turn',async()=>{
  let f;f=fixture({steer:async(parent,prepared,id)=>{await f.agent.update(parent,{id,status:'handled',summary:'Answered and applied the correction.'});return true;}});
  await f.send('Use the existing filenames.');
  const result=await f.agent.beforeComplete('chat',{text:'Done.'},()=>{throw Error('Unexpected continuation.');});
  assert.equal(result.text,'Done.');assert.equal(f.run.message.followups[0].taskStatus,'handled');
});

test('finishing waits for accepted attachment preparation and the side answer',async()=>{
  let releasePrepare,releaseAnswer,resumed=false;
  const f=fixture({prepare:()=>new Promise(resolve=>{releasePrepare=resolve;}),execute:()=>new Promise(resolve=>{releaseAnswer=resolve;})});
  const sending=f.send('Inspect the attached reference.');
  const finishing=f.agent.beforeComplete('chat',{text:'Original done.'},async({items})=>{resumed=true;await f.agent.update('chat',{id:items[0].id,status:'handled',summary:'Inspected the reference.'});return {text:'Both done.'};});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(resumed,false);assert.notEqual(f.run.acceptingFollowups,false);
  releasePrepare({selection:{provider:'claude',model:'sonnet'},prompt:'Reference text.\nInspect the attached reference.',images:[{mimeType:'image/png',dataBase64:'synthetic'}],attachments:[]});
  await sending;while(!releaseAnswer)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(resumed,false);releaseAnswer({text:'Reference explanation.'});
  const result=await finishing;assert.equal(result.text,'Both done.');assert.equal(resumed,true);
});

test('a follow-up arriving during continuation is handled before the final result',async()=>{
  const f=fixture();await f.send('First extra change.');let calls=0;
  const result=await f.agent.beforeComplete('chat',{text:'Original done.'},async({items})=>{
    calls++;if(calls===1)await f.send('Second change received during finishing.');
    for(const item of items)await f.agent.update('chat',{id:item.id,status:'handled',summary:'Completed '+item.text});
    return {text:'Final with '+calls+' batches.'};
  });
  assert.equal(calls,2);assert.match(result.text,/2 batches/);assert.ok(f.run.message.followups.every(item=>item.taskStatus==='handled'));
  await assert.rejects(f.send('After closing.'),/finished/);
});

test('unconfirmed completion remains visible instead of being labelled handled',async()=>{
  const f=fixture();await f.send('Implement the additional request.');let calls=0;
  const result=await f.agent.beforeComplete('chat',{text:'Original result.'},async()=>{calls++;return {text:'A proposal only.'};});
  assert.equal(calls,2);assert.equal(f.run.message.followups[0].taskStatus,'blocked');
  assert.match(result.text,/Follow-ups needing attention/);assert.match(result.text,/without confirming completion/);
});

test('failed steering is recovered through the main task and another chat cannot resolve it',async()=>{
  const f=fixture({steer:async()=>{throw Error('Turn ended.');}});const sent=await f.send('Make this extra edit.');
  await settle(f);assert.equal(f.run.message.followups[0].status,'answered');assert.match(f.run.message.followups[0].deliveryError,/Turn ended/);
  await assert.rejects(f.agent.update('another-chat',{id:sent.followup,status:'handled',summary:'Wrong chat.'}),/does not belong/);
  await assert.rejects(f.agent.update('chat',{id:sent.followup,status:'handled'}),/Explain/);
  await f.agent.beforeComplete('chat',{text:'Original result.'},async({items})=>{await f.agent.update('chat',{id:items[0].id,status:'handled',summary:'Extra edit completed and checked.'});return {text:'Both done.'};});
  assert.equal(f.run.message.followups[0].taskStatus,'handled');
  const transcript=JSON.parse((await new ConversationTools({getConversations:()=>[f.chat]}).call('conversation_read',{messageId:'main-reply'},'chat')).content[0].text).text;
  assert.match(transcript,/Extra edit completed and checked/);
});

test('stopping a side answer withdraws its request without resuming the main task for it',async()=>{
  let release;const f=fixture({execute:()=>new Promise(resolve=>{release=resolve;})});const sent=await f.send('Withdraw this.');
  while(!release)await new Promise(resolve=>setImmediate(resolve));assert.equal(f.agent.cancelOne('chat',sent.followup),true);
  release({text:'Late answer.'});await f.agent.beforeComplete('chat',{text:'Original completed.'},()=>{throw Error('Withdrawn follow-up resumed.');});
  assert.equal(f.run.message.followups[0].taskStatus,'cancelled');assert.equal(f.run.cancelled,false);
});

test('follow-up batches retain all text while bounding combined attachments and prompt size',()=>{
  const f=fixture(),items=Array.from({length:4},(_,i)=>({id:String(i),text:'Request.'}));
  for(const item of items)f.agent.inputs.set(item.id,{prompt:'x'.repeat(70000),attachments:[{bytes:12*1024*1024}]});
  assert.deepEqual(f.agent.batch(items),[items[0]]);
});

test('main-task failures keep follow-ups needing attention and release attachment inputs',async()=>{
  const f=fixture();await f.send('Additional work.');await settle(f);await f.agent.failed('chat','Provider unavailable');
  assert.equal(f.run.message.followups[0].taskStatus,'blocked');assert.match(f.run.message.followups[0].summary,/Provider unavailable/);assert.equal(f.agent.inputs.size,0);
});
