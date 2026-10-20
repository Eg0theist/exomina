import test from 'node:test';
import assert from 'node:assert/strict';
import { LIFTS, LANGUAGE_NOTE, FURTHER, IDEAS, IDEA_AREAS, splitAmbition, composeAmbition, toggleLift } from '../desktop/ambition.mjs';

const lift = id => LIFTS.find(item => item.id === id).text;

test('a lift appends visible guidance and one language note after the user’s words', () => {
  const text = toggleLift('Plan my sister’s birthday.', 'bigger');
  assert.equal(text, `Plan my sister’s birthday.\n\n${lift('bigger')}\n\n${LANGUAGE_NOTE}`);
  const both = toggleLift(text, 'check');
  assert.equal(both.split(LANGUAGE_NOTE).length, 2, 'the language note appears once');
  assert.deepEqual(splitAmbition(both), { base: 'Plan my sister’s birthday.', ids: ['bigger', 'check'] });
});

test('toggling a lift off restores the original request exactly', () => {
  const original = 'Wie kündige ich meinen Stromvertrag?\n\nIch wohne in Example City.';
  const on = toggleLift(toggleLift(original, 'deeper'), 'wider');
  assert.equal(toggleLift(toggleLift(on, 'deeper'), 'wider'), original);
});

test('lifts keep a fixed order whatever order they are chosen in', () => {
  assert.equal(toggleLift(toggleLift('x', 'check'), 'faster'), composeAmbition('x', ['faster', 'check']));
});

test('edited lift text becomes part of the user’s own request', () => {
  const edited = toggleLift('Fix my CV.', 'deeper').replace('high standard', 'very high standard');
  const { base, ids } = splitAmbition(edited);
  assert.deepEqual(ids, []);
  assert.match(base, /very high standard/);
  assert.equal(toggleLift(edited, 'faster'), composeAmbition(base, ['faster']));
});

test('unknown lifts and empty drafts are left alone', () => {
  assert.equal(toggleLift('Hello', 'nonsense'), 'Hello');
  assert.deepEqual(splitAmbition(''), { base: '', ids: [] });
});

test('every idea, follow-up and area is complete and refers to known lifts', () => {
  const areas = IDEA_AREAS.map(([id]) => id);
  for (const idea of IDEAS) {
    assert.ok(areas.includes(idea.area), idea.headline);
    assert.ok(LIFTS.some(item => item.id === idea.lift), idea.headline);
    assert.ok(idea.before && idea.headline && idea.prompt.length > idea.before.length, idea.headline);
  }
  for (const area of areas) assert.equal(IDEAS.filter(idea => idea.area === area).length, 3, `${area} fills one row of cards`);
  assert.equal(new Set(FURTHER.map(item => item.id)).size, FURTHER.length);
});
