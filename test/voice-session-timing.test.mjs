import test from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeVoiceSession} from '../src/realtime-voice-session.js';
import {voiceTimingEvent,voiceTimingRun} from '../desktop/voice-session-timing.mjs';

function fixture() {
  let time=1000;const calls=[],states=[],sent=[];
  const track={enabled:true,stop(){this.stopped=true;}},stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  const channel={readyState:'open',send:data=>sent.push(JSON.parse(data)),close(){this.closed=true;}};
  const peer={connectionState:'new',addTrack(){},createDataChannel:()=>channel,createOffer:async()=>({type:'offer',sdp:'offer'}),async setLocalDescription(value){this.localDescription=value;},close(){this.closed=true;}};
  const audio={play:async()=>{},pause(){},remove(){}};
  const session=new RealtimeVoiceSession({invoke:async(method,payload)=>{calls.push({method,payload});return method.endsWith('.prepare')?{sessionId:'session',voices:['cove'],defaultVoice:'cove'}:method.endsWith('.start')?{conversationId:'chat'}:{};},current:()=>({conversationId:'chat',page:'chat',settings:{}}),update:state=>states.push(state),getMedia:async()=>stream,createPeer:()=>peer,createAudio:()=>audio,now:()=>time,schedule:()=>1,unschedule:()=>{}});
  return {session,calls,states,sent,peer,track,tick:ms=>{time+=ms;}};
}

test('live voice displays reply preparation and measures speech end to first output signal once',async()=>{
  const f=fixture();await f.session.start();f.peer.connectionState='connected';f.peer.onconnectionstatechange();
  f.session.dataEvent({type:'input_audio_buffer.speech_started',transcript:'private words'});f.tick(250);
  f.session.dataEvent({type:'input_audio_buffer.speech_stopped'});assert.equal(f.session.phase,'waiting');assert.equal(f.track.enabled,true);assert.match(f.states.at(-1).hint,/interrupt/);
  f.tick(400);f.session.dataEvent({type:'input_audio_buffer.speech_stopped'});f.tick(250);
  f.session.dataEvent({type:'session.output_audio.delta',delta:'private audio'});f.tick(20);
  f.session.dataEvent({type:'response.audio.delta',delta:'more audio'});assert.equal(f.session.phase,'speaking');
  await f.session.stop();const trace=f.calls.find(call=>call.method==='voice.realtime.trace').payload;
  assert.deepEqual(trace.events.filter(event=>event.name==='response-output'),[{name:'response-output',atMs:900,responseDelayMs:650}]);
  assert.equal(trace.events.filter(event=>event.name==='speech-stopped').length,1);
  assert.equal(JSON.stringify(trace).includes('private'),false);assert.equal(JSON.stringify(trace).includes('delta'),false);
  assert.equal(f.track.stopped,true);assert.equal(f.peer.closed,true);
});

test('interruptions and resumed speech discard the prior pending response clock',async()=>{
  const f=fixture();await f.session.start();f.session.dataEvent({type:'input_audio_buffer.speech_stopped'});f.tick(2000);
  f.session.interrupt();f.session.dataEvent({type:'output_audio_buffer.started'});
  assert.equal(f.session.liveTrace.some(event=>event.name==='response-output'),false);
  f.session.dataEvent({type:'input_audio_buffer.speech_stopped'});f.tick(1000);f.session.dataEvent({type:'input_audio_buffer.speech_started'});
  f.session.dataEvent({type:'response.output_audio.delta'});assert.equal(f.session.liveTrace.some(event=>event.name==='response-output'),false);
  f.session.dataEvent({type:'input_audio_buffer.speech_stopped'});f.tick(123);f.session.dataEvent({type:'output_audio_buffer.started'});
  assert.equal(f.session.liveTrace.at(-1).responseDelayMs,123);assert.deepEqual(f.sent.slice(0,2),[{type:'response.cancel'},{type:'output_audio_buffer.clear'}]);await f.session.stop();
});

test('a delayed stop acknowledgment from an interrupted reply preserves the next waiting reply',async()=>{
  const f=fixture();await f.session.start();f.session.dataEvent({type:'output_audio_buffer.started'});f.session.interrupt();
  f.session.dataEvent({type:'input_audio_buffer.speech_started'});f.session.dataEvent({type:'input_audio_buffer.speech_stopped'});f.tick(500);
  f.session.dataEvent({type:'output_audio_buffer.cleared'});f.session.dataEvent({type:'output_audio_buffer.stopped'});assert.equal(f.session.phase,'waiting');
  f.tick(200);f.session.dataEvent({type:'output_audio_buffer.started'});assert.equal(f.session.liveTrace.at(-1).responseDelayMs,700);await f.session.stop();
});

test('only current-session backend timings are retained, with their independent clock labeled',async()=>{
  const f=fixture();await f.session.start();f.tick(500);
  const event={type:'timing',name:'thread-ready',elapsedMs:450,reasoningEffort:'low',secret:'private token'};
  await f.session.receive({type:'voice.realtime.event',sessionId:'stale-session',event});
  await f.session.receive({type:'voice.realtime.event',sessionId:'session',event});
  assert.deepEqual(f.session.liveTrace.at(-1),{name:'thread-ready',atMs:500,elapsedMs:450,reasoningEffort:'low'});
  f.session.mode='preview';f.session.liveTiming('thread-ready',event);assert.equal(f.session.liveTrace.filter(value=>value.name==='thread-ready').length,1);f.session.mode='realtime';await f.session.stop();
});

test('diagnostic sink strips arbitrary content, sanitizes enums and caps durations and event counts',()=>{
  const privateValue='credential or transcript';
  assert.equal(voiceTimingEvent({name:privateValue}),null);
  const run=voiceTimingRun({result:privateValue,events:[{name:'thread-ready',atMs:Infinity,elapsedMs:-3,reasoningEffort:privateValue,model:privateValue},{name:'turn-completed',atMs:4e9,elapsedMs:NaN,status:privateValue,turnElapsedMs:4e9,turnId:privateValue},{name:'response-output',atMs:4,responseDelayMs:123.6,audio:privateValue},{name:privateValue}],transcript:privateValue},'2026-10-07T22:00:00.000Z');
  assert.deepEqual(run.events,[{name:'thread-ready',atMs:0,elapsedMs:0,reasoningEffort:'unknown'},{name:'turn-completed',atMs:3600000,elapsedMs:0,status:'unknown',turnElapsedMs:3600000},{name:'response-output',atMs:4,responseDelayMs:124}]);
  assert.equal(run.result,'stopped');assert.equal(JSON.stringify(run).includes(privateValue),false);
  assert.equal(voiceTimingRun({events:Array.from({length:10000},()=>({name:'speech-started',atMs:2}))}).events.length,120);
});

test('trace collection stays bounded and stop failures do not prevent resource release',async()=>{
  const f=fixture();await f.session.start();for(let i=0;i<500;i++)f.session.liveTiming('speech-started');assert.equal(f.session.liveTrace.length,120);
  const original=f.session.invoke;f.session.invoke=(method,payload)=>method==='voice.realtime.trace'?Promise.reject(Error('disk unavailable')):original(method,payload);
  await f.session.stop();assert.equal(f.track.stopped,true);assert.equal(f.peer.closed,true);assert.equal(f.session.mode,'');
});
