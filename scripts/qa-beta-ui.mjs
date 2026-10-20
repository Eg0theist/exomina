// Shareable beta: exact executable first-run gate, then exact packaged host and
// renderer under a protected synthetic fixture with forbidden sign-in/inference.
import { _electron as electron, chromium } from 'playwright';
import { listPackage } from '@electron/asar';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = path.resolve(process.env.EXOMINA_QA_WORKSPACE || path.join(root, '../Workspace'));
const executable = path.resolve(process.env.EXOMINA_QA_EXE || process.argv[2] || path.join(root, 'release/win-unpacked/Exomina.exe'));
const packagePath = path.join(path.dirname(executable), 'resources/app.asar');
const packageRoot = packagePath;
const output = await mkdtemp(path.join(work, 'qa-beta-ui-'));
assert.equal(path.dirname(output), work);
const report = {
  executable, packagePath, startedAt: new Date().toISOString(),
  buildStamp: JSON.parse(await readFile(path.join(path.dirname(executable), 'exomina.build.json'), 'utf8')),
  scope: 'Exact beta executable with an intentionally encrypted, empty legacy fixture lacking a recovery record. Protected second fixture loads exact packaged host/renderer through the production Electron launcher, with synthetic account/model/voice metadata; no account authorization, model inference, recovery export, microphone capture or external navigation.',
  checks: {}, errors: [],
};
let child, browser, launched, page;

async function killChild() {
  if (!child || child.exitCode !== null) { child = null; return; }
  const pid = child.pid;
  const killer = spawn(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  await new Promise(resolve => { killer.once('close', resolve); killer.once('error', resolve); });
  child = null;
}
async function launchFirstRun(profile) {
  const env = { ...process.env, EXOMINA_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--mute-audio'], { cwd: path.dirname(executable), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(Error('Beta first-run debugging endpoint did not start.')), 30000);
    child.stderr.on('data', chunk => {
      buffer = (buffer + chunk.toString()).slice(-16000);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); reject(Error('Beta first-run process exited ' + code)); });
  });
  child.stdout.resume();
  browser = await chromium.connectOverCDP(endpoint);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().endsWith('/dist/index.html'));
    if (page) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Beta first-run app page did not load.');
}

try {
  const entries = listPackage(packagePath);
  assert.ok(!entries.some(name => /(?:theme-art[\/]|voice-previews[\/]|voice-previews-clear[\/]|claude-voice-previews[\/]|voice-preview-clips-personal\.js|theme-catalog-full\.mjs)/i.test(name)));
  assert.ok(!entries.some(name => /[\/](?:[^\/]+\.(?:wav|mp3))$/i.test(name)), 'The beta must not ship provider recordings.');
  report.checks.protectedThemeAndVoiceAssetsAbsent = true;

  const firstProfile = path.join(output, 'first-run-data');
  await mkdir(firstProfile);
  assert.deepEqual(await readdir(firstProfile), []);
  await promisify(execFile)(path.join(process.env.SystemRoot, 'System32/cipher.exe'), ['/e', firstProfile], { windowsHide: true });
  await launchFirstRun(firstProfile);
  page.on('pageerror', error => report.errors.push(error.message));
  page.setDefaultTimeout(20000);
  await page.getByRole('heading', { name: /Protect your workspace|Check data protection/ }).waitFor();
  const security = await page.evaluate(() => window.studio.invoke('security.status'));
  assert.equal(security.protected, false);
  assert.equal(security.needsRecovery, true);
  assert.equal(await page.getByLabel('Message', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Connections', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Protect and restart', exact: true }).isEnabled(), false);
  const blocked = await page.evaluate(async () => {
    const results = {};
    for (const [method, payload] of [['bootstrap', {}], ['provider.connect', { provider: 'codex' }], ['chat.send', { text: 'Synthetic blocked request.', provider: 'codex' }]]) {
      try { await window.studio.invoke(method, payload); results[method] = 'UNEXPECTED_SUCCESS'; }
      catch (error) { results[method] = error.message; }
    }
    return results;
  });
  for (const message of Object.values(blocked)) assert.match(message, /Local app storage must be ready before opening chats or connecting accounts/);
  assert.deepEqual((await readdir(firstProfile)).filter(name => name !== 'lockfile'), [], 'First-run setup may own its Electron lock file but must not open chat or account stores.');
  report.checks.firstLaunchBlocksChatAndAccounts = { exactExecutable: true, securitySupported: security.supported, blockedMethods: Object.keys(blocked), recoveryExportAttempted: false };
  await page.screenshot({ path: path.join(output, 'beta-first-launch.png') });
  await browser.close(); browser = null; await killChild(); page = null;

  const fixture = await createProtectedQaProfile('beta-protected-ui');
  const { profile } = fixture;
  report.profilePreparation = fixture.report;
  const workspace = path.join(fixture.output, 'workspace'); await mkdir(workspace);
  const store = new Store(profile, { workspace }); await store.init();
  Object.assign(store.state.settings, { provider: 'codex', model: 'auto', autoUpdate: false, autoTitle: false, closeToTray: false, memoryEnabled: false });
  await store.save();
  const packaged = name => JSON.stringify(pathToFileURL(path.join(packageRoot, name)).href);
  const launcher = path.join(output, 'protected-launcher.cjs');
  await writeFile(launcher, `const { app, BrowserWindow, dialog, shell } = require('electron');
app.commandLine.appendSwitch('mute-audio');
BrowserWindow.prototype.show = function() {};
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
globalThis.qaBeta = { connects: [], runs: [], external: [], voiceCalls: [] };
shell.openExternal = async url => { globalThis.qaBeta.external.push(url); throw Error('QA external navigation is prohibited.'); };
(async () => {
 const { ProviderManager } = await import(${packaged('desktop/providers.mjs')});
 const { PROVIDER_CATALOG } = await import(${packaged('desktop/provider-catalog.mjs')});
 const { WindowsVoice } = await import(${packaged('desktop/voice.mjs')});
 const models = [{ id: 'synthetic-chatgpt', label: 'Synthetic ChatGPT', isDefault: true, supportsImages: false, defaultEffort: 'low', efforts: [{ id: 'low', label: 'Low' }] }];
 ProviderManager.prototype.status = async function({ onStatus } = {}) {
  const rows = PROVIDER_CATALOG.filter(item => item.mode === 'subscription').map(item => ({ id: item.id, installed: true, available: true, checking: false, connected: item.id === 'codex', detail: item.id === 'codex' ? 'Synthetic connected ChatGPT.' : 'Synthetic signed-out provider.' }));
  for (const row of rows) onStatus?.(row); return rows;
 };
 ProviderManager.prototype.subscriptionModels = async () => ({ codex: models });
 ProviderManager.prototype.modelsFor = async id => id === 'codex' ? models : [];
 ProviderManager.prototype.codexUsage = async () => null;
 ProviderManager.prototype.claudeUsage = async () => null;
 ProviderManager.prototype.connect = async id => { globalThis.qaBeta.connects.push(id); throw Error('QA account authorization is prohibited.'); };
 ProviderManager.prototype.run = async request => { globalThis.qaBeta.runs.push(request.provider); throw Error('QA inference is prohibited.'); };
 ProviderManager.prototype.getCodex = async () => ({ request: async (method, payload) => { globalThis.qaBeta.voiceCalls.push(method); if(method === 'thread/realtime/listVoices')return { voices: { v1: ['juniper', 'futurevoice'], defaultV1: 'juniper' } }; throw Error('QA native voice session start is prohibited.'); } });
 WindowsVoice.prototype.status = async () => ({ available: true, recognizers: [], voices: [] });
 await import(${packaged('desktop/main.mjs')});
})().catch(error => { console.error(error); app.exit(1); });
`);
  const env = { ...process.env, EXOMINA_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  launched = await electron.launch({ args: [launcher], cwd: root, env, timeout: 30000 });
  page = await launched.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.locator('[data-provider="codex"]').waitFor();
  // Claude is an opt-in that uses the user's own Claude Code; it must start off.
  await page.locator('[data-provider="claude"]').getByRole('button', { name: 'Turn on Claude', exact: true }).waitFor();
  assert.equal(await page.locator('[data-provider="anthropic-api"]').count(), 1);
  report.checks.betaProviderSelectionIsHonest = true;
  await page.getByRole('button', { name: /^Settings(?:\s+v|$)/ }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const themeNames = await page.locator('#settings-appearance .theme-card strong').allTextContents();
  assert.deepEqual([...themeNames].sort(), ['Verdigris', 'Graphite', 'Midnight', 'Paper', 'Daylight', 'High contrast', 'Match Windows'].sort());
  await page.getByText('Want a different look? Ask Exomina in chat to help design your own theme.', { exact: true }).waitFor();
  await page.getByRole('radio').filter({ has: page.getByText('Graphite', { exact: true }) }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'graphite');
  report.checks.sixStandardThemesWindowsAndDesignHint = { names: themeNames };
  await page.screenshot({ path: path.join(output, 'beta-appearance.png') });
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  await page.getByText('Beta updates', { exact: true }).waitFor();
  assert.equal(await page.getByRole('switch', { name: 'Download updates automatically', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Release feed address', { exact: true }).count(), 0);
  report.checks.manualBetaUpdates = true;
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('button', { name: 'Load ChatGPT voices', exact: true }).click();
  const realtime = page.getByLabel('ChatGPT realtime voice', { exact: true });
  await realtime.waitFor(); assert.equal(await realtime.isEnabled(), true);
  await realtime.selectOption('futurevoice');
  await page.waitForFunction(async () => (await window.studio.invoke('bootstrap')).settings.voice.realtimeVoice === 'futurevoice');
  assert.equal(await page.getByRole('button', { name: 'Preview realtime voice', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('ChatGPT sample sound', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Claude voice sample', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Play test tone', exact: true }).count(), 1);
  await page.getByText('Voice previews are not built in.', { exact: false }).first().waitFor();
  await page.getByText('Why aren’t they built in?', { exact: true }).waitFor();
  report.checks.recordedControlsHiddenNativeVoicePersists = true;
  await page.screenshot({ path: path.join(output, 'beta-voice.png') });

  // One click copies the recordings from this host's own Codex/Claude program folders into the synthetic profile only.
  const addButton = page.getByRole('button', { name: 'Add voice previews', exact: true });
  await addButton.click();
  await page.getByText(/voice previews are on this computer|could not find the Codex or Claude/).first().waitFor();
  const samples = await page.evaluate(() => window.studio.invoke('voice.samples.status'));
  const playing = () => page.getByText('Playing voice preview. Microphone off.').first().waitFor();
  if (samples.imported) {
    assert.ok(samples.chatgpt.includes('juniper'), 'The installed Codex app provides ChatGPT voice recordings.');
    await page.getByRole('button', { name: 'Update from my apps', exact: true }).waitFor();
    await page.getByLabel('ChatGPT sample sound', { exact: true }).waitFor();
    await realtime.selectOption('juniper');
    await page.getByRole('button', { name: 'Preview realtime voice', exact: true }).click();
    await playing();
    await page.getByRole('button', { name: 'Stop realtime preview', exact: true }).click();
    await page.getByLabel('ChatGPT sample sound', { exact: true }).selectOption('original');
    await page.getByRole('button', { name: 'Preview realtime voice', exact: true }).click();
    await playing();
    await page.getByRole('button', { name: 'Stop realtime preview', exact: true }).click();
    if (samples.claude.length) {
      await page.getByLabel('Claude voice sample', { exact: true }).selectOption(samples.claude[0]);
      await page.getByRole('button', { name: 'Preview Claude voice', exact: true }).click();
      await playing();
      await page.getByRole('button', { name: 'Stop Claude preview', exact: true }).click();
    }
    await realtime.selectOption('futurevoice');
    await page.getByRole('button', { name: 'Preview realtime voice', exact: true }).click();
    await page.getByText('No preview recording is available for this voice.', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'beta-voice-previews.png') });
    // The same previews are offered in the chat voice menu.
    await page.getByRole('button', { name: 'Exomina home', exact: true }).click();
    await page.getByRole('button', { name: 'Voice options', exact: true }).click();
    await page.getByRole('button', { name: 'Preview realtime voice', exact: true }).waitFor();
    if (samples.claude.length) await page.getByLabel('Claude voice sample', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Settings(?:\s+v|$)/ }).click();
    await page.getByRole('button', { name: 'Voice', exact: true }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByText('Voice previews removed.', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.studio.invoke('voice.samples.status'))).imported, false);
    assert.equal(await page.getByRole('button', { name: 'Preview realtime voice', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Claude voice sample', { exact: true }).count(), 0);
    report.checks.voicePreviewsImportedPlayedAndRemoved = { chatgpt: samples.chatgpt.length, claude: samples.claude.length, clear: samples.clear, sources: samples.sources };
  } else {
    await page.getByRole('button', { name: 'choose its folder', exact: true }).waitFor();
    report.checks.voicePreviewsReportMissingApps = true;
  }
  await page.getByRole('button', { name: 'Exomina home', exact: true }).click();
  await page.getByRole('button', { name: 'Voice options', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /Realtime ChatGPT/ }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Preview realtime voice', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Claude voice sample', { exact: true }).count(), 0);
  // Without previews the chat voice menu points to the one place where they are added.
  await page.getByRole('button', { name: 'Add them in Settings → Voice', exact: true }).click();
  await page.getByRole('button', { name: /Add voice previews|Looking for the apps/ }).waitFor();
  report.checks.chatVoiceControlsMatchBeta = true;
  const activity = await launched.evaluate(() => globalThis.qaBeta);
  assert.deepEqual(activity.connects, []); assert.deepEqual(activity.runs, []); assert.deepEqual(activity.external, []);
  assert.ok(activity.voiceCalls.every(method => method === 'thread/realtime/listVoices'));
  report.checks.noAuthInferenceOrCapture = { ...activity, physicalMicrophoneUsed: false, recordedPlaybackAttempted: Boolean(samples.imported), audioMuted: true };
  report.profileProtected = (await fixture.verify()).encrypted;
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.message; process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'beta-failure.png') }).catch(() => {});
} finally {
  if (launched) await launched.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await killChild();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
