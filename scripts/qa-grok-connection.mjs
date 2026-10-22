// Real production host/renderer with fresh protected QA data and synthetic Grok
// status, authorization events and inference. Never opens personal accounts.
import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { PROVIDER_CATALOG } from '../desktop/provider-catalog.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(PROVIDER_CATALOG.some(item => item.id === 'grok' && item.mode === 'subscription'), 'Build the Grok subscription catalog before this QA.');
assert.ok(PROVIDER_CATALOG.some(item => item.id === 'xai' && item.mode === 'api'));
const fixture = await createProtectedQaProfile('grok-connection');
const { output, profile } = fixture;
const workspace = path.join(output, 'workspace');
await mkdir(workspace);
const store = new Store(profile, { workspace });
await store.init();
Object.assign(store.state.settings, { autoUpdate: false, autoTitle: false, closeToTray: false, memoryEnabled: false, provider: 'grok', model: 'auto' });
await store.save();
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lscAAAAASUVORK5CYII=';
const launcher = path.join(output, 'launcher.cjs');
const source = name => JSON.stringify(pathToFileURL(path.join(root, name)).href);
await writeFile(launcher, `const { app, BrowserWindow, dialog, shell } = require('electron');
app.commandLine.appendSwitch('mute-audio');
BrowserWindow.prototype.show = function() {};
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
shell.openExternal = async () => { throw Error('QA cannot open external authorization.'); };
globalThis.qaGrok = { phase: 'signed-out', connects: [], runs: [], configured: [], manager: null };
(async () => {
 const { ProviderManager } = await import(${source('desktop/providers.mjs')});
 const { PROVIDER_CATALOG } = await import(${source('desktop/provider-catalog.mjs')});
 const models = [
  { id: 'grok-4.6', label: 'Grok 4.6 QA', isDefault: true, supportsImages: false, defaultEffort: 'medium', efforts: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }] },
  { id: 'grok-4.5', label: 'Grok 4.5 QA', supportsImages: false, defaultEffort: 'low', efforts: [{ id: 'low', label: 'Low' }] }
 ];
 ProviderManager.prototype.status = async function({ onStatus } = {}) {
  globalThis.qaGrok.manager = this;
  const rows = PROVIDER_CATALOG.filter(item => item.mode === 'subscription').map(item => ({
   id: item.id, installed: true, available: true, checking: false,
   connected: item.id === 'grok' && globalThis.qaGrok.phase === 'connected',
   detail: item.id === 'grok' ? ({ 'signed-out': 'Synthetic Grok account is signed out.', pending: 'Synthetic Grok sign-in pending.', rejected: 'Synthetic Grok sign-in rejected.', connected: 'Synthetic Grok account connected.' }[globalThis.qaGrok.phase]) : 'Synthetic signed-out provider.'
  }));
  for (const row of rows) onStatus?.(row);
  return rows;
 };
 ProviderManager.prototype.subscriptionModels = async () => ({ grok: models });
 ProviderManager.prototype.modelsFor = async id => id === 'grok' ? models : [];
 ProviderManager.prototype.codexUsage = async () => null;
 ProviderManager.prototype.claudeUsage = async () => null;
 ProviderManager.prototype.connect = async function(id) {
  globalThis.qaGrok.connects.push(id);
  if (id !== 'grok') throw Error('Only Grok synthetic authorization is allowed.');
  if (globalThis.qaGrok.phase === 'rejected') throw Error('Synthetic Grok sign-in was rejected. Retry from Connections.');
  globalThis.qaGrok.phase = 'pending';
  const result = { url: 'https://accounts.x.ai/oauth2/device?user_code=QA-GROK', userCode: 'QA-GROK', message: 'Continue synthetic Grok sign-in.' };
  this.emit({ type: 'auth.url', provider: id, ...result });
  return result;
 };
 ProviderManager.prototype.run = async function(request) {
  globalThis.qaGrok.runs.push({ provider: request.provider, model: request.model, effort: request.effort, images: request.images?.length || 0 });
  if (request.provider !== 'grok') throw Error('Only Grok synthetic inference is allowed.');
  if (request.images?.length) throw Error('Grok account runtime does not support image input. Choose an image-capable connection.');
  this.emit({ type: 'chat.delta', conversationId: request.conversationId, text: 'Synthetic Grok account reply.', block: 'grok-answer' });
  return { sessionId: 'synthetic-grok-session', text: 'Synthetic Grok account reply.' };
 };
 await import(${source('desktop/main.mjs')});
})().catch(error => { console.error(error); app.exit(1); });
`);

const report = {
  startedAt: new Date().toISOString(),
  scope: 'Production host and renderer; isolated protected synthetic profile; synthetic Grok authorization/status/models/inference; no credentials, personal profile, external authorization or provider requests. Image-error check verifies renderer presentation, not native adapter enforcement.',
  checks: {}, errors: [], profilePreparation: fixture.report,
};
let app, page;
try {
  const env = { ...process.env, EXOMINA_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [launcher], cwd: root, env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const grok = page.locator('[data-provider="grok"]');
  const xai = page.locator('[data-provider="xai"]');
  await grok.getByRole('button', { name: 'Sign in to Grok', exact: true }).waitFor();
  assert.equal(await grok.evaluate(el => el.closest('[data-mode]').dataset.mode), 'subscription');
  assert.equal(await xai.evaluate(el => el.closest('[data-mode]').dataset.mode), 'api');
  assert.ok((await xai.innerText()).includes('API key required'));
  assert.equal(await grok.locator('input[type="password"]').count(), 0);
  report.checks.accountAndApiAreSeparate = true;

  await grok.getByRole('button', { name: 'Sign in to Grok', exact: true }).click();
  const banner = page.locator('.provider-auth-banner');
  await banner.getByText('Continue Grok sign-in', { exact: true }).waitFor();
  await banner.getByLabel('Sign-in code', { exact: true }).waitFor();
  assert.equal(await banner.getByLabel('Sign-in code', { exact: true }).innerText(), 'QA-GROK');
  assert.equal(await banner.getByRole('link', { name: 'Open provider sign-in' }).getAttribute('href'), 'https://accounts.x.ai/oauth2/device?user_code=QA-GROK');
  await grok.getByText('Synthetic Grok sign-in pending.', { exact: true }).waitFor();
  assert.deepEqual(await app.evaluate(() => globalThis.qaGrok.connects), ['grok']);
  assert.deepEqual(await app.evaluate(() => globalThis.qaGrok.configured), []);
  assert.equal(await page.locator('.provider-setup-modal').count(), 0);
  report.checks.nativeSignInAndPendingCodeBanner = true;

  await app.evaluate(() => { globalThis.qaGrok.phase = 'rejected'; globalThis.qaGrok.manager.emit({ type: 'auth.completed', provider: 'grok', success: false }); });
  await grok.getByText('Synthetic Grok sign-in rejected.', { exact: true }).waitFor();
  await banner.waitFor({ state: 'hidden' });
  await grok.getByRole('button', { name: 'Sign in to Grok', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic Grok sign-in was rejected.' }).waitFor();
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await app.evaluate(() => globalThis.qaGrok.manager.emit({ type: 'auth.url', provider: 'grok', url: 'https://grok.invalid/account', userCode: 'DO-NOT-SHOW' }));
  await page.getByRole('alert').filter({ hasText: /sign-in address/i }).waitFor();
  assert.equal(await page.getByText('DO-NOT-SHOW', { exact: true }).count(), 0);
  assert.equal(await banner.count(), 0);
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  report.checks.rejectedAndUnsupportedAuthAreReported = true;

  await app.evaluate(() => { globalThis.qaGrok.phase = 'connected'; globalThis.qaGrok.manager.emit({ type: 'auth.completed', provider: 'grok', success: true }); });
  await grok.getByRole('button', { name: 'Manage sign-in', exact: true }).waitFor();
  assert.ok((await grok.innerText()).includes('Connected'));
  assert.ok((await xai.innerText()).includes('API key required'));
  await page.screenshot({ path: path.join(output, 'grok-connections.png') });
  report.checks.connectedNativeStatusLeavesXaiApiUntouched = true;

  await page.getByRole('button', { name: 'Exomina home', exact: true }).click();
  await page.getByRole('button', { name: 'Choose AI, model and effort', exact: true }).click();
  await page.getByLabel('AI connection', { exact: true }).selectOption('grok');
  await page.getByRole('option', { name: 'Grok 4.6 QA 2 effort levels' }).click();
  await page.getByRole('radio', { name: 'High', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(async () => {
    const settings = (await window.studio.invoke('bootstrap')).settings;
    return settings.provider === 'grok' && settings.model === 'grok-4.6' && settings.effort === 'high';
  });
  const chosen = await page.evaluate(async () => (await window.studio.invoke('bootstrap')).settings);
  assert.equal(chosen.provider, 'grok');
  assert.equal(chosen.model, 'grok-4.6');
  assert.equal(chosen.effort, 'high');
  await page.getByRole('button', { name: 'Choose AI, model and effort', exact: true }).click();
  await page.getByRole('option', { name: 'Grok 4.5 QA 1 effort levels' }).click();
  await page.getByRole('radio', { name: 'High', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('radio', { name: 'High', exact: true }).count(), 0);
  await page.getByRole('radio', { name: 'Low', exact: true }).click();
  await page.waitForFunction(async () => {
    const settings = (await window.studio.invoke('bootstrap')).settings;
    return settings.model === 'grok-4.5' && settings.effort === 'low';
  });
  await page.keyboard.press('Escape');
  report.checks.reportedModelsAndPerModelEffortsPersist = true;

  await page.getByLabel('Message', { exact: true }).fill('Synthetic Grok text request.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Synthetic Grok account reply.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop this reply', exact: true }).waitFor({ state: 'hidden' });
  const runs = await app.evaluate(() => globalThis.qaGrok.runs);
  assert.equal(runs[0].provider, 'grok');
  assert.equal(runs[0].model, 'grok-4.5');
  assert.equal(runs[0].effort, 'low');
  assert.equal(runs[0].images, 0);
  report.checks.selectedAccountModelAndEffortReachHost = true;

  await page.getByRole('button', { name: 'Voice options', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /Realtime ChatGPT/ }).isEnabled(), false);
  await page.keyboard.press('Escape');
  report.checks.grokDoesNotAdvertiseChatGptRealtime = true;

  await page.locator('input[type="file"]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByRole('button', { name: 'Send message', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /Grok account runtime does not support image input/ }).waitFor();
  report.checks.unsupportedImageFailureIsVisible = true;
  assert.deepEqual(await app.evaluate(() => globalThis.qaGrok.configured), []);
  assert.deepEqual(report.errors, []);
  report.profileProtected = (await fixture.verify()).encrypted;
  report.passed = true;
} catch (error) {
  report.failure = error.message;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'grok-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  await writeFile(path.join(output, 'renderer-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
