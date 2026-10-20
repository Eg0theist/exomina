import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openChatLink, chatFileAction } from '../desktop/chat-link-open.mjs';

async function fixture(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'exomina-chat-link-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
    assert.match(path.basename(workspace), /^exomina-chat-link-/);
    return rm(workspace, { recursive: true, force: true });
  });
  const calls = [], excluded = [];
  const shell = {
    openPath: async file => { calls.push(['folder', file]); return ''; },
    showItemInFolder: file => calls.push(['reveal', file]),
    openExternal: async url => calls.push(['external', url]),
  };
  const clipboard = { writeText: value => calls.push(['clipboard', value]) };
  return { workspace, shell, clipboard, calls, excluded, excludePrivate: async file => excluded.push(file) };
}

test('file links select files in Explorer, including spaces, Unicode, parentheses and line suffixes', async t => {
  const options = await fixture(t), file = path.join(options.workspace, 'Résumé report (final).txt');
  await writeFile(file, 'Synthetic report');
  const urls = [file, file + ':12:3', pathToFileURL(file).href, ...(process.platform === 'win32' ? ['/' + file.replaceAll('\\', '/') + ':12'] : [])];
  for (const url of urls) assert.deepEqual(await openChatLink(url, options), { path: file, action: 'revealed-file' });
  assert.deepEqual(options.calls, urls.map(() => ['reveal', file]));
  assert.equal(options.excluded.length, urls.length * 2);
});

test('folder and relative links open the folder in Explorer', async t => {
  const options = await fixture(t), folder = path.join(options.workspace, 'My folder (2)');
  await mkdir(folder);
  assert.deepEqual(await openChatLink('./My folder (2)', options), { path: folder, action: 'opened-folder' });
  assert.deepEqual(options.calls, [['folder', folder]]);
});

test('executable and shortcut links are revealed without launching their contents', async t => {
  const options = await fixture(t);
  for (const extension of ['exe', 'ps1', 'lnk', 'url']) {
    const file = path.join(options.workspace, 'Synthetic.' + extension);
    await writeFile(file, 'Not an executable');
    await openChatLink(file, options);
    assert.deepEqual(options.calls.at(-1), ['reveal', file]);
  }
  assert.equal(options.calls.some(call => call[0] === 'folder'), false);
});

test('missing files and Explorer failures report errors instead of silently succeeding', async t => {
  const options = await fixture(t);
  await assert.rejects(openChatLink('./missing.txt', options), /This path no longer exists:/);
  assert.deepEqual(options.calls, []);
  options.shell.openPath = async () => 'Windows shell failure';
  await assert.rejects(openChatLink(options.workspace, options), /Explorer could not open this folder: Windows shell failure/);
});

test('private paths are refused before any file or shell access', async t => {
  const options = await fixture(t);
  options.excludePrivate = async () => { throw new Error('Private app data is outside file links.'); };
  await assert.rejects(openChatLink('./missing-private.txt', options), /Private app data/);
  assert.deepEqual(options.calls, []);
});

test('web links retain their route and unsupported links never reach the shell', async t => {
  const options = await fixture(t);
  assert.deepEqual(await openChatLink('https://example.com/report', options), {});
  assert.deepEqual(options.calls, [['external', 'https://example.com/report']]);
  assert.deepEqual(options.excluded, []);
  for (const input of ['javascript:alert(1)', 'data:text/html,test', 'C:/report.txt:stream', 'https://user:pass@example.com']) {
    await assert.rejects(openChatLink(input, options), /not a supported/);
  }
  assert.equal(options.calls.length, 1);
});

test('explicit file actions open the default app or copy the resolved path without line numbers', async t => {
  const options = await fixture(t), file = path.join(options.workspace, 'Report (2).txt');
  await writeFile(file, 'Synthetic report');
  assert.deepEqual(await chatFileAction(file + ':12:3', options, 'copy'), { path: file, action: 'copied-path' });
  assert.deepEqual(options.calls, [['clipboard', file]]);
  assert.deepEqual(await chatFileAction('./Report (2).txt', options, 'open'), { path: file, action: 'opened-file' });
  assert.deepEqual(options.calls.at(-1), ['folder', file]);
  options.shell.openPath = async () => 'No associated app';
  await assert.rejects(chatFileAction(file, options, 'open'), /The default app could not open this file: No associated app/);
});

test('copy remains available for missing files, but open and show require an existing path', async t => {
  const options = await fixture(t), file = path.join(options.workspace, 'gone.txt');
  assert.deepEqual(await chatFileAction('./gone.txt:19', options, 'copy'), { path: file, action: 'copied-path' });
  for (const action of ['open', 'show']) await assert.rejects(chatFileAction('./gone.txt', options, action), /no longer exists/);
  assert.deepEqual(options.calls, [['clipboard', file]]);
  await assert.rejects(chatFileAction(file, options, 'unknown'), /supported file action/);
});

test('all explicit actions retain private-path restrictions', async t => {
  const options = await fixture(t);
  options.excludePrivate = async () => { throw new Error('Private app data'); };
  for (const action of ['show', 'open', 'copy']) await assert.rejects(chatFileAction('./private.txt', options, action), /Private app data/);
  assert.deepEqual(options.calls, []);
});
