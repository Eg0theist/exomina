import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store, retireGeminiCli } from '../desktop/store.mjs';

const oldSelection = () => ({ provider: 'gemini-cli', model: 'gemini-auto', effort: 'high', speed: 'fast' });
const migratedSelection = () => ({ provider: 'antigravity', model: 'auto', effort: '', speed: '' });

test('retirement moves active Gemini choices to Antigravity while preserving chat history and other sessions', () => {
  const messages = [{ id: 'message', role: 'assistant', provider: 'gemini-cli', model: 'gemini-auto', content: 'Synthetic old reply.', activity: [{ name: 'Read', status: 'done' }] }];
  const chat = { id: 'old-chat', title: 'Saved title', provider: 'gemini-cli', selection: oldSelection(), messages,
    sessions: { 'gemini-cli': 'old-tools', 'gemini-cli:chat': 'old-chat', codex: 'keep-codex', 'antigravity:chat': 'keep-agy' },
    sessionSeen: { 'gemini-cli': { memory: 1 }, 'gemini-cli:chat': { memory: 2 }, codex: { memory: 3 } },
    contextSent: { 'gemini-cli:chat': { snapshot: 3 }, codex: { snapshot: 4 } },
    selections: { 'gemini-cli': '["gemini-auto","high"]', codex: '["auto",""]', antigravity: '["gemini-current",""]' } };
  const other = { id: 'other', provider: 'codex', messages: [{ role: 'user', content: 'Keep me' }], selection: { provider: 'codex', model: 'gpt-live', effort: 'high', speed: '' }, sessions: { codex: 'native' } };
  const otherBefore = structuredClone(other), messagesBefore = structuredClone(messages);
  const state = { settings: oldSelection(), conversations: [chat, other] };

  assert.deepEqual(retireGeminiCli(state), ['gemini-cli']);
  assert.deepEqual(state.settings, migratedSelection());
  assert.equal(chat.provider, 'antigravity');
  assert.deepEqual(chat.selection, migratedSelection());
  assert.deepEqual(chat.messages, messagesBefore, 'Historical provider attribution and message content stay intact.');
  assert.equal(chat.title, 'Saved title');
  assert.deepEqual(chat.sessions, { codex: 'keep-codex', 'antigravity:chat': 'keep-agy' });
  assert.deepEqual(chat.sessionSeen, { codex: { memory: 3 } });
  assert.deepEqual(chat.contextSent, { codex: { snapshot: 4 } });
  assert.deepEqual(chat.selections, { codex: '["auto",""]', antigravity: '["gemini-current",""]' });
  assert.deepEqual(other, otherBefore);
  assert.deepEqual(retireGeminiCli(state), [], 'A repeated migration is a no-op.');
});

test('retirement removes Gemini caches even when the current chat uses another provider', () => {
  for (const cache of ['sessions', 'sessionSeen', 'contextSent', 'selections']) {
    const state = { settings: { provider: 'codex', model: 'gpt-live' }, conversations: [{ provider: 'codex', messages: [], [cache]: { 'gemini-cli:tools': 'old-value', codex: 'keep' } }] };
    assert.deepEqual(retireGeminiCli(state), ['gemini-cli'], cache + ' cleanup must request persistence.');
    assert.deepEqual(state.conversations[0][cache], { codex: 'keep' });
    assert.deepEqual(state.settings, { provider: 'codex', model: 'gpt-live' });
    assert.deepEqual(retireGeminiCli(state), []);
  }
});

test('retirement cleans legacy picker preferences and scheduled selections without altering Google API choices', () => {
  const state = { settings: { provider: 'gemini', model: 'api-model', effort: 'high', modelPreferences: {
    connectedOnly: false, hiddenProviders: ['gemini-cli', 'gemini', 'antigravity', 'codex'],
    models: { 'gemini-cli': ['gemini-auto'], gemini: ['api-model'], antigravity: ['gemini-current'] },
    fallback: { enabled: true, mode: 'ordered', targets: [oldSelection(), { provider: 'gemini', model: 'api-model', effort: 'high' }, { provider: 'antigravity', model: 'gemini-current', effort: '' }] },
  } }, conversations: [], schedules: [{ id: 'old-task', ...oldSelection(), prompt: 'Synthetic prompt', enabled: true }, { id: 'api-task', provider: 'gemini', model: 'api-model', effort: 'high' }] };
  const apiTask = structuredClone(state.schedules[1]);
  assert.deepEqual(retireGeminiCli(state), ['gemini-cli']);
  assert.equal(state.settings.provider, 'gemini'); assert.equal(state.settings.model, 'api-model'); assert.equal(state.settings.effort, 'high');
  assert.deepEqual(state.settings.modelPreferences, {
    connectedOnly: false, hiddenProviders: ['gemini', 'antigravity', 'codex'], models: { gemini: ['api-model'], antigravity: ['gemini-current'] },
    fallback: { enabled: true, mode: 'ordered', targets: [{ provider: 'gemini', model: 'api-model', effort: 'high' }, { provider: 'antigravity', model: 'gemini-current', effort: '' }] },
  });
  assert.deepEqual(state.schedules[0], { id: 'old-task', ...migratedSelection(), prompt: 'Synthetic prompt', enabled: true });
  assert.deepEqual(state.schedules[1], apiTask);
  assert.deepEqual(retireGeminiCli(state), []);
});

test('synthetic saved and subsequently imported chats retire on init and save and remain normalized after reopening', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'exomina-provider-retirement-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('exomina-provider-retirement-')); await rm(directory, { recursive: true, force: true }); });
  const state = { settings: { ...oldSelection(), workspace: path.join(directory, 'workspace') }, conversations: [{ id: 'saved', provider: 'gemini-cli', messages: [{ id: 'original', role: 'user', content: 'Synthetic history' }], sessions: { 'gemini-cli': 'old-native-session' } }] };
  await writeFile(path.join(directory, 'state.json'), JSON.stringify(state));
  const store = new Store(directory); await store.init();
  assert.deepEqual(store.retiredProviders, ['gemini-cli']);
  assert.equal(store.state.settings.provider, 'antigravity'); assert.equal(store.conversation('saved').provider, 'antigravity');
  store.state.conversations.push({ id: 'imported', provider: 'gemini-cli', messages: [{ id: 'imported-message', role: 'assistant', provider: 'gemini-cli', content: 'Synthetic imported history' }], sessions: { 'gemini-cli:chat': 'imported-native-session', codex: 'preserve' } });
  await store.save();
  const saved = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  assert.equal(saved.conversations[1].provider, 'antigravity'); assert.deepEqual(saved.conversations[1].sessions, { codex: 'preserve' });
  assert.equal(saved.conversations[1].messages[0].provider, 'gemini-cli');
  const reopened = new Store(directory); await reopened.init();
  assert.deepEqual(reopened.retiredProviders, []);
  assert.deepEqual(reopened.state.conversations, saved.conversations);
  assert.equal(reopened.state.settings.model, 'auto'); assert.equal(reopened.state.settings.effort, '');
});
