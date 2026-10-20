import test from 'node:test';
import assert from 'node:assert/strict';
import {SubscriptionRealtimeVoice} from '../desktop/realtime-voice.mjs';
import {appendVoiceTranscript} from '../desktop/voice-transcript.mjs';
import {RealtimeVoiceSession} from '../src/realtime-voice-session.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
function fixture({rejectTranscript=false}={}) {
  const chat={id:'chat',messages:[]},calls=[],updates=[];
  let client;
  const rpc={request:async(method)=>{
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='thread/realtime/listVoices')return {voices:{v1:['juniper'],defaultV1:'juniper'}};
    if(method==='thread/start')return {thread:{id:'native-voice'}};
    if(method==='thread/realtime/start')host.notification('thread/realtime/sdp',{threadId:'native-voice',sdp});
    return {};
  }};
  const host=new SubscriptionRealtimeVoice({getRpc:async()=>rpc,emit:event=>{
    if(!event.preview)appendVoiceTranscript(chat,event);
    void client?.receive(event);
  }});
  const track={enabled:true,stop(){this.stopped=true;}},stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  const channel={readyState:'open',send(){},close(){this.closed=true;}};
  const peer={connectionState:'new',createDataChannel:()=>channel,addTrack(){},createOffer:async()=>({type:'offer',sdp}),
    async setLocalDescription(offer){this.localDescription=offer;},
    async setRemoteDescription(){this.connectionState='connected';this.onconnectionstatechange?.();},
    close(){this.closed=true;}};
  client=new RealtimeVoiceSession({current:()=>({conversationId:'chat',page:'chat',provider:'codex',settings:{}}),update:value=>updates.push(value),createPeer:()=>peer,getMedia:async()=>stream,
    createPreviewInput:async()=>({stream,close(){}}),createAudio:()=>({pause(){},remove(){}}),
    invoke:async(method,payload={})=>{
      calls.push({method,payload});
      if(method==='voice.realtime.prepare')return host.prepare();
      if(method==='voice.realtime.preview.prepare')return host.prepare({preview:true});
      if(method==='voice.realtime.start'||method==='voice.realtime.preview.start')return host.start({...payload,workspace:'C:/synthetic',preview:method.includes('.preview.')});
      if(method==='voice.realtime.preview.sample')return host.sample(payload.sessionId);
      if(method==='voice.realtime.transcript'){
        if(rejectTranscript)throw Error('Synthetic transcript storage failed.');
        return host.transcript(payload.sessionId,payload.event);
      }
      if(method==='voice.realtime.stop')return host.stop(payload.sessionId);
      return {};
    }});
  return {host,client,chat,calls,updates,track,peer,channel,send:event=>channel.onmessage({data:JSON.stringify(event)})};
}

test('raw WebRTC user and spoken assistant finals reach chat through the host once, excluding audio and protocol secrets',async()=>{
  const f=fixture();await f.client.start();
  try {
    f.send({type:'conversation.item.input_audio_transcription.delta',item_id:'question',delta:'Remember the blue ',audio:'PRIVATE-AUDIO',token:'PRIVATE-TOKEN'});
    await tick();assert.equal(f.chat.messages.length,0);assert.match(f.updates.at(-1).transcript,/blue/);
    const user={type:'conversation.item.input_audio_transcription.completed',item_id:'question',transcript:'Remember the blue lantern.',audio:'PRIVATE-AUDIO',token:'PRIVATE-TOKEN'};
    f.send(user);f.send(user);
    const assistant={type:'response.output_audio_transcript.done',item_id:'answer',response_id:'response',transcript:'I remember the blue lantern.'};
    f.send(assistant);f.send(assistant);await tick();
    assert.deepEqual(f.chat.messages.map(message=>[message.role,message.content]),[['user','Remember the blue lantern.'],['assistant','I remember the blue lantern.']]);
    const forwarded=JSON.stringify(f.calls.filter(call=>call.method==='voice.realtime.transcript'));
    assert.equal(forwarded.includes('PRIVATE-AUDIO'),false);assert.equal(forwarded.includes('PRIVATE-TOKEN'),false);
    f.host.notification('thread/realtime/transcript/done',{threadId:'native-voice',role:'user',text:user.transcript});
    f.host.notification('thread/realtime/transcript/done',{threadId:'native-voice',role:'model',text:assistant.transcript});
    assert.equal(f.chat.messages.length,2,'The parallel native final does not duplicate the same utterance.');
    f.send({...user,item_id:'question-again'});await tick();
    assert.equal(f.chat.messages.length,3,'Saying the same words again is a new utterance.');
  } finally {await f.client.stop();}
});

test('transcript save failures stop capture and report a visible error',async()=>{
  const f=fixture({rejectTranscript:true});await f.client.start();
  f.send({type:'conversation.item.input_audio_transcription.completed',item_id:'question',transcript:'Save this question.'});
  await tick();await tick();
  assert.equal(f.track.stopped,true);assert.equal(f.peer.closed,true);assert.equal(f.host.active,null);
  assert.match(f.updates.findLast(value=>value.error)?.error,/transcript could not be saved.*Synthetic transcript storage failed/);
});

test('previews and late data channel messages cannot append chat transcripts',async()=>{
  const f=fixture();await f.client.start({previewVoice:'juniper'});
  f.send({type:'transcript.done',role:'user',text:'Never save a preview.'});await tick();
  assert.equal(f.calls.some(call=>call.method==='voice.realtime.transcript'),false);assert.equal(f.chat.messages.length,0);
  await f.client.stop();
  f.send({type:'transcript.done',role:'assistant',text:'Never save a closed session.'});await tick();
  assert.equal(f.chat.messages.length,0);
});
