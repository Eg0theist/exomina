/** Audio stays on the WebRTC connection; IPC carries only control and transcripts. */
import {boundedVoiceMs,voiceTimingEvent} from '../desktop/voice-session-timing.mjs';
import {sanitizeRealtimeTranscriptEvent} from '../desktop/realtime-transcript.mjs';
// Silent Opus packets can carry a tiny amount of codec noise.
const PREVIEW_AUDIO_ENERGY_MIN=1e-6;
/** Live sessions need an active input timeline, including silence. No capture device is opened. */
export async function createSilentPreviewInput({createContext=()=>new AudioContext(),signal}={}) {
  signal?.throwIfAborted();
  const context=createContext();let source,destination,closed=false,rejectAbort;
  const close=()=>{if(closed)return;closed=true;signal?.removeEventListener('abort',abort);try{source?.stop();source?.disconnect();}catch{}destination?.stream.getTracks().forEach(track=>track.stop());void context.close().catch(()=>{});};
  const abort=()=>{close();rejectAbort?.(Error('Voice preview stopped.'));};
  signal?.addEventListener('abort',abort,{once:true});
  try {
    source=context.createConstantSource();source.offset.value=0;
    destination=context.createMediaStreamDestination();source.connect(destination);source.start();
    const aborted=new Promise((_resolve,reject)=>{rejectAbort=reject;});
    await Promise.race([context.resume(),aborted]);
    if(context.state!=='running')throw Error('The silent preview stream could not start. Try the preview again.');
    return {stream:destination.stream,close};
  }catch(error){close();throw error;}
}
const audioStats=stats=>{const value={energy:0,bytes:0,known:false,sentBytes:0,sentPackets:0};stats?.forEach(report=>{
  if(report.kind!=='audio')return;
  if(report.type==='inbound-rtp'){value.known=true;value.energy+=report.totalAudioEnergy||0;value.bytes+=report.bytesReceived||0;}
  else if(report.type==='outbound-rtp'){value.sentBytes+=report.bytesSent||0;value.sentPackets+=report.packetsSent||0;}
});return value;};
const audioTrace=value=>`rtp:in=${value.bytes},energy=${value.energy.toPrecision(5)},out=${value.sentBytes},packets=${value.sentPackets}`;
async function boundedStats(stats) {
  if(!stats)return null;let timer;
  try{return await Promise.race([Promise.resolve(stats).catch(()=>null),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),750);})]);}
  finally{clearTimeout(timer);}
}
export class RealtimeVoiceSession {
  constructor({invoke,current,update,onConversation,createPeer=()=>new RTCPeerConnection(),getMedia=constraints=>navigator.mediaDevices.getUserMedia(constraints),createAudio=()=>new Audio(),createPreviewInput=createSilentPreviewInput,now=()=>Date.now(),schedule=(fn,ms)=>setTimeout(fn,ms),unschedule=id=>clearTimeout(id)}) {
    Object.assign(this,{invoke,current,update,onConversation,createPeer,getMedia,createAudio,createPreviewInput,now,schedule,unschedule});
    this.generation=0;this.mode='';this.scope='';this.sessionId='';this.peer=null;this.stream=null;this.audio=null;this.channel=null;this.muted=false;
  }
  state(phase,extra={}) {this.phase=phase;if('hint'in extra)this.hint=extra.hint;this.update({mode:this.mode,voiceId:this.previewVoice||'',phase,transcript:this.caption||'',muted:this.muted,hint:this.hint,...extra,...(this.muted&&this.mode==='realtime'?{hint:'Microphone muted.'}:{})});}
  cleanup() {for(const key of ['timer','startupTimer','finishTimer','monitorTimer']){this.unschedule(this[key]);this[key]=null;}this.previewInputAbort?.abort();this.previewInputAbort=null;this.previewInput?.close();this.previewInput=null;this.stream?.getTracks().forEach(track=>track.stop());this.stream=null;if(this.audio){this.audio.pause();this.audio.srcObject=null;this.audio.remove?.();}this.audio=null;this.channel?.close();this.channel=null;const peer=this.peer;this.peer=null;peer?.close();}
  async stop({error='',hint='Voice stopped.'}={}) {
    this.generation++;const sessionId=this.sessionId,preview=this.mode==='preview',live=this.mode==='realtime',voice=this.previewVoice||'',events=[...(this.previewTrace||[])],timings=[...(this.liveTrace||[])];
    let stats;try{stats=preview?this.peer?.getStats?.():null;}catch{}
    this.sessionId='';this.mode='';this.caption='';this.pendingResponseAt=null;this.cleanup();this.state(error?'error':'idle',{error,hint:error?'':hint});
    if(live)void this.invoke('voice.realtime.trace',{result:error?'error':'stopped',events:timings}).catch(()=>{});
    if(sessionId){
      const stopping=this.invoke('voice.realtime.stop',{sessionId}).catch(()=>{});
      if(preview){
        const bounded=await boundedStats(stats);
        if(bounded)events.push(audioTrace(audioStats(bounded)));
        await this.invoke('voice.realtime.preview.trace',{voice,result:error||hint,events}).catch(()=>{});
      }
      await stopping;
    }
  }
  async start({previewVoice}={}) {
    const stopped=this.stop(),generation=this.generation;await stopped;if(generation!==this.generation)return;
    const preview=typeof previewVoice==='string';
    this.mode=preview?'preview':'realtime';this.previewVoice=previewVoice;this.scope=this.current().conversationId||'';this.scopePage=this.current().page;this.caption='';this.canonicalCaption=false;this.muted=false;this.hasPreviewAudio=false;this.playbackStarted=false;this.lastAudioAt=0;this.lastMeasuredEnergy=0;this.previewEvents=[];this.previewTrace=[];this.state('starting',{error:'',hint:preview?'Connecting voice preview…':'Connecting ChatGPT realtime voice…'});
    this.liveStartedAt=this.now();this.liveTrace=[];this.pendingResponseAt=null;this.liveTiming('session-start');
    const current=()=>generation===this.generation;
    if(preview)this.startupTimer=this.schedule(()=>{if(current())this.stop({error:'The voice preview could not finish connecting. Try again.'});},45000);
    let prepared;
    try {
      prepared=await this.invoke(preview?'voice.realtime.preview.prepare':'voice.realtime.prepare',preview?{}:{conversationId:this.scope||undefined});
      if(!current()){await this.invoke('voice.realtime.stop',{sessionId:prepared.sessionId});return;}
      this.sessionId=prepared.sessionId;
      this.liveTiming('prepare-complete');
      if(preview)this.state('starting',{hint:'Connecting voice service. Microphone off.'});
      const requestedVoice=preview?previewVoice:this.current().settings?.realtimeVoice||'';
      const voice=prepared.voices.includes(requestedVoice)?requestedVoice:prepared.defaultVoice;
      if(preview)this.previewInputAbort=new AbortController();
      const previewInput=preview?await this.createPreviewInput({signal:this.previewInputAbort.signal}):null;
      if(!current()){previewInput?.close();return;}
      this.previewInput=previewInput;
      const stream=preview?previewInput.stream:await this.getMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(!current()){stream?.getTracks().forEach(track=>track.stop());return;}
      this.stream=stream;this.liveTiming('microphone-ready');const peer=this.createPeer();this.peer=peer;
      const audio=this.createAudio();this.audio=audio;audio.autoplay=true;
      peer.ontrack=event=>{if(!current())return;audio.srcObject=event.streams?.[0]||new MediaStream([event.track]);audio.play().then(()=>{if(current()){this.playbackStarted=true;this.trace('local:playback-started');this.liveTiming('playback-started');}}).catch(()=>{if(current())this.stop({error:'Voice playback was blocked. Start voice again to allow audio.'});});};
      peer.onconnectionstatechange=()=>{if(!current())return;if(peer.connectionState==='connected'){if(!preview){this.unschedule(this.timer);this.timer=null;this.liveTiming('rtc-connected');}this.state(preview?'starting':'listening',{hint:preview?'Preparing voice sample. Microphone off.':'Realtime voice · microphone on. You can interrupt.'});}else if(['failed','disconnected','closed'].includes(peer.connectionState))this.stop({error:'The voice connection ended. Start voice again when you are ready.'});};
      stream.getAudioTracks().forEach(track=>{peer.addTrack(track,stream);track.onended=()=>{if(current())this.stop({error:preview?'The voice preview audio stream ended. Try again.':'The microphone was disconnected.'});};});
      if(preview)this.trace('local:silent-input-running');
      peer.oniceconnectionstatechange=()=>{if(current())this.trace('ice:'+peer.iceConnectionState);};
      const channel=peer.createDataChannel('oai-events');this.channel=channel;
      channel.onmessage=message=>{if(!current())return;try{this.dataEvent(JSON.parse(message.data));}catch{/* Ignore unknown or malformed protocol events. */}};
      const offer=await peer.createOffer();if(!current())return;await peer.setLocalDescription(offer);if(!current())return;
      this.timer=this.schedule(()=>{if(!current())return;if(preview)return this.finishPreview({timeout:true});return this.stop({error:'ChatGPT voice did not connect. Check your connection and try again.'});},preview?30000:40000);
      const result=await this.invoke(preview?'voice.realtime.preview.start':'voice.realtime.start',{sessionId:this.sessionId,sdp:peer.localDescription.sdp,voice,...(preview?{}:{conversationId:this.scope||undefined,projectId:this.current().projectId||undefined})});
      if(!current())return;
      if(preview){
        let requested=false;
        const sample=()=>{
          if(!current()||requested||channel.readyState!=='open')return;
          requested=true;
          this.unschedule(this.startupTimer);this.startupTimer=null;
          this.state('starting',{hint:'Preparing voice sample. Microphone off.'});
          this.monitorTimer=this.schedule(()=>this.monitorPreview(generation),500);
          const failed=error=>{if(current())this.stop({error:String(error?.message||error).replace(/^Error invoking remote method '[^']+': Error: /,'')});};
          // The native runtime forwards the sample reply as spoken commentary.
          this.trace('sent:codexHandoff:commentary');
          this.invoke('voice.realtime.preview.sample',{sessionId:this.sessionId}).then(sent=>{
            if(!current()||sent?.requested===false)return;
            this.trace('native:sample-accepted');
          }).catch(failed);
        };
        channel.onopen=sample;if(channel.readyState==='open')sample();
      }else{this.scope=result.conversationId;this.onConversation?.(result.conversationId);}
    } catch(error) {if(current())await this.stop({error:String(error?.message||error).replace(/^Error invoking remote method '[^']+': Error: /,'')});}
  }
  async receive(value) {
    if(value.type==='voice.reset'&&this.mode){await this.stop();return;}
    if(value.type!=='voice.realtime.event'||value.sessionId!==this.sessionId||!this.mode)return;
    const event=value.event;
    if(event.type==='timing'){this.liveTiming(event.name,event);return;}
    if(event.type==='trace'){this.trace('native:'+event.name);return;}
    if(event.type==='sdp') {
      const generation=this.generation;
      try{await this.peer.setRemoteDescription({type:'answer',sdp:event.sdp});if(generation===this.generation)this.state(this.peer.connectionState==='connected'&&this.mode!=='preview'?'listening':'starting',{hint:this.mode==='preview'?'Preparing voice sample. Microphone off.':'Connecting realtime audio…'});}
      catch(error){if(generation===this.generation)this.stop({error:'ChatGPT returned an invalid voice connection. '+error.message});}
    } else if(event.type==='error')await this.stop({error:event.message});
    else if(event.type==='stopped'||event.type==='closed')await this.stop();
    else if(event.type==='caption'&&!this.canonicalCaption) {if(this.captionRole!==event.role){this.caption='';this.captionRole=event.role;}this.caption=(this.caption+String(event.text||'')).slice(-3000);this.state(this.phase);}
    else if(event.type==='transcript') {this.canonicalCaption=true;this.caption=event.text||'';this.state(this.phase);}
  }
  trace(name) {if(this.mode!=='preview'||!this.previewTrace)return;name=String(name).slice(0,120);if(this.previewTrace.at(-1)!==name&&this.previewTrace.length<80)this.previewTrace.push(name);if(!this.previewEvents.includes(name)&&this.previewEvents.length<15&&!name.startsWith('rtp:'))this.previewEvents.push(name);}
  liveTiming(name,fields={}) {if(this.mode!=='realtime'||!this.liveTrace||this.liveTrace.length>=120)return;const value=voiceTimingEvent({...fields,name,atMs:boundedVoiceMs(this.now()-this.liveStartedAt)});if(value)this.liveTrace.push(value);}
  async inboundAudio() {const generation=this.generation;let stats;try{stats=await boundedStats(this.peer?.getStats?.());}catch{/* Diagnostics are best effort. */}const value=audioStats(stats);if(generation===this.generation)this.trace(audioTrace(value));return value;}
  async inboundEnergy() {return (await this.inboundAudio()).energy;}
  async monitorPreview(generation) {
    if(generation!==this.generation||this.mode!=='preview')return;
    const {energy}=await this.inboundAudio();if(generation!==this.generation)return;
    if(energy>PREVIEW_AUDIO_ENERGY_MIN){
      if(energy-this.lastMeasuredEnergy>1e-8){this.lastAudioAt=this.now();this.lastMeasuredEnergy=energy;}
      if(!this.hasPreviewAudio){this.hasPreviewAudio=true;this.state('playing',{hint:'Playing voice preview. Microphone off.'});}
      if(this.now()-this.lastAudioAt>=2000){await this.finishPreview();return;}
    }
    this.monitorTimer=this.schedule(()=>this.monitorPreview(generation),500);
  }
  previewSummary() {return 'Events received: '+(this.previewEvents?.length?this.previewEvents.join(', '):'none')+'.';}
  /** Report what reached this PC so silence can be told apart from a wrong Windows output device. */
  async finishPreview({timeout=false}={}) {
    const generation=this.generation,{bytes,energy,known}=await this.inboundAudio();
    if(generation!==this.generation)return;
    if(energy>PREVIEW_AUDIO_ENERGY_MIN&&this.playbackStarted)await this.stop({hint:'Voice sample finished.'});
    else if(energy>PREVIEW_AUDIO_ENERGY_MIN)await this.stop({error:'Exomina received sample audio, but local playback did not start.'});
    else if(bytes>0)await this.stop({error:'ChatGPT sent only silence for this sample. Try again or choose another voice.'});
    else await this.stop({error:(timeout?'The voice preview timed out without audio. ':known?'No audio reached Exomina from ChatGPT. ':'The preview ended without verified audio. ')+this.previewSummary()});
  }
  dataEvent(event) {
    if(this.mode==='preview'&&typeof event.type==='string')this.trace(event.type.slice(0,60));
    if(event.type==='error'){if(event.error?.code==='response_cancel_not_active')return;this.stop({error:String(event.error?.message||'ChatGPT realtime voice failed.')});return;}
    if(this.mode==='preview') {
      if(['output_audio_buffer.started','response.audio.delta','response.output_audio.delta','session.output_audio.delta'].includes(event.type)){this.hasPreviewAudio=true;this.state('playing',{hint:'Playing voice preview. Microphone off.'});}
      else if(['output_audio_buffer.stopped','output_audio_buffer.cleared'].includes(event.type)&&this.hasPreviewAudio)this.finishPreview();
      else if(event.type==='response.done'&&['failed','cancelled','incomplete'].includes(event.response?.status))this.stop({error:event.response?.status_details?.error?.message||'The voice sample could not be completed. Try again.'});
      else if(event.type==='response.done'&&!this.hasPreviewAudio) {
        // v3 may stream audio without buffer events, so check the WebRTC track before calling it silent.
        const generation=this.generation;
        this.inboundEnergy().then(energy=>{
          if(generation!==this.generation||this.hasPreviewAudio)return;
          if(energy>PREVIEW_AUDIO_ENERGY_MIN){this.hasPreviewAudio=true;this.unschedule(this.finishTimer);this.finishTimer=this.schedule(()=>{if(generation===this.generation)this.finishPreview();},10000);}
          else this.stop({error:'ChatGPT finished the sample without sending audio. '+this.previewSummary()});
        });
      }
      return;
    }
    const transcript=sanitizeRealtimeTranscriptEvent(event);
    if(transcript&&this.sessionId) {
      const generation=this.generation;
      this.invoke('voice.realtime.transcript',{sessionId:this.sessionId,event:transcript}).catch(error=>{
        if(generation===this.generation)this.stop({error:'The voice transcript could not be saved. '+String(error?.message||error).replace(/^Error invoking remote method '[^']+': Error: /,'')});
      });
    }
    if(event.type==='input_audio_buffer.speech_started') {if(this.phase==='speaking'&&this.channel?.readyState==='open')this.channel.send(JSON.stringify({type:'output_audio_buffer.clear'}));this.pendingResponseAt=null;this.liveTiming('speech-started');this.caption='';this.state('listening',{hint:'Listening · microphone on.'});}
    else if(event.type==='input_audio_buffer.speech_stopped') {if(this.pendingResponseAt===null){this.pendingResponseAt=this.now();this.liveTiming('speech-stopped');}this.state('waiting',{hint:'Preparing a reply. Microphone on; you can interrupt.'});}
    else if(['output_audio_buffer.started','response.audio.delta','response.output_audio.delta','session.output_audio.delta'].includes(event.type)){
      if(this.pendingResponseAt!==null){this.liveTiming('response-output',{responseDelayMs:this.now()-this.pendingResponseAt});this.pendingResponseAt=null;}
      this.state('speaking',{hint:'ChatGPT is speaking. You can interrupt.'});
    }
    else if(['output_audio_buffer.stopped','output_audio_buffer.cleared'].includes(event.type)){
      this.liveTiming('output-stopped');
      // An interrupted reply can acknowledge its clear after the next utterance ends.
      if(this.pendingResponseAt===null)this.state('listening',{hint:'Realtime voice · microphone on. You can interrupt.'});
    }
  }
  toggleMute() {if(!this.mode||!this.stream)return;this.muted=!this.muted;this.liveTiming(this.muted?'microphone-muted':'microphone-unmuted');this.stream.getAudioTracks().forEach(track=>{track.enabled=!this.muted;});this.state(this.phase,{hint:this.muted?'Microphone muted.':'Microphone on. You can interrupt.'});}
  interrupt() {if(!this.channel||this.channel.readyState!=='open')return;this.channel.send(JSON.stringify({type:'response.cancel'}));this.channel.send(JSON.stringify({type:'output_audio_buffer.clear'}));this.pendingResponseAt=null;this.liveTiming('interrupted');this.caption='';this.state('listening',{hint:'Reply interrupted. Microphone on.'});}
  scopeChanged(conversationId,page,provider) {if(this.mode&&(this.mode==='preview'?(page!==this.scopePage||(conversationId||'')!==this.scope):(page!=='chat'||(conversationId||'')!==this.scope||provider!=='codex')))this.stop();}
}
