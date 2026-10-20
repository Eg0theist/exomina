import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatUploads, uploadName } from '../desktop/chat-uploads.mjs';
import { AssetStore } from '../desktop/assets.mjs';
import { WorkspaceTools } from '../desktop/workspace-tools.mjs';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8QsAAAAASUVORK5CYII=';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'exomina-uploads-')), dataDir = path.join(root, 'data'), settings = { workspace: path.join(root, 'workspace') };
  await mkdir(dataDir); await mkdir(settings.workspace);
  const assets = new AssetStore(dataDir); await assets.init();
  const tools = new WorkspaceTools({ dataDir, getSettings: () => settings, approve: async () => true });
  const uploads = new ChatUploads({ dataDir, assets, workspaceTools: tools }); await uploads.init();
  t.after(async () => { assets.close(); await rm(root, { recursive: true, force: true }); });
  return { uploads, settings, root, dataDir, assets, tools };
}
test('uploaded text stays in the workspace, survives restart, and appears in model context', async t => {
  const f = await fixture(t), attachment = await f.uploads.put({ name: '../../notes.md', dataBase64: Buffer.from('User-selected text').toString('base64') });
  assert.equal(attachment.name, 'notes.md'); assert.equal(attachment.kind, 'file');
  assert.equal(await readFile(path.join(f.settings.workspace, attachment.relativePath), 'utf8'), 'User-selected text');
  const reloaded = new ChatUploads({ dataDir: f.dataDir, assets: f.assets, workspaceTools: f.tools }); await reloaded.init();
  const input = await reloaded.input(reloaded.resolve([attachment.uploadId]));
  assert.match(input.context, /User-selected text/); assert.match(input.context, /source data/); assert.equal(input.images.length, 0);
  assert.throws(() => reloaded.resolve(['toString']), /unavailable/);
  f.settings.workspace = f.root;
  assert.throws(() => reloaded.resolve([attachment.uploadId]), /project folder changed/);
});
test('screenshots reach image input with original pixels and validated metadata', async t => {
  const f = await fixture(t), attachment = await f.uploads.put({ name: 'Screenshot.png', mimeType: 'image/png', dataBase64: png });
  const input = await f.uploads.input(f.uploads.resolve([attachment.uploadId]));
  assert.equal(attachment.kind, 'image'); assert.equal(input.images[0].dataBase64, png); assert.equal(input.images[0].mimeType, 'image/png');
  await assert.rejects(f.uploads.put({ name: 'bad.png', dataBase64: Buffer.from('not pixels').toString('base64') }), /PNG, JPEG/);
});
test('uploads reject invalid data, oversized batches and protected destinations', async t => {
  const f = await fixture(t);
  await assert.rejects(f.uploads.put({ name: 'bad.txt', dataBase64: 'not base64' }), /20 MiB/);
  assert.throws(() => f.uploads.resolve(Array(11).fill('missing')), /10 files/);
  f.settings.workspace = f.dataDir;
  await assert.rejects(f.uploads.put({ name: 'private.txt', dataBase64: 'eA==' }), /account stores/);
  assert.equal(uploadName('CON.txt'), 'file-CON.txt'); assert.equal(uploadName('x?.txt'), 'x_.txt');
});
