import test from 'node:test';
import assert from 'node:assert/strict';
import { hudQuestionGroups } from '../src/hud-questions.js';
import { findTextQuestions, textQuestionGroup } from '../desktop/text-questions.mjs';

const prose = 'Which accent do you prefer?\n- Blue\n- Green';
test('HUD recovers commentary questions with the same source and saved answer', () => {
  const message = { id: 'reply', role: 'assistant', activity: [{ id: 'note', kind: 'note', text: prose }] };
  const group = hudQuestionGroups(message)[0];
  assert.equal(group.questions[0].question, 'Which accent do you prefer?');
  assert.equal(group.source.stepId, 'note');
  const saved = { ...group, status: 'answered', answers: { answer: { answers: ['Green'] } } };
  assert.deepEqual(hudQuestionGroups({ ...message, content: 'More progress.', questions: [saved] }), [saved]);
});
test('HUD restores a pruned question row and avoids duplicating a matching tool question', () => {
  const question = findTextQuestions(prose)[0];
  const group = { id: 'native', status: 'open', questions: [{ id: 'accent', question: question.question, options: question.options.map(label => ({ label })) }] };
  const message = { id: 'reply', role: 'assistant', questions: [group], activity: [{ id: 'note', kind: 'note', text: prose }] };
  assert.deepEqual(hudQuestionGroups(message), [group]);
});
test('HUD keeps final-prose questions in place and recovers answers when that prose is pruned', () => {
  const message = { id: 'reply', role: 'assistant', content: prose };
  const group = textQuestionGroup(message, 'content', findTextQuestions(prose)[0]);
  assert.deepEqual(hudQuestionGroups({ ...message, questions: [group] }), []);
  assert.deepEqual(hudQuestionGroups({ ...message, content: '', questions: [group] }), [group]);
});
test('HUD recovery excludes tool output, user prose and approval-like questions', () => {
  const message = { id: 'reply', role: 'assistant', activity: [{ id: 'tool', kind: 'tool', text: prose }, { id: 'consent', kind: 'note', text: 'Can I delete your files?\n- Yes\n- No' }] };
  assert.deepEqual(hudQuestionGroups(message), []);
  assert.deepEqual(hudQuestionGroups({ role: 'user', activity: [{ id: 'user', kind: 'note', text: prose }] }), []);
});
