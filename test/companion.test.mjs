import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAppearance, validateAppearance} from '../desktop/themes.mjs';

test('companion is opt-in and stored visual preferences survive unrelated theme changes', () => {
  assert.equal(normalizeAppearance().companionEnabled, false);
  const chosen = validateAppearance({companionEnabled: true, companionAvatar: 'cat', companionLabel: 'Nova', companionColor: '#abcdef', companionAnimate: false}, {});
  const next = validateAppearance({theme: 'paper'}, chosen);
  for (const key of ['companionEnabled', 'companionAvatar', 'companionLabel', 'companionColor', 'companionAnimate']) assert.equal(next[key], chosen[key]);
});

test('companion settings reject unsafe or malformed renderer input', () => {
  for (const patch of [{companionEnabled: 'true'}, {companionAvatar: 'https://remote/image.svg'}, {companionColor: 'url(https://remote/)'}, {companionAnimate: 1}, {companionLabel: 'x'.repeat(41)}, {companionLabel: 'hidden\u0000name'}]) assert.throws(() => validateAppearance(patch, {}), /Invalid appearance setting/);
  const legacy = normalizeAppearance({companionEnabled: {}, companionAvatar: 'unknown', companionLabel: '\u0000Hi\n', companionColor: '#broken'});
  assert.equal(legacy.companionEnabled, false); assert.equal(legacy.companionAvatar, 'fox'); assert.equal(legacy.companionLabel, 'Hi');
});
