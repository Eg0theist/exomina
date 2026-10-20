import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatMemoryTree } from '../desktop/chat-memory-tree.mjs';
import { ChatMemoryService } from '../desktop/chat-memory-service.mjs';
import { ChatMemorySearch, runIndexRequest, searchTokens } from '../desktop/chat-memory-search.mjs';
import { ConversationTools } from '../desktop/conversation-tools.mjs';

const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.verification', 'chat-memory-search-tests');
const unpack = response => JSON.parse(response.content[0].text);
// Runs index requests inline, standing in for the worker thread.
const inlineWorker = dataDir => {
  const listeners = new Map();
  return { unref() {}, terminate() {}, on(event, fn) { listeners.set(event, fn); }, off(event) { listeners.delete(event); },
    postMessage(request) { setImmediate(() => { try { listeners.get('message')?.({ ok: true, ...runIndexRequest(dataDir, request) }); } catch (error) { listeners.get('message')?.({ error: error.message }); } }); } };
};
async function fixture(t) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'synthetic-'));
  const tree = await new ChatMemoryTree(directory).init();
  const search = await new ChatMemorySearch(directory, { createWorker: inlineWorker, delay: 5 }).init();
  const service = new ChatMemoryService({ tree, search, settings: () => ({ chatMemoryEnabled: true }) });
  t.after(async () => { await service.close(); assert.ok(path.resolve(directory).startsWith(parent + path.sep)); await rm(directory, { recursive: true, force: true }); });
  return { tree, search, service, directory };
}
const event = (key, kind, text, extra = {}) => ({ key, kind, text, createdAt: '2026-10-13T10:00:00Z', ...extra });

test('tokens ignore short words and surrounding punctuation', () => {
  assert.deepEqual(searchTokens('  "Crash" of 14b5bbb, in the  M9?'), ['crash', '14b5bbb', 'the']);
  assert.deepEqual(searchTokens('a b'), []);
});

test('ranked search puts conversation text before tool output and keeps hits traceable', async t => {
  const f = await fixture(t);
  await f.tree.append('chat', event('u1', 'user', 'The suppressor build failed with address 14b5bbb at level load.'));
  await f.tree.append('chat', event('t1', 'echo', 'dump 14b5bbb 14b5bbb 14b5bbb 14b5bbb module lookup'));
  await f.tree.append('chat', event('a1', 'assistant', 'Unrelated reply about food.'));
  await f.search.sync('chat');
  const found = f.search.find('crash address 14B5BBB', { chatIds: ['chat'] });
  assert.equal(found.results[0].source, 'conversation', 'conversation text outranks a repetitive tool dump');
  assert.equal(found.results[0].id, 0);
  assert.equal(found.mode, 'any', 'falls back to any word when not every word matches');
  assert.ok(found.results.some(hit => hit.source === 'tool'));
  assert.equal(f.search.find('zzzzqqq', { chatIds: ['chat'] }).results.length, 0);
  assert.deepEqual(f.search.find('address', { chatIds: [] }).results, []);
  assert.match(JSON.stringify(await f.tree.zoom('chat', found.results[0].id)), /suppressor/);
});

test('superseded streamed snapshots are not indexed and later records are caught up incrementally', async t => {
  const f = await fixture(t);
  for (const [index, hash] of ['aaa1', 'bbb2', 'ccc3'].entries()) await f.tree.append('chat', event(`call:output:${hash}:part:0`, 'echo', 'growing snapshot ' + 'x'.repeat(index) + ' marker-' + hash));
  await f.tree.append('chat', event('u1', 'user', 'plain question about snapshots'));
  await f.search.sync('chat');
  assert.deepEqual(f.search.find('marker-', { chatIds: ['chat'] }).results.map(hit => hit.id), [2]);
  await f.tree.append('chat', event('u2', 'user', 'a later question about wibblewobble'));
  await f.search.sync('chat'); await f.search.sync('chat');
  assert.equal(f.search.status().documents, 3);
  assert.equal(f.search.find('wibblewobble', { chatIds: ['chat'] }).results[0].id, 4);
});

test('removing a chat or a deleted chat clears its documents', async t => {
  const f = await fixture(t);
  await f.tree.append('one', event('u', 'user', 'findable text alpha'));
  await f.tree.append('two', event('u', 'user', 'findable text beta'));
  await f.search.backfill();
  assert.equal(f.search.find('findable').results.length, 2);
  await f.service.remove('one');
  assert.deepEqual(f.search.find('findable').results.map(hit => hit.chatId), ['two']);
  await f.tree.removeChat('two'); await f.search.backfill();
  assert.equal(f.search.status().documents, 0);
});

test('search covers the middle of bulky output and retires a snapshot indexed in an earlier pass',async t=>{
  const f=await fixture(t);
  await f.tree.append('chat',event('call:output:abc1:part:0','echo','obsolete-first-snapshot'));
  await f.search.sync('chat');
  const dump='head '.repeat(1600)+'middle-needle-7733'+' tail'.repeat(1800);
  await f.tree.append('chat',event('call:output:abc2:part:0','echo',dump));
  await f.search.sync('chat');
  assert.equal(f.search.find('obsolete-first-snapshot').results.length,0);
  assert.deepEqual(f.search.find('middle-needle-7733').results.map(hit=>hit.id),[1]);
  assert.equal(f.search.status().documents,1);
});

test('conversation_find respects shared-memory scope and returns ids for conversation_zoom', async t => {
  const f = await fixture(t);
  const chats = [{ id: 'current', title: 'Now', messages: [] }, { id: 'other', title: 'Private', messages: [] }];
  let shared = false;
  const tools = new ConversationTools({ getConversations: () => chats, getMemoryEnabled: () => shared, getChatMemory: async () => f.tree, getSearch: async chat => { await f.search.flush(chat.id); return f.search; } });
  await f.tree.append('current', event('u', 'user', 'remember the nightglass codename'));
  await f.tree.append('other', event('u', 'user', 'nightglass in the other chat'));
  await f.search.backfill();
  assert.ok(tools.definitions.some(tool => tool.name === 'conversation_find'));
  let found = unpack(await tools.call('conversation_find', { query: 'nightglass' }, 'current'));
  assert.deepEqual(found.results.map(hit => hit.conversation.id), ['current']);
  shared = true;
  found = unpack(await tools.call('conversation_find', { query: 'nightglass' }, 'current'));
  assert.equal(found.results.length, 2);
  const zoomed = unpack(await tools.call('conversation_zoom', { conversationId: 'other', id: found.results.find(hit => hit.conversation.id === 'other').id, count: 1 }, 'current'));
  assert.match(JSON.stringify(zoomed), /other chat/);
  assert.equal(unpack(await tools.call('conversation_find', { query: 'ab' }, 'current')).ignoredShortWords, true);
  await assert.rejects(tools.call('conversation_find', { query: ' ' }, 'current'), /Search for/);
});
