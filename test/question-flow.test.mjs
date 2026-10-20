import test from 'node:test';
import assert from 'node:assert/strict';
import { questionFlowMessage } from '../src/question-flow.js';
import { UserQuestions } from '../desktop/user-questions.mjs';
import { RunActivity } from '../desktop/activity.mjs';

const before = { id: 'before', kind: 'note', text: 'Earlier work.', startedAt: '2026-10-11T10:00:00.000Z' };
const after = { id: 'after', kind: 'note', text: 'Later work.', startedAt: '2026-10-11T10:00:02.000Z' };
const group = { id: 'choice', createdAt: '2026-10-11T10:00:01.000Z', questions: [] };

test('a missing question row is restored between retained work without rewriting saved history', () => {
  const message = { activity: [before, after], questions: [group] }, original = structuredClone(message);
  const rendered = questionFlowMessage(message);
  assert.deepEqual(rendered.activity.map(step => step.id), ['before', 'question:choice', 'after']);
  assert.deepEqual(message, original);
  assert.equal(rendered.activity[0], before);
});

test('a delayed question activity event replaces its derived row without duplicate cards', () => {
  const message = { activity: [before, after], questions: [group] };
  assert.equal(questionFlowMessage(message).activity.filter(step => step.questionId === group.id).length, 1);
  const actual = { id: 'question:choice', kind: 'question', questionId: group.id, startedAt: group.createdAt };
  message.activity.splice(1, 0, actual);
  const rendered = questionFlowMessage(message);
  assert.equal(rendered.activity.filter(step => step.questionId === group.id).length, 1);
  assert.equal(rendered.activity[1], actual);
});

test('new question records retain their explicit preceding activity when timestamps coincide', () => {
  const message = { activity: [before, after], questions: [
    { ...group, createdAt: before.startedAt, activityAfterId: before.id },
    { ...group, id: 'second', activityAfterId: 'question:choice' },
  ] };
  assert.deepEqual(questionFlowMessage(message).activity.map(step => step.id), ['before', 'question:choice', 'question:second', 'after']);
});

test('older records without reliable timestamps remain attached to their original message', () => {
  const first = { id: 'old', questions: [] }, second = { id: 'newer', questions: [] };
  assert.deepEqual(questionFlowMessage({ content: 'Saved answer.', questions: [first, second] }).activity.map(step => step.id), ['question:old', 'question:newer']);
  assert.deepEqual(questionFlowMessage({ activity: [before], questions: [{ ...group, activityAfterId: 'pruned' }] }).activity.map(step => step.id), ['before', 'question:choice']);
});

test('asking cuts preceding narration before stamping and anchoring the question record', async () => {
  let now = Date.parse('2026-10-11T10:00:00.000Z');
  const message = { id: 'reply', role: 'assistant', content: '' }, chat = { messages: [message] };
  const activity = new RunActivity(message, { conversationId: 'chat', emit: () => {}, now: () => now++ });
  activity.delta('Narration before the question.');
  const run = { message, activity };
  const questions = new UserQuestions({ getRun: () => run, getChat: () => chat, save: async () => {}, emit: () => {}, deliver: async () => {}, now: () => now++, setTimer: () => ({}), clearTimer: () => {} });
  await questions.ask('chat', { questions: [{ question: 'Which option?', options: ['One', 'Two'] }] }, { wait: false });
  const record = message.questions[0];
  assert.equal(message.activity[0].text, 'Narration before the question.');
  assert.equal(record.activityAfterId, message.activity[0].id);
  assert.ok(Date.parse(record.createdAt) > Date.parse(message.activity[0].startedAt));
  assert.deepEqual(message.activity.map(step => step.kind), ['note', 'question']);
  assert.equal(questionFlowMessage(message).activity.length, 2);
  await questions.cancel('chat');
});
