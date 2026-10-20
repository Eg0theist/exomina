// Real production renderer/IPC with synthetic profiles and an independent Explorer check.
import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractFile } from '@electron/asar';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT || root);
const baseline = process.env.EXOMINA_QA_BASELINE === '1';
const realExplorer = process.env.EXOMINA_QA_REAL_EXPLORER === '1';
const fileMenu = process.env.EXOMINA_QA_FILE_MENU === '1';
assert.ok(!baseline || !realExplorer, 'The old file-launch behavior is intercepted, never forwarded.');
const reportDir = path.resolve(process.env.EXOMINA_QA_REPORT_DIR || '../Workspace/file-explorer-links-20261012/link-qa');
await mkdir(reportDir, { recursive: true });
const fixture = await createProtectedQaProfile('chat-links'), { profile, output } = fixture;
const workspace = path.join(output, 'workspace'), project = path.join(output, 'project (spaces)'), folder = path.join(project, 'My folder (2)');
const file = path.join(project, 'Résumé report (final).txt'), executable = path.join(project, 'Synthetic.exe'), bareFile = path.join(workspace, 'plain.txt');
const bareLink = pathToFileURL(bareFile).href;
const compactFile = path.join(workspace, 'plain-again.txt'), compactLink = pathToFileURL(compactFile).href;
const explorerFolder = path.join(project, 'Explorer proof'), explorerFile = path.join(explorerFolder, 'Selected report (proof).txt');
for (const directory of [workspace, folder, explorerFolder]) await mkdir(directory, { recursive: true });
for (const filePath of [file, executable, explorerFile, bareFile, compactFile]) await writeFile(filePath, 'Synthetic Exomina link verification.');
const asLinkPath = filePath => filePath.replaceAll('\\', '/');
const markdown = (label, target) => `[${label}](<${target}>)`;
const store = new Store(profile, { workspace }); await store.init();
Object.assign(store.state.settings, { workspace, autoUpdate: false, autoTitle: false, closeToTray: false, memoryEnabled: false, chatMemorySummaries: false, browserEnabled: false, desktopEnabled: false, routing: 'tools' });
store.state.projects = [{ id: 'link-project', name: 'Synthetic link project', folder: project, files: [], instructions: '' }];
const chat = store.create('codex'); chat.title = 'Explorer link verification'; chat.titleSource = 'manual'; chat.projectId = 'link-project';
chat.messages = [{ role: 'user', content: markdown('User file', asLinkPath(file)) }, { role: 'assistant', provider: 'codex', content: [
  markdown('Report with line', '/' + asLinkPath(file) + ':12:3'), markdown('File URL', pathToFileURL(file).href),
  markdown('Project relative file', './Résumé report (final).txt'), markdown('Folder link', asLinkPath(folder)),
  '`' + file + '`', bareLink + ' and ' + compactLink, markdown('Executable location', asLinkPath(executable)), markdown('Missing file', './missing.txt'),
  markdown('Private file', asLinkPath(path.join(profile, 'state.json'))), markdown('Explorer proof', asLinkPath(explorerFile)),
].join('\n\n') }]; await store.save();
const version = JSON.parse(runtimeRoot.endsWith('.asar') ? extractFile(runtimeRoot, 'package.json') : await readFile(path.join(runtimeRoot, 'package.json'), 'utf8')).version;
const moduleUrl = relative => JSON.stringify(pathToFileURL(path.join(runtimeRoot, relative)).href);
const launcher = path.join(output, 'launcher.cjs');
await writeFile(launcher, `const {app,BrowserWindow,session,shell,dialog,Menu,clipboard}=require('electron');
BrowserWindow.prototype.show=function(){};app.commandLine.appendSwitch('mute-audio');app.getVersion=()=>${JSON.stringify(version)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qaLinks={calls:[],openActual:false,menus:[],menuActions:[],otherMenuPopups:0};const actualReveal=shell.showItemInFolder.bind(shell),actualFolder=shell.openPath.bind(shell);
shell.openPath=async file=>{globalThis.qaLinks.calls.push({kind:'openPath',path:file});if(globalThis.qaLinks.openError)return globalThis.qaLinks.openError;return globalThis.qaLinks.openActual?actualFolder(file):'';};
shell.showItemInFolder=file=>{globalThis.qaLinks.calls.push({kind:'showItemInFolder',path:file});if(globalThis.qaLinks.openActual)actualReveal(file);};
shell.openExternal=async url=>{globalThis.qaLinks.calls.push({kind:'external',url});};
if(${JSON.stringify(fileMenu)}){const originalBuild=Menu.buildFromTemplate.bind(Menu);
 clipboard.writeText=value=>{globalThis.qaLinks.copiedPath=value;};
 Menu.buildFromTemplate=template=>{const fileMenu=template.some(item=>item.label==='Show in Explorer');const nativeTemplate=fileMenu?template.map(item=>({...item,click:async(...args)=>{try{return await item.click(...args);}finally{globalThis.qaLinks.menuActions.push(item.label);}}})):template;const menu=originalBuild(nativeTemplate);menu.popup=options=>{if(fileMenu){globalThis.qaLinks.currentMenu={menu,options};globalThis.qaLinks.menus.push({labels:menu.items.map(item=>item.label),enabled:menu.items.map(item=>item.enabled),x:options.x,y:options.y,owned:options.window instanceof BrowserWindow});}else{globalThis.qaLinks.otherMenuPopups++;options.callback?.();}};return menu;};
}
(async()=>{await app.whenReady();for(const partition of [session.defaultSession,session.fromPartition('persist:exomina-browser')])partition.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
const {ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const {PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,installed:true,connected:item.id==='codex',available:true,checking:false,detail:'Synthetic connection'}));for(const row of rows)onStatus?.(row);return rows;};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.getCodex=async()=>{throw Error('Live account access is prohibited in link QA')};ProviderManager.prototype.run=async()=>{throw Error('Live inference is prohibited in link QA')};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`);
const env = { ...process.env, EXOMINA_DATA_DIR: profile, EXOMINA_ACCOUNTS_DIR: profile, EXOMINA_WORKSPACE_DIR: workspace, TEMP: output, TMP: output, TMPDIR: output };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/(?:token|secret|password|api_?key|credential|authorization)/i.test(key)) delete env[key];
const report = { runtimeRoot, version, baseline, realExplorer, fileMenu, output, scope: 'Synthetic profile and provider. Production Markdown, mouse clicks, IPC and link handler. File menus use real native Menu objects; popup display, default-app launches and clipboard writes are intercepted. External navigation blocked. No personal account stores or model calls.', checks: {}, errors: [] };
let app, page;
const calls = () => app.evaluate(() => globalThis.qaLinks.calls);
async function clickAndExpect(label, kind, expectedPath) {
  const before = (await calls()).length;
  await page.getByRole('link', { name: label, exact: true }).click();
  await page.waitForFunction(length => globalThis.document && !document.querySelector('.feedback.error') && document.querySelectorAll('.message').length === 2, before);
  await app.evaluate(async (_e, length) => { const deadline = Date.now() + 5000; while (globalThis.qaLinks.calls.length === length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); }, before);
  const after = await calls();
  assert.equal(after.length, before + 1, 'A mouse click must reach the handler exactly once.');
  assert.deepEqual(after.at(-1), { kind, path: expectedPath });
}
const explorerScript = path.join(root, 'scripts/qa-chat-links-explorer.ps1');
const explorerState = async close => {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', explorerScript, '-Folder', explorerFolder, '-ExpectedFile', explorerFile];
  if (close) args.push('-CloseMatchedWindow');
  const { stdout } = await promisify(execFile)('powershell.exe', args, { windowsHide: true, timeout: 15000 });
  return JSON.parse(stdout.trim());
};
async function menuFor(label) {
  const before = await app.evaluate(() => globalThis.qaLinks.menus.length);
  await page.getByRole('link', { name: label, exact: true }).click({ button: 'right' });
  await app.evaluate(async (_e, count) => { const deadline = Date.now() + 5000; while (globalThis.qaLinks.menus.length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); }, before);
  const state = await app.evaluate(() => ({ count: globalThis.qaLinks.menus.length, menu: globalThis.qaLinks.menus.at(-1), other: globalThis.qaLinks.otherMenuPopups }));
  assert.equal(state.count, before + 1); assert.equal(state.other, 0);
  assert.deepEqual(state.menu.labels, ['Show in Explorer', 'Open with default app', 'Copy path']);
  assert.equal(state.menu.owned, true); assert.ok(Number.isInteger(state.menu.x) && Number.isInteger(state.menu.y));
  return state.menu;
}
async function chooseMenu(label) {
  await app.evaluate(async (_e, label) => { const qa = globalThis.qaLinks, current = qa.currentMenu, item = current.menu.items.find(item => item.label === label), before = qa.menuActions.length; if (!item?.enabled) throw Error('Menu action is disabled'); item.click(); current.options.callback(); const deadline = Date.now() + 5000; while (qa.menuActions.length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); if (qa.menuActions.length !== before + 1) throw Error('Menu callback did not complete exactly once'); }, label);
}
try {
  app = await electron.launch({ args: [launcher], cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('.chat-open').filter({ hasText: chat.title }).click();
  await clickAndExpect('Report with line', baseline ? 'openPath' : 'showItemInFolder', file);
  report.checks.reportLink = baseline ? 'Reproduced: the file itself went to openPath instead of Explorer selection.' : true;
  if (baseline) {
    const before = (await calls()).length;
    await page.getByRole('link', { name: file, exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal((await calls()).length, before);
    assert.ok(report.errors.includes("Cannot read properties of null (reading '2')"));
    await page.getByRole('link', { name: bareLink, exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal((await calls()).length, before);
    assert.ok(report.errors.includes("Cannot read properties of null (reading '10')"));
    report.checks.inlineCodeAndBarePathClickFailure = 'Reproduced: both callbacks read a cleared regex match, throw and never reach IPC.';
  } else {
    for (const label of ['User file', 'File URL', 'Project relative file', file]) await clickAndExpect(label, 'showItemInFolder', file);
    report.checks.userMarkdownFileUrlInlineCodeAndProjectWorkspace = true;
    await clickAndExpect(bareLink, 'showItemInFolder', bareFile);
    await clickAndExpect(compactLink, 'showItemInFolder', compactFile);
    report.checks.twoBareLinksInOneParagraph = true;
    await clickAndExpect('Executable location', 'showItemInFolder', executable); report.checks.executableRevealedWithoutLaunch = true;
    await clickAndExpect('Folder link', 'openPath', folder); report.checks.folderOpened = true;
    if (fileMenu) {
      await menuFor('Report with line'); await chooseMenu('Show in Explorer');
      assert.deepEqual((await calls()).at(-1), { kind: 'showItemInFolder', path: file });
      await menuFor('Project relative file'); await chooseMenu('Copy path');
      assert.equal(await app.evaluate(() => globalThis.qaLinks.copiedPath), file);
      await menuFor('File URL'); await chooseMenu('Open with default app');
      assert.deepEqual((await calls()).at(-1), { kind: 'openPath', path: file });
      await menuFor(file); await chooseMenu('Copy path'); assert.equal(await app.evaluate(() => globalThis.qaLinks.copiedPath), file);
      await menuFor(bareLink); await chooseMenu('Copy path'); assert.equal(await app.evaluate(() => globalThis.qaLinks.copiedPath), bareFile);
      await menuFor('User file'); await chooseMenu('Copy path'); assert.equal(await app.evaluate(() => globalThis.qaLinks.copiedPath), file);
      await menuFor('Folder link'); await chooseMenu('Open with default app'); assert.deepEqual((await calls()).at(-1), { kind: 'openPath', path: folder });
      const missingMenu = await menuFor('Missing file'); assert.deepEqual(missingMenu.enabled, [false, false, true]);
      await chooseMenu('Copy path'); assert.equal(await app.evaluate(() => globalThis.qaLinks.copiedPath), path.join(project, 'missing.txt'));
      const beforeCancel = (await calls()).length;
      await menuFor('Report with line'); await app.evaluate(() => globalThis.qaLinks.currentMenu.options.callback());
      assert.equal((await calls()).length, beforeCancel);
      await menuFor('Report with line'); await app.evaluate(() => { globalThis.qaLinks.openError = 'Synthetic association failure'; });
      await chooseMenu('Open with default app');
      await page.getByRole('alert').filter({ hasText: 'The default app could not open this file: Synthetic association failure' }).waitFor();
      await app.evaluate(() => { globalThis.qaLinks.openError = null; });
      await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
      const beforePrivateMenu = await app.evaluate(() => globalThis.qaLinks.menus.length);
      await page.getByRole('link', { name: 'Private file', exact: true }).click({ button: 'right' });
      await page.getByRole('alert').filter({ hasText: 'account stores and app data are outside' }).waitFor();
      assert.equal(await app.evaluate(() => globalThis.qaLinks.menus.length), beforePrivateMenu);
      await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
      report.checks.fileMenu = { threeNativeItems: true, lineNumberLink: true, projectRelativeCopy: true, fileUrlDefaultApp: true, codeBareAndUserLinks: true, folderActions: true, missingFileCopyWithOpenDisabled: true, cancelWithoutAction: true, visibleDefaultAppError: true, privateMenuRefused: true };
    }
    await page.getByRole('link', { name: 'Missing file', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'This path no longer exists:' }).waitFor(); report.checks.missingFileVisibleError = true;
    const beforePrivate = (await calls()).length;
    await page.getByRole('link', { name: 'Private file', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'account stores and app data are outside' }).waitFor();
    assert.equal((await calls()).length, beforePrivate); report.checks.privateDataRefused = true;
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await page.evaluate(() => window.studio.invoke('app.openLink', { url: 'https://example.invalid/unchanged-web-route' }));
    assert.deepEqual((await calls()).at(-1), { kind: 'external', url: 'https://example.invalid/unchanged-web-route' }); report.checks.webRouteRetained = true;
    if (realExplorer) {
      await app.evaluate(() => { globalThis.qaLinks.openActual = true; });
      await clickAndExpect('Explorer proof', 'showItemInFolder', explorerFile);
      report.checks.realExplorer = await explorerState(false);
      assert.equal(report.checks.realExplorer.folderFound, true); assert.equal(report.checks.realExplorer.expectedFileSelected, true);
      await app.evaluate(() => { globalThis.qaLinks.openActual = false; });
    }
    await page.reload(); await page.locator('.chat-open').filter({ hasText: chat.title }).click();
    await clickAndExpect('Report with line', 'showItemInFolder', file); report.checks.afterReload = true;
    if (fileMenu) { await menuFor('Report with line'); await chooseMenu('Copy path'); assert.equal(await app.evaluate(() => globalThis.qaLinks.copiedPath), file); report.checks.fileMenu.afterReload = true; }
  }
  if (!baseline) assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.error = error.stack; if (page) await page.screenshot({ path: path.join(reportDir, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (realExplorer) report.explorerCleanup = await explorerState(true).catch(error => ({ error: error.message }));
  if (app) { report.calls = await calls().catch(() => []); if (fileMenu) report.menus = await app.evaluate(() => globalThis.qaLinks.menus).catch(() => []); await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  report.protection = await fixture.verify();
  await writeFile(path.join(reportDir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, baseline, checks: report.checks, error: report.error, report: path.join(reportDir, 'result.json') }));
}
