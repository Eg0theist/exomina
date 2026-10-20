import test from 'node:test';
import assert from 'node:assert/strict';
import {UpdateRestartGuard,UpdateInstallAction,updateRestartBlockers,VOICE_START_METHODS} from '../desktop/update-restart-guard.mjs';
import {SubscriptionRealtimeVoice} from '../desktop/realtime-voice.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('reply preparation reserves the update gate before it becomes active',async()=>{
  const preparation=deferred();let active=false,launches=0,finished=0,settled=0;
  const guard=new UpdateRestartGuard({busy:()=>active,launch:async()=>{launches++;},finish:()=>{finished++;},settled:()=>{settled++;}});
  const reply=guard.work(async()=>{await preparation.promise;active=true;});
  assert.equal(guard.idle,false);
  await assert.rejects(guard.run('chat'),/work is still preparing/);
  assert.equal(launches,0);
  preparation.resolve();await reply;
  assert.equal(settled,1);assert.equal(guard.idle,false);
  active=false;await guard.run('chat');
  assert.equal(launches,1);assert.equal(finished,1);
});

test('runner handshake blocks new work and coalesces repeated restart requests',async()=>{
  const handshake=deferred();let launches=0,finishes=0,started=false;
  const guard=new UpdateRestartGuard({launch:()=>{launches++;return handshake.promise;},finish:()=>{finishes++;}});
  const first=guard.run('chat'),second=guard.run('chat');
  assert.equal(first,second);assert.equal(launches,1);assert.equal(finishes,0);
  await assert.rejects(guard.work(()=>{started=true;}),/approved update/);
  assert.equal(started,false);
  handshake.resolve();await first;
  assert.equal(finishes,1);
  await assert.rejects(guard.work(()=>{}),/approved update/);
});

test('failed handshake keeps the app open and allows a subsequent reply or retry',async()=>{
  let failed=true,finishes=0;
  const guard=new UpdateRestartGuard({launch:async()=>{if(failed)throw Error('runner failed');},finish:()=>{finishes++;}});
  await assert.rejects(guard.run(),/runner failed/);
  assert.equal(finishes,0);assert.equal(guard.idle,true);
  assert.equal(await guard.work(()=>42),42);
  failed=false;await guard.run();assert.equal(finishes,1);
});

test('voice sessions and pending voice preparation prevent a restart',async()=>{
  for(const method of ['voice.listen','voice.speak','voice.realtime.prepare','voice.realtime.start','voice.realtime.preview.prepare','voice.realtime.preview.start'])assert.equal(VOICE_START_METHODS.has(method),true);
  assert.equal(VOICE_START_METHODS.has('voice.realtime.stop'),false);
  let speech=true,realtime=false;
  const guard=new UpdateRestartGuard({busy:()=>speech||realtime,launch:async()=>assert.fail('busy launch'),finish:()=>assert.fail('busy quit')});
  await assert.rejects(guard.run(),/voice sessions/);
  speech=false;realtime=true;await assert.rejects(guard.run(),/voice sessions/);
});

test('failed preparation releases its reservation',async()=>{
  const guard=new UpdateRestartGuard({launch:async()=>{},finish:()=>{}});
  await assert.rejects(guard.work(()=>{throw Error('invalid message');}),/invalid message/);
  assert.equal(guard.idle,true);assert.equal(guard.preparing,0);
});

test('accepted follow-ups keep the approving task busy until their work ends',async()=>{
  let replying=true,queued=1,followups=true,launched=0;
  const guard=new UpdateRestartGuard({busy:()=>replying||queued||followups,launch:async()=>{launched++;},finish:()=>{}});
  await assert.rejects(guard.run('chat'),/Finish or stop/);
  replying=false;await assert.rejects(guard.run('chat'),/Finish or stop/);
  queued=0;await assert.rejects(guard.run('chat'),/Finish or stop/);
  assert.equal(launched,0);followups=false;await guard.run('chat');assert.equal(launched,1);
});

test('realtime shutdown delays the restart until its stop request has settled',async()=>{
  const stopped=deferred();let launches=0,restart;
  const voice=new SubscriptionRealtimeVoice({getRpc:()=>{},settled:()=>{restart=guard.run('chat');}});
  const guard=new UpdateRestartGuard({busy:()=>!!voice.active||voice.closing.size>0,launch:async()=>{launches++;},finish:()=>{}});
  voice.active={threadId:'voice',sessionId:'session',timer:null,rpc:{request:()=>stopped.promise},transcripts:{clear(){}}};
  const stop=voice.stop();assert.equal(voice.active,null);assert.equal(voice.closing.size,1);
  await assert.rejects(guard.run('chat'),/voice sessions/);assert.equal(launches,0);
  stopped.resolve();await stop;await restart;
  assert.equal(voice.closing.size,0);assert.equal(launches,1);
});

test('restart status names idle terminals and each actual blocker without reading content',async()=>{
  let counts={terminals:1};const guard=new UpdateRestartGuard({blockers:()=>updateRestartBlockers(counts),launch:async()=>{},finish:()=>{}});
  assert.equal(guard.status().idle,false);assert.deepEqual(guard.status().blockers.map(item=>item.kind),['terminals']);
  await assert.rejects(guard.run(),/open terminal session.*prompt/);
  counts={replies:1,queued:2,commands:1,analysis:1,followups:1,voice:true,realtime:true,realtimeClosing:1};
  assert.deepEqual(guard.status().blockers.map(item=>item.kind),['replies','queued','commands','analysis','followups','voice','realtime','realtimeClosing']);
  counts={};assert.equal(guard.status().idle,true);
});

test('Apply closes only confirmed terminals and waits for their exit before handoff',async()=>{
  let ids=['user-shell'],launches=0,closes=0;const closed=deferred();
  const guard=new UpdateRestartGuard({blockers:()=>updateRestartBlockers({terminals:ids.length}),launch:async()=>{launches++;},finish:()=>{}});
  const action=new UpdateInstallAction({guard,terminalIds:()=>[...ids],confirm:async count=>{assert.equal(count,1);return true;},close:async selected=>{assert.deepEqual(selected,['user-shell']);closes++;await closed.promise;ids=[];}});
  const first=action.run(),second=action.run();assert.equal(first,second);await new Promise(resolve=>setImmediate(resolve));assert.equal(closes,1);assert.equal(launches,0);await assert.rejects(guard.work(()=>assert.fail('late work')),/approved update/);
  closed.resolve();assert.deepEqual(await first,{restarting:true});assert.equal(launches,1);
});

test('declining terminal closure preserves sessions and allows another apply attempt',async()=>{
  let confirmed=false,ids=['shell'],launches=0,closes=0;
  const guard=new UpdateRestartGuard({blockers:()=>updateRestartBlockers({terminals:ids.length}),launch:async()=>{launches++;},finish:()=>{}});
  const action=new UpdateInstallAction({guard,terminalIds:()=>[...ids],confirm:async()=>confirmed,close:async()=>{closes++;ids=[];}});
  assert.deepEqual(await action.run(),{cancelled:true});assert.equal(closes,0);assert.equal(launches,0);assert.deepEqual(ids,['shell']);
  confirmed=true;await action.run();assert.equal(closes,1);assert.equal(launches,1);
});

test('reply or new terminal starting during confirmation never gets silently interrupted',async()=>{
  for(const race of ['reply','terminal']){
    let ids=['approved-shell'],replies=0,closes=0,launches=0;
    const guard=new UpdateRestartGuard({blockers:()=>updateRestartBlockers({terminals:ids.length,replies}),launch:async()=>{launches++;},finish:()=>{}});
    const action=new UpdateInstallAction({guard,terminalIds:()=>[...ids],confirm:async()=>{if(race==='reply')replies++;else ids.push('new-shell');return true;},close:async selected=>{closes++;ids=ids.filter(id=>!selected.includes(id));}});
    await assert.rejects(action.run(),race==='reply'?/active reply/:/terminal/);assert.equal(launches,0);assert.equal(closes,0);
    assert.deepEqual(ids,race==='reply'?['approved-shell']:['approved-shell','new-shell']);
  }
});

test('Apply never offers to interrupt replies, commands, voice or analysis',async()=>{
  for(const counts of [{replies:1},{commands:1},{analysis:1},{voice:true},{followups:1},{queued:1}]){
    const guard=new UpdateRestartGuard({blockers:()=>updateRestartBlockers({...counts,terminals:1}),launch:async()=>assert.fail('busy launch'),finish:()=>{}});
    const action=new UpdateInstallAction({guard,terminalIds:()=>['shell'],confirm:async()=>assert.fail('must finish this work first'),close:async()=>assert.fail('must not stop terminal')});
    await assert.rejects(action.run(),/Update is waiting/);
  }
});

test('failed terminal closure leaves the application open',async()=>{
  let launches=0;const guard=new UpdateRestartGuard({blockers:()=>updateRestartBlockers({terminals:1}),launch:async()=>{launches++;},finish:()=>{}});
  const action=new UpdateInstallAction({guard,terminalIds:()=>['shell'],confirm:async()=>true,close:async()=>{throw Error('still closing');}});
  await assert.rejects(action.run(),/still closing/);assert.equal(launches,0);assert.equal(guard.completed,false);
});
