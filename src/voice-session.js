import { normalizeVoice, spokenText } from '../desktop/voice-settings.mjs';

/** One explicitly started voice session. Never restarts after Stop or navigation. */
export class VoiceSession {
  constructor({ invoke, current, update, draft, send, schedule = (fn, ms) => setTimeout(fn, ms), unschedule = id => clearTimeout(id) }) {
    Object.assign(this, { invoke, current, update, draft, send, schedule, unschedule });
    this.generation = 0; this.mode = ''; this.phase = 'idle'; this.sessionId = ''; this.scope = ''; this.buffer = ''; this.timer = null; this.pending = false;
  }
  state(phase, extra = {}) { this.phase = phase; this.update({ mode: this.mode, phase, transcript: this.buffer, ...extra }); }
  async stop({ clear = false } = {}) {
    this.generation++; this.unschedule(this.timer); this.timer = null;
    const sessionId = this.sessionId; this.sessionId = ''; this.mode = ''; this.pending = false;
    if (clear) this.buffer = '';
    this.state('idle');
    await this.invoke('voice.stop', sessionId ? { sessionId } : {}).catch(() => {});
  }
  async start(mode) {
    const stopped = this.stop({ clear: true }), generation = this.generation;
    await stopped;
    if (generation !== this.generation) return;
    this.mode = mode; this.scope = this.current().conversationId || '';
    await this.listen();
  }
  async listen() {
    if (!this.mode) return;
    const generation = this.generation;
    this.state('starting');
    try {
      const result = await this.invoke('voice.listen', normalizeVoice(this.current().settings));
      if (generation !== this.generation) { await this.invoke('voice.stop', { sessionId: result.sessionId }); return; }
      this.sessionId = result.sessionId; this.state('listening', { language: result.language, error: '' });
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  fail(error) {
    this.unschedule(this.timer); this.timer = null; this.generation++;
    const sessionId = this.sessionId; this.sessionId = ''; this.mode = ''; this.pending = false;
    this.state('error', { error: String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '') });
    if (sessionId) this.invoke('voice.stop', { sessionId }).catch(() => {});
  }
  receive(value) {
    if (value.type === 'voice.reset' && this.mode) {
      this.generation++; this.mode = ''; this.pending = false; this.sessionId = ''; this.unschedule(this.timer);
      this.state('idle', { hint: 'Voice stopped.', error: '' }); return;
    }
    if (value.type !== 'voice.event' || !value.sessionId || value.sessionId !== this.sessionId) return;
    const event = value.event;
    if (event.type === 'error') { this.fail(event.message); return; }
    if (event.type === 'stopped') { this.generation++; this.mode = ''; this.pending = false; this.sessionId = ''; this.unschedule(this.timer); this.state('idle', { hint: 'Voice stopped.' }); return; }
    if (event.type === 'speech' && this.mode === 'conversation' && this.phase === 'listening') {
      this.unschedule(this.timer); this.timer = null; this.state('listening', { hint: 'Listening…' }); return;
    }
    if (event.type === 'quiet' && this.mode === 'conversation' && this.phase === 'listening' && this.buffer) {
      this.unschedule(this.timer); this.timer = this.schedule(() => this.submit(), normalizeVoice(this.current().settings).silenceMs); return;
    }
    if (event.type === 'unclear') { this.state('listening', { hint: 'I could not hear that clearly. Please try again.' }); return; }
    if (event.type === 'transcript' && this.phase === 'listening') {
      const text = String(event.text || '').trim(); if (!text) return;
      if (this.mode === 'dictation') { this.draft(text); this.state('listening', { hint: 'Added to your draft. Review it before sending.' }); return; }
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
      const result = await this.invoke('voice.speak', { ...normalizeVoice(this.current().settings), text: prose });
      if (generation !== this.generation) { await this.invoke('voice.stop', { sessionId: result.sessionId }); return; }
      this.sessionId = result.sessionId;
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  scopeChanged(conversationId, page) {
    if (!this.mode) return;
    // Sending the first voice message temporarily assigns a pending chat id.
    if (page !== 'chat' || (conversationId !== this.scope && !(this.phase === 'waiting' && !this.scope && String(conversationId || '').startsWith('pending-')))) this.stop({ clear: true });
  }
}
