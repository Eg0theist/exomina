// Production IPC and native confirmation with synthetic credits only. Never redeems live credits.
import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT || root).replace(/app\.asar\.unpacked$/i, 'app.asar');
const fixture = await createProtectedQaProfile('reset-selection');
const { profile, output } = fixture;
const store = new Store(profile); await store.init();
Object.assign(store.state.settings, { autoUpdate: false, autoTitle: false, closeToTray: false, memoryEnabled: false, chatMemoryEnabled: false, chatMemorySummaries: false, browserEnabled: false });
await store.save();
const now = Math.floor(Date.now() / 1000);
const credits = [
  { id: 'synthetic-later', title: 'Later synthetic credit', status: 'available', resetType: 'codexRateLimits', grantedAt: now - 100, expiresAt: now + 86400 * 7 },
  { id: 'synthetic-soon', title: 'Sooner synthetic credit', status: 'available', resetType: 'codexRateLimits', grantedAt: now - 100, expiresAt: now + 86400 },
  { id: 'synthetic-expired', title: 'Expired synthetic credit', status: 'available', resetType: 'codexRateLimits', grantedAt: now - 100, expiresAt: now - 1 }
];
const moduleUrl = name => JSON.stringify(pathToFileURL(path.join(runtimeRoot, name)).href);
const launcher = path.join(output, 'launcher.cjs');
await writeFile(launcher, `const { app, BrowserWindow, dialog, session } = require('electron');
app.commandLine.appendSwitch('mute-audio');
BrowserWindow.prototype.show = function() {};
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
globalThis.qaReset = { count: 2, credits: ${JSON.stringify(credits)}, consume: [], confirmations: [], confirmation: 0, failNext: false, outcome: 'reset', connects: [], runs: [] };
dialog.showMessageBox = async (_owner, options) => {
 if (options.title !== 'Use a ChatGPT usage reset?') throw Error('Unexpected QA dialog: ' + options.title);
 globalThis.qaReset.confirmations.push(options); return { response: globalThis.qaReset.confirmation };
};
(async () => {
 await app.whenReady();
 session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
 const { ProviderManager } = await import(${moduleUrl('desktop/providers.mjs')});
 const { PROVIDER_CATALOG } = await import(${moduleUrl('desktop/provider-catalog.mjs')});
 ProviderManager.prototype.status = async function({ onStatus } = {}) {
  const rows = PROVIDER_CATALOG.filter(item => item.mode === 'subscription').map(item => ({ id: item.id, installed: true, connected: item.id === 'codex', available: true, checking: false, detail: 'Synthetic usage connection only.' }));
  for (const row of rows) onStatus?.(row); return rows;
 };
 ProviderManager.prototype.subscriptionModels = async () => ({});
 ProviderManager.prototype.modelsFor = async () => [];
 ProviderManager.prototype.codexUsage = async ({ details = false } = {}) => ({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: ${now + 3600} } }, rateLimitResetCredits: { availableCount: globalThis.qaReset.count, credits: details ? globalThis.qaReset.credits : null } });
 ProviderManager.prototype.claudeUsage = async () => null;
 ProviderManager.prototype.consumeCodexReset = async (key, creditId) => {
  globalThis.qaReset.consume.push({ key, creditId });
  if (globalThis.qaReset.failNext) { globalThis.qaReset.failNext = false; throw Error('Synthetic reply lost'); }
  return { outcome: globalThis.qaReset.outcome };
 };
 ProviderManager.prototype.connect = async id => { globalThis.qaReset.connects.push(id); throw Error('QA sign-in prohibited.'); };
 ProviderManager.prototype.run = async request => { globalThis.qaReset.runs.push(request.provider); throw Error('QA model requests prohibited.'); };
 await import(${moduleUrl('desktop/main.mjs')});
})().catch(error => { console.error(error); app.exit(1); });
`);
const env = { ...process.env, EXOMINA_DATA_DIR: profile, TEMP: output, TMP: output, TMPDIR: output };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/(?:token|secret|password|api_?key|credential|authorization)/i.test(key)) delete env[key];
const report = { runtimeRoot, output, scope: 'Hidden production host and renderer; synthetic usage and consumption only, fresh protected profile, no account sign-in or model calls.', checks: {}, errors: [] };
let app, page;
const invoke = (method, payload = {}) => page.evaluate(({ method, payload }) => window.studio.invoke(method, payload), { method, payload });
const state = () => app.evaluate(() => structuredClone(globalThis.qaReset));
try {
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [launcher], cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
  await page.waitForFunction(async () => (await window.studio.invoke('bootstrap')).connections.some(item => item.id === 'codex' && item.connected));
  const usage = await invoke('usage.refresh', { details: true });
  assert.equal(usage.codex.resetCredits.credits[0].id, 'synthetic-soon');
  report.checks.realUsageDetailsSorted = true;
  assert.equal((await invoke('usage.resetCredit', { provider: 'codex', creditId: 'synthetic-later' })).outcome, 'cancelled');
  let activity = await state(); assert.equal(activity.consume.length, 0); assert.match(activity.confirmations[0].detail, /Later synthetic credit.*Expires/); assert.equal(activity.confirmations[0].defaultId, 0); assert.equal(activity.confirmations[0].cancelId, 0);
  report.checks.confirmationShowsExactChoiceAndCancelSpendsNothing = true;
  await app.evaluate(() => { globalThis.qaReset.confirmation = 1; });
  assert.equal((await invoke('usage.resetCredit', { provider: 'codex', creditId: 'synthetic-soon' })).outcome, 'reset');
  activity = await state(); assert.equal(activity.consume.length, 1); assert.equal(activity.consume[0].creditId, 'synthetic-soon'); assert.match(activity.consume[0].key, /^[a-f0-9-]{36}$/);
  report.checks.productionIpcPreservesChosenCredit = true;
  await assert.rejects(invoke('usage.resetCredit', { provider: 'codex', creditId: 'synthetic-expired' }), /expired|available|usable/i);
  await assert.rejects(invoke('usage.resetCredit', { provider: 'codex', creditId: 'synthetic-missing' }), /available|refresh|found/i);
  activity = await state(); assert.equal(activity.consume.length, 1); assert.equal(activity.confirmations.length, 2);
  report.checks.staleAndExpiredChoicesNeverReachConfirmationOrConsumption = true;
  await app.evaluate(() => { globalThis.qaReset.failNext = true; });
  await assert.rejects(invoke('usage.resetCredit', { provider: 'codex', creditId: 'synthetic-later' }), /Synthetic reply lost/);
  assert.equal((await invoke('bootstrap')).usageResetPending, true);
  activity = await state(); const uncertain = activity.consume.at(-1);
  await app.evaluate(() => { globalThis.qaReset.count = 0; globalThis.qaReset.credits = []; globalThis.qaReset.outcome = 'alreadyRedeemed'; });
  assert.equal((await invoke('usage.resetCredit', { provider: 'codex' })).outcome, 'alreadyRedeemed');
  activity = await state(); assert.deepEqual(activity.consume.at(-1), uncertain); assert.equal((await invoke('bootstrap')).usageResetPending, false);
  assert.match(activity.confirmations.at(-1).detail, /same request and credit/);
  report.checks.lostResponseRetriesSameCreditAndRequestWithZeroRemaining = true;
  const hidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()));
  assert.equal(hidden, true); assert.deepEqual(activity.connects, []); assert.deepEqual(activity.runs, []); assert.deepEqual(report.errors, []);
  await fixture.verify(); report.checks.hiddenHostAndRealProfileProtection = true; report.passed = true;
} catch (error) {
  report.failure = error.stack; process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
