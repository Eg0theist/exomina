// Real source renderer and Store migration; all data and provider status are synthetic.
// No personal profile, account store, external page, sign-in, or model request is used.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../desktop/store.mjs';
import { PROVIDER_CATALOG } from '../desktop/provider-catalog.mjs';

const root = process.cwd();
const output = await mkdtemp(path.resolve('../Workspace/qa-antigravity-card-'));
const profile = path.join(output, 'profile'), workspace = path.join(output, 'workspace');
await mkdir(profile); await mkdir(workspace);
const legacyMessage = { id: 'legacy-message', role: 'assistant', provider: 'gemini-cli', content: 'Synthetic earlier Gemini reply retained.' };
await writeFile(path.join(profile, 'state.json'), JSON.stringify({
  settings: { provider: 'gemini-cli', model: 'obsolete-gemini-model', effort: 'high', speed: 'fast', workspace, memoryEnabled: false, browserEnabled: false },
  conversations: [{ id: 'legacy-chat', title: 'Synthetic migrated Google chat', provider: 'gemini-cli', updatedAt: '2026-10-11',
    selection: { provider: 'gemini-cli', model: 'obsolete-gemini-model', effort: 'high', speed: 'fast' },
    messages: [legacyMessage], sessions: { 'gemini-cli:obsolete-gemini-model': 'obsolete-session', 'codex:auto': 'retained-session' },
    sessionSeen: { 'gemini-cli:obsolete-gemini-model': 1, 'codex:auto': 1 } }],
}));
const store = new Store(profile, { workspace }); await store.init();
const chat = store.conversation('legacy-chat');
assert.equal(store.state.settings.provider, 'antigravity');
assert.ok(['', 'auto', undefined].includes(store.state.settings.model), 'Retirement must clear the old Gemini model');
assert.ok(!store.state.settings.effort && !store.state.settings.speed, 'Old Gemini effort/speed must be cleared');
assert.equal(chat.provider, 'antigravity');
assert.ok(!chat.selection || chat.selection.provider === 'antigravity');
assert.ok(!chat.selection || ['', 'auto', undefined].includes(chat.selection.model));
assert.ok(!chat.selection?.effort && !chat.selection?.speed);
assert.deepEqual(chat.messages, [legacyMessage], 'Migration must retain earlier reply history');
assert.deepEqual(chat.sessions, { 'codex:auto': 'retained-session' });
assert.deepEqual(chat.sessionSeen, { 'codex:auto': 1 });
await store.save();
const reloaded = new Store(profile, { workspace }); await reloaded.init();
assert.equal(reloaded.conversation(chat.id).provider, 'antigravity');
assert.equal(reloaded.state.settings.provider, 'antigravity');
assert.ok(['', 'auto', undefined].includes(reloaded.state.settings.model));

const state = {
  ...reloaded.state, version: 'synthetic retirement QA', providers: PROVIDER_CATALOG,
  connections: PROVIDER_CATALOG.filter(item => item.mode === 'subscription').map(item => ({ id: item.id, installed: true, connected: false, available: true, checking: false, detail: 'Synthetic signed-out status.' })),
  providerModels: { antigravity: [{ id: 'auto', name: 'Default' }, { id: 'synthetic-agy-model', name: 'Synthetic Antigravity model' }] },
  memories: [], tools: [], approvals: [], activeRuns: [],
  runtime: { capabilities: { nativeBrowser: false, localFiles: false, desktopControl: false } },
};
const preload = path.join(output, 'preload.cjs'), launcher = path.join(output, 'fixture.cjs');
await writeFile(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('studio',{invoke:(method,payload)=>ipcRenderer.invoke('qa:invoke',method,payload),onEvent:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('studio:event',listener);return()=>ipcRenderer.removeListener('studio:event',listener)}});`);
const server = await createServer({ root, server: { port: 5201, strictPort: false }, logLevel: 'error' });
await server.listen();
await writeFile(launcher, `const{app,BrowserWindow,ipcMain,session}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(output, 'electron-profile'))});
globalThis.qa={state:${JSON.stringify(state)},calls:[],network:[]};
ipcMain.handle('qa:invoke',(_event,method,payload={})=>{
 const q=globalThis.qa,s=q.state;q.calls.push({method,payload});
 if(method==='security.status')return{protected:true,supported:true,needsRecovery:false};
 if(method==='bootstrap')return s;
 if(method==='conversations.get')return s.conversations.find(chat=>chat.id===payload.id);
 if(method==='settings.save'){Object.assign(s.settings,payload);return s.settings;}
 if(method==='connections.refresh')return s.connections;
 if(method==='memory.search')return[];
 if(method==='window.state')return{maximized:false};
 if(method==='browser.show'||method==='browser.state')return{visible:false,tabs:[]};
 if(method==='update.status')return{status:'idle'};
 if(method==='provider.connect'||method==='chat.send')throw Error('Sign-in/model calls prohibited in synthetic QA.');
 return{};
});app.whenReady().then(()=>{
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{const external=/^https?:/.test(details.url)&&!details.url.startsWith(${JSON.stringify(`http://localhost:${server.config.server.port}/`)});if(external)globalThis.qa.network.push(details.url);callback({cancel:external});});
 const w=new BrowserWindow({width:1500,height:1000,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://localhost:${server.config.server.port}/`)});
});app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/(?:token|secret|password|api_?key|credential|authorization)/i.test(key)) delete env[key];
let app, page;
const report = { passed: false, syntheticOnly: true, output, checks: { persistedMigration: true, defaultModelReset: true, effortSpeedReset: true, historyRetained: true, obsoleteSessionsCleared: true }, errors: [] };
try {
  app = await electron.launch({ args: [launcher], cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  assert.equal(await page.locator('[data-provider="gemini-cli"]').count(), 0);
  await page.getByLabel('Filter providers', { exact: true }).fill('Gemini');
  const card = page.locator('[data-provider="antigravity"]');
  await card.getByRole('heading', { name: 'Antigravity', exact: true }).waitFor();
  const filteredIds = await page.locator('.catalog-connection-card').evaluateAll(cards => cards.map(card => card.dataset.provider));
  assert.equal(filteredIds.filter(id => PROVIDER_CATALOG.find(item => item.id === id)?.mode === 'subscription').length, 1, 'Gemini search must find only Antigravity among subscription connections');
  assert.ok(filteredIds.every(id => id === 'antigravity' || PROVIDER_CATALOG.find(item => item.id === id)?.mode === 'api'), 'API presets may remain in Gemini search');
  await card.getByRole('button', { name: 'Open Gemini for images & videos', exact: true }).waitFor();
  assert.match(await card.innerText(), /Antigravity CLI/);
  await page.screenshot({ path: path.join(output, 'cards.png') });
  report.checks.oldCardAbsent = true; report.checks.geminiFilterFindsAntigravity = true; report.checks.geminiMediaWebsiteRetained = true; report.checks.filteredConnections = filteredIds;
  await page.locator(`[data-chat-id="${chat.id}"] .chat-open`).click();
  await page.getByText(legacyMessage.content, { exact: true }).waitFor();
  const modelChip = page.getByRole('button', { name: 'Choose AI, model and effort', exact: true });
  assert.match(await modelChip.innerText(), /Antigravity.*Default/);
  await modelChip.click();
  assert.equal(await page.getByLabel('AI connection', { exact: true }).inputValue(), 'antigravity');
  assert.equal(await page.getByLabel('AI connection', { exact: true }).locator('option[value="gemini-cli"]').count(), 0);
  assert.equal(await page.getByRole('option', { name: /obsolete-gemini-model/ }).count(), 0);
  await page.screenshot({ path: path.join(output, 'migrated-chat.png') });
  report.checks.migratedChatProvider = true; report.checks.migratedChatDefaultVisible = true; report.checks.oldModelAbsent = true;
  const activity = await app.evaluate(() => ({ calls: globalThis.qa.calls, network: globalThis.qa.network }));
  assert.equal(activity.calls.some(call => ['provider.connect', 'chat.send'].includes(call.method)), false);
  assert.deepEqual(activity.network, []); assert.deepEqual(report.errors, []);
  report.checks.noSignInModelCallsOrOutsideRequests = true; report.passed = true;
} catch (error) {
  report.failure = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {}); await server.close();
  const persisted = JSON.parse(await readFile(path.join(profile, 'state.json'), 'utf8'));
  report.persisted = { provider: persisted.settings.provider, model: persisted.settings.model, chatProvider: persisted.conversations[0].provider, selection: persisted.conversations[0].selection };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
