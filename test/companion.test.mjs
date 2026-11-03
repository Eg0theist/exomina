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

test('the sigil is a built-in avatar that survives character profiles', async () => {
  assert.equal(validateAppearance({companionAvatar: 'sigil'}, {}).companionAvatar, 'sigil');
  const {characterProfile} = await import('../desktop/character-profile.mjs');
  const profile = characterProfile({format: 'exomina-character', version: 1, name: 'Vesper', essence: 'Attentive.', appearance: {companionEnabled: true, companionAvatar: 'sigil'}});
  assert.equal(profile.appearance.companionAvatar, 'sigil');
});

test('the invented script is stable and renders the same glyphs for the theme and the sigil', async () => {
  const {seeded, inventScript, glyphPath} = await import('../src/invented-script.js');
  const first = inventScript(seeded(0x5161)), second = inventScript(seeded(0x5161));
  assert.equal(first.length, 72);
  assert.deepEqual(first, second);
  for (const glyph of first) {
    assert.ok(glyph.strokes.length >= 2 && glyph.strokes.length <= 3);
    assert.match(glyphPath(glyph, 60, 15, 8), /^M[\d.\- ]+[LQ]/);
  }
});
