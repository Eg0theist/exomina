import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WindowsVoice } from '../desktop/voice.mjs';
import { normalizeVoice, patchVoice, spokenText } from '../desktop/voice-settings.mjs';

test('voice control patches preserve independently changed fields in either request order',()=>{
  const initial=normalizeVoice({realtimeVoice:'maple',previewTone:'clear',rate:2,language:'de-DE'});
  for(const patches of [[{realtimeVoice:'vale'},{previewTone:'original'}],[{previewTone:'original'},{realtimeVoice:'vale'}]]){
    const result=patches.reduce((value,patch)=>patchVoice(value,patch),initial);assert.equal(result.realtimeVoice,'vale');assert.equal(result.previewTone,'original');assert.equal(result.rate,2);assert.equal(result.language,'de-DE');
  }
  assert.equal(patchVoice(initial,{realtimeVoice:''}).realtimeVoice,undefined);
  assert.throws(()=>patchVoice(initial,{permissionMode:'full'}),/Invalid voice/);assert.throws(()=>patchVoice(initial,null),/Invalid voice/);assert.throws(()=>patchVoice(initial,[]),/Invalid voice/);
});
import { VoiceSession } from '../src/voice-session.js';

const status = { type: 'status', available: true, language: 'de-DE', recognizers: [{ id: 'de', language: 'de-DE' }, { id: 'en', language: 'en-US' }], voices: [{ id: 'Desktop Voice', language: 'de-DE' }] };
function host() {
  const calls = [], events = [], children = [];
  const service = new WindowsVoice({ platform: 'win32', emit: event => events.push(event), spawnImpl(executable, args, options) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', 0)); };
    child.event = value => child.stdout.write(JSON.stringify(value) + '\n');
    const call = { executable, args, options, input: '' }; child.stdin.on('data', bytes => call.input += bytes.toString()); calls.push(call); children.push(child);
    setImmediate(() => { if (args.at(-1) === 'status') { child.event(status); child.emit('close', 0); } else child.event({ type: 'ready' }); });
    return child;
  } });
  return { service, calls, events, children };
}
function ui({ sendError = false } = {}) {
  const calls = [], drafts = [], sent = [], states = [];
  let sequence = 0, callback;
  const current = { conversationId: 'chat-1', settings: {}, reply: { id: 'old' } };
  const session = new VoiceSession({
    invoke: async (method, payload) => { calls.push({ method, payload }); return { sessionId: 's' + ++sequence, conversationId: 'chat-1', language: 'de-DE' }; },
    current: () => current, update: state => states.push(state), draft: text => drafts.push(text),
    send: async text => { sent.push(text); if (sendError) throw Error('Connection unavailable'); return { conversationId: 'chat-1' }; },
    schedule: fn => { callback = fn; return 1; }, unschedule: () => { callback = null; },
  });
  return { session, calls, drafts, sent, states, current, transcript: text => session.receive({ type: 'voice.event', sessionId: session.sessionId, event: { type: 'transcript', text } }), flush: async () => { const fn = callback; await fn?.(); } };
}

test('voice settings are bounded and speech removes code and link destinations', () => {
  assert.deepEqual(normalizeVoice({ language: '$(code)', voice: '\nsecret', rate: 20, silenceMs: -1 }), { language: '', voice: '', rate: 5, silenceMs: 1400, previewTone: 'clear' });
  const text = spokenText('# Hello\n**Alex** [reference](https://example.com)\n```js\nSECRET CODE\n```\n![](https://example.com/image.png)');
  assert.equal(text, 'Hello Alex reference Code example omitted.');
});
test('Windows speech discovers installed languages without recording and launches a fixed hidden helper', async () => {
  const h = host(); const found = await h.service.status(); assert.equal(found.available, true);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args.at(-1), 'status');
  const run = await h.service.start('listen'); assert.equal(run.language, 'de-DE');
  assert.equal(h.calls[1].options.windowsHide, true); assert.equal(h.calls[1].options.shell, false);
  assert.equal(JSON.parse(h.calls[1].input).language, 'de-DE');
  h.service.stop(run.sessionId); assert.ok(h.children[1].killed);
});
test('uninstalled languages are rejected and stale Stop cannot stop a newer microphone session', async () => {
  const h = host(); await assert.rejects(h.service.start('listen', { language: 'es-ES' }), /installed language/);
  assert.equal(h.calls.length, 1);
  const first = await h.service.start('listen', { language: 'en-US' });
  const second = await h.service.start('listen', { language: 'de-DE' });
  assert.deepEqual(h.service.stop(first.sessionId), { stopped: false });
  assert.equal(h.service.active.sessionId, second.sessionId); h.service.close();
});
test('Stop during language discovery prevents microphone launch', async () => {
  const h = host(), pending = h.service.start('listen'); h.service.stop();
  await assert.rejects(pending, /stopped/); assert.equal(h.calls.length, 1); h.service.close();
});
test('dictation adds text only to the draft; an old session cannot inject speech', async () => {
  const f = ui(); await f.session.start('dictation'); f.transcript('Hello Alex');
  f.session.receive({ type: 'voice.event', sessionId: 'old', event: { type: 'transcript', text: 'wrong' } });
  assert.deepEqual(f.drafts, ['Hello Alex']); assert.deepEqual(f.sent, []);
  await f.session.stop(); assert.equal(f.session.mode, ''); assert.equal(f.calls.at(-1).method, 'voice.stop');
});
test('voice conversation sends once, pauses the microphone, speaks the completed reply and resumes listening', async () => {
  const f = ui(); await f.session.start('conversation'); f.transcript('Hello'); f.transcript('Alex'); await f.flush();
  assert.deepEqual(f.sent, ['Hello Alex']); assert.equal(f.session.phase, 'waiting');
  assert.deepEqual(f.calls.slice(1).map(call => call.method), ['voice.listen', 'voice.stop']);
  f.session.reply({ id: 'new', content: 'Still streaming' }, false); assert.equal(f.session.phase, 'waiting');
  f.session.reply({ id: 'new', content: 'Hello back.', finishedAt: 'now' }, false);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.session.phase, 'speaking');
  assert.equal(f.calls.at(-1).method, 'voice.speak');
  f.session.receive({ type: 'voice.event', sessionId: f.session.sessionId, event: { type: 'done' } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.session.phase, 'listening'); assert.equal(f.calls.at(-1).method, 'voice.listen');
  await f.session.stop();
});
test('Stop while waiting and navigation both prevent automatic playback or microphone restart', async () => {
  const f = ui(); await f.session.start('conversation'); f.transcript('Question'); await f.flush(); await f.session.stop();
  f.session.reply({ id: 'new', content: 'Hello', finishedAt: 'now' }, false); assert.equal(f.session.phase, 'idle');
  await f.session.start('dictation'); f.session.scopeChanged('another-chat', 'chat'); assert.equal(f.session.mode, '');
  await f.session.start('conversation'); f.session.scopeChanged('chat-1', 'settings'); assert.equal(f.session.mode, '');
});
test('failed voice send restores recognized speech for review and ends automatic listening', async () => {
  const f = ui({ sendError: true }); await f.session.start('conversation'); f.transcript('Keep this message'); await f.flush();
  assert.deepEqual(f.drafts, ['Keep this message']); assert.equal(f.session.phase, 'error'); assert.equal(f.session.mode, '');
});
test('Stop during microphone startup cancels a late successful result by its own session id', async () => {
  const f = ui(); let ready;
  f.session.invoke = (method, payload) => { f.calls.push({ method, payload }); return method === 'voice.listen' ? new Promise(resolve => { ready = resolve; }) : Promise.resolve({}); };
  const pending = f.session.start('dictation'); await new Promise(resolve => setImmediate(resolve)); await f.session.stop();
  ready({ sessionId: 'late' }); await pending;
  assert.equal(f.session.mode, ''); assert.deepEqual(f.calls.at(-1), { method: 'voice.stop', payload: { sessionId: 'late' } });
});

test('a host stop while awaiting the AI ends the voice session even with no active microphone', async () => {
  const f = ui(); await f.session.start('conversation'); f.transcript('Question'); await f.flush();
  f.session.receive({ type: 'voice.reset' });
  f.session.reply({ id: 'new', content: 'Reply after lock', finishedAt: 'now' }, false);
  assert.equal(f.session.mode, ''); assert.equal(f.session.pending, false); assert.ok(!f.calls.some(call => call.method === 'voice.speak'));
  const h = host(); h.service.stop(); assert.equal(h.events.at(-1).type, 'voice.reset');
});

test('fresh speech cancels the pending send so a continuing speaker is not interrupted', async () => {
  const f = ui(); await f.session.start('conversation'); f.transcript('First phrase');
  f.session.receive({ type: 'voice.event', sessionId: f.session.sessionId, event: { type: 'speech' } });
  await f.flush(); assert.deepEqual(f.sent, []);
  f.transcript('second phrase'); await f.flush(); assert.deepEqual(f.sent, ['First phrase second phrase']); await f.session.stop();
});
