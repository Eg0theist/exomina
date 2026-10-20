import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { driverLaunchSignature } from '../desktop/computer-connection.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { extractFile } from '@electron/asar';
import { createHash } from 'node:crypto';

// Production host and UI in an isolated encrypted profile; every window stays
// hidden. The real bundled Cua driver only initializes and lists tools. Every
// tools/call is blocked by the launcher, and provider/account access is replaced.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT || root);
const fixture = await createProtectedQaProfile('computer-persistence'), { profile, output } = fixture;
const workspace = path.join(output, 'workspace'); await mkdir(workspace);
const store = new Store(profile, { workspace }); await store.init();
Object.assign(store.state.settings, { autoUpdate: false, closeToTray: false, memoryEnabled: false, chatMemorySummaries: false, autoTitle: false, permissionMode: 'ask' });
const chat = store.create('codex'); chat.title = 'Synthetic computer persistence QA'; chat.titleSource = 'manual'; await store.save();
const expectedVersion = JSON.parse(runtimeRoot.endsWith('.asar') ? extractFile(runtimeRoot, 'package.json') : await readFile(path.join(runtimeRoot, 'package.json'), 'utf8')).version;
const moduleUrl = name => JSON.stringify(pathToFileURL(path.join(runtimeRoot, name)).href);
const launcher = path.join(output, 'launcher.cjs');
await writeFile(launcher, `const {app,BrowserWindow,dialog,session}=require('electron');
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile, 'browser-data'))});
globalThis.qaComputer={visibleWindows:0,accountCalls:0,modelCalls:0,nativeToolCalls:0,results:{},manager:null,external:null};
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};
app.on('browser-window-created',(_event,window)=>window.on('show',()=>globalThis.qaComputer.visibleWindows++));
app.getVersion=()=>${JSON.stringify(expectedVersion)};app.commandLine.appendSwitch('mute-audio');
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
const {ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const {PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){globalThis.qaComputer.manager=this;const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,installed:true,connected:item.id==='codex',available:true,checking:false}));for(const row of rows)onStatus?.(row);return rows;};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];
ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.getCodex=async()=>{globalThis.qaComputer.accountCalls++;throw Error('QA forbids native account access')};
ProviderManager.prototype.run=async function(request){globalThis.qaComputer.modelCalls++;const name=this.toolDefinitions.find(tool=>tool.name.startsWith('external_cua_')).name;
globalThis.qaComputer.results.action=await this.callTool(name,{},request.conversationId);return {text:'Synthetic declined action completed without a model request.',sessionId:'synthetic-computer-qa'};};
const {ExternalMcpTools,StdioMcpClient}=await import(${moduleUrl('desktop/external-mcp.mjs')});
const refresh=ExternalMcpTools.prototype.refresh;ExternalMcpTools.prototype.refresh=function(...args){globalThis.qaComputer.external=this;return refresh.apply(this,args)};
const request=StdioMcpClient.prototype.request;StdioMcpClient.prototype.request=function(method,...args){if(method==='tools/call'){globalThis.qaComputer.nativeToolCalls++;throw Error('QA forbids all native computer actions')};return request.call(this,method,...args)};
await import(${moduleUrl('desktop/main.mjs')});
})().catch(error=>{console.error(error);app.exit(1)});`);
const env = { ...process.env, EXOMINA_DATA_DIR: profile, TEMP: output, TMP: output, TMPDIR: output }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/(?:token|secret|password|api_?key|credential|authorization)/i.test(key)) delete env[key];
const reportDir = path.resolve(process.env.EXOMINA_QA_REPORT_DIR || path.resolve(root, '../Workspace/computer-use-persistence-20261010'));
await mkdir(reportDir, { recursive: true });
const report = { runtimeRoot, output, checks: {}, diagnostics: [], errors: [], scope: 'Hidden production host/UI and real bundled-driver handshakes in a synthetic encrypted profile. No personal profiles, provider accounts, remote model calls or native desktop actions.' };
if (runtimeRoot.endsWith('.asar')) report.archive = { sha256: createHash('sha256').update(await readFile(runtimeRoot)).digest('hex'), build: JSON.parse(await readFile(path.join(path.dirname(path.dirname(runtimeRoot)), 'exomina.build.json'), 'utf8')) };
let app, page;
const invoke = (method, payload = {}) => page.evaluate(({ method, payload }) => window.studio.invoke(method, payload), { method, payload });
async function until(read, accept, timeout = 20000) {
  const deadline = Date.now() + timeout; let value;
  do { value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
  throw Error('Computer persistence QA timed out: ' + JSON.stringify(value));
}
async function launch() {
  app = await electron.launch({ args: [launcher], cwd: root, env, timeout: 30000 }); page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message)); await page.locator('.chat-open').filter({ hasText: chat.title }).waitFor();
  await page.getByRole('button', { name: 'Tools', exact: true }).click(); await page.locator('.driver-panel').waitFor();
}
async function diagnostics() {
  const value = await app.evaluate(() => ({ visibleWindows: globalThis.qaComputer.visibleWindows, accountCalls: globalThis.qaComputer.accountCalls,
    syntheticProviderRuns: globalThis.qaComputer.modelCalls, nativeToolCalls: globalThis.qaComputer.nativeToolCalls, driverPid: globalThis.qaComputer.external?.clients.get('cua')?.client.child?.pid }));
  report.diagnostics.push(value); assert.equal(value.visibleWindows, 0); assert.equal(value.accountCalls, 0); assert.equal(value.nativeToolCalls, 0); return value;
}
async function close() { if (app) { await diagnostics(); await app.close(); } app = null; page = null; }
async function connected() {
  const state = await until(() => invoke('bootstrap'), value => value.mcpStatus.some(server => server.id === 'cua' && server.connected));
  assert.equal(state.mcpStatus.find(server => server.id === 'cua').toolCount, 59);
  assert.equal(state.tools.filter(tool => tool.name.startsWith('external_cua_')).length, 59);
  await until(() => app.evaluate(() => globalThis.qaComputer.manager?.toolDefinitions.filter(tool => tool.name.startsWith('external_cua_')).length), value => value === 59);
  assert.equal((await invoke('computer.status')).skill.current, true); return state;
}
try {
  await launch(); const fresh = await invoke('bootstrap');
  assert.equal(fresh.approvals.length, 0); assert.equal(fresh.mcpStatus.length, 0); report.checks.freshProfileRemainsOff = true;
  await page.getByRole('button', { name: 'Set up computer use', exact: true }).click();
  const card = page.locator('.approval-card'); await card.waitFor();
  assert.match((await invoke('bootstrap')).approvals[0].detail, /stay enabled.*reconnect after restarts/);
  await card.getByRole('button', { name: 'Allow once', exact: true }).click(); const first = await connected();
  assert.ok(first.settings.cuaDriverApproval.signature); report.checks.activationApprovalStoredAnd59ToolsAvailable = true;
  assert.match(await page.locator('.setup-note').innerText(), /stays on across restarts and updates/); report.checks.uiExplainsPersistentActivation = true;
  const originalPid = (await diagnostics()).driverPid;
  await close(); await launch(); const reopened = await connected();
  assert.equal(reopened.approvals.length, 0); assert.equal((await invoke('computer.status')).automatic, true);
  assert.notEqual((await diagnostics()).driverPid, originalPid); report.checks.realAppRestartReconnectsWithoutApproval = true;
  const droppedPid = (await diagnostics()).driverPid;
  await app.evaluate(() => globalThis.qaComputer.external.clients.get('cua').client.child.kill());
  await until(() => app.evaluate(() => globalThis.qaComputer.external.clients.get('cua')?.client.child?.pid), value => value && value !== droppedPid);
  const recovered = await connected(); assert.equal(recovered.approvals.length, 0); report.checks.driverInterruptionRecoversWithoutActionReplay = true;
  await page.locator('.chat-open').filter({ hasText: chat.title }).click();
  await invoke('chat.send', { conversationId: chat.id, provider: 'codex', text: 'Synthetic denied computer action', mode: 'tools' });
  await page.locator('.approval-card').waitFor(); await page.locator('.approval-card').getByRole('button', { name: 'Deny', exact: true }).click();
  const action = await until(() => app.evaluate(() => globalThis.qaComputer.results.action), Boolean);
  assert.equal(action.isError, true); await until(() => invoke('bootstrap'), value => value.activeRuns.length === 0);
  assert.equal((await diagnostics()).nativeToolCalls, 0); report.checks.reconnectionRetainsInvocationApprovalAndDenial = true;
  // Exercise update path rebasing in the same previously activated synthetic
  // profile; the old path is never opened or executed.
  await close(); const updated = new Store(profile, { workspace }); await updated.init();
  const current = updated.state.settings.externalMcpServers.find(server => server.id === 'cua');
  const old = path.join(output, 'old-install', 'resources', 'app.asar.unpacked', 'vendor', 'cua-driver', 'cua-driver.exe');
  current.command = old; updated.state.settings.cuaDriverPath = old;
  updated.state.settings.cuaDriverApproval = { signature: driverLaunchSignature(current), bundled: true }; await updated.save();
  await launch(); const moved = await connected(); assert.equal(moved.approvals.length, 0); assert.notEqual(moved.settings.cuaDriverPath, old);
  assert.equal(moved.settings.externalMcpServers.find(server => server.id === 'cua').command, moved.settings.cuaDriverPath); report.checks.updateRelocationKeepsBundledApproval = true;
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  const off = await until(() => invoke('bootstrap'), value => value.mcpStatus.every(server => server.id !== 'cua'));
  assert.equal(off.settings.cuaDriverApproval, undefined); assert.equal(off.tools.some(tool => tool.name.startsWith('external_cua_')), false);
  assert.equal(await app.evaluate(() => globalThis.qaComputer.external.clients.has('cua')), false); report.checks.turnOffClearsConsentStopsProcessAndRemovesTools = true;
  await close(); await launch(); await new Promise(resolve => setTimeout(resolve, 5500)); const stillOff = await invoke('bootstrap');
  assert.equal(stillOff.mcpStatus.length, 0); assert.equal(stillOff.approvals.length, 0); assert.equal((await invoke('computer.status')).enabled, false);
  report.checks.turnOffPersistsAcrossAppRestart = true;
  // A pre-upgrade enabled connection has no persisted launch consent. Startup
  // asks once, and a decline is never treated as successful activation.
  await close(); const legacy = new Store(profile, { workspace }); await legacy.init();
  legacy.state.settings.externalMcpServers.find(server => server.id === 'cua').enabled = true; await legacy.save();
  await launch(); await page.locator('.approval-card').waitFor();
  await page.locator('.approval-card').getByRole('button', { name: 'Deny', exact: true }).click();
  await new Promise(resolve => setTimeout(resolve, 11000)); const declined = await invoke('bootstrap');
  assert.equal(declined.approvals.length, 0); assert.equal(declined.settings.cuaDriverApproval, undefined);
  assert.equal(declined.mcpStatus.find(server => server.id === 'cua').connected, false);
  assert.equal(await page.getByRole('button', { name: 'Turn off', exact: true }).count(), 1);
  report.checks.legacyConsentDeclineDoesNotLoopAndCanBeTurnedOff = true;
  await page.getByRole('button', { name: 'Turn off', exact: true }).click(); await close();
  report.protection = await fixture.verify(); report.checks.syntheticProfileEncryptedAndRestricted = true;
  if (report.archive) assert.equal(createHash('sha256').update(await readFile(runtimeRoot)).digest('hex'), report.archive.sha256, 'Package changed during QA.');
  assert.deepEqual(report.errors, []); report.checks.noVisibleWindowsPersonalAccountsOrNativeActions = true; report.passed = true;
} catch (error) { report.error = error.stack || error.message; throw error; }
finally { if (app) await close().catch(() => {}); await writeFile(path.join(reportDir, runtimeRoot === root ? 'source-qa.json' : 'packaged-qa.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ passed: report.passed, checks: Object.keys(report.checks).length, runtimeRoot, output, reportDir }));
