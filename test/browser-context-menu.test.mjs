import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { browserContextMenuTemplate, attachBrowserContextMenu } from '../desktop/browser-context-menu.mjs';

function fixture(params = {}) {
  const calls = [], wc = new EventEmitter();
  Object.assign(wc, {
    isDestroyed: () => false, getURL: () => 'https://example.test/page', isLoading: () => false,
    navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: () => calls.push('back'), goForward: () => calls.push('forward') },
    session: { addWordToSpellCheckerDictionary: word => calls.push(['dictionary', word]) },
  });
  for (const method of ['focus', 'undo', 'redo', 'copy', 'cut', 'paste', 'selectAll', 'reload', 'stop', 'copyImageAt', 'replaceMisspelling']) wc[method] = (...args) => calls.push([method, ...args]);
  const options = { clipboard: { writeText: text => calls.push(['clipboard', text]) }, navigate: url => calls.push(['navigate', url]), openExternal: url => calls.push(['external', url]) };
  const items = browserContextMenuTemplate(wc, params, options);
  return { calls, wc, options, items, item: label => items.find(item => item.label === label) };
}

test('context menu edits the clicked browser contents and respects native edit flags', () => {
  const f = fixture({ isEditable: true, editFlags: { canUndo: true, canRedo: false, canCopy: true, canPaste: true, canCut: false } });
  assert.equal(f.item('Undo').enabled, true); assert.equal(f.item('Redo').enabled, false); assert.equal(f.item('Cut').enabled, false);
  for (const label of ['Copy', 'Paste', 'Select all']) f.item(label).click();
  assert.deepEqual(f.calls, [['focus'], ['copy'], ['focus'], ['paste'], ['focus'], ['selectAll']]);
  assert.ok(f.items.every(item => !item.role));
});

test('navigation and link actions stay with the clicked page; non-web links can only be copied', () => {
  const f = fixture({ linkURL: 'https://example.test/target' });
  assert.equal(f.item('Back').enabled, true); assert.equal(f.item('Forward').enabled, false);
  for (const label of ['Back', 'Reload', 'Open link', 'Open link in default browser', 'Copy link address']) f.item(label).click();
  assert.deepEqual(f.calls, ['back', ['reload'], ['navigate', 'https://example.test/target'], ['external', 'https://example.test/target'], ['clipboard', 'https://example.test/target']]);
  for (const url of ['javascript:alert(1)', 'file:///C:/private.txt', 'https://user:secret@example.test/', 'mailto:person@example.test']) {
    const unsafe = fixture({ linkURL: url });
    assert.equal(unsafe.item('Open link'), undefined); assert.equal(unsafe.item('Open link in default browser'), undefined);
    unsafe.item('Copy link address').click(); assert.deepEqual(unsafe.calls, [['clipboard', url]]);
  }
});

test('image copying uses the clicked image coordinates and never opens blob or data URLs externally', () => {
  const f = fixture({ mediaType: 'image', hasImageContents: true, srcURL: 'blob:https://example.test/fixture', x: 12, y: 34 });
  f.item('Copy image').click(); f.item('Copy image address').click();
  assert.deepEqual(f.calls, [['focus'], ['copyImageAt', 12, 34], ['clipboard', 'blob:https://example.test/fixture']]);
  assert.equal(f.item('Open image'), undefined);
  assert.equal(fixture({ mediaType: 'image', hasImageContents: false }).item('Copy image'), undefined);
});

test('native popup handles rejected actions, ignores hidden or closed pages, and detaches on close', async () => {
  const f = fixture(), popups = [], errors = [];
  let visible = true, template;
  const options = { ...f.options, navigate: async () => { throw Error('Synthetic navigation failure'); },
    window: {}, isVisible: () => visible, onError: error => errors.push(error.message),
    Menu: { buildFromTemplate(items) { template = items; return { popup: options => popups.push(options), closePopup: () => popups.push('closed') }; } },
  };
  const detach = attachBrowserContextMenu(f.wc, options);
  f.wc.emit('context-menu', {}, { linkURL: 'https://example.test/target' });
  assert.deepEqual(popups[0], { window: options.window });
  const click = template.find(item => item.label === 'Open link').click;
  click(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(errors, ['Synthetic navigation failure']);
  visible = false; click(); f.wc.emit('context-menu', {}, {});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(errors.length, 1); assert.equal(popups.length, 1);
  detach(); assert.equal(f.wc.listenerCount('context-menu'), 0); assert.equal(popups.at(-1), 'closed');
});
