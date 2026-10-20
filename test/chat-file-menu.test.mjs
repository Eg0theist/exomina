import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { showChatFileMenu } from '../desktop/chat-file-menu.mjs';

async function fixture(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'exomina-file-menu-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
    assert.match(path.basename(workspace), /^exomina-file-menu-/);
    return rm(workspace, { recursive: true, force: true });
  });
  const file = path.join(workspace, 'Report (spaces).txt'); await writeFile(file, 'Synthetic report');
  const state = { calls: [], templates: [] }, window = new EventEmitter();
  window.isDestroyed = () => false; window.getContentBounds = () => ({ width: 900, height: 700 });
  const options = { workspace, window, x: 122.6, y: 240.1, excludePrivate: async () => { if (state.private) throw new Error('Private path'); },
    shell: { showItemInFolder: file => state.calls.push(['show', file]), openPath: async file => { state.calls.push(['open', file]); return ''; } },
    clipboard: { writeText: text => state.calls.push(['copy', text]) },
    Menu: { buildFromTemplate: template => { state.templates.push(template); return { popup: value => { state.popup = value; }, closePopup: () => { state.closed = true; } }; } },
  };
  return { state, options, file };
}
async function ready(state) {
  const deadline = Date.now() + 5000;
  while (!state.popup && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(state.popup);
}

test('native file menu has the three requested actions and executes each choice once', async t => {
  for (const [index, call, outcome] of [[0, 'show', 'revealed-file'], [1, 'open', 'opened-file'], [2, 'copy', 'copied-path']]) {
    const { state, options, file } = await fixture(t), result = showChatFileMenu(file + ':12:3', options);
    await ready(state);
    assert.deepEqual(state.templates[0].map(item => item.label), ['Show in Explorer', 'Open with default app', 'Copy path']);
    assert.equal(state.popup.window, options.window); assert.equal(state.popup.x, 123); assert.equal(state.popup.y, 240);
    const pending = state.templates[0][index].click(); state.popup.callback();
    await pending;
    assert.deepEqual(await result, { path: file, action: outcome });
    await state.templates[0][index].click(); assert.deepEqual(state.calls, [[call, file]]);
    assert.equal(options.window.listenerCount('closed'), 0);
  }
});

test('dismissing a native menu or closing its owner does not act on the file', async t => {
  for (const closeWindow of [false, true]) {
    const { state, options, file } = await fixture(t), result = showChatFileMenu(file, options);
    await ready(state);
    if (closeWindow) options.window.emit('closed'); else state.popup.callback();
    assert.deepEqual(await result, { cancelled: true }); assert.deepEqual(state.calls, []);
    assert.equal(options.window.listenerCount('closed'), 0);
  }
});

test('missing file menus disable opening while preserving copy path', async t => {
  const { state, options } = await fixture(t), file = path.join(options.workspace, 'gone.txt');
  const result = showChatFileMenu(file, options); await ready(state);
  assert.equal(state.templates[0][0].enabled, false); assert.equal(state.templates[0][1].enabled, false);
  await state.templates[0][2].click(); assert.deepEqual(await result, { path: file, action: 'copied-path' });
});

test('a chosen action rechecks privacy before accessing the file', async t => {
  const { state, options, file } = await fixture(t), result = showChatFileMenu(file, options);
  await ready(state);
  state.private = true;
  const rejected = assert.rejects(result, /Private path/);
  await state.templates[0][1].click(); state.popup.callback(); await rejected;
  assert.deepEqual(state.calls, []);
});

test('default-app failures are returned after the popup closes', async t => {
  const { state, options, file } = await fixture(t), result = showChatFileMenu(file, options);
  await ready(state);
  options.shell.openPath = async () => 'Default app failed';
  const rejected = assert.rejects(result, /Default app failed/);
  await state.templates[0][1].click(); state.popup.callback(); await rejected;
  assert.deepEqual(state.calls, []);
});

test('private and non-file paths cannot create a native file menu', async t => {
  const { state, options, file } = await fixture(t);
  options.excludePrivate = async () => { throw new Error('Private path'); };
  await assert.rejects(showChatFileMenu(file, options), /Private path/);
  await assert.rejects(showChatFileMenu('https://example.com', options), /local file or folder/);
  assert.deepEqual(state.templates, []); assert.deepEqual(state.calls, []);
});
