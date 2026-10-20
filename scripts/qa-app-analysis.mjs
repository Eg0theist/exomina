// Production host/renderer and actual REA worker, using only fresh synthetic data.
import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Electron resolves unpacked code through the archive's logical paths. Importing
// main through app.asar.unpacked would also duplicate its unpacked preload path.
const runtimeRoot = path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT || root).replace(/app\.asar\.unpacked$/i, 'app.asar');
if (process.env.EXOMINA_QA_EXE) throw Error('UI QA uses the hidden Electron harness. Set EXOMINA_QA_RUNTIME_ROOT for packaged host/renderer files; exact executable workers are verified separately.');
const quickSmoke = process.env.EXOMINA_QA_QUICK === '1';
const fixture = await createProtectedQaProfile('app-analysis');
const { profile, output } = fixture;
const workspace = path.join(output, 'workspace');
const target = path.join(workspace, 'synthetic-electron-app');
const realNativeSetup = process.env.EXOMINA_QA_NATIVE_SETUP ? JSON.parse(process.env.EXOMINA_QA_NATIVE_SETUP) : null;
const realNativeTarget = process.env.EXOMINA_QA_NATIVE_TARGET || null;
if (realNativeSetup && (!realNativeSetup.ghidraPath || !realNativeSetup.javaPath)) throw Error('EXOMINA_QA_NATIVE_SETUP must name ghidraPath and javaPath.');
const setupPaths = realNativeSetup || { ghidraPath: path.join(workspace, 'synthetic-ghidra'), javaPath: path.join(workspace, 'synthetic-jdk') };
if (!realNativeSetup) for (const folder of Object.values(setupPaths)) { await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'fixture.txt'), 'Synthetic setup selection only; this is not an installed dependency.'); }
await mkdir(target, { recursive: true });
await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'synthetic-electron-app', version: '1.0.0', main: 'main.js', dependencies: { electron: '1.0.0' } }));
await writeFile(path.join(target, 'main.js'), `import fs from 'node:fs';
import { ipcMain } from 'electron';
fs.writeFileSync(new URL('./executed.txt', import.meta.url), 'Target execution must never occur');
export function findResults(query) { return query.toLowerCase().split(' '); }
export class SearchIndex { constructor() { this.entries = []; } search(query) { return findResults(query); } }
ipcMain.handle('search:query', (event, query) => findResults(query));
`);
await writeFile(path.join(target, '.env'), 'SYNTHETIC_EXCLUDED_VALUE=fixture-only');
const store = new Store(profile, { workspace }); await store.init();
Object.assign(store.state.settings, { workspace, autoUpdate: false, autoTitle: false, closeToTray: false, memoryEnabled: false, chatMemoryEnabled: false, chatMemorySummaries: false, browserEnabled: false });
await store.save();
const exportPath = path.join(workspace, 'exported-evidence.json');
const moduleUrl = name => JSON.stringify(pathToFileURL(path.join(runtimeRoot, name)).href);
const launcher = path.join(output, 'launcher.cjs');
const qaInstrumentation = `app.commandLine.appendSwitch('mute-audio');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
BrowserWindow.prototype.show = function() { this.webContents.setBackgroundThrottling(false); };
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
globalThis.qaAnalysis = { target: ${JSON.stringify(target)}, exportPath: ${JSON.stringify(exportPath)}, setupPaths: ${JSON.stringify(setupPaths)}, choosers: [], setupChoosers: [], exports: [], requests: [], connects: [], runs: [], nativeInvocations: [], cancelNextSetup: false };
dialog.showOpenDialog = async (_owner, options) => {
 if (options.title === 'Choose Ghidra installation folder' || options.title === 'Choose Java JDK installation folder') {
  globalThis.qaAnalysis.setupChoosers.push(options);
  if (globalThis.qaAnalysis.cancelNextSetup) { globalThis.qaAnalysis.cancelNextSetup = false; return { canceled: true, filePaths: [] }; }
  return { canceled: false, filePaths: [options.title === 'Choose Ghidra installation folder' ? globalThis.qaAnalysis.setupPaths.ghidraPath : globalThis.qaAnalysis.setupPaths.javaPath] };
 }
 if (!options.title.startsWith('Choose an app to inspect in ')) throw Error('Unexpected native chooser in QA: ' + options.title);
 globalThis.qaAnalysis.choosers.push(options); return { canceled: false, filePaths: [globalThis.qaAnalysis.target] };
};
dialog.showSaveDialog = async (_owner, options) => {
 if (options.title !== 'Export app-analysis evidence') throw Error('Unexpected native save dialog in QA: ' + options.title);
 globalThis.qaAnalysis.exports.push(options); return { canceled: false, filePath: globalThis.qaAnalysis.exportPath };
};
await app.whenReady();
 session.defaultSession.webRequest.onBeforeRequest((details, callback) => { globalThis.qaAnalysis.requests.push(details.url); callback({ cancel: /^https?:/.test(details.url) }); });
 const { ProviderManager } = await import(${moduleUrl('desktop/providers.mjs')});
 const { PROVIDER_CATALOG } = await import(${moduleUrl('desktop/provider-catalog.mjs')});
 if (!${JSON.stringify(!!realNativeSetup)}) {
  const { AppAnalysis } = await import(${moduleUrl('desktop/app-analysis.mjs')});
  AppAnalysis.prototype.statusNativeDependencies = async function() {
   const config = await this.nativeConfiguration();
   const available = !globalThis.qaAnalysis.forceNativeUnavailable && config.ghidraPath === globalThis.qaAnalysis.setupPaths.ghidraPath && config.javaPath === globalThis.qaAnalysis.setupPaths.javaPath;
   return { ...config, available, details: available ? 'Synthetic UI dependency status ready; real decompilation is tested separately.' : 'Synthetic UI status: choose both fixture dependency folders.' };
  };
  const realCall = AppAnalysis.prototype.call;
  AppAnalysis.prototype.call = async function(name, args, id) {
   if (name === 'analysis_run' && args.operation === 'native-functions') {
    globalThis.qaAnalysis.nativeInvocations.push({name,args,id});
    if (globalThis.qaAnalysis.forceNativeFailure) {
     const { mkdir, writeFile } = await import('node:fs/promises');
     const failedId = '12345678-1234-4123-8123-123456789abc', folder = this.folder(id) + '/' + failedId;
     const metadata = { id: failedId, operation: args.operation, createdAt: new Date().toISOString(), status: 'failed', target: this.chat(id).analysisTarget };
     await mkdir(folder, { recursive: true }); await writeFile(folder + '/metadata.json', JSON.stringify(metadata)); await writeFile(folder + '/report.json', JSON.stringify({ ...metadata, error: 'Synthetic native decompilation failed.', syntheticUiFixture: true }));
     this.changed(id);
     return { isError: true, content: [{ type: 'text', text: JSON.stringify({ id: failedId, status: 'failed', error: 'Synthetic native decompilation failed.' }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'synthetic-ui-dispatch-only' }) }] };
   }
   return realCall.call(this,name,args,id);
  };
 }
 ProviderManager.prototype.status = async function({ onStatus } = {}) {
  const rows = PROVIDER_CATALOG.filter(item => item.mode === 'subscription').map(item => ({id:item.id,installed:true,connected:false,available:true,checking:false,detail:'Synthetic signed-out status.'}));
  for (const row of rows) onStatus?.(row); return rows;
 };
 ProviderManager.prototype.subscriptionModels = async () => ({});
 ProviderManager.prototype.modelsFor = async () => [];
 ProviderManager.prototype.codexUsage = async () => null;
 ProviderManager.prototype.claudeUsage = async () => null;
 ProviderManager.prototype.connect = async id => { globalThis.qaAnalysis.connects.push(id); throw Error('QA sign-in prohibited.'); };
 ProviderManager.prototype.run = async request => { globalThis.qaAnalysis.runs.push(request.provider); throw Error('QA model requests prohibited.'); };
`;
await writeFile(launcher, `const { app, BrowserWindow, dialog, session } = require('electron');
(async () => {
${qaInstrumentation}
 await import(${moduleUrl('desktop/main.mjs')});
})().catch(error => { console.error(error); app.exit(1); });
`);
const environment = { ...process.env, EXOMINA_DATA_DIR: profile, TEMP: output, TMP: output, TMPDIR: output };
delete environment.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(environment)) if (/(?:token|secret|password|api_?key|credential|authorization)/i.test(key) || /^(?:GHIDRA_INSTALL_DIR|JAVA_HOME)$/i.test(key)) delete environment[key];
const report = { runtimeRoot, output, executable: path.join(root, 'node_modules/electron/dist/electron.exe'), packagedRuntime: /app\.asar$/i.test(runtimeRoot), scope: 'Hidden production Electron harness loading production host/renderer and real REA JavaScript/.NET worker from runtimeRoot. Synthetic target and fresh EFS-protected QA profile; no personal account stores, sign-ins or model calls. Native chooser/save dialogs provide fixture paths; setup path validation, vault and analysis permission gates remain real. Native setup availability/function dispatch use explicit synthetic instrumentation unless EXOMINA_QA_NATIVE_SETUP is supplied; actual staged executable workers are verified separately.', realNativeSetup: !!realNativeSetup, checks: {}, errors: [] };
let app, page;
async function invoke(method, payload = {}) { return page.evaluate(({ method, payload }) => window.studio.invoke(method, payload), { method, payload }); }
async function fullEvidence(conversationId, id) {
 let offset = 0, text = '';
 do { const page = await invoke('analysis.report', { conversationId, id, offset, limit: 64000 }); text += page.text; offset = page.nextOffset; } while (offset !== null && offset !== undefined);
 return JSON.parse(text);
}
async function screenshot(filename) {
 try { await page.screenshot({ path: path.join(output, filename), fullPage: true, timeout: 10000 }); }
 catch (error) { (report.screenshotLimitations ||= []).push({ filename, message: error.message }); }
}
async function until(check, accept = Boolean, timeout = 30000) {
 const deadline = Date.now() + timeout;
 while (Date.now() < deadline) { const value = await check(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
 throw Error('App analysis QA condition timed out.');
}
async function compileManagedFixture() {
 const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 try { await access(compiler); } catch { return null; }
 const input = path.join(workspace, 'SyntheticManaged.cs'), output = path.join(workspace, 'SyntheticManaged.dll');
 await writeFile(input, 'using System.Runtime.InteropServices; public class SyntheticManaged { public string Search(string query) { return query.ToLowerInvariant(); } [DllImport("user32.dll")] public static extern int GetSystemMetrics(int metric); }');
 await new Promise((resolve, reject) => {
  const child = spawn(compiler, ['/nologo', '/target:library', '/out:' + output, input], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
  child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error('Synthetic C# compilation failed: ' + log)));
 });
 return output;
}
try {
 app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [launcher], cwd: root, env: environment, timeout: 30000 });
 page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => report.errors.push(error.message));
 await page.getByRole('button', { name: 'Tools', exact: true }).click();
 if (quickSmoke) {
  await page.getByText('Native analysis setup', { exact: true }).waitFor();
  const activity = await app.evaluate(({ BrowserWindow, app }) => ({ packagedApp: app.isPackaged, stubInstalled: !!globalThis.qaAnalysis, connects: globalThis.qaAnalysis.connects, runs: globalThis.qaAnalysis.runs, choosers: globalThis.qaAnalysis.choosers.length, visibleWindows: BrowserWindow.getAllWindows().filter(window => window.isVisible()).length }));
  assert.equal(activity.packagedApp, false); assert.equal(activity.stubInstalled, true); assert.equal(activity.visibleWindows, 0); assert.equal(activity.choosers, 0); assert.deepEqual(activity.connects, []); assert.deepEqual(activity.runs, []);
  report.checks.hiddenHarnessQuickSmoke = activity;
  await fixture.verify(); report.checks.realVaultProtectionVerified = true;
 } else {
 await page.getByText('Open or start a chat, then choose the app you want to inspect.', { exact: true }).waitFor();
 await page.getByText('Native analysis setup', { exact: true }).waitFor();
 await page.getByRole('button', { name: 'Choose Ghidra folder', exact: true }).click();
 assert.equal((await invoke('analysis.nativeDependencies')).ghidraPath, setupPaths.ghidraPath);
 await page.getByRole('button', { name: 'Choose JDK folder', exact: true }).click();
 await until(async () => (await invoke('analysis.nativeDependencies')).available);
 await page.getByText('Ready', { exact: true }).waitFor();
 await app.evaluate(() => { globalThis.qaAnalysis.cancelNextSetup = true; });
 await page.getByRole('button', { name: 'Choose Ghidra folder', exact: true }).click();
 await until(async () => page.getByRole('button', { name: 'Choose Ghidra folder', exact: true }).isEnabled());
 assert.equal((await invoke('analysis.nativeDependencies')).ghidraPath, setupPaths.ghidraPath);
 await page.getByRole('button', { name: 'Recheck setup', exact: true }).click();
 await page.getByRole('button', { name: 'Recheck setup', exact: true }).waitFor();
 await assert.rejects(invoke('analysis.configureNative', { kind: 'other' }), /Ghidra folder or a Java JDK folder/);
 report.checks.nativeSetupPickersWithoutChatAndCancel = { realPathValidation: true, syntheticAvailability: !realNativeSetup, noChatRequired: true, canceledPickerPreservesSelection: true };
 await page.getByRole('button', { name: 'Start analysis chat', exact: true }).click();
 const chat = await until(async () => (await invoke('bootstrap')).conversations.find(chat => chat.title === 'App analysis'));
 await page.getByRole('button', { name: 'Tools', exact: true }).click();
 await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
 await page.getByText('synthetic-electron-app', { exact: true }).waitFor();
 const selected = await invoke('analysis.status', { conversationId: chat.id });
 assert.equal(selected.target.path, target); assert.equal(selected.target.kind, 'directory');
 report.checks.nativeSelectionAndChatCreation = true;
 const reportsTab = page.getByRole('tab', { name: /Inspection reports/ });
 const projectTab = page.getByRole('tab', { name: /Ghidra project/ });
 await projectTab.click();
 const projectPane = page.getByRole('region', { name: 'Ghidra project', exact: true });
 await projectPane.getByText(/Choose a single Windows x86\/x64 EXE/).waitFor();
 assert.equal(await projectPane.getByRole('button', { name: 'Start project', exact: true }).isDisabled(), true);
 assert.equal(await page.getByRole('button', { name: 'Choose EXE', exact: true }).count(), 0);
 assert.equal(await page.getByRole('button', { name: 'Choose file', exact: true }).count(), 1);
 assert.equal(await page.getByRole('button', { name: 'Choose Ghidra folder', exact: true }).count(), 1);
 assert.equal((await invoke('analysis.status', { conversationId: chat.id })).target.path, target);
 await projectTab.focus(); await page.keyboard.press('ArrowLeft');
 assert.equal(await reportsTab.getAttribute('aria-selected'), 'true');
 await page.getByLabel('Function to decompile (optional)', { exact: true }).fill('401000');
 await projectTab.click(); await reportsTab.click();
 assert.equal(await page.getByLabel('Function to decompile (optional)', { exact: true }).inputValue(), '401000');
 await page.getByLabel('Function to decompile (optional)', { exact: true }).fill('');
 report.checks.unifiedModesShareSelectionAndSetup = { folderExplained: true, projectStartDisabledForFolder: true, singleFilePicker: true, singleSetup: true, keyboardSwitching: true, draftPreserved: true };
 if (!realNativeSetup) {
  await app.evaluate(() => { globalThis.qaAnalysis.forceNativeUnavailable = true; });
  await page.getByRole('button', { name: 'Recheck setup', exact: true }).click();
  await until(() => page.getByRole('button', { name: 'Recheck setup', exact: true }).isEnabled());
  await until(() => page.getByRole('button', { name: 'Native executable overview', exact: false }).isDisabled());
  assert.ok(await page.getByRole('button', { name: 'Native function decompilation', exact: false }).isDisabled());
  assert.ok(await page.getByRole('button', { name: 'JavaScript / Electron', exact: false }).isEnabled());
  await app.evaluate(() => { globalThis.qaAnalysis.forceNativeUnavailable = false; });
  await page.getByRole('button', { name: 'Recheck setup', exact: true }).click();
  await until(() => page.getByRole('button', { name: 'Native function decompilation', exact: false }).isEnabled());
  report.checks.unavailableNativeSetupDisablesOnlyNativeOperations = true;
  const procedure = page.getByLabel('Function to decompile (optional)', { exact: true });
  await procedure.fill('synthetic_search');
  await page.getByRole('button', { name: 'Native function decompilation', exact: false }).click();
  const dispatched = await until(() => app.evaluate(() => globalThis.qaAnalysis.nativeInvocations.at(-1)));
  assert.equal(dispatched.args.operation, 'native-functions'); assert.equal(dispatched.args.procedure, 'synthetic_search'); assert.equal(dispatched.id, chat.id);
  await procedure.fill('');
  await page.getByRole('button', { name: 'Native function decompilation', exact: false }).click();
  const boundedDispatch = await until(() => app.evaluate(() => globalThis.qaAnalysis.nativeInvocations.length === 2 && globalThis.qaAnalysis.nativeInvocations.at(-1)));
  assert.equal(Object.hasOwn(boundedDispatch.args, 'procedure'), false);
  report.checks.nativeFunctionInputDispatch = { specificName: true, emptyAllowsBoundedSelection: true, syntheticDispatchOnly: true };
 }
 await page.getByText('Native analysis setup', { exact: true }).scrollIntoViewIfNeeded();
 await screenshot('app-analysis-native-setup.png');
 await page.getByRole('button', { name: 'JavaScript / Electron', exact: false }).click();
 await page.getByRole('button', { name: 'View report', exact: true }).waitFor();
 const status = await invoke('analysis.status', { conversationId: chat.id });
 assert.equal(status.running, null); assert.equal(status.reports[0].operation, 'javascript');
 const evidence = JSON.parse((await invoke('analysis.report', { conversationId: chat.id, id: status.reports[0].id, offset: 0, limit: 64000 })).text);
 assert.ok(evidence.inventory.some(item => item.path === 'main.js' && /^[a-f0-9]{64}$/.test(item.sha256)));
 assert.ok(!evidence.inventory.some(item => item.path === '.env'));
 assert.match(JSON.stringify(evidence.evidence), /search:query/);
 assert.equal(evidence.evidence.files[0].result.parse_status, 'complete');
 await assert.rejects(access(path.join(target, 'executed.txt')));
 report.checks.realReaJavaScriptEvidence = { sha256: true, sourceStructure: true, envExcluded: true, targetNeverExecuted: true };
 await page.getByRole('button', { name: 'View report', exact: true }).click();
 await page.locator('.app-analysis-report-viewer pre').waitFor();
 assert.ok((await page.locator('.app-analysis-report-viewer pre').innerText()).includes('REA 6.1.0'));
 assert.ok((await page.locator('.app-analysis-report-viewer pre').innerText()).length <= 16000);
 await page.getByRole('button', { name: 'Save JSON', exact: true }).click();
 await until(async () => { try { return JSON.parse(await readFile(exportPath, 'utf8')); } catch { return null; } });
 const exported = JSON.parse(await readFile(exportPath, 'utf8')); assert.equal(exported.id, status.reports[0].id);
 report.checks.reportViewAndNativeExport = true;
 await screenshot('app-analysis-production.png');
 await invoke('settings.save', { permissionRules: [{ effect: 'deny', tool: 'analysis_*', match: '' }] });
 await page.getByRole('button', { name: 'File inventory', exact: false }).click();
 await page.getByRole('alert').filter({ hasText: 'Blocked by your rule: analysis_*' }).waitFor();
 const denied = await invoke('analysis.status', { conversationId: chat.id }); assert.equal(denied.reports.length, 1); assert.equal(denied.running, null);
 await assert.rejects(invoke('analysis.report', { conversationId: chat.id, id: status.reports[0].id }), /Blocked by your rule/);
 report.checks.denyRulesApplyToButtonsAndReports = true;
 await invoke('settings.save', { permissionRules: [] });
 const other = await invoke('analysis.newChat'); assert.equal((await invoke('analysis.status', { conversationId: other.id })).target, null);
 report.checks.targetIsScopedToChat = true;
 await app.evaluate((_electron, target) => { globalThis.qaAnalysis.target = target; }, profile);
 await assert.rejects(invoke('analysis.choose', { conversationId: chat.id, kind: 'folder' }), /account stores|app data|private|protected/i);
 assert.equal((await invoke('analysis.status', { conversationId: chat.id })).target.path, target);
 report.checks.privateProfileSelectionRejected = true;
 const managed = await compileManagedFixture();
 if (managed) {
  await app.evaluate((_electron, target) => { globalThis.qaAnalysis.target = target; }, managed);
  await invoke('analysis.choose', { conversationId: other.id, kind: 'file' });
  await invoke('analysis.run', { conversationId: other.id, operation: 'managed' });
  await invoke('analysis.run', { conversationId: other.id, operation: 'managed-native' });
  const managedStatus = await invoke('analysis.status', { conversationId: other.id }); assert.equal(managedStatus.reports.length, 2);
  const native = managedStatus.reports.find(item => item.operation === 'managed-native');
  const managedEvidence = JSON.parse((await invoke('analysis.report', { conversationId: other.id, id: native.id, limit: 64000 })).text);
  assert.match(JSON.stringify(managedEvidence), /user32\.dll|GetSystemMetrics/);
  report.checks.realReaManagedMetadataAndNativeBoundary = true;
 } else report.checks.realReaManagedMetadataAndNativeBoundary = { skipped: 'Windows .NET compiler is unavailable.' };
 if (realNativeSetup && realNativeTarget) {
  await app.evaluate((_electron, target) => { globalThis.qaAnalysis.target = target; }, realNativeTarget);
  await page.getByRole('button', { name: 'Choose file', exact: true }).click();
  await until(async () => (await invoke('analysis.status', { conversationId: chat.id })).target.path === realNativeTarget);
  for (const [operation, title] of [['native', 'Native executable overview'], ['native-functions', 'Native function decompilation']]) {
   const button = page.getByRole('button', { name: title, exact: false }); await until(() => button.isEnabled()); await button.click();
   const finished = await until(async () => { const status = await invoke('analysis.status', { conversationId: chat.id }); return !status.running && status.reports.find(item => item.operation === operation); }, Boolean, 120000);
   assert.equal(finished.status, 'completed');
  }
  const nativeStatus = await invoke('analysis.status', { conversationId: chat.id });
  for (const operation of ['native', 'native-functions']) {
   const saved = nativeStatus.reports.find(item => item.operation === operation); assert.ok(saved);
   const evidence = await fullEvidence(chat.id, saved.id);
   assert.ok(evidence.inventory.some(item => /^[a-f0-9]{64}$/.test(item.sha256)));
   assert.match(JSON.stringify(evidence.evidence), /Ghidra|ghidra/);
  }
  const nativeRow = page.locator('.app-analysis-reports li').filter({ hasText: 'Native function decompilation' });
  await nativeRow.getByRole('button', { name: 'View report', exact: true }).click();
  await until(async () => /native-functions/.test(await page.locator('.app-analysis-report-viewer pre').innerText()));
  report.checks.realNativeOverviewAndDecompilation = { renderedButtons: true, completedReports: true, sha256Evidence: true, realGhidra: true, reportViewer: true };
 }
 if (!realNativeSetup) {
  await app.evaluate(() => { globalThis.qaAnalysis.forceNativeFailure = true; });
  await page.getByRole('button', { name: 'Native function decompilation', exact: false }).click();
  const failureAlert = page.getByRole('alert').filter({ hasText: 'Synthetic native decompilation failed.' }); await failureAlert.waitFor();
  const message = await failureAlert.innerText(); assert.match(message, /Recent reports \(12345678-1234-4123-8123-123456789abc\)/); assert.ok(!message.includes('"status"'));
  const failedRow = page.locator('.app-analysis-reports li').filter({ hasText: 'Native function decompilation' }); await until(async () => /failed/.test(await failedRow.innerText()));
  await failedRow.getByRole('button', { name: 'View report', exact: true }).click();
  await until(async () => /Synthetic native decompilation failed/.test(await page.locator('.app-analysis-report-viewer pre').innerText()));
  report.checks.failedNativeReportShowsPlainErrorAndSavedFailedStatus = { syntheticFailedReport: true, savedReportCanBeOpened: true };
 }
 const activity = await app.evaluate(({ BrowserWindow }) => ({ connects: globalThis.qaAnalysis.connects, runs: globalThis.qaAnalysis.runs, choosers: globalThis.qaAnalysis.choosers.length, exports: globalThis.qaAnalysis.exports.length, visibleWindows: BrowserWindow.getAllWindows().filter(window => window.isVisible()).length }));
 assert.deepEqual(activity.connects, []); assert.deepEqual(activity.runs, []); assert.equal(activity.visibleWindows, 0);
 report.checks.noSignInsOrModelCallsAndHiddenHost = activity;
 await fixture.verify(); report.checks.realVaultProtectionVerified = true;
 }
 assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
 report.failure = error.stack; process.exitCode = 1;
 if (page && !page.isClosed()) { report.ui = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
} finally {
 await app?.close().catch(() => {});
 await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
 console.log(JSON.stringify(report, null, 2));
}
