import {VOICE_PREVIEW_CLIPS,VOICE_CLEAR_PREVIEW_CLIPS} from './voice-preview-clips.js';

/** Immediate local playback, matching Codex's prerecorded voice picker. */
export class VoicePreviewSession {
  constructor({current,update,clips=VOICE_PREVIEW_CLIPS,clearClips=VOICE_CLEAR_PREVIEW_CLIPS,createAudio=()=>new Audio(),schedule=(fn,ms)=>setTimeout(fn,ms),unschedule=id=>clearTimeout(id)}){
    Object.assign(this,{current,update,clips,clearClips,createAudio,schedule,unschedule});this.generation=0;this.mode='';this.audio=null;
  }
  state(phase,{error='',hint=''}={}){this.phase=phase;this.update({mode:this.mode,voiceId:this.voice||'',phase,error,hint});}
  async stop({error='',hint='Voice stopped.'}={}){
    this.generation++;this.mode='';this.unschedule(this.timer);this.timer=null;
    const audio=this.audio;this.audio=null;
    if(audio){audio.onended=null;audio.onerror=null;audio.onplaying=null;audio.pause();audio.removeAttribute?.('src');audio.src='';audio.load?.();audio.remove?.();}
    this.state(error?'error':'idle',{error,hint});
  }
  async start({previewVoice}={}){
    const stopped=this.stop(),generation=this.generation;await stopped;if(generation!==this.generation)return;
    const voice=previewVoice||'cove';
    if(!Object.hasOwn(this.clips,voice)){this.state('error',{error:'No preview recording is available for this voice.'});return;}
    this.voice=voice;this.mode='preview';this.scope=this.current().conversationId||'';this.scopePage=this.current().page;
    const clear=this.current().settings?.previewTone!=='original'&&Object.hasOwn(this.clearClips,voice);
    this.state('starting',{hint:'Starting voice preview. Microphone off.'});
    const current=()=>generation===this.generation;
    try {
      const audio=this.createAudio();this.audio=audio;audio.preload='auto';audio.src=clear?this.clearClips[voice]:this.clips[voice];
      const playing=()=>{if(!current())return;this.unschedule(this.timer);this.state('playing',{hint:'Playing voice preview. Microphone off.'});this.timer=this.schedule(()=>{if(current())this.stop({error:'The voice preview did not finish. Try again.'});},30000);};
      audio.onplaying=playing;
      audio.onended=()=>{if(current())this.stop({hint:'Voice sample finished.'});};
      audio.onerror=()=>{if(current())this.stop({error:'The voice preview recording could not be played. Try again.'});};
      this.timer=this.schedule(()=>{if(current())this.stop({error:'The voice preview could not start. Try again.'});},5000);
      await audio.play();if(current())playing();
    }catch{if(current())await this.stop({error:'Voice preview playback was blocked. Start the preview again.'});}
  }
  receive(event){if(event.type==='voice.reset'&&this.mode)return this.stop();}
  scopeChanged(conversationId,page){if(this.mode&&(page!==this.scopePage||(conversationId||'')!==this.scope))return this.stop();}
}
