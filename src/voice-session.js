import { normalizeVoice, spokenText } from '../desktop/voice-settings.mjs';
import { prepareDictation } from '../desktop/dictation.mjs';
import {DictationRecorder} from './dictation-recorder.js';

/** One explicitly started voice session. Never restarts after Stop or navigation. */
export class VoiceSession {
  constructor({ invoke, current, update, draft, recoverDraft, send, capture=options=>new DictationRecorder(options),schedule = (fn, ms) => setTimeout(fn, ms), unschedule = id => clearTimeout(id) }) {
    Object.assign(this, { invoke, current, update, draft, recoverDraft, send, capture,schedule, unschedule });
    this.generation = 0; this.mode = ''; this.phase = 'idle'; this.sessionId = ''; this.scope = ''; this.buffer = ''; this.timer = null; this.pending = false;
  }
  state(phase, extra = {}) { this.phase = phase; this.update({ mode: this.mode, phase, transcript: this.buffer, dictation: this.dictation || null, ...extra }); }
  async stop({ clear = false } = {}) {
    this.generation++; this.unschedule(this.timer); this.timer = null;
    this.recorder?.cancel();this.recorder=null;
    const sessionId = this.sessionId; this.sessionId = ''; this.mode = ''; this.pending = false;
    if (clear) { this.buffer = ''; this.dictation = null; this.dictationReceipt = null; }
    this.state('idle',{recording:false});
    await this.invoke('voice.stop', sessionId ? { sessionId } : {}).catch(() => {});
  }
  async start(mode) {
    const stopped = this.stop({ clear: true }), generation = this.generation;
    await stopped;
    if (generation !== this.generation) return;
    this.mode = mode; this.scope = this.current().conversationId || ''; this.projectScope = this.current().projectId || '';
    await this.listen();
  }
  async listen() {
    if (!this.mode) return;
    const generation = this.generation;
    this.state('starting');
    try {
      const options=normalizeVoice(this.current().settings),local=this.mode==='dictation'&&options.dictationEngine==='whisper';
      const result = await this.invoke('voice.listen', {language:options.language,...(local?{engine:'whisper',conversationId:this.current().conversationId||'',projectId:this.current().projectId||''}:{})});
      if (generation !== this.generation) { await this.invoke('voice.stop', { sessionId: result.sessionId }); return; }
      this.sessionId = result.sessionId;
      if(result.capture){const recorder=this.capture({onLimit:()=>{if(generation===this.generation)this.state('listening',{recording:true,hint:'Two-minute recording limit reached. Choose Transcribe recording or Stop to discard.'});}});this.recorder=recorder;await recorder.start();if(generation!==this.generation){recorder.cancel();await this.invoke('voice.stop',{sessionId:result.sessionId});return;}}
      this.state('listening', { language: result.language, error: '',recording:!!result.capture,hint:result.capture?'Recording locally. Choose Transcribe recording when finished. Stop discards the recording.':'' });
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  fail(error) {
    this.recorder?.cancel();this.recorder=null;
    this.unschedule(this.timer); this.timer = null; this.generation++;
    const sessionId = this.sessionId; this.sessionId = ''; this.mode = ''; this.pending = false;
    this.state('error', {recording:false, error: String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '') });
    if (sessionId) this.invoke('voice.stop', { sessionId }).catch(() => {});
  }
  receive(value) {
    if (value.type === 'voice.reset' && this.mode) {
      this.recorder?.cancel();this.recorder=null;
      this.generation++; this.mode = ''; this.pending = false; this.sessionId = ''; this.unschedule(this.timer);
      this.dictation = null; this.dictationReceipt = null; this.state('idle', {recording:false,hint: 'Voice stopped.', error: '' }); return;
    }
    if (value.type !== 'voice.event' || !value.sessionId || value.sessionId !== this.sessionId) return;
    const event = value.event;
    if (event.type === 'error') { this.fail(event.message); return; }
    if (event.type === 'stopped') {this.recorder?.cancel();this.recorder=null;this.generation++; this.mode = ''; this.pending = false; this.sessionId = ''; this.unschedule(this.timer); this.state('idle', {recording:false,hint: 'Voice stopped.' }); return; }
    if (event.type === 'speech' && this.mode === 'conversation' && this.phase === 'listening') {
      this.unschedule(this.timer); this.timer = null; this.state('listening', { hint: 'Listening…' }); return;
    }
    if (event.type === 'quiet' && this.mode === 'conversation' && this.phase === 'listening' && this.buffer) {
      this.unschedule(this.timer); this.timer = this.schedule(() => this.submit(), normalizeVoice(this.current().settings).silenceMs); return;
    }
    if (event.type === 'unclear') { this.state('listening', { hint: 'I could not hear that clearly. Please try again.' }); return; }
    if (event.type === 'transcript' && this.phase === 'listening') {
      const text = String(event.text || '').trim(); if (!text) return;
      if (this.mode === 'dictation') {
        const result = prepareDictation(text, this.current().settings, this.current().projectId || '');
        this.dictationReceipt = this.draft(result.text);
        this.dictation = { ...result, restored: false, error: '' };
        this.state('listening', { hint: result.changed ? 'Added with minimal cleanup. Original recognition is available below.' : 'Added to your draft. Review it before sending.' }); return;
      }
      this.buffer = (this.buffer + ' ' + text).trim(); this.state('listening', { hint: '' });
      this.unschedule(this.timer);
      this.timer = this.schedule(() => this.submit(), normalizeVoice(this.current().settings).silenceMs);
    }
    if (event.type === 'done' && this.phase === 'speaking') {
      this.sessionId = '';
      if (this.mode === 'conversation') { this.buffer = ''; this.listen(); }
      else { this.mode = ''; this.state('idle'); }
    } else if (event.type === 'ended' && ['listening', 'speaking'].includes(this.phase)) {
      this.fail('The microphone stopped. Start voice again when you are ready.');
    }
  }
  async finishDictation(){
    if(this.mode!=='dictation'||this.phase!=='listening'||!this.recorder)return;
    const generation=this.generation,sessionId=this.sessionId,recorder=this.recorder;this.recorder=null;this.state('transcribing',{recording:false,hint:'Microphone off. Transcribing locally…'});
    try{const wav=recorder.finish(),result=await this.invoke('voice.local.transcribe',{sessionId,wav,conversationId:this.scope,projectId:this.projectScope});if(generation!==this.generation)return;
      if((this.current().conversationId||'')!==this.scope||(this.current().projectId||'')!==this.projectScope){await this.stop({clear:true});return;}
      this.state('listening');this.receive({type:'voice.event',sessionId,event:{type:'transcript',text:result.text}});await this.stop();
    }catch(error){if(generation===this.generation)this.fail(error);}
  }
  recoverOriginal() {
    if (!this.dictation?.changed || this.dictation.restored || !this.recoverDraft) return;
    try {
      this.recoverDraft(this.dictationReceipt, this.dictation.original);
      this.dictation = { ...this.dictation, restored: true, error: '' };
      this.state(this.phase, { hint: 'Original recognition restored in your draft. Review it before sending.' });
    } catch (error) { this.dictation = { ...this.dictation, error: error.message }; this.state(this.phase); }
  }
  dismissDictation() { this.dictation = null; this.dictationReceipt = null; this.state(this.phase, { hint: '' }); }
  async submit() {
    if (this.mode !== 'conversation' || this.phase !== 'listening' || !this.buffer) return;
    const generation = this.generation, text = this.buffer;
    this.unschedule(this.timer); this.timer = null;
    const sessionId = this.sessionId; this.sessionId = '';
    this.baseline = this.current().reply?.id; this.pending = true; this.state('waiting', { hint: 'Microphone paused while your AI replies.' });
    try {
      await this.invoke('voice.stop', { sessionId });
      if (generation !== this.generation) return;
      const result = await this.send(text);
      if (generation !== this.generation) return;
      if (!result?.conversationId) throw Error('Your voice message was not sent. It is available to review in the message box.');
      this.scope = result.conversationId;
    } catch (error) { if (generation === this.generation) { this.draft(text); this.fail(error); } }
  }
  reply(message, running) {
    if (!this.pending || this.phase !== 'waiting' || running || !message?.id || message.id === this.baseline) return;
    if (message.error) { this.fail('The reply did not complete. Review the chat, then start voice again.'); return; }
    if (!message.completedAt && !message.finishedAt) return;
    this.pending = false;
    this.speak(message.content, true);
  }
  async speak(text, continuing = false) {
    const prose = spokenText(text);
    if (!prose) {
      if (continuing) { this.buffer = ''; await this.listen(); }
      return;
    }
    if (!continuing) { const stopped = this.stop({ clear: true }), generation = this.generation; await stopped; if (generation !== this.generation) return; this.mode = 'read'; this.scope = this.current().conversationId || ''; }
    const generation = this.generation; this.state('speaking', { hint: 'Microphone paused. Use Stop to end voice.' });
    try {
      const {language,voice,rate}=normalizeVoice(this.current().settings);
      const result = await this.invoke('voice.speak', { language,voice,rate,text: prose });
      if (generation !== this.generation) { await this.invoke('voice.stop', { sessionId: result.sessionId }); return; }
      this.sessionId = result.sessionId;
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  scopeChanged(conversationId, page, projectId = this.current().projectId || '') {
    const changedProject = projectId !== (this.projectScope || '');
    if (this.dictation && (page !== 'chat' || conversationId !== this.scope || changedProject)) { this.dictation = null; this.dictationReceipt = null; this.state(this.phase, { hint: '' }); }
    if (!this.mode) return;
    // Sending the first voice message temporarily assigns a pending chat id.
    if (page !== 'chat' || changedProject || (conversationId !== this.scope && !(this.phase === 'waiting' && !this.scope && String(conversationId || '').startsWith('pending-')))) this.stop({ clear: true });
  }
}
