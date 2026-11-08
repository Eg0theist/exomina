import test from 'node:test';
import assert from 'node:assert/strict';
import { modelTier, backgroundEffort, chooseBackgroundModel, backgroundApiModel } from '../desktop/model-tiers.mjs';
import { helperRole } from '../desktop/helper-selection.mjs';
import { chooseSoulModel } from '../desktop/soul-learning.mjs';
import { TitleService } from '../desktop/chat-titles.mjs';

test('one tier classifier covers helper roles and background choices', () => {
  assert.equal(modelTier('claude-haiku-5-5'), 'light');
  assert.equal(modelTier({ id: 'gpt-5-mini' }), 'light');
  assert.equal(modelTier('gemini-2.5-flash-lite'), 'light');
  assert.equal(modelTier('gemini-2.5-pro'), 'deep', 'gemini must not read as mini');
  assert.equal(modelTier({ model: 'gpt-6-astra', label: 'GPT-6-Astra' }), 'deep');
  assert.equal(modelTier('sonnet'), 'balanced');
  assert.equal(helperRole({ model: 'gpt-6-luna' }), 'light');
});

test('background work picks the lightest model at its cheapest effort', () => {
  const models = [{ id: 'opus', efforts: ['low', 'high'] }, { id: 'sonnet' }, { id: 'haiku', efforts: [{ id: 'minimal' }, { id: 'low' }] }];
  assert.deepEqual(chooseBackgroundModel(models), { model: 'haiku', effort: 'minimal', tier: 'light' });
  assert.equal(chooseBackgroundModel([{ id: 'sonnet' }, { id: 'opus' }]).model, 'sonnet');
  assert.equal(chooseBackgroundModel([{ id: 'haiku', available: false }, { id: 'opus' }]).model, 'opus');
  assert.equal(chooseBackgroundModel([]), null);
  assert.equal(backgroundEffort(['medium', 'high']), '');
});

test('API background model is skipped when the chat already uses a light model or none is known', () => {
  assert.equal(backgroundApiModel('anthropic-api', 'claude-opus-5-5'), 'claude-haiku-5-5');
  assert.equal(backgroundApiModel('openai-api', 'gpt-5-mini'), '');
  assert.equal(backgroundApiModel('custom-api', 'llama'), '');
});

test('soul reflection still prefers a light subscription model at low effort', () => {
  const models = [{ provider: 'claude', model: 'opus', available: true, efforts: ['low'] }, { provider: 'claude', model: 'haiku', available: true, efforts: ['minimal', 'low'] }];
  assert.deepEqual([chooseSoulModel(models, {}, 'claude').model, chooseSoulModel(models, {}, 'claude').effort], ['haiku', 'low']);
});

test('API titles try the light model first and fall back to the chat model when it is refused', async () => {
  const calls = [];
  let refuse = true;
  const agent = { run: async ({ model }) => { calls.push(model || 'chosen'); if (model && refuse) throw Error('HTTP 404 model not found'); return { text: 'Quarterly tax plan' }; } };
  const service = new TitleService({ getConnections: () => [{ id: 'anthropic-api', configured: true }], getProviders: () => ({}), getApiAgent: () => agent, getChosenModel: () => 'claude-opus-5-5' });
  const chat = { id: 'c', provider: 'anthropic-api', messages: [{ role: 'user', content: 'tax plan' }] };
  assert.equal((await service.generate(chat)).title, 'Quarterly tax plan');
  assert.deepEqual(calls, ['claude-haiku-5-5', 'chosen']);
  // A refused light model is not retried this session.
  await service.generate({ ...chat, id: 'd' });
  assert.deepEqual(calls, ['claude-haiku-5-5', 'chosen', 'chosen']);
  const ok = new TitleService({ getConnections: () => [{ id: 'anthropic-api', configured: true }], getProviders: () => ({}), getApiAgent: () => agent, getChosenModel: () => 'claude-opus-5-5' });
  refuse = false; calls.length = 0;
  await ok.generate({ ...chat, id: 'e' });
  assert.deepEqual(calls, ['claude-haiku-5-5']);
});

test('a light-model failure followed by a failed fallback does not disable the light model', async () => {
  let fail = true; const calls = [];
  const agent = { run: async ({ model }) => { calls.push(model || 'chosen'); if (fail) throw Error('offline'); return { text: 'Back online' }; } };
  const service = new TitleService({ getConnections: () => [{ id: 'openai-api', configured: true }], getProviders: () => ({}), getApiAgent: () => agent, getChosenModel: () => 'gpt-6' });
  const chat = { id: 'c', provider: 'openai-api', messages: [{ role: 'user', content: 'hello world' }] };
  assert.equal((await service.generate(chat)).source, 'heuristic');
  fail = false; calls.length = 0;
  await service.generate({ ...chat, id: 'd' });
  assert.deepEqual(calls, ['gpt-5-mini']);
});
