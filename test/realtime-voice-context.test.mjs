import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeConversationContext, realtimeRecentConversation, REALTIME_CONTEXT_LIMIT } from '../desktop/realtime-voice-context.mjs';
import { SubscriptionRealtimeVoice } from '../desktop/realtime-voice.mjs';

test('a huge latest reply retains the current question, reply beginning, and latest correction', () => {
  const messages = [{ role: 'user', id: 'question', content: 'We are fixing voice context in this chat.' }, { role: 'assistant', id: 'reply', content: 'Beginning of relevant answer. ' + 'x'.repeat(50000) + ' Latest correction: live replies are still unverified.' }];
  const text = realtimeRecentConversation(messages), entries = JSON.parse(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].content, messages[0].content);
  assert.match(entries[1].content, /Beginning of relevant answer/);
  assert.match(entries[1].content, /Latest correction: live replies are still unverified/);
  assert.match(entries[1].content, /middle omitted/);
  assert.ok(text.length <= 12000);
});

test('voice context uses both earlier tree decisions and recent originals across model switches', () => {
  const context = realtimeConversationContext({ chat: { id: 'current', title: 'Voice repair', messages: [{ role: 'user', provider: 'claude', content: 'Keep the private GitHub repository.' }, { role: 'assistant', provider: 'codex', content: 'Voice replies need current context.', voice: { mode: 'realtime' } }] }, memoryPlan: { view: { entries: [{ id: 0, count: 16, text: 'Earlier decision: preserve existing chat history.' }, { id: 16, count: 1, pending: true, text: 'Do not invent this pending content.' }] } } });
  assert.match(context, /continues the currently open Exomina chat/);
  assert.match(context, /preserve existing chat history/);
  assert.match(context, /Keep the private GitHub repository/);
  assert.match(context, /"voice":true/);
  assert.match(context, /Summary pending; this range is unavailable/);
  assert.doesNotMatch(context, /Do not invent this pending content/);
  assert.match(context, /no retrieval tools/);
});

test('large memory and preference records remain bounded without dropping newest chat context', () => {
  const entries = Array.from({ length: 1000 }, (_, id) => ({ id, count: 1, text: `Decision ${id}: ` + 'y'.repeat(2000) }));
  const context = realtimeConversationContext({ chat: { id: 'scope', messages: [{ role: 'user', content: 'Newest question must survive.' }] }, memoryPlan: { view: { entries } }, personalization: 'p'.repeat(8000), projectInstructions: 'i'.repeat(8000), savedMemory: 's'.repeat(50000), importedContext: 'a'.repeat(20000) });
  assert.ok(context.length <= REALTIME_CONTEXT_LIMIT);
  assert.match(context, /Newest question must survive/);
  assert.match(context, /Decision 0:/);
  assert.match(context, /Decision 999:/);
  assert.match(context, /memory ranges omitted/);
  assert.match(context, /permissions/);
});

test('source context redacts credentials and binary content without reading attachment pixels', () => {
  const context = realtimeConversationContext({ chat: { id: 'current', messages: [{ role: 'user', content: 'api_key=sk-thisisasecretkey12345678\nAttached: data:audio/wav;base64,YWJjZA==', attachments: [{ name: 'recording.wav', kind: 'audio', dataBase64: 'c2VjcmV0' }] }] } });
  assert.doesNotMatch(context, /sk-thisisasecretkey|YWJjZA==|c2VjcmV0|dataBase64/);
  assert.match(context, /credential redacted/);
  assert.match(context, /recording.wav/);
});

test('missing or disabled memory still supplies usable recent chat context', () => {
  const context = realtimeConversationContext({ chat: { id: 'current', messages: [{ role: 'user', content: 'We discussed the new installer.' }] } });
  assert.match(context, /We discussed the new installer/);
  assert.match(context, /overview is unavailable/);
  assert.match(context, /bounded/);
});

test('long current-chat snapshot reaches both realtime speech and native delegated answers identically', async t => {
  const calls = [], rpc = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/realtime/listVoices') return { voices: { v1: ['cove'], defaultV1: 'cove' } };
    if (method === 'thread/start') return { thread: { id: 'synthetic-voice-thread' }, sandbox: { type: 'readOnly' } };
    return {};
  } };
  const voice = new SubscriptionRealtimeVoice({ getRpc: async () => rpc });
  t.after(() => voice.stop());
  const chat = { id: 'current-chat', messages: [{ role: 'user', content: 'The current chat is about fixing Exomina voice.' }, { role: 'assistant', content: 'Earlier reply start. ' + 'x'.repeat(50000) + ' Correction: published beta installers remain unchanged.' }] };
  const context = realtimeConversationContext({ chat, memoryPlan: { view: { entries: [{ id: 0, count: 64, text: 'Prior decision: preserve the user\'s existing shared notes.' }] } } });
  const ready = await voice.prepare();
  await voice.start({ sessionId: ready.sessionId, conversationId: chat.id, workspace: 'C:/synthetic', context, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' });
  const delegated = calls.find(call => call.method === 'thread/start').params;
  const speech = calls.find(call => call.method === 'thread/realtime/start').params;
  const sourceBlock = text => /<exomina_chat_source>\n([\s\S]*?)\n<\/exomina_chat_source>/.exec(text)?.[1];
  const delegatedSnapshot = JSON.parse(sourceBlock(delegated.developerInstructions));
  const speechSnapshot = JSON.parse(sourceBlock(speech.prompt));
  assert.equal(delegatedSnapshot, context);
  assert.equal(speechSnapshot, context);
  assert.match(delegatedSnapshot, /current chat is about fixing Exomina voice/);
  assert.match(delegatedSnapshot, /Correction: published beta installers remain unchanged/);
  assert.match(delegatedSnapshot, /preserve the user/);
  assert.equal(delegated.ephemeral, true);
  assert.deepEqual(delegated.dynamicTools, []);
  assert.equal(delegated.approvalPolicy, 'never');
  assert.equal(delegated.sandbox, 'read-only');
});
