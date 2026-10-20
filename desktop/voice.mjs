import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { normalizeVoice, spokenText } from './voice-settings.mjs';

const script = fileURLToPath(new URL('./voice-windows.ps1', import.meta.url)).replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
const failure = message => new Error(String(message || 'Windows speech could not start. Check your microphone and Windows speech language.').slice(0, 500));

/** UI-only local speech. Audio is neither saved nor sent to a cloud service. */
export class WindowsVoice {
  constructor({ emit = () => {}, spawnImpl = spawn, platform = process.platform } = {}) {
    Object.assign(this, { emit, spawnImpl, platform });
    this.active = null; this.cached = null; this.probe = null; this.serial = 0; this.closed = false;
  }
  launch(mode, request, onMessage, onExit) {
    if (this.platform !== 'win32') throw failure('Voice is currently available in the Windows desktop app.');
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = this.spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', finished = false;
    const finish = error => { if (finished) return; finished = true; onExit(error); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {}); // The helper returns a bounded, readable error as JSON.
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 100000) { child.kill(); finish(failure('Windows speech returned an oversized response.')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        try { onMessage(JSON.parse(line)); } catch { child.kill(); finish(failure('Windows speech returned an invalid response.')); }
      }
    });
    child.on('error', error => finish(failure(error.message)));
    child.on('close', code => finish(code ? failure() : null));
    child.stdin.on('error', () => {});
    child.stdin.end(request ? JSON.stringify(request) + '\n' : '');
    return child;
  }
  async status() {
    if (this.cached) return structuredClone(this.cached);
    if (this.platform !== 'win32') return { available: false, recognizers: [], voices: [], error: 'Local dictation and local spoken replies require Windows. ChatGPT Realtime voice is available separately with microphone permission.' };
    if (!this.probe) this.probe = new Promise((resolve, reject) => {
      let response, helperError;
      const child = this.launch('status', null, event => { if (event.type === 'status') response = event; if (event.type === 'error') helperError = failure(event.message); }, error => {
        clearTimeout(timer); this.probe = null;
        if (helperError || error || !response) reject(helperError || error || failure());
        else { this.cached = response; resolve(response); }
      });
      const timer = setTimeout(() => { child.kill(); }, 15000);
    });
    return structuredClone(await this.probe);
  }
  async start(mode, payload = {}) {
    if (this.closed) throw failure('Voice has stopped. Reopen Exomina to use it again.');
    if (!['listen', 'speak'].includes(mode)) throw failure('Invalid voice mode.');
    const serial = ++this.serial; this.stopActive();
    const status = await this.status();
    if (serial !== this.serial) throw failure('Voice was stopped.');
    const options = normalizeVoice(payload);
    if (mode === 'listen') {
      const language = options.language || (status.recognizers.find(item => item.language === status.language) || status.recognizers.find(item => item.language.startsWith('en-')) || status.recognizers[0])?.language;
      if (!language || !status.recognizers.some(item => item.language === language)) throw failure('Install a Windows speech language, or choose an installed language in Settings > Voice.');
      options.language = language;
    } else {
      options.text = spokenText(payload.text);
      if (!options.text) throw failure('There is no readable reply to speak.');
      if (options.voice && !status.voices.some(item => item.id === options.voice)) throw failure('The selected voice is no longer installed. Choose a voice in Settings > Voice.');
      if (!status.voices.length) throw failure('No Windows speaking voice is installed. Add one in Windows language settings.');
      options.voice ||= (status.voices.find(item => item.language === (options.language || status.language)) || status.voices[0])?.id || '';
    }
    const sessionId = randomUUID();
    return new Promise((resolve, reject) => {
      const state = { sessionId, mode, ready: false, timer: null, child: null, reject };
      this.active = state;
      const event = value => this.emit({ type: 'voice.event', sessionId, mode, event: value });
      state.timer = setTimeout(() => { if (this.active === state) { this.stopActive(); event({ type: 'error', message: 'Windows speech took too long to start. Check microphone access in Windows Settings.' }); } }, 15000);
      try {
        state.child = this.launch(mode, options, value => {
          if (this.active !== state) return;
          if (value.type === 'ready') { state.ready = true; clearTimeout(state.timer); resolve({ sessionId, language: options.language }); }
          if (value.type === 'error') { reject(failure(value.message)); this.stopActive(); }
          event(value);
        }, error => {
          if (this.active !== state) return;
          this.active = null; clearTimeout(state.timer);
          if (!state.ready) reject(error || failure());
          if (error) event({ type: 'error', message: error.message });
          else event({ type: 'ended' });
        });
      } catch (error) { this.active = null; clearTimeout(state.timer); reject(error); }
    });
  }
  stopActive() {
    const state = this.active; if (!state) return;
    this.active = null; clearTimeout(state.timer);
    state.reject(failure('Voice was stopped.')); state.child?.kill();
    this.emit({ type: 'voice.event', sessionId: state.sessionId, mode: state.mode, event: { type: 'stopped' } });
  }
  stop(sessionId,{reset=true}={}) {
    // A late stop from a previous UI request must not stop a newer session.
    if (sessionId && this.active?.sessionId !== sessionId) return { stopped: false };
    this.serial++; this.stopActive();
    if (!sessionId&&reset) this.emit({ type: 'voice.reset' });
    return { stopped: true };
  }
  close() { this.closed = true; this.stop(); }
}
