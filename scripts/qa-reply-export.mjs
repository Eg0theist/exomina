// Real host/renderer, isolated encrypted data, synthetic messages and file choices.
import { _electron as electron } from 'playwright';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createProtectedQaProfile } from './qa-profile.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), packageRoot = process.env.EXOMINA_QA_PACKAGE_DIR;
const runtime = packageRoot ? path.join(packageRoot, 'resources/app.asar') : project, host = packageRoot ? runtime + '.unpacked' : project;
const fixture = await createProtectedQaProfile('reply-export'), { profile, output } = fixture;
const workspace = path.join(output, 'workspace'), accounts = path.join(profile, 'accounts');
await mkdir(workspace); await mkdir(accounts);
const { Store } = await import(pathToFileURL(path.join(host, 'desktop/store.mjs')));
const store = new Store(profile, { workspace }); await store.init();
Object.assign(store.state.settings, { workspace, provider: 'codex', autoUpdate: false, autoTitle: false, closeToTray: false, quickAccess: false, permissionMode: 'ask', memoryEnabled: false, chatMemorySummaries: false, attentionNotifications: false, browserEnabled: false, desktopEnabled: false, decisionLayer: { enabled: false }, interfaceView: 'advanced' });
const content = '# A useful result\n\nA **clear** document with a source: [Example](https://example.com).\n\n| Item | Value |\n| --- | --- |\n| Budget | 42 |\n| Literal formula | =1+1 |\n| Reference | 00123 |\n| Unicode | Grüße 🦊 |\n\n## Next steps\n\n1. Check the figures.\n2. Share the file.\n';
const chat = store.create('codex'); chat.title = 'Reply export QA'; chat.titleSource = 'manual';
chat.messages = [{ id: 'fixture-user', role: 'user', provider: 'codex', content: 'Make a useful document.' }, { id: 'fixture-reply', role: 'assistant', provider: 'codex', content }];
const plain = store.create('codex'); plain.title = 'Plain reply QA'; plain.titleSource = 'manual'; plain.messages = [{ id: 'fixture-plain', role: 'assistant', provider: 'codex', content: 'A plain reply with no table.' }];
await store.save();
const url = file => JSON.stringify(pathToFileURL(path.join(runtime, file)).href), launcher = path.join(output, 'launcher.cjs');
await writeFile(launcher, `const{app,BrowserWindow,dialog,Notification,session}=require('electron');const path=require('node:path');app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile, 'browser-data'))});app.commandLine.appendSwitch('mute-audio');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};Notification.prototype.show=function(){};dialog.showErrorBox=(t,m)=>{console.error(t,m);app.exit(1)};global.__qaSaveCount=0;dialog.showSaveDialog=async(_window,options)=>global.__qaCancelSave?{canceled:true}:{canceled:false,filePath:path.join(${JSON.stringify(output)},'reply-'+(++global.__qaSaveCount)+'.'+options.filters[0].extensions[0])};(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_r,done)=>done({cancel:true}));const{ProviderManager}=await import(${url('desktop/providers.mjs')});ProviderManager.prototype.status=async()=>[{id:'codex',connected:true,installed:true,detail:'Synthetic'}];ProviderManager.prototype.subscriptionModels=async()=>({codex:[{id:'fixture',label:'Fixture',efforts:[]}]});ProviderManager.prototype.modelsFor=async()=>[{id:'fixture',label:'Fixture',efforts:[]}];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;ProviderManager.prototype.getCodex=async()=>{throw Error('Personal account access refused')};ProviderManager.prototype.run=async()=>{throw Error('Live inference refused')};await import(${url('desktop/main.mjs')});})().catch(e=>{console.error(e);app.exit(1)});`, 'utf8');
const env = { ...process.env, EXOMINA_DATA_DIR: profile, EXOMINA_ACCOUNTS_DIR: accounts, EXOMINA_WORKSPACE_DIR: workspace, TEMP: output, TMP: output, TMPDIR: output }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/token|secret|password|api_?key|credential|authorization/i.test(key)) delete env[key];
const report = { output, runtime, checks: {}, errors: [], limitations: ['Synthetic provider and native file choices. No personal data, live inference, Office rendering, audio quality or physical phone test.'] };
let app, page;
const invoke = (method, payload = {}) => page.evaluate(({ method, payload }) => window.studio.invoke(method, payload), { method, payload });
const openChat = id => page.locator('[data-chat-id="' + id + '"] .chat-open').click();
const verifyVisibleChoices = async menu => {
  await page.waitForFunction(() => { const menu = document.querySelector('.reply-export-menu'); return menu && getComputedStyle(menu).position === 'fixed' && menu.clientHeight >= 160 && menu.scrollHeight <= menu.clientHeight + 1; });
  const box = await menu.boundingBox();
  for (const item of await menu.getByRole('menuitem').all()) { const choice = await item.boundingBox(); assert.ok(choice.height >= 32 && choice.y >= box.y && choice.y + choice.height <= box.y + box.height + 1, 'Every format is fully visible inside the menu.'); }
};
try {
  app = await electron.launch({ args: [launcher], cwd: project, env, timeout: 40000 }); page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor(); await openChat(chat.id);
  const save = page.getByRole('button', { name: 'Save reply as a file', exact: true }); await save.waitFor();
  await save.click(); const menu = page.getByRole('menu', { name: 'Reply file format' }); await menu.waitFor();
  await verifyVisibleChoices(menu); report.checks.allFourChoicesVisible = true;
  assert.equal(await menu.getByRole('menuitem', { name: /Excel workbook/ }).isEnabled(), true);
  await page.screenshot({ path: path.join(output, 'reply-export-desktop.png') });
  await page.keyboard.press('Escape'); assert.equal(await menu.count(), 0); assert.equal(await save.evaluate(el => document.activeElement === el), true);
  report.checks.menuSupportsKeyboardAndEscape = true;
  await save.click(); await menu.getByRole('menuitem', { name: /^Word document/ }).focus(); await page.keyboard.press('Tab');
  assert.equal(await menu.count(), 0); assert.equal(await page.getByRole('button', { name: 'Read aloud', exact: true }).evaluate(el => document.activeElement === el), true);
  report.checks.tabReturnsToReplyActions = true;
  for (const [label, extension] of [['Word document', 'docx'], ['Excel workbook', 'xlsx'], ['Markdown', 'md'], ['Plain text', 'txt']]) {
    await save.click(); await menu.getByRole('menuitem', { name: new RegExp('^' + label) }).click();
    await page.locator('.reply-export-status').waitFor(); const filename = (await readdir(output)).find(file => file.endsWith('.' + extension)); assert.ok(filename);
    const bytes = await readFile(path.join(output, filename)); assert.ok(bytes.length > 40);
    if (['docx', 'xlsx'].includes(extension)) assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
    if (extension === 'md') assert.equal(bytes.toString('utf8'), content);
    report.checks['nativeSave' + extension.toUpperCase()] = true;
  }
  const before = (await readdir(output)).filter(name => /^reply-/.test(name)); await app.evaluate(() => { global.__qaCancelSave = true; });
  await save.click(); await menu.getByRole('menuitem', { name: /^Word document/ }).click(); await save.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.reply-export button').disabled); assert.deepEqual((await readdir(output)).filter(name => /^reply-/.test(name)), before);
  await app.evaluate(() => { global.__qaCancelSave = false; }); report.checks.cancelCreatesNoFile = true;
  await openChat(plain.id); await save.click(); const unavailableExcel = menu.getByRole('menuitem', { name: /Excel workbook/ }); assert.equal(await unavailableExcel.getAttribute('aria-disabled'), 'true');
  await menu.getByRole('menuitem', { name: /^Word document/ }).focus(); await page.keyboard.press('ArrowDown'); assert.equal(await unavailableExcel.evaluate(el => document.activeElement === el), true);
  assert.match(await unavailableExcel.innerText(), /Ask for a table/); await page.keyboard.press('Enter'); assert.equal(await menu.count(), 1); await page.keyboard.press('Escape'); report.checks.excelUnavailableWithoutTables = true;
  report.checks.unavailableFormatExplainedToKeyboardUsers = true;
  const message = page.getByRole('textbox', { name: 'Message', exact: true }); await message.fill('Keep this draft.');
  await page.getByRole('button', { name: 'Explore workspace', exact: true }).click(); const explore = page.getByRole('dialog', { name: 'Explore Exomina' });
  await page.getByRole('button', { name: /^Make a document or spreadsheet/ }).click();
  await page.getByRole('button', { name: 'Add to chat', exact: true }).click(); assert.match(await message.inputValue(), /^Keep this draft\.\n\nCreate/);
  assert.equal((await invoke('conversations.get', { id: plain.id })).messages.length, 1); report.checks.documentStarterPreservesDraftAndSendsNothing = true;
  await page.getByRole('button', { name: 'Explore workspace', exact: true }).click(); await page.getByRole('button', { name: /^Make something easier to understand/ }).click();
  assert.match(await page.locator('.explore-detail').innerText(), /worked example|comparison table|interactive/); await page.getByRole('button', { name: 'Close Explore', exact: true }).click(); report.checks.explanationStarterAvailable = true;
  await message.fill(''); await page.getByRole('button', { name: 'Voice options', exact: true }).click(); assert.equal(await page.getByRole('combobox', { name: 'Claude voice sample', exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: 'Load ChatGPT voices', exact: true }).count(), 1); await page.keyboard.press('Escape'); report.checks.voiceMenuKeepsRealControlsAndRemovesClaudeSamples = true;
  await page.locator('.sidebar-bottom button').filter({ hasText: 'Settings' }).click(); await page.getByRole('button', { name: 'Models & usage', exact: true }).click(); await page.getByRole('button', { name: 'Models & continuity', exact: true }).click();
  await page.getByText('How model updates and access work', { exact: true }).click(); assert.match(await page.locator('.model-access-note').innerText(), /free offer/); report.checks.modelAccessExplanationVisible = true;
  await page.getByRole('button', { name: 'Appearance & audio', exact: true }).click(); await page.getByRole('button', { name: 'Voice', exact: true }).click();
  assert.equal(await page.getByText('Claude voice samples', { exact: true }).count(), 0); assert.equal(await page.getByRole('combobox', { name: 'Speaking voice', exact: true }).count(), 1); report.checks.voiceSettingsKeepWindowsControls = true;
  await openChat(chat.id); await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(360, 600); window.setSize(420, 820); });
  await page.waitForFunction(() => innerWidth <= 440); await save.click(); await menu.waitFor(); const box = await menu.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= await page.evaluate(() => innerWidth) + 1); assert.ok(box.y >= 0 && box.y + box.height <= await page.evaluate(() => innerHeight) + 1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(380, 640));
  await page.waitForFunction(() => { const menu = document.querySelector('.reply-export-menu')?.getBoundingClientRect(); return menu && menu.left >= 0 && menu.right <= innerWidth + 1 && menu.top >= 0 && menu.bottom <= innerHeight + 1; });
  await verifyVisibleChoices(menu); report.checks.allChoicesVisibleAfterResize = true;
  await page.screenshot({ path: path.join(output, 'reply-export-narrow.png') }); await page.keyboard.press('Escape'); report.checks.narrowMenuFitsViewport = true; report.checks.openMenuFollowsResize = true;
  assert.deepEqual(report.errors, []); report.protection = await fixture.verify(); report.passed = true;
} catch (error) { report.error = error.stack; report.passed = false; if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await writeFile(path.join(output, 'failure-body.txt'), await page.locator('body').innerText().catch(() => ''), 'utf8'); } }
finally { if (app) await app.close(); await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8'); console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1; }
