import test from 'node:test';
import assert from 'node:assert/strict';
import {SubscriptionRealtimeVoice,audioPermission,REALTIME_PREVIEW_REQUEST,REALTIME_PREVIEW_INSTRUCTION} from '../desktop/realtime-voice.mjs';
import {RealtimeVoiceSession,createSilentPreviewInput} from '../src/realtime-voice-session.js';
import {WindowsVoice} from '../desktop/voice.mjs';
import {appendVoiceTranscript} from '../desktop/voice-transcript.mjs';
import {RealtimeTranscriptCollector,sanitizeRealtimeTranscriptEvent} from '../desktop/realtime-transcript.mjs';

const offer='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('silent preview input sends zeros and releases its tracks and AudioContext on stop or failed resume',async()=>{
  for(const failure of [false,true]){
    const track={stopped:false,stop(){this.stopped=true;}},source={offset:{value:1},start(){this.started=true;},stop(){this.stopped=true;},connect(node){this.destination=node;},disconnect(){}},context={state:'suspended',createConstantSource:()=>source,createMediaStreamDestination:()=>({stream:{getTracks:()=>[track]}}),resume:async function(){if(failure)throw Error('resume failed');this.state='running';},close:async function(){this.closed=true;}};
    const request=createSilentPreviewInput({createContext:()=>context});
    if(failure)await assert.rejects(request,/resume failed/);else {const input=await request;assert.equal(source.offset.value,0);assert.equal(source.started,true);assert.equal(context.state,'running');assert.equal(track.stopped,false);input.close();}
    assert.equal(track.stopped,true);assert.equal(source.stopped,true);assert.equal(context.closed,true);
  }
});
test('Stop during a suspended silent stream aborts its pending resume and releases resources',async()=>{
  const controller=new AbortController(),track={stop(){this.stopped=true;}},source={offset:{},start(){},stop(){this.stopped=true;},connect(){},disconnect(){}},context={state:'suspended',createConstantSource:()=>source,createMediaStreamDestination:()=>({stream:{getTracks:()=>[track]}}),resume:()=>new Promise(()=>{}),close:async function(){this.closed=true;}};
  const request=createSilentPreviewInput({createContext:()=>context,signal:controller.signal});controller.abort();await assert.rejects(request,/preview stopped/);
  assert.equal(track.stopped,true);assert.equal(source.stopped,true);assert.equal(context.closed,true);
});
test('AVAS accepts WebRTC previews and conversations with realtime v3',async()=>{
  for(const preview of [true,false]) {
    const f=host({request:(method,params,result)=>{
      if(method==='thread/realtime/start'&&!['v1','v3'].includes(params.version))throw Error('AVAS realtime calls require realtime v1 or v3');
      if(method==='thread/realtime/start'&&!['juniper','cove'].includes(params.voice))throw Error('This voice is not supported for v3.');
      return result;
    }});
    const ready=await f.voice.prepare({preview});
    assert.deepEqual(ready.voices,['juniper','cove']);assert.equal(ready.defaultVoice,'juniper');
    await f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic',conversationId:'chat',voice:'cove',preview});
    const requests=f.calls.filter(call=>call.method==='thread/realtime/start');
    assert.equal(requests.length,1);assert.equal(requests[0].params.version,'v3');assert.equal(requests[0].params.voice,'cove');
    assert.deepEqual(requests[0].params.transport,{type:'webrtc',sdp:offer});
    assert.equal(f.voice.mediaAllowed(),!preview);
    await f.voice.stop();assert.equal(f.voice.active,null);
  }
});
test('voice previews cannot arm capture, use conversation context, or replace a live conversation',async()=>{
  const f=host(),ready=await f.voice.prepare({preview:true});assert.equal(f.voice.mediaAllowed(),false);
  const params={sessionId:ready.sessionId,sdp:offer,conversationId:'never-use-this-chat',workspace:'C:/synthetic',context:'PRIVATE CHAT CONTEXT',voice:'cove'};
  await assert.rejects(f.voice.start(params),/selected voice mode/);
  const result=await f.voice.start({...params,preview:true});assert.equal(result.conversationId,'');assert.equal(f.voice.mediaAllowed(),false);
  const start=f.calls.find(call=>call.method==='thread/realtime/start').params;assert.equal(start.voice,'cove');assert.ok(!start.prompt.includes('PRIVATE CHAT CONTEXT'));assert.equal(start.includeStartupContext,false);
  f.notify('thread/realtime/sdp',{sdp:offer});assert.equal(f.voice.mediaAllowed(),false);assert.equal(f.events.at(-1).preview,true);
  await f.voice.stop();assert.ok(f.timers.every(timer=>timer.cancelled));
  const g=host(),conversation=await g.voice.prepare();await assert.rejects(g.voice.prepare({preview:true}),/Stop the voice conversation/);assert.equal(g.voice.active.sessionId,conversation.sessionId);await g.voice.stop();
});
test('abandoned voice previews have a host timeout and ignore late notifications',async()=>{
  const f=host(),ready=await f.voice.prepare({preview:true});await f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic',preview:true});
  assert.equal(f.timers.at(-1).ms,35000);f.timers.at(-1).fn();await turn();assert.equal(f.voice.active,null);assert.equal(f.calls.at(-1).method,'thread/realtime/stop');
  const length=f.events.length;f.notify('thread/realtime/sdp',{sdp:offer});assert.equal(f.events.length,length);
});
test('a connected preview requests one sample and explicitly routes its reply into speech',async()=>{
  const f=host(),ready=await f.voice.prepare({preview:true});
  await assert.rejects(f.voice.sample(ready.sessionId),/Start a voice preview/);
  await f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic',preview:true});
  await assert.rejects(f.voice.sample(ready.sessionId),/Start a voice preview/);
  f.notify('thread/realtime/sdp',{sdp:offer});
  await assert.rejects(f.voice.sample('stale-preview'),/Start a voice preview/);
  assert.equal(f.voice.active.sessionId,ready.sessionId);
  assert.deepEqual(await f.voice.sample(ready.sessionId),{requested:true});
  assert.deepEqual(await f.voice.sample(ready.sessionId),{requested:false});
  assert.deepEqual(f.calls.filter(call=>call.method.startsWith('thread/realtime/append')),[]);
  assert.deepEqual(f.calls.filter(call=>call.method==='turn/start'),[{method:'turn/start',params:{threadId:'voice-thread',input:[{type:'text',text:REALTIME_PREVIEW_INSTRUCTION}],approvalPolicy:'never',effort:'low'}}]);
  assert.equal(f.calls.find(call=>call.method==='thread/realtime/start').params.clientManagedHandoffs,false);
  assert.equal(f.calls.find(call=>call.method==='thread/realtime/start').params.codexResponseHandoffMode,'commentary');
  f.notify('turn/completed',{turn:{id:'turn',status:'completed'}});assert.deepEqual(f.events.at(-1).event,{type:'trace',name:'turn/completed:completed'});assert.ok(REALTIME_PREVIEW_INSTRUCTION.includes(REALTIME_PREVIEW_REQUEST));
  assert.equal(f.voice.mediaAllowed(),false);await f.voice.stop();
  const next=await f.voice.prepare();await f.voice.start({sessionId:next.sessionId,sdp:offer,workspace:'C:/synthetic',conversationId:'chat'});f.notify('thread/realtime/sdp',{sdp:offer});
  await assert.rejects(f.voice.sample(next.sessionId),/Start a voice preview/);assert.equal(f.voice.active.sessionId,next.sessionId);await f.voice.stop();
});
test('native sample rejection reports the error and releases the preview and its timers',async()=>{
  const f=host({request:(method,_params,result)=>{if(method==='turn/start')throw Error('Native sample unavailable.');return result;}}),ready=await f.voice.prepare({preview:true});
  await f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic',preview:true});f.notify('thread/realtime/sdp',{sdp:offer});
  await assert.rejects(f.voice.sample(ready.sessionId),/Native sample unavailable/);
  assert.equal(f.voice.active,null);assert.equal(f.voice.mediaAllowed(),false);assert.ok(f.timers.every(timer=>timer.cancelled));
  assert.equal(f.events.at(-2).event.message,'Native sample unavailable.');assert.equal(f.events.at(-1).event.type,'stopped');assert.equal(f.calls.at(-1).method,'thread/realtime/stop');
});
test('late native sample completion or failure cannot stop a newer preview',async()=>{
  for(const failure of [false,true]) {
    let settle;const pending=new Promise((resolve,reject)=>{settle=()=>failure?reject(Error('Old preview failed.')):resolve({});});
    const f=host({request:(method,_params,result)=>method==='turn/start'?pending:result}),ready=await f.voice.prepare({preview:true});
    await f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic',preview:true});f.notify('thread/realtime/sdp',{sdp:offer});
    const requested=f.voice.sample(ready.sessionId);await turn();assert.deepEqual(await f.voice.sample(ready.sessionId),{requested:false});
    await f.voice.stop(ready.sessionId);const next=await f.voice.prepare({preview:true}),length=f.events.length;settle();
    if(failure)await assert.rejects(requested,/Old preview failed/);else assert.deepEqual(await requested,{requested:false});
    assert.equal(f.events.length,length);assert.equal(f.voice.active.sessionId,next.sessionId);await f.voice.stop();
  }
});
test('stopping a preview cancels its unfinished backend turn, including a late start response',async()=>{
  for(const late of [false,true]){
    let resolve;const pending=new Promise(done=>resolve=done);
    const f=host({request:(method,_params,result)=>method==='turn/start'&&late?pending:result}),ready=await f.voice.prepare({preview:true});
    await f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic',preview:true});f.notify('thread/realtime/sdp',{sdp:offer});
    const request=f.voice.sample(ready.sessionId);await turn();await f.voice.stop();
    if(late)resolve({turn:{id:'turn',status:'inProgress'}});await request;
    assert.deepEqual(f.calls.filter(call=>call.method==='turn/interrupt'),[{method:'turn/interrupt',params:{threadId:'voice-thread',turnId:'turn'}}]);
    assert.equal(f.voice.active,null);
  }
});
test('backend completion before its start response does not leave a pending turn to interrupt',async()=>{
  let resolve;const pending=new Promise(done=>resolve=done);
  const f=host({request:(method,_params,result)=>method==='turn/start'?pending:result}),ready=await f.voice.prepare({preview:true});
  await f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic',preview:true});f.notify('thread/realtime/sdp',{sdp:offer});
  const request=f.voice.sample(ready.sessionId);f.notify('turn/completed',{turn:{id:'turn',status:'completed'}});
  resolve({turn:{id:'turn',status:'inProgress'}});await request;await f.voice.stop();
  assert.equal(f.calls.some(call=>call.method==='turn/interrupt'),false);
});
test('Stop between turn notification and its RPC response interrupts the sample once',async()=>{
  let resolve;const pending=new Promise(done=>resolve=done);
  const f=host({request:(method,_params,result)=>method==='turn/start'?pending:result}),ready=await f.voice.prepare({preview:true});
  await f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic',preview:true});f.notify('thread/realtime/sdp',{sdp:offer});
  const request=f.voice.sample(ready.sessionId);f.notify('turn/started',{turn:{id:'turn',status:'inProgress'}});await f.voice.stop();
  resolve({turn:{id:'turn',status:'inProgress'}});await request;
  assert.equal(f.calls.filter(call=>call.method==='turn/interrupt').length,1);
});
test('remote realtime closure releases a still-running sample turn',async()=>{
  const f=host(),ready=await f.voice.prepare({preview:true});
  await f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic',preview:true});f.notify('thread/realtime/sdp',{sdp:offer});await f.voice.sample(ready.sessionId);
  f.notify('thread/realtime/closed',{reason:'remote closed'});await turn();
  assert.equal(f.voice.active,null);assert.equal(f.calls.filter(call=>call.method==='turn/interrupt').length,1);
});
test('voice history preserves only completed user/assistant text once per session item, without audio or signaling',()=>{
  const chat={messages:[]};const event={sessionId:'s',event:{type:'transcript',id:'item',role:'user',text:'My spoken question.',done:false,audio:'never-store'}};
  assert.equal(appendVoiceTranscript(chat,event),false);event.event.done=true;assert.equal(appendVoiceTranscript(chat,event,'2026-10-07T00:00:00Z'),true);assert.equal(appendVoiceTranscript(chat,event),false);
  assert.equal(appendVoiceTranscript(chat,{...event,sessionId:'next'}),true);assert.equal(chat.messages.length,2);assert.equal(chat.messages[0].content,'My spoken question.');assert.equal(chat.messages[0].audio,undefined);assert.equal(chat.messages[0].completedAt,'2026-10-07T00:00:00Z');
  assert.equal(appendVoiceTranscript(chat,{...event,event:{...event.event,role:'system',id:'bad'}}),false);
});
function host(overrides={}) {
  const calls=[],events=[];let listener;let now=0;
  const results={'account/read':{account:{type:'chatgpt'}},'thread/realtime/listVoices':{voices:{v1:['juniper','cove'],defaultV1:'juniper',v2:['marin','cedar'],defaultV2:'marin'}},'thread/start':{thread:{id:'voice-thread'}},'thread/realtime/start':{},'thread/realtime/appendText':{},'turn/start':{turn:{id:'turn'}},'thread/realtime/stop':{}};
  const rpc={request:async(method,params)=>{calls.push({method,params});return overrides.request?overrides.request(method,params,results[method]):results[method];}};
  const timers=[];
  const voice=new SubscriptionRealtimeVoice({getRpc:async()=>rpc,subscribe:fn=>{listener=fn;return()=>{};},emit:event=>events.push(event),now:overrides.now||(()=>now),schedule:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},unschedule:timer=>{if(timer)timer.cancelled=true;}});
  return {voice,calls,events,timers,notify:(method,params)=>listener(method,{threadId:'voice-thread',...params}),expire:()=>{now=61000;}};
}
test('realtime uses subscription auth and the official audio-only WebRTC transport without tools or API credentials',async()=>{
  const f=host(),prepared=await f.voice.prepare();assert.equal(f.voice.mediaAllowed(),true);
  await f.voice.start({sessionId:prepared.sessionId,sdp:offer,conversationId:'chat',workspace:'C:/synthetic',context:'Earlier user discussion',voice:'cove'});
  const thread=f.calls.find(call=>call.method==='thread/start').params;assert.equal(thread.ephemeral,true);assert.equal(thread.sandbox,'read-only');assert.deepEqual(thread.dynamicTools,[]);assert.equal(thread.config.features.shell_tool,false);assert.equal(thread.config.model_reasoning_effort,'low');assert.equal(thread.model,undefined);
  assert.match(thread.developerInstructions,/Earlier user discussion/,'Automatic native Codex handoffs receive the current chat source too.');
  const start=f.calls.find(call=>call.method==='thread/realtime/start').params;assert.deepEqual(start.transport,{type:'webrtc',sdp:offer});assert.equal(start.outputModality,'audio');assert.equal(start.voice,'cove');assert.match(start.prompt,/Earlier user discussion/);assert.equal(start.model,undefined);assert.equal(start.clientManagedHandoffs,false);assert.equal(start.codexResponseHandoffMode,'commentary');
  assert.equal(f.calls.some(call=>call.method==='model/list'||call.method==='turn/start'||call.method.startsWith('thread/realtime/append')),false);
  f.notify('thread/realtime/sdp',{sdp:'v=0\r\nanswer'});assert.equal(f.events.at(-1).event.type,'sdp');
  await f.voice.stop();assert.equal(f.voice.mediaAllowed(),false);assert.equal(f.calls.at(-1).method,'thread/realtime/stop');
});
test('signed-out and API accounts cannot arm microphone access or start a realtime turn',async()=>{
  for(const account of [null,{type:'apiKey'}]){const f=host({request:(method,_params,result)=>method==='account/read'?{account}:result});await assert.rejects(f.voice.prepare(),/subscription/);assert.equal(f.voice.mediaAllowed(),false);assert.ok(!f.calls.some(call=>call.method==='thread/start'));}
  const f=host({request:(method,_params,result)=>method==='thread/start'?{thread:{id:'voice-thread'},sandbox:{type:'dangerFullAccess'}}:result}),prepared=await f.voice.prepare();await assert.rejects(f.voice.start({sessionId:prepared.sessionId,sdp:offer,workspace:'C:/synthetic',conversationId:'chat'}),/permissions/);assert.equal(f.voice.mediaAllowed(),false);assert.ok(!f.calls.some(call=>call.method==='thread/realtime/start'));
});
test('expired and stale starts, camera SDP and unsupported voices are rejected',async()=>{
  const f=host(),prepared=await f.voice.prepare(),params={sessionId:prepared.sessionId,sdp:offer,conversationId:'chat',workspace:'C:/synthetic'};
  await assert.rejects(f.voice.start({...params,sdp:offer+'m=video 9 UDP/TLS/RTP/SAVPF 96\r\n'}),/audio-only/);
  await assert.rejects(f.voice.start({...params,voice:'unavailable'}),/available/);
  f.expire();assert.equal(f.voice.mediaAllowed(),false);await assert.rejects(f.voice.start(params),/Start voice again/);await f.voice.stop();
});
test('canonical transcripts are streamed once per item and notifications from other threads are ignored',async()=>{
  const f=host(),prepared=await f.voice.prepare();await f.voice.start({sessionId:prepared.sessionId,sdp:offer,conversationId:'chat',workspace:'C:/synthetic'});
  f.notify('thread/realtime/item/started',{item:{id:'a',type:'transcriptSegment',role:'assistant',text:''}});f.notify('thread/realtime/item/transcript/delta',{itemId:'a',delta:'Hello'});
  const complete={id:'a',type:'transcriptSegment',role:'assistant',text:'Hello there'};
  f.notify('thread/realtime/item/completed',{item:complete});f.notify('thread/realtime/item/completed',{item:complete});
  f.notify('thread/realtime/item/completed',{threadId:'another-chat',item:{...complete,id:'b'}});
  assert.equal(f.events.filter(event=>event.event.type==='transcript'&&event.event.done).length,1);assert.equal(f.events.at(-1).event.text,'Hello there');
  f.notify('thread/realtime/error',{message:'Native usage exhausted.'});await turn();assert.equal(f.voice.active,null);assert.equal(f.events.some(event=>event.event.message==='Native usage exhausted.'),true);
});
test('Stop during subscription preparation prevents microphone authorization and late thread creation is stopped',async()=>{
  let release;const wait=new Promise(resolve=>release=resolve);
  const f=host({request:async(method,_params,result)=>{if(method==='account/read')await wait;return result;}});
  const preparing=f.voice.prepare();await turn();await f.voice.stop();release();await assert.rejects(preparing,/cancelled/);assert.equal(f.voice.mediaAllowed(),false);
  let threadRelease;const threadWait=new Promise(resolve=>threadRelease=resolve);
  const g=host({request:async(method,_params,result)=>{if(method==='thread/start')await threadWait;return result;}});
  const ready=await g.voice.prepare();const starting=g.voice.start({sessionId:ready.sessionId,sdp:offer,conversationId:'chat',workspace:'C:/synthetic'});await turn();await g.voice.stop();threadRelease();await assert.rejects(starting,/cancelled/);assert.equal(g.calls.at(-1).method,'thread/realtime/stop');assert.ok(!g.calls.some(call=>call.method==='thread/realtime/start'));
});
test('only an armed visible main app frame may capture audio; camera, subframes and other windows are denied',()=>{
  const main={};const args={webContents:main,mainContents:main,permission:'media',details:{isMainFrame:true,mediaType:'audio'},visible:true,armed:true};
  assert.equal(audioPermission(args),true);assert.equal(audioPermission({...args,request:true,details:{isMainFrame:true,mediaTypes:['audio']}}),true);
  for(const patch of [{armed:false},{visible:false},{webContents:{}},{permission:'display-capture'},{details:{isMainFrame:false,mediaType:'audio'}},{details:{isMainFrame:true,mediaType:'video'}},{details:{isMainFrame:true,mediaType:'unknown'}}])assert.equal(audioPermission({...args,...patch}),false);
  assert.equal(audioPermission({...args,request:true,details:{isMainFrame:true,mediaTypes:['audio','video']}}),false);
});

function client(overrides={}) {
  const calls=[],events=[],sent=[];const track={enabled:true,stopped:false,stop(){this.stopped=true;}};
  const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  const previewTrack={enabled:true,stopped:false,stop(){this.stopped=true;}},previewStream={getTracks:()=>[previewTrack],getAudioTracks:()=>[previewTrack]};
  const channel={readyState:'open',send:value=>{const event=JSON.parse(value);sent.push(event);if(overrides.rejectResponse&&'response'in event)throw Error("Unknown parameter: 'response'.");},close(){this.closed=true;}};
  const peer={localDescription:null,connectionState:'new',tracks:[],addTrack(track){this.tracks.push(track);},addTransceiver(kind,options){this.transceiver={kind,...options};},createDataChannel:()=>channel,createOffer:async()=>({type:'offer',sdp:offer}),setLocalDescription:async function(description){this.localDescription=description;},setRemoteDescription:async function(description){this.remoteDescription=description;},close(){this.closed=true;}};
  const audio={play:async()=>{},pause(){this.paused=true;},remove(){}};let config={conversationId:'chat',provider:'codex',page:'chat',settings:{realtimeVoice:'cove',...overrides.settings}};
  const session=new RealtimeVoiceSession({invoke:async(method,payload)=>{calls.push({method,payload});return overrides.invoke?overrides.invoke(method,payload):method.endsWith('.prepare')?{sessionId:'session',voices:['juniper','cove'],defaultVoice:'juniper'}:method.endsWith('.start')?{sessionId:'session',conversationId:'chat'}:{};},current:()=>config,update:state=>events.push(state),getMedia:overrides.getMedia||(async()=>stream),createPreviewInput:overrides.createPreviewInput||(async()=>({stream:previewStream,close(){previewTrack.stop();}})),createPeer:()=>peer,createAudio:()=>audio,onConversation:id=>{config={...config,conversationId:id};}});
  return {session,calls,events,track,stream,previewTrack,previewStream,peer,audio,channel,sent};
}
test('realtime client keeps microphone live during speech, can mute and interrupt, and Stop releases every audio resource',async()=>{
  const f=client();await f.session.start();await f.session.receive({type:'voice.realtime.event',sessionId:'session',event:{type:'sdp',sdp:'v=0 answer'}});
  f.peer.ontrack({streams:[f.stream]});await turn();assert.equal(f.audio.srcObject,f.stream);
  f.channel.onmessage({data:JSON.stringify({type:'output_audio_buffer.started'})});assert.equal(f.session.phase,'speaking');assert.equal(f.track.enabled,true);assert.equal(f.track.stopped,false);
  f.session.toggleMute();assert.equal(f.track.enabled,false);f.session.toggleMute();assert.equal(f.track.enabled,true);
  f.session.interrupt();assert.deepEqual(f.sent,[{type:'response.cancel'},{type:'output_audio_buffer.clear'}]);assert.equal(f.session.phase,'listening');
  f.channel.onmessage({data:JSON.stringify({type:'output_audio_buffer.started'})});
  f.channel.onmessage({data:JSON.stringify({type:'input_audio_buffer.speech_started'})});assert.equal(f.track.stopped,false);
  assert.deepEqual(f.sent.at(-1),{type:'output_audio_buffer.clear'});
  await f.session.stop();assert.equal(f.track.stopped,true);assert.equal(f.peer.closed,true);assert.equal(f.channel.closed,true);assert.equal(f.audio.srcObject,null);assert.equal(f.audio.paused,true);
  assert.equal(f.calls.at(-1).method,'voice.realtime.stop');
});
test('Stop during microphone permission prevents late capture, while navigation and remote errors close the connection',async()=>{
  let release;const wait=new Promise(resolve=>release=resolve);let lateTrack;
  const f=client({getMedia:async()=>{await wait;return {getTracks:()=>[lateTrack]};}});lateTrack=f.track;
  const started=f.session.start();await turn();await f.session.stop();release();await started;assert.equal(f.track.stopped,true);assert.ok(!f.calls.some(call=>call.method==='voice.realtime.start'));
  const g=client();await g.session.start();g.session.scopeChanged('different','chat','codex');await turn();assert.equal(g.track.stopped,true);
  const h=client();await h.session.start();h.channel.onmessage({data:JSON.stringify({type:'error',error:{message:'Voice limit reached.'}})});await turn();assert.equal(h.track.stopped,true);assert.equal(h.events.at(-1).error,'Voice limit reached.');
});
test('preview sends only generated silence without opening the microphone and requests one sample',async()=>{
  let capture=0;const f=client({getMedia:async()=>{capture++;throw Error('Preview must never request a microphone.');}});
  await f.session.start({previewVoice:'cove'});assert.equal(capture,0);assert.deepEqual(f.peer.tracks,[f.previewTrack]);assert.equal(f.previewTrack.enabled,true);
  assert.equal(f.calls[0].method,'voice.realtime.preview.prepare');const start=f.calls.find(call=>call.method==='voice.realtime.preview.start');assert.equal(start.payload.voice,'cove');assert.equal(start.payload.conversationId,undefined);
  f.channel.onopen();await turn();assert.deepEqual(f.sent,[]);assert.equal(f.calls.filter(call=>call.method==='voice.realtime.preview.sample').length,1);
  f.peer.ontrack({streams:[f.stream]});f.session.dataEvent({type:'output_audio_buffer.started'});f.session.dataEvent({type:'response.done',response:{status:'completed'}});assert.equal(f.peer.closed,undefined);
  f.session.dataEvent({type:'output_audio_buffer.stopped'});await turn();assert.equal(f.peer.closed,true);assert.equal(f.channel.closed,true);assert.equal(f.audio.srcObject,null);assert.equal(f.track.stopped,false);assert.equal(f.previewTrack.stopped,true);
});
test('AVAS preview accepts a native sample request without an unsupported response parameter',async()=>{
  const f=client({rejectResponse:true});await f.session.start({previewVoice:'cove'});await turn();
  assert.notEqual(f.session.phase,'error',f.events.at(-1)?.error);
  assert.deepEqual(f.sent,[]);assert.deepEqual(f.calls.find(call=>call.method==='voice.realtime.preview.sample')?.payload,{sessionId:'session'});
  await f.session.stop();
});
test('preview waits for both startup and its data channel before requesting the sample',async()=>{
  let release;const ready=new Promise(resolve=>release=resolve);
  const f=client({invoke:async(method)=>{if(method.endsWith('.prepare'))return {sessionId:'session',voices:['juniper','cove'],defaultVoice:'juniper'};if(method.endsWith('.start')){await ready;return {sessionId:'session'};}return {};}});
  f.channel.readyState='connecting';const started=f.session.start({previewVoice:'cove'});await turn();
  f.channel.readyState='open';f.channel.onopen?.();assert.ok(!f.calls.some(call=>call.method==='voice.realtime.preview.sample'));
  release();await started;assert.equal(f.calls.filter(call=>call.method==='voice.realtime.preview.sample').length,1);
  f.channel.onopen();assert.equal(f.calls.filter(call=>call.method==='voice.realtime.preview.sample').length,1);await f.session.stop();
  const g=client();g.channel.readyState='connecting';await g.session.start({previewVoice:'cove'});assert.ok(!g.calls.some(call=>call.method==='voice.realtime.preview.sample'));
  g.channel.readyState='open';g.channel.onopen();assert.equal(g.calls.filter(call=>call.method==='voice.realtime.preview.sample').length,1);await g.session.stop();
});
test('sample failures close client audio resources while late failures preserve a stopped preview',async()=>{
  for(const late of [false,true]) {
    let reject;const pending=new Promise((_resolve,rejection)=>reject=rejection);
    const f=client({invoke:async(method)=>method.endsWith('.prepare')?{sessionId:'session',voices:['juniper','cove'],defaultVoice:'juniper'}:method==='voice.realtime.preview.sample'?pending:{sessionId:'session'}});
    await f.session.start({previewVoice:'cove'});f.peer.ontrack({streams:[f.stream]});
    if(late)await f.session.stop();reject(Error('Sample request failed.'));await turn();
    assert.equal(f.peer.closed,true);assert.equal(f.channel.closed,true);assert.equal(f.audio.srcObject,null);assert.equal(f.audio.paused,true);assert.equal(f.session.phase,late?'idle':'error');
    assert.equal(f.events.at(-1).error,late?'':'Sample request failed.');assert.equal(f.track.stopped,false);
  }
});
test('preview cancellation during preparation closes a late session and leaves the chat untouched',async()=>{
  let release;const wait=new Promise(resolve=>release=resolve);const f=client({invoke:async(method)=>{if(method==='voice.realtime.preview.prepare'){await wait;return {sessionId:'late-preview'};}return {};}});
  const playing=f.session.start({previewVoice:'marin'});await turn();await f.session.stop();release();await playing;
  assert.equal(f.calls.some(call=>call.method==='voice.realtime.preview.start'),false);assert.deepEqual(f.calls.at(-1),{method:'voice.realtime.stop',payload:{sessionId:'late-preview'}});assert.equal(f.peer.localDescription,null);
});

test('obsolete saved v2 voices use the service default for preview and conversation',async()=>{
  for(const preview of [true,false]) {
    const f=client({settings:{realtimeVoice:'marin'}});
    await f.session.start(preview?{previewVoice:'cedar'}:{});
    const start=f.calls.find(call=>call.method.endsWith('.start'));
    assert.equal(start.payload.voice,'juniper');assert.equal(f.session.phase,'starting');
    if(preview)assert.equal(f.stream.getAudioTracks()[0].stopped,false);
    await f.session.stop();
  }
});

test('Windows speech cleanup preserves Realtime startup while a global reset still stops it',async()=>{
  let f;const windows=new WindowsVoice({emit:event=>{void f.session.receive(event);}});
  f=client({invoke:async method=>{
    if(method==='voice.realtime.prepare'){windows.stop(undefined,{reset:false});return {sessionId:'session',voices:['juniper','cove'],defaultVoice:'juniper'};}
    return method==='voice.realtime.start'?{sessionId:'session',conversationId:'chat'}:{};
  }});
  await f.session.start();assert.ok(f.calls.some(call=>call.method==='voice.realtime.start'));assert.equal(f.track.stopped,false);
  windows.stop();await turn();assert.equal(f.peer.closed,true);assert.equal(f.track.stopped,true);
});

test('preview reports which realtime events arrived when no audio follows',async()=>{
  const f=client();await f.session.start({previewVoice:'cove'});await turn();
  f.session.dataEvent({type:'session.created'});f.session.dataEvent({type:'conversation.item.added'});f.session.dataEvent({type:'response.done',response:{status:'completed'}});await turn();await turn();
  assert.equal(f.session.phase,'error');assert.equal(f.events.at(-1).error,'ChatGPT finished the sample without sending audio. Events received: local:silent-input-running, sent:codexHandoff:commentary, native:sample-accepted, session.created, conversation.item.added, response.done.');
  const g=client();g.channel.readyState='connecting';await g.session.start({previewVoice:'cove'});
  assert.equal(g.sent.length,0);await g.session.stop();
});
test('preview never schedules a second sample when the host already handled it',async()=>{
  const f=client({invoke:async method=>method.endsWith('.prepare')?{sessionId:'session',voices:['juniper','cove'],defaultVoice:'juniper'}:method==='voice.realtime.preview.sample'?{requested:false}:{sessionId:'session'}});
  await f.session.start({previewVoice:'cove'});await turn();assert.deepEqual(f.sent,[]);await f.session.stop();
});

test('preview reports received sound, silent packets and missing audio without claiming audibility',async()=>{
  for(const sample of [
    {bytes:0,energy:0,error:'No audio reached Exomina'},
    {bytes:900,energy:0,error:'ChatGPT sent only silence'},
    {bytes:900,energy:7.54e-10,error:'ChatGPT sent only silence'},
    {bytes:900,energy:0.2,error:''},
    {unknown:true,error:'without verified audio'}
  ]){
    const f=client();f.peer.getStats=async()=>sample.unknown?new Map():new Map([['in',{type:'inbound-rtp',kind:'audio',bytesReceived:sample.bytes,totalAudioEnergy:sample.energy}]]);
    await f.session.start({previewVoice:'cove'});f.peer.ontrack({streams:[f.stream]});await turn();
    await f.session.finishPreview();
    const outcome=f.events.at(-1);assert.equal(outcome.error?'error':'idle',sample.error?'error':'idle');
    if(sample.error)assert.ok(outcome.error.includes(sample.error),outcome.error);else assert.equal(outcome.hint,'Voice sample finished.');
    const trace=f.calls.find(call=>call.method==='voice.realtime.preview.trace').payload;
    assert.equal(trace.voice,'cove');assert.ok(trace.events.some(event=>event.startsWith('rtp:in=')));
    assert.equal(f.calls.filter(call=>call.method==='voice.realtime.preview.sample').length,1);
  }
});
test('native flat transcript finals save user and model speech, pair canonical duplicates, and preserve repeated utterances',async()=>{
  const f=host(),prepared=await f.voice.prepare();await f.voice.start({sessionId:prepared.sessionId,sdp:offer,conversationId:'chat',workspace:'C:/synthetic'});
  const finals=()=>f.events.filter(event=>event.event.type==='transcript'&&event.event.done).map(event=>event.event);
  f.notify('thread/realtime/transcript/delta',{role:'user',delta:'My spoken '});
  assert.equal(finals().length,0);
  f.notify('thread/realtime/transcript/done',{role:'user',text:'My spoken question.'});
  f.notify('thread/realtime/item/completed',{item:{id:'question-1',type:'transcriptSegment',role:'user',text:'My spoken question.'}});
  f.notify('thread/realtime/transcript/done',{role:'model',text:'My spoken answer.'});
  f.notify('thread/realtime/item/completed',{item:{id:'answer-1',type:'transcriptSegment',role:'assistant',text:'My spoken answer.'}});
  f.notify('thread/realtime/transcript/done',{role:'system',text:'Never a transcript.'});
  f.notify('thread/realtime/transcript/done',{threadId:'another',role:'user',text:'Never another chat.'});
  assert.deepEqual(finals().map(event=>[event.role,event.text]),[['user','My spoken question.'],['assistant','My spoken answer.']]);
  f.notify('thread/realtime/transcript/delta',{role:'user',delta:'My spoken question.'});
  f.notify('thread/realtime/transcript/done',{role:'user',text:'My spoken question.'});
  f.notify('thread/realtime/item/completed',{item:{id:'question-2',type:'transcriptSegment',role:'user',text:'My spoken question.'}});
  assert.equal(finals().length,3);assert.notEqual(finals()[0].id,finals()[2].id);
  await f.voice.stop();
});
test('native final delivered during Stop is committed, while partial and late text after Stop are discarded',async()=>{
  let f;
  f=host({request:(method,_params,result)=>{
    if(method==='thread/realtime/stop'){
      f.notify('thread/realtime/transcript/delta',{role:'user',delta:'Do not commit a partial.'});
      f.notify('thread/realtime/transcript/done',{role:'user',text:'Completed as the call ended.'});
    }
    return result;
  }});
  const prepared=await f.voice.prepare();await f.voice.start({sessionId:prepared.sessionId,sdp:offer,conversationId:'chat',workspace:'C:/synthetic'});
  await f.voice.stop();
  const transcripts=f.events.filter(event=>event.event.type==='transcript');
  assert.equal(transcripts.length,1);assert.equal(transcripts[0].event.done,true);assert.equal(transcripts[0].event.text,'Completed as the call ended.');
  f.notify('thread/realtime/transcript/done',{role:'user',text:'Too late.'});
  assert.equal(f.events.filter(event=>event.event.type==='transcript').length,1);
  assert.deepEqual(f.voice.transcript(prepared.sessionId,{type:'transcript.done',role:'user',text:'Too late from renderer.'}),{accepted:false});
});
test('transcript collector retains canonical deltas through text-only sanitization and an empty final',()=>{
  const collector=new RealtimeTranscriptCollector();
  collector.consume({method:'thread/realtime/item/started',params:{item:{type:'transcriptSegment',id:'a',role:'user',text:''}}},{source:'native-canonical'});
  const clean=sanitizeRealtimeTranscriptEvent({method:'thread/realtime/item/transcript/delta',params:{itemId:'a',delta:'Final speech.',audio:'NEVER',token:'NEVER'}});
  assert.deepEqual(clean,{type:'transcript',id:'a',delta:'Final speech.',done:false});
  assert.equal(collector.consume(clean,{source:'native-canonical'})[0].text,'Final speech.');
  const final=collector.consume({method:'thread/realtime/item/completed',params:{item:{type:'transcriptSegment',id:'a',role:'user',text:''}}},{source:'native-canonical'});
  assert.deepEqual(final,[{type:'transcript',id:'a',role:'user',text:'Final speech.',done:true}]);
});
test('transcript sanitizer excludes audio and handoff inputs while allowing model and standard spoken finals',()=>{
  assert.equal(sanitizeRealtimeTranscriptEvent({type:'session.updated',session:{audio:'NEVER'}}),null);
  assert.equal(sanitizeRealtimeTranscriptEvent({method:'thread/realtime/itemAdded',params:{item:{type:'handoff_request',handoff_id:'h',input_transcript:'Not necessarily literal speech.'}}}),null);
  assert.equal(sanitizeRealtimeTranscriptEvent({type:'transcript.done',role:'tool',text:'Never a transcript.'}),null);
  assert.deepEqual(sanitizeRealtimeTranscriptEvent({type:'transcript.done',role:'model',text:'Spoken reply.',audio:'NEVER',token:'NEVER'}),{type:'transcript',role:'assistant',text:'Spoken reply.',done:true});
  assert.deepEqual(sanitizeRealtimeTranscriptEvent({type:'response.output_item.done',item:{id:'answer',type:'message',role:'assistant',content:[{type:'output_audio',transcript:'Spoken final.',audio:'NEVER'}]}}),{type:'transcript',id:'answer',role:'assistant',text:'Spoken final.',done:true});
});
test('live reply timing contains only effective effort, whitelisted milestones and elapsed time',async()=>{
  let clock=100;
  const secret='PRIVATE TRANSCRIPT sk-secret-value';
  const f=host({now:()=>clock,request:(method,_params,result)=>{
    if(method==='thread/start'){clock=140;return {...result,reasoningEffort:'low',model:secret};}
    return result;
  }}),ready=await f.voice.prepare();
  await f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic',conversationId:'chat'});
  clock=230;f.notify('thread/realtime/itemAdded',{item:{type:'handoff_request',handoff_id:secret,text:secret,audio:secret}});
  clock=250;f.notify('turn/started',{turn:{id:secret,status:'inProgress',items:[{text:secret}],error:{message:secret}}});
  clock=750;f.notify('turn/completed',{turn:{id:secret,status:'completed',items:[{text:secret}],error:{message:secret},durationMs:secret}});
  const timings=f.events.filter(event=>event.event.type==='timing');
  assert.deepEqual(timings.map(event=>event.event),[
    {type:'timing',name:'thread-ready',elapsedMs:40,reasoningEffort:'low'},
    {type:'timing',name:'handoff-request',elapsedMs:130},
    {type:'timing',name:'turn-started',elapsedMs:150,status:'inProgress'},
    {type:'timing',name:'turn-completed',elapsedMs:650,status:'completed',turnElapsedMs:500}
  ]);
  assert.ok(timings.every(event=>event.sessionId===ready.sessionId&&event.conversationId==='chat'&&event.preview===false));
  assert.equal(JSON.stringify(timings).includes(secret),false);
  const count=timings.length;
  f.notify('thread/realtime/itemAdded',{item:{type:'message',text:secret}});
  f.notify('thread/realtime/item/started',{item:{id:'quiet',type:'bemItemPromoted',text:secret}});
  assert.equal(f.events.filter(event=>event.event.type==='timing').length,count);
  await f.voice.stop();
});
test('live timing clamps invalid clocks and ignores unrecognized effort and status strings',async()=>{
  let clock=100;
  const f=host({now:()=>clock,request:(method,_params,result)=>method==='thread/start'?{...result,reasoningEffort:'low PRIVATE'}:result}),ready=await f.voice.prepare();
  await f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic'});
  assert.deepEqual(f.events.at(-1).event,{type:'timing',name:'thread-ready',elapsedMs:0,reasoningEffort:'unknown'});
  clock=-50;f.notify('turn/started',{turn:{id:'turn',status:'PRIVATE STATUS'}});
  assert.deepEqual(f.events.at(-1).event,{type:'timing',name:'turn-started',elapsedMs:0,status:'unknown'});
  clock=1e9;f.notify('turn/completed',{turn:{id:'turn',status:'failed',error:{message:'PRIVATE ERROR'}}});
  assert.deepEqual(f.events.at(-1).event,{type:'timing',name:'turn-completed',elapsedMs:3600000,status:'failed',turnElapsedMs:3600000});
  clock=Infinity;f.notify('thread/realtime/itemAdded',{item:{type:'handoff_request'}});
  assert.deepEqual(f.events.at(-1).event,{type:'timing',name:'handoff-request',elapsedMs:0});
  assert.equal(JSON.stringify(f.events).includes('PRIVATE'),false);
  await f.voice.stop();
});
test('timing from stopped or previous threads cannot enter a newer live session or preview',async()=>{
  let threadCount=0;
  const f=host({request:(method,_params,result)=>method==='thread/start'?{...result,thread:{id:`voice-${++threadCount}`},reasoningEffort:'low'}:result});
  const first=await f.voice.prepare();await f.voice.start({sessionId:first.sessionId,sdp:offer,workspace:'C:/synthetic'});await f.voice.stop();
  const count=f.events.length;
  f.notify('turn/started',{threadId:'voice-1',turn:{id:'old',status:'inProgress'}});
  f.notify('thread/realtime/itemAdded',{threadId:'voice-1',item:{type:'handoff_request'}});
  assert.equal(f.events.length,count);
  const second=await f.voice.prepare();await f.voice.start({sessionId:second.sessionId,sdp:offer,workspace:'C:/synthetic'});
  const nextCount=f.events.length;
  f.notify('turn/completed',{threadId:'voice-1',turn:{id:'old',status:'completed'}});
  f.notify('thread/realtime/itemAdded',{threadId:'voice-1',item:{type:'handoff_request'}});
  assert.equal(f.events.length,nextCount);
  f.notify('turn/completed',{threadId:'voice-2',turn:{id:'unmatched',status:'completed'}});
  assert.deepEqual(f.events.at(-1).event,{type:'timing',name:'turn-completed',elapsedMs:0,status:'completed'});
  await f.voice.stop();
  const preview=await f.voice.prepare({preview:true});await f.voice.start({sessionId:preview.sessionId,sdp:offer,workspace:'C:/synthetic',preview:true});
  f.notify('thread/realtime/itemAdded',{threadId:'voice-3',item:{type:'handoff_request'}});
  f.notify('turn/started',{threadId:'voice-3',turn:{id:'preview',status:'inProgress'}});
  assert.equal(f.events.filter(event=>event.sessionId===preview.sessionId&&event.event.type==='timing').length,0);
  await f.voice.stop();
});
test('a preparation stall ends with a clear timeout and closes any late session',async()=>{
  let resolve;const pending=new Promise(done=>resolve=done),timers=[];
  const f=client({invoke:async method=>method==='voice.realtime.preview.prepare'?pending:{}});f.session.schedule=(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;};f.session.unschedule=timer=>{if(timer)timer.cancelled=true;};
  const request=f.session.start({previewVoice:'cove'});await turn();await timers.find(timer=>timer.ms===45000).fn();
  assert.match(f.events.at(-1).error,/could not finish connecting/);
  resolve({sessionId:'late'});await request;assert.equal(f.calls.some(call=>call.method==='voice.realtime.preview.start'),false);assert.deepEqual(f.calls.at(-1),{method:'voice.realtime.stop',payload:{sessionId:'late'}});
});
test('Stop during silent-input creation releases the late source without opening a peer or microphone',async()=>{
  let resolve,closed=false;const pending=new Promise(done=>resolve=done);
  const f=client({createPreviewInput:()=>pending,getMedia:()=>{throw Error('No microphone allowed.');}});
  const request=f.session.start({previewVoice:'cove'});await turn();await f.session.stop();resolve({stream:f.previewStream,close(){closed=true;}});await request;
  assert.equal(closed,true);assert.equal(f.peer.localDescription,null);assert.equal(f.calls.some(call=>call.method==='voice.realtime.preview.start'),false);
});
test('preview monitors real sound to show playing and finish despite missing legacy audio events',async()=>{
  const f=client(),timers=[];let clock=1000,energy=0;
  f.session.schedule=(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;};f.session.unschedule=timer=>{if(timer)timer.cancelled=true;};f.session.now=()=>clock;
  f.peer.getStats=async()=>new Map([['in',{type:'inbound-rtp',kind:'audio',bytesReceived:900,totalAudioEnergy:energy}],['out',{type:'outbound-rtp',kind:'audio',bytesSent:600,packetsSent:20}]]);
  await f.session.start({previewVoice:'cove'});f.peer.ontrack({streams:[f.stream]});await turn();
  assert.equal(f.events.at(-1).hint,'Preparing voice sample. Microphone off.');
  await f.session.monitorPreview(f.session.generation);assert.equal(f.session.phase,'starting');
  energy=0.2;await f.session.monitorPreview(f.session.generation);assert.equal(f.session.phase,'playing');
  clock+=2500;await f.session.monitorPreview(f.session.generation);assert.equal(f.events.at(-1).hint,'Voice sample finished.');
  const trace=f.calls.find(call=>call.method==='voice.realtime.preview.trace').payload;assert.ok(trace.events.some(event=>event.includes('out=600,packets=20')));assert.equal(f.previewTrack.stopped,true);
});
test('Stop during realtime setup closes a connection that finishes starting late',async()=>{
  let release;const pending=new Promise(done=>release=done);
  const f=host({request:(method,_params,result)=>method==='thread/realtime/start'?pending:result}),ready=await f.voice.prepare({preview:true});
  const starting=f.voice.start({sessionId:ready.sessionId,sdp:offer,workspace:'C:/synthetic',preview:true});await turn();
  await f.voice.stop();const stopCount=f.calls.filter(call=>call.method==='thread/realtime/stop').length;
  release({});await assert.rejects(starting,/cancelled/);
  assert.equal(f.calls.filter(call=>call.method==='thread/realtime/stop').length,stopCount+1);assert.equal(f.voice.active,null);
});
test('preview timeout checks actual sound even without output buffer events',async()=>{
  for(const energy of [0,0.2]){
    const timers=[],f=client();f.session.schedule=(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;};f.session.unschedule=timer=>{if(timer)timer.cancelled=true;};
    f.peer.getStats=async()=>new Map([['in',{type:'inbound-rtp',kind:'audio',bytesReceived:energy?900:0,totalAudioEnergy:energy}]]);
    await f.session.start({previewVoice:'cove'});f.peer.ontrack({streams:[f.stream]});await turn();
    assert.equal(timers.some(timer=>timer.ms===5000),false);
    await timers.find(timer=>timer.ms===30000).fn();
    if(energy)assert.equal(f.events.at(-1).hint,'Voice sample finished.');else assert.match(f.events.at(-1).error,/timed out without audio/);
    assert.ok(timers.every(timer=>timer.cancelled));
  }
});
test('preview cannot claim playback when the audio element rejects it or never starts',async()=>{
  for(const blocked of [false,true]){
    const f=client();f.peer.getStats=async()=>new Map([['in',{type:'inbound-rtp',kind:'audio',bytesReceived:900,totalAudioEnergy:0.2}]]);
    await f.session.start({previewVoice:'cove'});
    if(blocked){f.audio.play=async()=>{throw Error('blocked');};f.peer.ontrack({streams:[f.stream]});await turn();assert.match(f.events.at(-1).error,/playback was blocked/);}
    else {await f.session.finishPreview();assert.match(f.events.at(-1).error,/local playback did not start/);}
    assert.equal(f.peer.closed,true);assert.equal(f.channel.closed,true);
  }
});
