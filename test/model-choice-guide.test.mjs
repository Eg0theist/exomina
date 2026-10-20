import test from 'node:test';
import assert from 'node:assert/strict';
import { modelTaskChoice } from '../desktop/model-choice-guide.mjs';
import { modelVisible } from '../desktop/model-preferences.mjs';

test('model suggestions use reported models and supported efforts, preferring the provider default within a family', () => {
  const models = [{ id: 'gpt-6-luna', efforts: [{ id: 'low' }] }, { id: 'gpt-6-sol', efforts: [{ id: 'medium' }] }, { id: 'gpt-6.1-sol', isDefault: true, efforts: [{ id: 'high' }] }, { id: 'gpt-6-astra', efforts: [{ id: 'xhigh' }] }];
  assert.equal(modelTaskChoice(models, 'quick').model, 'gpt-6-luna');
  assert.deepEqual(modelTaskChoice(models, 'everyday'), { model: 'gpt-6.1-sol', label: 'gpt-6.1-sol', effort: 'high', defaultModel: false });
  assert.equal(modelTaskChoice(models, 'difficult').effort, 'xhigh');
  assert.equal(modelTaskChoice([{ id: 'opus', efforts: [] }], 'difficult').effort, '');
});

test('unknown families fall back to a reported default, while hidden and missing options are never suggested', () => {
  const models = [{ id: 'auto', isDefault: true, efforts: [{ id: 'medium' }] }, { id: 'future-model', efforts: [{ id: 'ultra' }] }, { id: 'gpt-6-luna', efforts: [{ id: 'low' }] }];
  const visible = models.filter(item => modelVisible({ models: { codex: ['auto', 'future-model'] } }, 'codex', item.id));
  assert.deepEqual(modelTaskChoice(visible, 'quick'), { model: 'auto', label: 'Provider default', effort: 'medium', defaultModel: true });
  assert.equal(modelTaskChoice(visible, 'quick', { allowDefault: false }), null);
  assert.equal(modelTaskChoice([{ id: 'future-model' }], 'difficult'), null);
  assert.equal(modelTaskChoice([], 'everyday'), null);
});
