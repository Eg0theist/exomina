import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore, updateDraft, restoreDraft, moveDraft } from '../src/chat-drafts.js';

test('drafts keep separate text for existing chats and the unsent new chat', () => {
  let drafts = updateDraft({}, 'a', 'Half a message');
  drafts = updateDraft(drafts, 'b', 'Another draft');
  drafts = updateDraft(drafts, 'new', 'A new conversation');
  drafts = updateDraft(drafts, 'a', current => current + ' continued');
  assert.deepEqual(drafts, { a: 'Half a message continued', b: 'Another draft', new: 'A new conversation' });
  drafts = updateDraft(drafts, 'b', '');
  assert.equal(drafts.a, 'Half a message continued');
  assert.equal(drafts.new, 'A new conversation');
  assert.equal(drafts.b, undefined);
});

test('a failed background send restores to its original chat and preserves newer typing', () => {
  const drafts = restoreDraft({ a: 'Typed while sending', b: 'Current chat' }, 'a', 'Unsent message');
  assert.equal(drafts.a, 'Unsent message\n\nTyped while sending');
  assert.equal(drafts.b, 'Current chat');
  assert.deepEqual(restoreDraft(drafts, 'b', 'Current chat'), drafts);
});

test('typing during new-chat creation moves to the confirmed chat or returns on failure', () => {
  const drafts = { 'pending-1': 'Next thought', new: 'Another new draft', other: 'Elsewhere' };
  assert.deepEqual(moveDraft(drafts, 'pending-1', 'confirmed'), { confirmed: 'Next thought', new: 'Another new draft', other: 'Elsewhere' });
  assert.deepEqual(restoreDraft(moveDraft(drafts, 'pending-1', 'new'), 'new', 'Failed first message'), { new: 'Failed first message\n\nNext thought\n\nAnother new draft', other: 'Elsewhere' });
  assert.equal(drafts['pending-1'], 'Next thought');
});

test('draft subscriptions publish synchronously only to changed chats and unsubscribe cleanly', () => {
  const store = createDraftStore(), observed = [], other = [];
  const stop = store.subscribe('a', () => observed.push(store.get('a')));
  store.subscribe('b', () => other.push(store.get('b')));
  store.update(previous => updateDraft(previous, 'a', 'First'));
  store.update(previous => updateDraft(previous, 'a', 'First'));
  store.update(previous => updateDraft(previous, 'b', 'Elsewhere'));
  assert.deepEqual(observed, ['First']);
  assert.deepEqual(other, ['Elsewhere']);
  store.update(previous => restoreDraft(previous, 'a', 'Failed message'));
  assert.equal(store.get('a'), 'Failed message\n\nFirst');
  store.update(previous => moveDraft(previous, 'a', 'b'));
  assert.equal(store.get('a'), '');
  assert.equal(store.get('b'), 'Failed message\n\nFirst\n\nElsewhere');
  stop();
  store.update(previous => updateDraft(previous, 'a', 'After unmount'));
  assert.deepEqual(observed, ['First', 'Failed message\n\nFirst', '']);
});
