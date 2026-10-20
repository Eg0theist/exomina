import test from 'node:test';
import assert from 'node:assert/strict';
import { trimBootstrap, trimChat, phoneApproval, checkPhoneApproval } from '../desktop/remote-bridge.mjs';
import { phoneWorkCounts } from '../desktop/phone-work.mjs';
import { loadPhoneSession, savePhoneSession, clearPhoneSession } from '../src/phone-session.js';

test('phone work counts include old questions and unresolved follow-ups without exposing private tasks', () => {
  const chat = { id: 'public', messages: [{ questions: [{ id: 'q1', status: 'waiting' }, { id: 'q2', status: 'answered', deliveryState: 'failed' }, { id: 'q3', status: 'irrelevant' }], followups: [{ id: 'f1', status: 'answered', taskStatus: 'pending', text: 'SOURCE_BODY' }, { id: 'f2', taskStatus: 'handled' }, { id: 'f3', taskStatus: 'blocked' }] }] };
  assert.deepEqual(phoneWorkCounts(chat), { pendingQuestions: 2, pendingFollowups: 1, blockedFollowups: 1 });
  const result = trimBootstrap({ conversations: [chat, { id: 'private', private: true, messages: [{ questions: [{ id: 'secret', status: 'waiting' }] }] }], queues: { public: [{ id: 'queue', text: 'a'.repeat(1000), attachments: ['SECRET_UPLOAD'] }], private: [{ text: 'PRIVATE_QUEUE' }] }, activeRuns: [{ conversationId: 'private' }, { conversationId: 'public' }] });
  assert.equal(result.conversations[0].pendingQuestions, 2);
  assert.equal(result.queues.public[0].text.length, 500);
  assert.deepEqual(Object.keys(result.queues), ['public']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_QUEUE|SECRET_UPLOAD|SOURCE_BODY|secret/);
});

test('pending questions remain answerable when the phone omits their original messages', () => {
  const group = { id: 'old-question', status: 'open', questions: [{ id: 'colour', question: 'Which colour?', options: [{ label: 'Blue' }] }] };
  const chat = { id: 'c', messages: [{ id: 'old', questions: [group] }, ...Array.from({ length: 80 }, (_, i) => ({ id: String(i), content: 'Newer message' }))] };
  const result = trimChat(chat);
  assert.equal(result.messages.some(message => message.id === 'old'), false);
  assert.deepEqual(result.pendingQuestions, [group]);
  assert.equal(result.pendingQuestionsOmitted, 0);
  assert.equal(result.earlierOmitted, 21);
});

test('phone history retains bounded follow-up answers and respects its UTF-8 byte budget', () => {
  const messages = Array.from({ length: 80 }, (_, i) => ({ id: String(i), content: '🦉'.repeat(10000), followups: [{ id: 'f' + i, text: 'What changed?', answer: 'ANSWER'.repeat(10000), summary: 'Saved', taskStatus: 'handled', nativeSession: 'NEVER_SEND' }] }));
  const result = trimChat({ id: 'c', messages });
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 1500000);
  assert.equal(result.messages.at(-1).followups[0].taskStatus, 'handled');
  assert.match(result.messages.at(-1).followups[0].answer, /shortened on the phone/);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_SEND/);
});

test('chat drafts survive tab reload separately per device and chat, then clear on forget', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  assert.equal(savePhoneSession(storage, 'phone-a', 'chat-a', { 'chat-a': 'Draft A', 'chat-b': 'Draft B', $new: 'New chat draft' }), true);
  assert.deepEqual(loadPhoneSession(storage, 'phone-a'), { selectedId: 'chat-a', drafts: { 'chat-b': 'Draft B', $new: 'New chat draft', 'chat-a': 'Draft A' } });
  assert.deepEqual(loadPhoneSession(storage, 'phone-b'), { selectedId: null, drafts: {} });
  clearPhoneSession(storage, 'phone-a');
  assert.deepEqual(loadPhoneSession(storage, 'phone-a'), { selectedId: null, drafts: {} });
  assert.equal(savePhoneSession({ setItem() { throw Error('Quota exceeded'); } }, 'phone', null, { $new: 'Keep in memory' }), false);
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String(i), 'Draft ' + i]));
  savePhoneSession(storage, 'phone-a', '0', many);
  const bounded = loadPhoneSession(storage, 'phone-a');
  assert.equal(Object.keys(bounded.drafts).length, 20); assert.equal(bounded.drafts['0'], 'Draft 0');
});

test('large approval previews stay bounded and require the full preview on the computer', () => {
  const request = { id: 'large', title: 'Write a large file', tool: 'workspace_write', detail: 'CONTENT'.repeat(100000) };
  const shown = phoneApproval(request);
  assert.equal(shown.desktopOnly, true); assert.equal(shown.detail, undefined);
  assert.ok(JSON.stringify(shown).length < 1000);
  assert.throws(() => checkPhoneApproval(request, { digest: shown.digest, decision: 'once' }), /computer/);
  assert.doesNotThrow(() => checkPhoneApproval(request, { digest: shown.digest, decision: 'deny' }));
  assert.equal(trimChat({ messages: [{ content: [{ text: 'Structured content' }] }] }).messages[0].content, undefined);
});
