import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { SubscriptionRealtimeVoice } from '../desktop/realtime-voice.mjs';
import { normalizeVoice } from '../desktop/voice-settings.mjs';

async function betaPlayback(t) {
  const parent = path.resolve(tmpdir());
  const fixture = await mkdtemp(path.join(parent, 'exomina-beta-voice-'));
  t.after(async () => {
    assert.ok(path.resolve(fixture).startsWith(parent + path.sep));
    await rm(fixture, { recursive: true, force: true });
  });
  const src = path.join(fixture, 'src');
  await mkdir(src);
  await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}\n');
  await copyFile(new URL('../src/voice-preview-session.js', import.meta.url), path.join(src, 'voice-preview-session.js'));
  await copyFile(new URL('../src/voice-preview-clips-beta.js', import.meta.url), path.join(src, 'voice-preview-clips-beta.js'));
  await writeFile(path.join(src, 'voice-preview-clips.js'), "export { VOICE_PREVIEW_CLIPS, VOICE_CLEAR_PREVIEW_CLIPS } from './voice-preview-clips-beta.js';\n");
  // The personal catalog and every audio asset are physically absent.
  return {
    clips: await import(pathToFileURL(path.join(src, 'voice-preview-clips.js')).href),
    session: await import(pathToFileURL(path.join(src, 'voice-preview-session.js')).href),
  };
}

test('beta playback loads with no recorded assets and never creates a player', async t => {
  const { clips, session } = await betaPlayback(t);
  assert.deepEqual(Object.keys(clips.VOICE_PREVIEW_CLIPS), []);
  assert.deepEqual(Object.keys(clips.VOICE_CLEAR_PREVIEW_CLIPS), []);
  const events = [];
  const preview = new session.VoicePreviewSession({
    current: () => ({ conversationId: 'synthetic', page: 'settings' }),
    update: event => events.push(event),
    createAudio: () => { throw Error('The beta must not create a recording player.'); },
    schedule: () => { throw Error('No playback should be scheduled.'); },
    unschedule: () => {},
  });
  await preview.start({ previewVoice: 'maple' });
  assert.equal(preview.mode, '');
  assert.equal(preview.audio, null);
  assert.equal(events.at(-1).phase, 'error');
  assert.match(events.at(-1).error, /No preview recording/);
});

test('native realtime voice selection works without a bundled recording', async t => {
  const { clips } = await betaPlayback(t);
  const choice = normalizeVoice({ realtimeVoice: 'futurevoice', previewTone: 'original' });
  assert.equal(choice.realtimeVoice, 'futurevoice');
  assert.equal(Object.hasOwn(clips.VOICE_PREVIEW_CLIPS, choice.realtimeVoice), false);
  const requests = [];
  const rpc = { request: async (method, payload) => {
    requests.push({ method, payload });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/realtime/listVoices') return { voices: { v1: ['juniper', 'futurevoice'], defaultV1: 'futurevoice' } };
    if (method === 'thread/start') return { thread: { id: 'synthetic-voice-thread' }, sandbox: { type: 'readOnly' } };
    return {};
  } };
  const native = new SubscriptionRealtimeVoice({ getRpc: async () => rpc });
  const ready = await native.prepare();
  assert.deepEqual(ready.voices, ['juniper', 'futurevoice']);
  assert.equal(ready.defaultVoice, 'futurevoice');
  await native.start({ sessionId: ready.sessionId, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', conversationId: 'synthetic', workspace: 'C:/synthetic', voice: choice.realtimeVoice });
  assert.equal(requests.find(request => request.method === 'thread/realtime/start').payload.voice, 'futurevoice');
  assert.equal(requests.some(request => request.method === 'turn/start'), false);
  await native.stop();
});
