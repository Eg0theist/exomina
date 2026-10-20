// Real production host and sandboxed browser; only synthetic page/account data.
import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT || root);
const fixture = await createProtectedQaProfile('browser-menu');
const { profile, output } = fixture, workspace = path.join(output, 'workspace');
await mkdir(workspace);
const store = new Store(profile, { workspace }); await store.init();
Object.assign(store.state.settings, { workspace, autoUpdate: false, autoTitle: false,
  closeToTray: false, memoryEnabled: false, browserEnabled: false });
await store.save();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lscAAAAASUVORK5CYII=', 'base64');
const server = http.createServer((request, response) => {
  if (request.url === '/pixel.png') { response.setHeader('Content-Type', 'image/png'); response.end(png); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<title>Browser menu fixture</title><body style="font:18px system-ui;padding:18px;background:#10211d;color:white"><main><h1>Browser menu fixture</h1><p id="selection">Synthetic selection for copying</p><input id="field" value="Synthetic edit" style="width:220px"><p><a id="link" href="/target">Synthetic link</a></p><img id="image" src="/pixel.png" width="70" height="70"></main></body>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/fixture`, targetUrl = new URL('/target', url).href;
const moduleUrl = name => JSON.stringify(pathToFileURL(path.join(runtimeRoot, name)).href);
const launcher = path.join(output, 'launcher.cjs');
await writeFile(launcher, `const { app, BrowserWindow, dialog, shell, Menu, session } = require('electron');
app.commandLine.appendSwitch('mute-audio');
BrowserWindow.prototype.show = function() {};
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
globalThis.qaBrowser = { menus: [], popups: [], external: [], requests: [], connects: [], runs: [] };
shell.openExternal = async url => { globalThis.qaBrowser.external.push(url); };
const buildMenu = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = template => {
 const menu = buildMenu(template);
 if (template.some(item => item.label === 'Reload' || item.label === 'Stop loading')) {
  globalThis.qaBrowser.menus.push(template);
  // Record the native popup invocation while keeping this synthetic test hidden.
  menu.popup = options => { globalThis.qaBrowser.popups.push({ hasOwner: !!options.window }); };
 }
 return menu;
};
(async () => {
 await app.whenReady();
 for (const browserSession of [session.defaultSession, session.fromPartition('persist:exomina-browser')]) {
  browserSession.webRequest.onBeforeRequest((details, callback) => {
   globalThis.qaBrowser.requests.push(details.url);
   callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(${JSON.stringify(new URL('/', url).href)}) });
  });
 }
 const { ProviderManager } = await import(${moduleUrl('desktop/providers.mjs')});
 const { PROVIDER_CATALOG } = await import(${moduleUrl('desktop/provider-catalog.mjs')});
 ProviderManager.prototype.status = async function({ onStatus } = {}) {
  const rows = PROVIDER_CATALOG.filter(item => item.mode === 'subscription').map(item => ({
   id: item.id, installed: true, connected: false, available: true, checking: false, detail: 'Synthetic signed-out status.' }));
  for (const row of rows) onStatus?.(row); return rows;
 };
 ProviderManager.prototype.subscriptionModels = async () => ({});
 ProviderManager.prototype.modelsFor = async () => [];
 ProviderManager.prototype.codexUsage = async () => null;
 ProviderManager.prototype.claudeUsage = async () => null;
 ProviderManager.prototype.connect = async id => { globalThis.qaBrowser.connects.push(id); throw Error('QA sign-in prohibited.'); };
 ProviderManager.prototype.run = async request => { globalThis.qaBrowser.runs.push(request.provider); throw Error('QA model requests prohibited.'); };
 await import(${moduleUrl('desktop/main.mjs')});
})().catch(error => { console.error(error); app.exit(1); });
`);
const environment = { ...process.env, EXOMINA_DATA_DIR: profile, TEMP: output, TMP: output, TMPDIR: output };
delete environment.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(environment)) if (/(?:token|secret|password|api_?key|credential|authorization)/i.test(key)) delete environment[key];
const report = { runtimeRoot, output, scope: 'Production host/renderer and real right-click browser events on a local fixture. Native menus are constructed; popup invocations are recorded without showing an OS menu. No live accounts, model calls or outside page requests.', checks: {}, errors: [] };
let app, page;
async function until(check, accept = Boolean) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const value = await check(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw Error('Browser menu QA condition timed out.');
}
async function browserRead(source) {
  return app.evaluate(async ({ webContents }, { url, source }) => {
    const wc = webContents.getAllWebContents().find(wc => wc.getURL().startsWith(new URL('/', url).href));
    if (!wc) throw Error('Synthetic browser contents missing.');
    return wc.mainFrame.executeJavaScript(source);
  }, { url, source });
}
async function rightClick(selector) {
  const before = await app.evaluate(() => globalThis.qaBrowser.menus.length);
  await app.evaluate(async ({ webContents }, { url, selector }) => {
    const wc = webContents.getAllWebContents().find(wc => wc.getURL().startsWith(new URL('/', url).href));
    const point = await wc.mainFrame.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'right', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'right', clickCount: 1 });
  }, { url, selector });
  const menu = await until(() => app.evaluate(() => ({ count: globalThis.qaBrowser.menus.length, items: globalThis.qaBrowser.menus.at(-1)?.map(item => ({ label: item.label, enabled: item.enabled })) })), value => value.count > before);
  return menu.items;
}
async function menuAction(label) {
  await app.evaluate((_electron, label) => {
    const item = globalThis.qaBrowser.menus.at(-1).find(item => item.label === label);
    if (!item || item.enabled === false) throw Error('Missing or disabled browser menu action: ' + label);
    item.click();
  }, label);
}
try {
  app = await electron.launch({ args: [launcher], cwd: root, env: environment, timeout: 30000 });
  // Keep any previous clipboard data solely in the test process and restore it.
  // It is never serialized, logged, saved or sent to the assistant.
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.qaClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
    await clipboard.writeText('Synthetic clipboard fixture');
  });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByLabel('Filter providers', { exact: true }).fill('Gemini');
  const card = page.locator('[data-provider="gemini-cli"]');
  await card.getByRole('button', { name: 'Open Gemini for images & videos', exact: true }).waitFor();
  assert.match(await card.innerText(), /has no built-in image or video generator/);
  assert.match(await card.innerText(), /Antigravity CLI/);
  await card.screenshot({ path: path.join(output, 'gemini-connection.png') });
  await card.getByRole('button', { name: 'Open Gemini for images & videos', exact: true }).click();
  await page.getByRole('complementary', { name: 'Embedded browser', exact: true }).waitFor();
  await until(() => app.evaluate(() => globalThis.qaBrowser.requests.includes('https://gemini.google.com/app')));
  await until(() => page.evaluate(() => window.studio.invoke('browser.state')), state => !state.loading);
  report.checks.geminiWebsiteButton = { visible: true, opensEmbeddedBrowser: true, explainsCliLimit: true, requestBlockedInQa: true };
  await page.evaluate(url => window.studio.invoke('browser.navigate', { url }), url);
  await until(() => browserRead('document.querySelector("#image")?.complete'));
  await browserRead('document.querySelector("#field").focus(); document.querySelector("#field").select();');
  await rightClick('#field'); await menuAction('Copy');
  await until(() => app.evaluate(({ clipboard }) => clipboard.readText()), text => text === 'Synthetic edit');
  await app.evaluate(({ clipboard }) => clipboard.writeText('Synthetic paste'));
  await rightClick('#field'); await menuAction('Paste');
  await until(() => browserRead('document.querySelector("#field").value'), text => text === 'Synthetic paste');
  report.checks.editsTargetBrowserField = true;
  await browserRead('const range = document.createRange(); range.selectNodeContents(document.querySelector("#selection")); getSelection().removeAllRanges(); getSelection().addRange(range);');
  await rightClick('#selection'); await menuAction('Copy');
  await until(() => app.evaluate(({ clipboard }) => clipboard.readText()), text => text === 'Synthetic selection for copying');
  report.checks.selectedTextCopy = true;
  await rightClick('#link'); await menuAction('Copy link address');
  await until(() => app.evaluate(({ clipboard }) => clipboard.readText()), text => text === targetUrl);
  await menuAction('Open link in default browser');
  await until(() => app.evaluate((_electron, targetUrl) => globalThis.qaBrowser.external.includes(targetUrl), targetUrl));
  await menuAction('Open link'); await until(() => browserRead('location.href'), value => value === targetUrl);
  await rightClick('h1'); await menuAction('Back'); await until(() => browserRead('location.href'), value => value === url);
  report.checks.linkActionsAndHistory = true;
  await until(() => browserRead('document.querySelector("#image")?.complete'));
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await rightClick('#image'); await menuAction('Copy image');
  const dimensions = await until(() => app.evaluate(async ({ clipboard, nativeImage }) => {
    const item = (await clipboard.read()).find(item => item.types.includes('image/png'));
    if (!item) return null;
    return nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer())).getSize();
  }));
  assert.deepEqual(dimensions, { width: 1, height: 1 });
  report.checks.nativeImageCopy = true;
  const activity = await app.evaluate(() => ({ popups: globalThis.qaBrowser.popups, connects: globalThis.qaBrowser.connects, runs: globalThis.qaBrowser.runs }));
  assert.ok(activity.popups.length >= 6 && activity.popups.every(item => item.hasOwner));
  assert.deepEqual(activity.connects, []); assert.deepEqual(activity.runs, []);
  report.checks.noSignInOrModelCalls = true;
  report.checks.nativePopupInvocations = activity.popups.length;
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.failure = error.stack; process.exitCode = 1;
  if (app) report.requests = await app.evaluate(() => globalThis.qaBrowser.requests).catch(() => []);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  if (app) {
    await app.evaluate(async ({ clipboard }) => { const previous = globalThis.qaClipboard; if (previous) { if (previous.length) await clipboard.write(previous); else clipboard.clear(); } }).catch(() => {});
    await app.close().catch(() => {});
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (process.env.EXOMINA_QA_REPORT) await writeFile(process.env.EXOMINA_QA_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
