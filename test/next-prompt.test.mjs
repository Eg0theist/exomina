import test from 'node:test';
import assert from 'node:assert/strict';
import { extractNextPrompt, stripNextPrompt, repeatsUserRequest } from '../desktop/next-prompt.mjs';
import { workingInstructions } from '../desktop/context.mjs';

test('a finished reply loses its marker and yields the suggestion', () => {
  const reply = 'Done, beta.27 is packaged.\n\n<next-prompt>Install it now</next-prompt>';
  assert.deepEqual(extractNextPrompt(reply), { text: 'Done, beta.27 is packaged.', suggestion: 'Install it now' });
});

test('replies without a marker are untouched', () => {
  assert.deepEqual(extractNextPrompt('Plain answer.'), { text: 'Plain answer.', suggestion: '' });
});

test('suggestions are single-line, unquoted and bounded', () => {
  assert.equal(extractNextPrompt('x\n<next-prompt>  "Run the\n tests"  </next-prompt>').suggestion, 'Run the tests');
  assert.equal(extractNextPrompt('x\n<next-prompt>' + 'a'.repeat(300) + '</next-prompt>').suggestion, '');
  assert.equal(extractNextPrompt('x\n<next-prompt></next-prompt>').suggestion, '');
});

test('prose after a stray closing tag is kept', () => {
  assert.equal(extractNextPrompt('A\n<next-prompt>Go</next-prompt>\nB').text, 'A\n\nB');
});

test('a marker still streaming in is hidden, ordinary angle brackets are not', () => {
  assert.equal(stripNextPrompt('Answer\n<next-pro'), 'Answer');
  assert.equal(stripNextPrompt('Answer\n<next-prompt>Inst'), 'Answer');
  assert.equal(stripNextPrompt('Use a < b'), 'Use a < b');
  assert.equal(stripNextPrompt('Tag <n'), 'Tag <n');
});

test('a suggestion repeating a recent user request is recognised', () => {
  assert.equal(repeatsUserRequest('Apply the update now', ['Fix it, restart and apply the update']), true);
  assert.equal(repeatsUserRequest('Run the tests', ['Install beta.40']), false);
  assert.equal(repeatsUserRequest('', ['anything']), false);
});

test('working instructions cover the measured failure causes', () => {
  for (const phrase of ['do not guess paths', '-g or --glob', 'UTF-8', 'fails twice', 'two fix-and-recheck rounds', 'what was not'])
    assert.ok(workingInstructions.includes(phrase), phrase);
});
