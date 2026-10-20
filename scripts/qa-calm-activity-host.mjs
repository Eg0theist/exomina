// Production packaged desktop host, IPC, renderer and on-disk activity.
// The provider is replaced with canned events. The profile is fresh and synthetic.
import {_electron as electron} from 'playwright';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {extractFile} from '@electron/asar';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const runtimeRoot = path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT || (packaged ? path.join(root, 'release/win-unpacked/resources/app.asar') : root));
const unpackedRoot = runtimeRoot.endsWith('.asar') ? runtimeRoot + '.unpacked' : runtimeRoot;
const moduleUrl = file => pathToFileURL(path.join(runtimeRoot, file)).href;
const hostUrl = file => pathToFileURL(path.join(unpackedRoot, file)).href;
const {Store} = await import(hostUrl('desktop/store.mjs'));
const {RunActivity} = await import(hostUrl('desktop/activity.mjs'));
const artifact = {runtimeRoot, hostRoot: unpackedRoot, version: JSON.parse(runtimeRoot.endsWith('.asar') ? extractFile(runtimeRoot, 'package.json') : await readFile(path.join(root, 'package.json'), 'utf8')).version, files: {}};
if (runtimeRoot.endsWith('.asar')) {
  for (const file of ['desktop/main.mjs', 'desktop/activity.mjs', 'desktop/activity-visibility.mjs', 'desktop/providers.mjs', 'desktop/store.mjs', 'dist/index.html']) {
    const bytes = extractFile(runtimeRoot, path.normalize(file));
    assert.ok(bytes.equals(await readFile(path.join(root, file))), 'The packaged file must match current Source: ' + file);
    artifact.files[file] = {bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
  }
  const html = extractFile(runtimeRoot, 'dist/index.html').toString('utf8');
  const entry = /<script\b[^>]*src="\.\/([^" ]+\.js)"[^>]*><\/script>/.exec(html);
  assert.ok(entry, 'Packaged renderer entry is present');
  const bytes = extractFile(runtimeRoot, path.join('dist', entry[1]));
  assert.ok(bytes.equals(await readFile(path.join(root, 'dist', entry[1]))), 'Packaged renderer matches the current production build');
  artifact.entry = entry[1]; artifact.files['dist/' + entry[1]] = {bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
}
const fixture = await createProtectedQaProfile(packaged ? 'calm-activity-package' : 'calm-activity-host');
const {output, profile} = fixture, workspace = path.join(profile, 'workspace'), accounts = path.join(profile, 'accounts');
await mkdir(workspace); await mkdir(accounts);
const store = new Store(profile, {workspace}); await store.init();
Object.assign(store.state.settings, {workspace, provider: 'codex', model: 'fixture-model', autoTitle: false, autoUpdate: false, quickAccess: false, closeToTray: false, memoryEnabled: false, chatMemorySummaries: false, routing: 'tools', permissionMode: 'read-only', browserEnabled: false, desktopEnabled: false, decisionLayer: {enabled: false}, appearance: {theme: 'ink-wash', motion: 'reduced'}});
const chat = store.create('codex'); chat.title = 'Packaged calm activity QA'; chat.titleSource = 'manual';
const saved = {id: 'saved-reply', role: 'assistant', provider: 'codex', content: ''};
const prior = new RunActivity(saved, {conversationId: chat.id, emit: () => {}});
prior.delta('Earlier saved progress remains in the details.', 'first');
prior.thinking({id: 'saved-thinking', text: 'Synthetic saved provider reasoning.', start: true, done: true});
prior.tool({id: 'saved-failure', name: 'workspace_read', input: {path: 'saved.txt'}, status: 'running'});
prior.tool({id: 'saved-failure', status: 'error', output: 'Original saved failure output.'});
prior.tool({id: 'saved-retry', name: 'workspace_read', input: {path: 'saved.txt'}, status: 'running'});
prior.tool({id: 'saved-retry', status: 'done', outcomeConfirmed: true, output: 'The exact retry succeeded.'});
prior.permission('The saved provider connection was renewed.');
prior.tool({id: 'saved-denial', name: 'workspace_write', input: {path: 'denied.txt', text: 'Synthetic'}, status: 'running'});
prior.permission('The saved synthetic write was not allowed.', {denied: true});
saved.questions = [{id: 'saved-question', status: 'open', requireAnswer: true, createdAt: saved.startedAt, questions: [{id: 'format', question: 'Which format should the synthetic export use?', options: [{label: 'PDF'}, {label: 'Text'}]}]}];
prior.add({id: 'saved-question-row', kind: 'question', questionId: 'saved-question', status: 'done'});
saved.followups = [{id: 'saved-followup', text: 'Include the requested export.', status: 'answered', taskStatus: 'blocked', summary: 'The requested format is still needed.'}];
prior.add({id: 'saved-followup-row', kind: 'followup', followupId: 'saved-followup', status: 'done'});
prior.finish('Saved task retains the denied action and the unanswered question.');
chat.messages = [{id: 'saved-user', role: 'user', content: 'Synthetic saved task.'}, saved]; await store.save();

const launcher = path.join(output, 'launcher.cjs');
await writeFile(launcher, `const {app, BrowserWindow, dialog, session} = require('electron');
app.setPath('userData', ${JSON.stringify(profile)}); app.setPath('sessionData', ${JSON.stringify(path.join(profile, 'browser-data'))});
app.commandLine.appendSwitch('mute-audio'); app.commandLine.appendSwitch('disable-renderer-backgrounding');
BrowserWindow.prototype.show = function(){this.webContents.setBackgroundThrottling(false)};
app.getVersion = () => ${JSON.stringify(artifact.version)};
dialog.showErrorBox = (title,message) => {console.error(title,message);app.exit(1)};
globalThis.qaCalm = {requests: 0, emitted: [], emit: null, finish: null};
(async()=>{
await app.whenReady();
session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
const {ProviderManager} = await import(${JSON.stringify(moduleUrl('desktop/providers.mjs'))});
const {PROVIDER_CATALOG} = await import(${JSON.stringify(moduleUrl('desktop/provider-catalog.mjs'))});
ProviderManager.prototype.status = async function({onStatus}={}) {const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,detail:'Synthetic QA subscription'}));for(const row of rows)onStatus?.(row);return rows};
ProviderManager.prototype.subscriptionModels = async()=>({codex:[{id:'fixture-model',label:'Fixture',isDefault:true,efforts:[]}]});
ProviderManager.prototype.modelsFor = async()=>[{id:'fixture-model',label:'Fixture',isDefault:true,efforts:[]}];
ProviderManager.prototype.codexUsage = async()=>null; ProviderManager.prototype.claudeUsage = async()=>null;
ProviderManager.prototype.connect = async()=>{throw Error('QA sign-in refused')};
ProviderManager.prototype.getCodex = async()=>{throw Error('QA account access refused')};
ProviderManager.prototype.run = async function(request) {
 qaCalm.requests++; if(qaCalm.requests>1)throw Error('Unexpected extra provider call');
 qaCalm.emit = event => {if(typeof event?.type!=='string')throw Error('Synthetic provider event has no type');qaCalm.emitted.push({type:event.type,conversationId:request.conversationId});this.emit({...event,conversationId:request.conversationId});};
 await new Promise(resolve=>qaCalm.finish=resolve);
 return {text:'Synthetic live task finished with its denied action recorded.',sessionId:'synthetic'};
};
await import(${JSON.stringify(moduleUrl('desktop/main.mjs'))});
})().catch(error=>{console.error(error);app.exit(1)});`, 'utf8');
const env = {...process.env, EXOMINA_DATA_DIR: profile, EXOMINA_ACCOUNTS_DIR: accounts, EXOMINA_WORKSPACE_DIR: workspace, TEMP: output, TMP: output, TMPDIR: output};
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/token|secret|password|api_?key|credential|authorization/i.test(key)) delete env[key];
const report = {scope: (packaged ? 'Actual packaged' : 'Production source') + ' desktop host, IPC, compiled renderer and encrypted on-disk activity. Canned provider events, fresh synthetic profile, external requests blocked; no account access or native inference.', artifact, output, checks: {}, errors: []};
let app, page;
const invoke = (method, payload = {}) => page.evaluate(({method, payload}) => window.studio.invoke(method, payload), {method, payload});
async function until(read, accept = Boolean, label = 'QA state') {const end = Date.now() + 15000; for (;;) {const value = await read(); if (accept(value)) return value; if (Date.now() > end) throw Error(label + ' timed out'); await new Promise(resolve => setTimeout(resolve, 60));}}
async function launch() {
  app = await electron.launch({args: [launcher], cwd: root, env, timeout: 30000}); page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', {name: 'Exomina home', exact: true}).waitFor();
  await until(() => invoke('bootstrap'), value => value.connections.some(row => row.id === 'codex' && row.connected), 'Synthetic provider startup');
  await page.locator('[data-chat-id="' + chat.id + '"] .chat-open').click();
  await page.getByRole('button', {name: 'Close question popup', exact: true}).click();
  await page.getByRole('combobox', {name: 'Interface view', exact: true}).selectOption('standard');
}
// ElectronApplication.evaluate supplies Electron exports first and the explicit
// argument second, unlike Page.evaluate. Inject only the canned provider event.
const emit = event => app.evaluate((_electron, event) => qaCalm.emit(event), event);
try {
  await launch();
  let savedWork = page.locator('.activity').first();
  assert.equal(await savedWork.locator('.activity-updates .status-error').count(), 0);
  assert.equal(await savedWork.locator('.activity-updates .status-denied').count(), 1);
  assert.equal(await savedWork.getByText('Synthetic saved provider reasoning.', {exact: true}).count(), 0);
  await savedWork.getByRole('button', {name: 'Send answer', exact: true}).waitFor(); await savedWork.getByText('Needs attention', {exact: true}).waitFor();
  await savedWork.locator('.activity-problem-details').click();
  await savedWork.getByText('The same action succeeded on a later attempt.', {exact: true}).waitFor();
  await savedWork.getByText('The saved synthetic write was not allowed.', {exact: true}).waitFor();
  const failed = savedWork.locator('.activity-work-details .activity-step.tool.status-error'); await failed.locator('.step-head').click(); await failed.getByText('Original saved failure output.', {exact: true}).waitFor();
  await savedWork.getByRole('button', {name: /^Thought for/}).click(); await savedWork.getByText('Synthetic saved provider reasoning.', {exact: true}).waitFor();
  await savedWork.locator('.activity-head').click();
  report.checks.packagedSavedTimelinePreservesQuestionBlockedFollowupFailureAndDenialDetails = true;
  await invoke('chat.send', {conversationId: chat.id, provider: 'codex', model: 'fixture-model', text: 'Synthetic live activity QA.', mode: 'tools'});
  await until(() => app.evaluate(() => typeof qaCalm.emit === 'function'), Boolean, 'Synthetic provider ready');
  await emit({type: 'chat.delta', block: 'before', text: 'Earlier live progress goes into details.'});
  await emit({type: 'chat.thinking', id: 'live-thinking', text: 'Synthetic live provider reasoning.', start: true, done: true});
  await emit({type: 'chat.tool', id: 'live-failure', name: 'workspace_read', input: {path: 'live.txt'}, status: 'running'});
  await emit({type: 'chat.tool', id: 'live-failure', status: 'error', output: 'Original live read failure.'});
  await emit({type: 'chat.notice', text: 'The live provider connection was renewed.'});
  await emit({type: 'chat.delta', block: 'current', text: 'Current live progress is visible.'});
  await emit({type: 'chat.tool', id: 'live-denial', name: 'workspace_write', input: {path: 'unwritten.txt', text: 'Synthetic'}, status: 'running'});
  await emit({type: 'chat.tool', id: 'live-denial', status: 'denied', output: 'Live write was not allowed.'});
  const liveState = await invoke('conversations.get', {id: chat.id});
  assert.ok(liveState.messages.at(-1).activity.some(step => step.id === 'live-failure' && step.status === 'error'), 'The actual host recorded the injected live failure');
  assert.equal(await app.evaluate(() => qaCalm.emitted.length), 8);
  let liveWork = page.locator('.activity').last();
  await liveWork.locator('.activity-updates').getByText('Current live progress is visible.', {exact: true}).waitFor();
  assert.equal(await liveWork.locator('.activity-updates .status-error').count(), 1);
  assert.equal(await liveWork.locator('.activity-updates .status-denied').count(), 1);
  assert.equal(await liveWork.getByText('Synthetic live provider reasoning.', {exact: true}).count(), 0);
  assert.equal(await liveWork.getByText('Earlier live progress goes into details.', {exact: true}).count(), 0);
  assert.equal(await liveWork.getByText('The live provider connection was renewed.', {exact: true}).count(), 0);
  await emit({type: 'chat.tool', id: 'live-retry', name: 'workspace_read', input: {path: 'live.txt'}, status: 'running'});
  await emit({type: 'chat.tool', id: 'live-retry', status: 'done', outcomeConfirmed: true, output: 'Explicit later success.'});
  await liveWork.locator('.activity-updates .status-error').waitFor({state: 'hidden'});
  assert.equal(await liveWork.locator('.activity-updates .status-denied').count(), 1);
  report.checks.actualPackagedHostLiveEventsQuietOnlyConfirmedMatchingRetry = true;
  await liveWork.locator('.activity-problem-details').click();
  await liveWork.getByText('The same action succeeded on a later attempt.', {exact: true}).waitFor();
  await liveWork.getByText('Earlier live progress goes into details.', {exact: true}).waitFor();
  await liveWork.getByText('The live provider connection was renewed.', {exact: true}).waitFor();
  await liveWork.getByRole('button', {name: /^Thought for/}).click(); await liveWork.getByText('Synthetic live provider reasoning.', {exact: true}).waitFor();
  const liveFailure = liveWork.locator('.activity-work-details .activity-step.tool.status-error'); await liveFailure.locator('.step-head').click(); await liveFailure.getByText('Original live read failure.', {exact: true}).waitFor();
  await page.screenshot({path: path.join(output, 'packaged-standard-live-details.png')});
  report.checks.packagedDisclosurePreservesReasoningNarrationNoticeAndOriginalError = true;
  await page.getByRole('combobox', {name: 'Interface view', exact: true}).selectOption('advanced');
  await liveWork.locator('.activity-updates .status-error').waitFor();
  await liveWork.locator('.activity-updates').getByText('Earlier live progress goes into details.', {exact: true}).waitFor();
  await liveWork.locator('.activity-updates').getByText('The live provider connection was renewed.', {exact: true}).waitFor();
  report.checks.packagedAdvancedKeepsFullDiagnosticHistory = true;
  await emit({type: 'chat.tool', id: 'live-unconfirmed', name: 'workspace_shell', input: {command: 'synthetic unknown result'}, status: 'done', output: 'Result receipt only.'});
  await emit({type: 'chat.tool', id: 'live-unfinished', name: 'workspace_write', input: {path: 'unfinished.txt', text: 'Synthetic'}, status: 'running'});
  await app.evaluate(() => qaCalm.finish());
  await page.getByText('Synthetic live task finished with its denied action recorded.', {exact: false}).waitFor();
  await until(() => invoke('conversations.get', {id: chat.id}), value => !!value.messages.at(-1).finishedAt, 'Saved final activity');
  await app.evaluate(({app}) => app.exit(0)); await app.close().catch(() => {}); app = null;
  await launch(); assert.equal(await app.evaluate(() => qaCalm.requests), 0);
  savedWork = page.locator('.activity').first(); liveWork = page.locator('.activity').last();
  const restored = await invoke('conversations.get', {id: chat.id}), rows = restored.messages.at(-1).activity;
  assert.equal(rows.find(step => step.id === 'live-failure').status, 'error'); assert.equal(rows.find(step => step.id === 'live-failure').output, 'Original live read failure.');
  assert.equal(rows.find(step => step.id === 'live-retry').outcomeConfirmed, true); assert.equal(rows.find(step => step.id === 'live-denial').status, 'denied');
  assert.equal(rows.find(step => step.id === 'live-unconfirmed').outcomeConfirmed, false);
  assert.equal(rows.find(step => step.id === 'live-unfinished').status, 'stopped');
  assert.equal(rows.find(step => step.id === 'live-unfinished').outcomeConfirmed, false);
  await liveWork.locator('.activity-warning').waitFor(); assert.equal(await liveWork.locator('.activity-updates .status-error').count(), 0);
  assert.equal(await liveWork.locator('.activity-updates .status-denied').count(), 1);
  await liveWork.locator('.activity-head').click(); await liveWork.getByText('The same action succeeded on a later attempt.', {exact: true}).waitFor();
  await liveWork.locator('.activity-updates .status-unknown').waitFor(); await liveWork.locator('.activity-updates .status-stopped').waitFor();
  await liveWork.locator('.activity-work-details .tool.status-unknown').getByText('Running a command (result not confirmed)', {exact: true}).waitFor();
  await liveWork.locator('.activity-work-details .tool.status-stopped').getByText('Writing a file (completion not confirmed)', {exact: true}).waitFor();
  assert.equal(await liveWork.locator('.tool.status-unknown .step-state.done,.tool.status-stopped .step-state.done').count(), 0);
  report.checks.packagedUnknownAndAutoClosedActionsRemainWarningsWithTruthfulTitles = true;
  await savedWork.getByRole('button', {name: 'Send answer', exact: true}).waitFor(); await savedWork.getByText('Needs attention', {exact: true}).waitFor();
  report.checks.realHostRestartRestoresExactEvidenceAndControlsWithoutAnotherProviderRun = true;
  await page.setViewportSize({width: 760, height: 900});
  const bounds = await liveWork.evaluate(element => {const box = element.getBoundingClientRect(); return {left: box.left, right: box.right, width: innerWidth};});
  assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1); await page.screenshot({path: path.join(output, 'packaged-standard-restored-narrow.png')});
  report.checks.packagedNarrowTimelineFits = true;
  assert.deepEqual(report.errors, []); report.protection = await fixture.verify(); report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
  if (page) await page.screenshot({path: path.join(output, 'failure.png')}).catch(() => {});
} finally {
  if (app) {await app.evaluate(({app}) => app.exit(0)).catch(() => {}); await app.close().catch(() => {});}
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report, null, 2));
}
