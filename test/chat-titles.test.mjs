import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicTitle, cleanTitle, titlePrompt, canGenerateTitle, TitleService } from '../desktop/chat-titles.mjs';
import { spellcheckSettings, defaultLanguages } from '../desktop/spellcheck.mjs';

test('heuristic titles drop filler and keep the topic', () => {
  assert.equal(heuristicTitle('Hey, can you please help me fix the login bug in my React app? It crashes.'), 'Fix the login bug in my React app');
  assert.equal(heuristicTitle('Ich will dass du alle Ratgeber auf der Seite prüfst'), 'Alle Ratgeber auf der Seite prüfst');
  assert.equal(heuristicTitle('```js\nconst x = 1\n```\nwhy does this fail'), 'Why does this fail');
  assert.equal(heuristicTitle('   '), 'New chat');
  assert.ok(Array.from(heuristicTitle('word '.repeat(80))).length <= 60);
});

test('model titles are cleaned to a single safe line', () => {
  assert.equal(cleanTitle('Title: "React login crash fix".\nExtra'), 'React login crash fix');
  assert.equal(cleanTitle('**Steuererklärung 2025**'), 'Steuererklärung 2025');
  assert.equal(cleanTitle(''), null);
  assert.equal(cleanTitle('New chat'), null);
});

test('only placeholder chats are named automatically', () => {
  const chat = { id: '1', titleSource: 'pending', title: 'New chat', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(canGenerateTitle(chat), true);
  assert.equal(canGenerateTitle({ ...chat, titleSource: 'manual' }), false);
  assert.equal(canGenerateTitle({ ...chat, archived: true }), false);
  assert.match(titlePrompt({ messages: [{ role: 'user', content: 'Plan my trip' }, { role: 'assistant', content: 'Sure' }] }), /Plan my trip[\s\S]*Sure/);
});

test('title service uses Codex or Claude, falls through failures, then uses the heuristic', async () => {
  const calls = [];
  const service = new TitleService({
    getConnections: () => [{ id: 'grok', connected: true }, { id: 'codex', connected: true }, { id: 'claude', connected: true }, { id: 'antigravity', connected: true }],
    getProviders: () => ({ oneShot: async provider => { calls.push(provider); if (provider === 'claude') throw new Error('offline'); return 'Trip planning for Japan'; } }),
  });
  const chat = { id: 'c', provider: 'grok', messages: [{ role: 'user', content: 'plan japan trip' }] };
  assert.deepEqual(await service.generate(chat), { title: 'Trip planning for Japan', source: 'model' });
  assert.deepEqual(calls, ['claude', 'codex']);
  const offline = new TitleService({ getConnections: () => [], getProviders: () => ({}) });
  assert.deepEqual(await offline.generate(chat), { title: 'Plan japan trip', source: 'heuristic' });
});

test('spellcheck settings allow several languages and follow system languages by default', () => {
  assert.deepEqual(spellcheckSettings({ enabled: false, languages: ['de-DE', 'en-US', 'de-DE'] }), { enabled: false, languages: ['de-DE', 'en-US'] });
  assert.deepEqual(spellcheckSettings(undefined), { enabled: true, languages: [] });
  assert.throws(() => spellcheckSettings({ languages: ['<script>'] }), /languages/);
  assert.deepEqual(defaultLanguages(['de-DE', 'en-GB', 'en-US', 'fr'], ['de-AT', 'en-US', 'fr-CA']), ['de-DE', 'en-US', 'fr']);
  assert.deepEqual(defaultLanguages(['en-US', 'es'], []), ['en-US']);
});
