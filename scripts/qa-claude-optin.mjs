// Real production host/renderer with a fresh protected QA profile. The real
// opt-in gate and provider.optIn handler run; Claude Code lookup, installation,
// status and sign-in are synthetic. Never installs software or opens accounts.
import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { getProvider } from '../desktop/provider-catalog.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(getProvider('claude')?.optIn, true, 'Run this QA against the shared (beta) catalog.');
const fixture = await createProtectedQaProfile('claude-optin');
const { output, profile } = fixture;
const workspace = path.join(output, 'workspace');
await mkdir(workspace);
const store = new Store(profile, { workspace });
await store.init();
Object.assign(store.state.settings, { autoUpdate: false, autoTitle: false, closeToTray: false, memoryEnabled: false });
await store.save();
const launcher = path.join(output, 'launcher.cjs');
const source = name => JSON.stringify(pathToFileURL(path.join(root, name)).href);
await writeFile(launcher, `const { app, BrowserWindow, dialog, shell } = require('electron');
app.commandLine.appendSwitch('mute-audio');
BrowserWindow.prototype.show = function() {};
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
shell.openExternal = async url => { globalThis.qaClaude.opened.push(url); };
globalThis.qaClaude = { phase: 'missing', connects: [], installs: 0, opened: [], lookups: 0, manager: null };
(async () => {
 const { ProviderManager } = await import(${source('desktop/providers.mjs')});
 const original = ProviderManager.prototype.status;
 ProviderManager.prototype.status = function(options) {
  globalThis.qaClaude.manager = this;
  this.adapters.clear();
  this.getCodex = async () => { throw Error('Codex is not part of this QA.'); };
  return original.call(this, options);
 };
 ProviderManager.prototype.findUserClaude = async function() { globalThis.qaClaude.lookups++; return globalThis.qaClaude.phase === 'missing' ? null : 'C:/synthetic/.local/bin/claude.exe'; };
 ProviderManager.prototype.installClaude = async function() { globalThis.qaClaude.installs++; globalThis.qaClaude.phase = 'installed'; return 'C:/synthetic/.local/bin/claude.exe'; };
 ProviderManager.prototype.claudeStatus = async function() {
  const phase = globalThis.qaClaude.phase;
  if (phase === 'missing') return { installed: false, connected: false, detail: 'Claude Code isn’t installed yet. Press the button to install it from Anthropic and sign in.' };
  return { installed: true, connected: phase === 'connected', detail: phase === 'connected' ? 'Claude subscription connected.' : 'Sign in with your Claude subscription.' };
 };
 ProviderManager.prototype.subscriptionModels = async function() { return this.isProviderEnabled('claude') ? { claude: [{ id: 'default', label: 'Default QA', isDefault: true, efforts: [], speeds: [] }] } : {}; };
 ProviderManager.prototype.claudeUsage = async () => null;
 ProviderManager.prototype.codexUsage = async () => null;
 ProviderManager.prototype.connect = async function(id) {
  this.requireProvider(id);
  globalThis.qaClaude.connects.push(id);
  if (!await this.findUserClaude()) await this.installClaude();
  globalThis.qaClaude.phase = 'pending';
  const result = { url: 'https://claude.ai/oauth/authorize?code=QA-CLAUDE', message: 'Complete the official Claude sign-in, then refresh connections.' };
  this.emit({ type: 'auth.url', provider: id, url: result.url });
  return result;
 };
 await import(${source('desktop/main.mjs')});
})().catch(error => { console.error(error); app.exit(1); });
`);

const report = {
  startedAt: new Date().toISOString(),
  scope: 'Production host and renderer with the real opt-in gate and provider.optIn handler; synthetic Claude Code lookup/install/status/sign-in; no software installed, no credentials, personal profile or provider requests.',
  checks: {}, errors: [], profilePreparation: fixture.report,
};
const settings = page => page.evaluate(async () => (await window.studio.invoke('bootstrap')).settings);
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
  const claude = page.locator('[data-provider="claude"]');
  await claude.getByRole('button', { name: 'Turn on Claude', exact: true }).waitFor();
  assert.equal(await claude.evaluate(el => el.closest('[data-mode]').dataset.mode), 'subscription');
  assert.ok((await claude.innerText()).includes('Off'));
  assert.equal(await app.evaluate(() => globalThis.qaClaude.lookups), 0, 'Nothing is looked up while off.');
  await claude.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'claude-off.png') });
  report.checks.startsOffWithoutTouchingClaudeCode = true;

  await claude.getByRole('button', { name: 'Turn on Claude', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Use your Claude plan in Exomina' });
  await modal.waitFor();
  for (const text of ['What happens when you turn it on', 'Why this is a switch instead of built in', 'Claude Code belongs to Anthropic.', 'Exomina never sees your password']) await modal.getByText(text, { exact: false }).first().waitFor();
  await page.screenshot({ path: path.join(output, 'claude-explanation.png') });
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  assert.equal((await settings(page)).optInProviders?.claude, undefined);
  assert.deepEqual(await app.evaluate(() => globalThis.qaClaude.connects), []);
  report.checks.explanationShownAndCancelChangesNothing = true;

  await claude.getByRole('button', { name: 'Turn on Claude', exact: true }).click();
  await modal.getByRole('button', { name: 'Turn on and sign in', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await page.locator('.provider-auth-banner').getByRole('link', { name: 'Open provider sign-in' }).waitFor();
  assert.equal(await page.locator('.provider-auth-banner').getByRole('link', { name: 'Open provider sign-in' }).getAttribute('href'), 'https://claude.ai/oauth/authorize?code=QA-CLAUDE');
  assert.equal((await settings(page)).optInProviders?.claude, true);
  assert.deepEqual(await app.evaluate(() => globalThis.qaClaude.connects), ['claude']);
  assert.equal(await app.evaluate(() => globalThis.qaClaude.installs), 1);
  report.checks.oneClickInstallsThenOpensAnthropicSignIn = true;

  await app.evaluate(() => { globalThis.qaClaude.phase = 'connected'; globalThis.qaClaude.manager.emit({ type: 'auth.completed', provider: 'claude', success: true }); });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await claude.getByRole('button', { name: 'Manage sign-in', exact: true }).waitFor();
  assert.ok((await claude.innerText()).includes('Connected'));
  await claude.getByRole('switch').waitFor();
  await claude.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'claude-on.png') });
  report.checks.connectedCardShowsOnSwitch = true;

  await claude.getByRole('switch').click();
  await claude.getByRole('button', { name: 'Turn on Claude', exact: true }).waitFor();
  assert.equal((await settings(page)).optInProviders?.claude, false);
  report.checks.switchTurnsItOffAgain = true;
  assert.deepEqual(report.errors, []);
  report.profileProtected = (await fixture.verify()).encrypted;
  report.passed = true;
} catch (error) {
  report.failure = error.message;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'claude-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  await writeFile(path.join(output, 'renderer-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
