import test from 'node:test';
import assert from 'node:assert/strict';
import { isConcrete, recallBlock, recallTerms } from '../desktop/chat-memory-recall.mjs';
import { SEARCH_ONLY_CHARS, searchOnlyNote } from '../desktop/chat-memory-compactor.mjs';

test('only concrete terms qualify: versions, paths, identifiers, never plain words', () => {
  for (const term of ['0.3.5', 'beta.24', 'RIP14b5bbb', 'C:\Games\mod.pak', 'src/App.jsx', 'chat_memory', 'conversationFind', 'TLOU2', 'tree.sqlite']) assert.equal(isConcrete(term), true, term);
  for (const term of ['the', 'continue', 'suppressor', 'okay', 'https', 'e.g']) assert.equal(isConcrete(term), false, term);
});

test('terms come from the recent conversation, so a bare "Continue" still finds something', () => {
  const messages = [
    { role: 'user', content: 'The M700 crash is at RIP14b5bbb in pak68.txt, using suppressors0.3.3' },
    { role: 'assistant', content: 'The null lookup at RIP14b5bbb comes from the audio module table.' },
    { role: 'user', content: 'Continue' },
  ];
  const terms = recallTerms(messages);
  assert.equal(terms[0], 'RIP14b5bbb', 'repeated and recent terms rank first');
  assert.ok(terms.includes('pak68.txt') && terms.includes('suppressors0.3.3'));
  assert.deepEqual(recallTerms([{ role: 'user', content: 'Yo, what do you think about that?' }]), []);
  assert.ok(recallTerms([{ role: 'user', content: 'a1b2c3 '.repeat(50) + 'x'.repeat(10) }]).length <= 6);
});

test('the recall block skips passages the model already has, is bounded, and labels its contents as untrusted', () => {
  const hit = (id, text, extra = {}) => ({ id, role: 'user', kind: 'user', createdAt: '2026-10-12T10:00:00Z', source: 'conversation', snippet: text, ...extra });
  const found = { results: [hit(990, 'recent, already visible'), hit(12, 'We chose pak68 additions over the bare file.'), hit(12, 'duplicate'), hit(30, 'x'.repeat(2000)), hit(31, 'third'), hit(32, 'fourth', { source: 'tool' }), hit(33, 'fifth')] };
  const block = recallBlock(found, { newestId: 1000, terms: ['pak68'] });
  assert.match(block, /untrusted source data/); assert.match(block, /conversation_zoom/);
  assert.equal(block.includes('already visible'), false); assert.equal(block.includes('duplicate'), false);
  assert.equal((block.match(/^- id /gm) || []).length, 3);
  assert.ok(block.length < 2200);
  assert.equal(recallBlock({ results: [hit(999, 'recent')] }, { newestId: 1000, terms: ['a'] }), '');
  assert.equal(recallBlock({ results: [] }, { terms: ['a'] }), '');
});

test('the search-only note names its size and the way back to the text', () => {
  assert.equal(SEARCH_ONLY_CHARS, 12000);
  assert.match(searchOnlyNote(30000), /30,000 characters.*conversation_find/);
});
