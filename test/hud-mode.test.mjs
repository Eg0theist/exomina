import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL('../src/' + name, import.meta.url), 'utf8');

test('Hide HUD styles apply only while the app frame is marked hidden', async () => {
  const css = await read('hud.css');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(rule => rule.split('{')[0].trim()).filter(Boolean).filter(selector => !selector.startsWith('@') && !/^(from|to|\d+%)/.test(selector));
  const unscoped = rules.flatMap(selector => selector.split(',')).map(item => item.trim()).filter(item => item && !item.includes('[data-hud="hidden"]') && !/^(\.hud-|\[data-motion)/.test(item));
  assert.deepEqual(unscoped, []);
  for (const hidden of ['.sidebar', '.topbar', '.composer-toolbar>:not(.send-button)', '.message-actions', '.message-body>.activity']) assert.ok(css.includes(`[data-hud="hidden"] ${hidden}`), hidden);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /\[data-motion="reduced"\]/);
});

test('Hide HUD yields to approvals and other pages while preserving question controls', async () => {
  const app = await read('App.jsx');
  const active = app.match(/const hudActive = ([^;]+);/)?.[1] || '';
  for (const guard of ["page === 'chat'", '!approvals.length', '!pendingConnectorForm', '!taskSetup']) assert.ok(active.includes(guard), guard);
  assert.match(app, /data-hud=\{hudActive \? 'hidden' : undefined\}/);
  assert.match(app, /!modalVisible && !hudActive &&/, 'native browser view hides with the HUD');
  assert.doesNotMatch(app, /HudExit/);
});

test('Hide HUD clears the window bar and chat flair never loops at rest', async () => {
  const css = await read('hud.css'), flair = await read('chat-flair.css'), hud = await read('HudMode.jsx');
  assert.match(css, /\[data-hud="hidden"\] \.window-header\{position:absolute;[^}]*background:transparent!important/);
  assert.match(css, /\[data-hud="hidden"\]\[data-hud-peek\] \.window-header>\*/);
  assert.match(hud, /invoke\('window\.hud', \{ mode \}\)/);
  const looping = flair.split('}').filter(rule => /animation:[^;]*infinite/.test(rule)).map(rule => rule.split('{')[0].trim());
  assert.ok(looping.length > 0);
  for (const selector of looping) assert.match(selector, /is-running|is-streaming|\.stop/, selector);
  const hudLoops = css.split('}').filter(rule => /animation:[^;]*infinite/.test(rule)).map(rule => rule.split('{')[0].trim());
  for (const selector of hudLoops) assert.match(selector, /is-running|is-streaming|\.hud-pulse/, selector);
  assert.match(flair, /prefers-reduced-motion:reduce/);
  assert.match(flair, /\[data-motion="reduced"\]/);
});
