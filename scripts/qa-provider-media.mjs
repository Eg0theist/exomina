// Real host and renderer with isolated test data and synthetic provider output.
// Native protocol and permission handling are covered by the adapter tests.
import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await createProtectedQaProfile('provider-media');
const { output, profile } = fixture, workspace = path.join(output, 'workspace');
await mkdir(workspace);
// Exomina's explicit data-dir override isolates all host data. Keep Windows
// KnownFolder environment paths intact so Electron can initialize normally.
// Provider methods below are replaced before the host starts any connections.
const environment = { ...process.env, EXOMINA_DATA_DIR: profile,
  TEMP: output, TMP: output, TMPDIR: output };
for (const key of Object.keys(environment)) if (/(?:token|secret|password|api_?key|credential|authorization)/i.test(key)) delete environment[key];
delete environment.ELECTRON_RUN_AS_NODE;
const videoPath = path.join(output, 'synthetic.mp4');
await promisify(execFile)(process.env.EXOMINA_QA_FFMPEG || 'ffmpeg',
  ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', videoPath],
  { cwd: output, env: environment, windowsHide: true, timeout: 15000 });
const video = await readFile(videoPath), png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lscAAAAASUVORK5CYII=';
const store = new Store(profile, { workspace });
await store.init();
Object.assign(store.state.settings, { workspace, autoUpdate: false, autoTitle: false,
  closeToTray: false, memoryEnabled: false, provider: 'grok', model: 'auto' });
await store.save();
const launcher = path.join(output, 'launcher.cjs');
const moduleUrl = name => JSON.stringify(pathToFileURL(path.join(root, name)).href);
await writeFile(launcher, `const { app, BrowserWindow, dialog, shell } = require('electron');
app.commandLine.appendSwitch('mute-audio');
BrowserWindow.prototype.show = function() {};
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
shell.openExternal = async () => { throw Error('External requests are prohibited during test QA.'); };
globalThis.qaMedia = { runs: [], saves: [] };
dialog.showSaveDialog = async (_window, options) => {
  const filePath = require('node:path').join(${JSON.stringify(output)}, options.defaultPath);
  globalThis.qaMedia.saves.push(options);
  return { canceled: false, filePath };
};
(async () => {
  const { ProviderManager } = await import(${moduleUrl('desktop/providers.mjs')});
  const { PROVIDER_CATALOG } = await import(${moduleUrl('desktop/provider-catalog.mjs')});
  const models = [{ id: 'grok-synthetic', label: 'Synthetic Grok', isDefault: true, supportsImages: true, efforts: [] }];
  ProviderManager.prototype.status = async function({ onStatus } = {}) {
    const rows = PROVIDER_CATALOG.filter(item => item.mode === 'subscription').map(item => ({
      id: item.id, installed: true, connected: item.id === 'grok', checking: false,
      detail: 'Synthetic provider status, no sign-in or inference.',
      ...(item.id === 'grok' ? { imageGeneration: { supported: true, enabled: true, available: true, detail: 'Synthetic Imagine capability.' }, supportsImages: true } : {})
    }));
    for (const row of rows) onStatus?.(row);
    return rows;
  };
  ProviderManager.prototype.subscriptionModels = async () => ({ grok: models });
  ProviderManager.prototype.modelsFor = async id => id === 'grok' ? models : [];
  ProviderManager.prototype.codexUsage = async () => null;
  ProviderManager.prototype.claudeUsage = async () => null;
  ProviderManager.prototype.connect = async () => { throw Error('Sign-in is prohibited during test QA.'); };
  ProviderManager.prototype.run = async function(request) {
    if (request.provider !== 'grok') throw Error('Only synthetic Grok output is allowed.');
    globalThis.qaMedia.runs.push({ provider: request.provider, images: request.images?.length || 0 });
    this.emit({ type: 'chat.delta', conversationId: request.conversationId, text: 'Synthetic image and video ready.' });
    this.emit({ type: 'chat.media.generated', provider: 'grok', conversationId: request.conversationId, mimeType: 'image/png', dataBase64: ${JSON.stringify(png)} });
    this.emit({ type: 'chat.media.generated', provider: 'grok', conversationId: request.conversationId, mimeType: 'video/mp4', dataBase64: ${JSON.stringify(video.toString('base64'))} });
    return { text: 'Synthetic image and video ready.', sessionId: 'synthetic-media-session' };
  };
  await import(${moduleUrl('desktop/main.mjs')});
})().catch(error => { console.error(error); app.exit(1); });
`);

const report = { scope: 'Production host/renderer, synthetic provider events, real MP4 playback, isolated profile. No provider sign-in, entitlement checks or live inference.', output, checks: {}, errors: [] };
let app, page;
async function open() {
  app = await electron.launch({ args: [launcher], cwd: root, env: environment, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
}
async function checkMedia() {
  await page.locator('.message-image img').waitFor();
  await page.waitForFunction(() => document.querySelector('.message-image img')?.naturalWidth === 1);
  await page.locator('.message-image video').waitFor();
  await page.waitForFunction(() => { const v = document.querySelector('.message-image video'); return v && v.readyState >= 1 && v.videoWidth === 320 && v.duration > 0; });
  await page.locator('.message-image video').evaluate(video => video.play());
  await page.waitForFunction(() => document.querySelector('.message-image video').currentTime > 0);
  await page.locator('.message-image video').evaluate(video => video.pause());
}
try {
  await open();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.locator('[data-provider="grok"]').getByText('Imagine images & videos', { exact: true }).waitFor();
  report.checks.grokCapabilityVisible = true;
  await page.getByRole('button', { name: 'Exomina home', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Create synthetic media fixtures.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Synthetic image and video ready.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop this reply', exact: true }).waitFor({ state: 'hidden' });
  await checkMedia(); report.checks.imageDisplayAndVideoPlayback = true;
  await page.getByRole('button', { name: 'Save video', exact: true }).click();
  await page.getByText(`Saved to ${path.join(output, 'Exomina-video.mp4')}`, { exact: true }).waitFor();
  assert.deepEqual(await readFile(path.join(output, 'Exomina-video.mp4')), video);
  assert.equal((await app.evaluate(() => globalThis.qaMedia.saves))[0].title, 'Save video');
  report.checks.videoSave = true;
  const before = await page.evaluate(() => window.studio.invoke('bootstrap'));
  const chat = before.conversations.find(item => item.messages.some(m => m.content === 'Synthetic image and video ready.'));
  assert.deepEqual(chat.messages.at(-1).attachments.map(a => a.kind), ['image', 'video']);
  assert.ok(!JSON.stringify(before).includes(video.toString('base64')));
  await page.screenshot({ path: path.join(output, 'media-chat.png') });
  await app.close(); app = null;
  await open();
  await page.locator(`[data-chat-id="${chat.id}"] .chat-open`).click();
  await checkMedia();
  report.checks.persistedMediaAfterRestart = true;
  assert.deepEqual(await app.evaluate(() => globalThis.qaMedia.runs), []);
  assert.deepEqual(report.errors, []);
  report.profileProtection = await fixture.verify();
  report.passed = true;
} catch (error) {
  report.failure = error.stack || error.message; process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'media-failure.png') }).catch(() => {});
} finally {
  if (app) await app.close().catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
