// Hidden Electron, production renderer and RunActivity, synthetic data only.
// External requests are blocked. No accounts, provider processes or model calls.
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {RunActivity} from '../desktop/activity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || '../Workspace/qa-calm-activity');
await mkdir(output, {recursive: true});
const events = [], message = {id: 'calm-reply', role: 'assistant', provider: 'codex', content: ''};
const activity = new RunActivity(message, {conversationId: 'c1', emit: event => events.push(structuredClone(event))});
activity.delta('Earlier update retained in work details.', 'first');
activity.thinking({id: 'thinking', text: 'Synthetic detailed provider reasoning.', start: true, done: true});
activity.tool({id: 'recoverable', name: 'workspace_read', input: {path: 'recovered.txt'}, status: 'running'});
activity.tool({id: 'recoverable', status: 'error', output: 'Original recoverable failure detail.'});
activity.tool({id: 'retry', name: 'workspace_read', input: {path: 'recovered.txt'}, status: 'running'});
activity.tool({id: 'retry', status: 'done', outcomeConfirmed: true, output: 'Explicit successful retry.'});
activity.permission('The provider connection was renewed.');
activity.tool({id: 'unresolved', name: 'workspace_write', input: {path: 'blocked.txt', text: 'Synthetic'}, status: 'running'});
activity.permission('The user declined this synthetic write.', {denied: true});
activity.native({kind: 'reroute', threadId: 'synthetic', turnId: 'turn', fromModel: 'first-model', toModel: 'second-model', reason: 'synthetic'});
const question = {id: 'calm-question', status: 'open', requireAnswer: true, waitingForAnswer: true, questions: [{id: 'format', question: 'Which export format should I use?', options: [{label: 'PDF'}, {label: 'Text'}]}]};
message.questions = [question];
activity.add({id: 'question-row', kind: 'question', questionId: question.id, status: 'done'});
message.followups = [{id: 'calm-followup', text: 'Include the requested export.', status: 'answered', taskStatus: 'blocked', summary: 'An export format is needed.'}];
activity.add({id: 'followup-row', kind: 'followup', followupId: 'calm-followup', status: 'done'});
activity.delta('Current plain progress is visible.', 'last'); activity.cut();
message.content = 'The task is still working.';
const live = structuredClone(message);
const final = structuredClone(message); final.content = 'Synthetic task finished with the blocked action recorded.'; final.finishedAt = new Date().toISOString();
const fixture = `
localStorage.setItem('exomina.interfaceView', 'standard');
const chat = await window.studio.invoke('conversations.get', {id:'c1'});
chat.title = 'Calm activity QA'; chat.provider = 'codex';
chat.messages = [{id:'user',role:'user',content:'Run a synthetic task.'}, new URL(location.href).searchParams.has('final') ? ${JSON.stringify(final)} : ${JSON.stringify(live)}];
window.__exominaPreviewReplaceChat(chat);
window.__exominaPreviewSetRun('c1', new URL(location.href).searchParams.has('final') ? null : ${JSON.stringify(message.startedAt)});
window.__qaEvents = input => {for(const event of input) window.__exominaPreviewEmit(event);};
`;
const prefix = '/__qa_calm/';
const plugin = {name: 'isolated-calm-activity-fixture', configureServer(server) {server.middlewares.use((request, response, next) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === prefix + 'index.html') {response.setHeader('Content-Type', 'text/html'); return response.end('<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="./entry.mjs"></script></body></html>');}
  if (pathname === prefix + 'entry.mjs') {response.setHeader('Content-Type', 'text/javascript'); return response.end(`import '/preview/mock-studio.mjs';\n${fixture}\nawait import('/src/main.jsx');`);}
  next();
});}};
const server = await createServer({root, plugins: [plugin], server: {port: 0, hmr: false}, logLevel: 'error'}); await server.listen();
const url = `http://localhost:${server.config.server.port}${prefix}index.html`;
const env = {...process.env, EXOMINA_DESIGN_QA_DIR: output, EXOMINA_DESIGN_QA_URL: url}; delete env.ELECTRON_RUN_AS_NODE;
const report = {scope: 'Hidden Electron production source renderer; synthetic persisted and live activity from RunActivity; fresh local QA profile and external requests blocked.', output, checks: {}, errors: []};
let app, page;
try {
  app = await electron.launch({args: [path.join(root, 'scripts/qa-design-main.cjs')], cwd: root, env, timeout: 30000});
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort());
  await page.locator('[data-chat-id="c1"] .chat-open').click();
  await page.getByRole('button', {name: 'Close question popup', exact: true}).click();
  const work = page.locator('.activity').last();
  await work.locator('.activity-updates').getByText('Current plain progress is visible.', {exact: true}).waitFor();
  assert.equal(await work.getByText('Earlier update retained in work details.', {exact: true}).count(), 0);
  assert.equal(await work.getByText('Synthetic detailed provider reasoning.', {exact: true}).count(), 0);
  assert.equal(await work.locator('.activity-updates .status-error').count(), 0);
  assert.equal(await work.locator('.activity-updates .status-denied').count(), 1);
  assert.equal(await work.getByText('The provider connection was renewed.', {exact: true}).count(), 0);
  assert.equal(await work.getByText('Model changed to second-model', {exact: true}).count(), 0);
  await work.getByRole('button', {name: 'Send answer', exact: true}).waitFor();
  await work.getByText('Needs attention', {exact: true}).waitFor();
  report.checks.standardLatestProgressAndRequiredQuestionsAndBlockedFollowupsVisible = true;
  report.checks.recoveredAttemptsAndProviderHistoryQuietButDenialVisible = true;
  const problemDetails = work.locator('.activity-problem-details');
  for (let index = 0; index < 2; index++) {
    await problemDetails.click(); assert.equal(await work.locator('.activity-head').getAttribute('aria-expanded'), 'true');
    await work.locator('.activity-work-details').getByText('Earlier update retained in work details.', {exact: true}).waitFor();
    await work.getByText('The same action succeeded on a later attempt.', {exact: true}).waitFor();
    await work.getByText('The provider connection was renewed.', {exact: true}).waitFor();
    await problemDetails.click(); assert.equal(await work.locator('.activity-head').getAttribute('aria-expanded'), 'false');
    assert.equal(await work.locator('.activity-work-details').count(), 0);
  }
  await problemDetails.click();
  const recovered = work.locator('.activity-work-details .activity-step.tool.status-error');
  await recovered.locator('.step-head').click();
  await recovered.getByText('Original recoverable failure detail.', {exact: true}).waitFor();
  const denied = work.locator('.activity-work-details .activity-step.tool.status-denied');
  await denied.getByText('The user declined this synthetic write.', {exact: true}).waitFor();
  await work.getByRole('button', {name: /^Thought for/}).click();
  await work.getByText('Synthetic detailed provider reasoning.', {exact: true}).waitFor();
  report.checks.disclosureTogglesAndPreservesReasoningOriginalFailureAndDenialReason = true;
  await page.screenshot({path: path.join(output, 'standard-open.png')});
  await work.locator('.activity-head').click();
  const before = events.length;
  activity.tool({id: 'new-failure', name: 'workspace_read', input: {path: 'live.txt'}, status: 'running'});
  activity.tool({id: 'new-failure', status: 'error', output: 'Unresolved live read error.'});
  await page.evaluate(input => window.__qaEvents(input), events.slice(before));
  await work.locator('.activity-updates .status-error').waitFor();
  const after = events.length;
  activity.tool({id: 'live-retry', name: 'workspace_read', input: {path: 'live.txt'}, status: 'running'});
  activity.tool({id: 'live-retry', status: 'done', outcomeConfirmed: true});
  await page.evaluate(input => window.__qaEvents(input), events.slice(after));
  await work.locator('.activity-updates .status-error').waitFor({state: 'hidden'});
  assert.equal(await work.locator('.activity-updates .status-denied').count(), 1);
  report.checks.liveExplicitRetryQuietsOnlyItsMatchingFailure = true;
  await page.getByLabel('Interface view', {exact: true}).selectOption('advanced');
  await work.locator('.activity-updates').getByText('Earlier update retained in work details.', {exact: true}).waitFor();
  await work.getByText('The provider connection was renewed.', {exact: true}).waitFor();
  assert.equal(await work.locator('.activity-updates .status-error').count(), 2);
  await work.getByText('Model changed to second-model', {exact: true}).waitFor();
  report.checks.advancedRetainsEveryDiagnosticAndHistoricalUpdate = true;
  await page.goto(url + '?final=1');
  await page.locator('[data-chat-id="c1"] .chat-open').click();
  await page.getByRole('button', {name: 'Close question popup', exact: true}).click();
  await work.locator('.activity-warning').waitFor();
  assert.equal(await work.locator('.activity-done').count(), 0);
  assert.equal(await work.getByText('Current plain progress is visible.', {exact: true}).count(), 0);
  await work.getByRole('button', {name: 'Send answer', exact: true}).waitFor();
  await work.getByText('Needs attention', {exact: true}).waitFor();
  assert.equal(await work.locator('.activity-updates .status-denied').count(), 1);
  await work.locator('.activity-head').click();
  await work.getByText('The same action succeeded on a later attempt.', {exact: true}).waitFor();
  report.checks.persistedFinishedWorkKeepsControlsProblemsAndRecoveryEvidence = true;
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(760, 900));
  const bounds = await work.evaluate(element => {const rect = element.getBoundingClientRect(); return {left: rect.left, right: rect.right, width: innerWidth};});
  assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1);
  await page.screenshot({path: path.join(output, 'standard-finished-narrow.png')});
  report.checks.narrowActivityFitsViewport = true;
  const unconfirmedStart = events.length;
  activity.tool({id: 'unconfirmed', name: 'workspace_read', input: {path: 'unknown.txt'}, status: 'done'});
  activity.tool({id: 'unfinished', name: 'workspace_write', input: {path: 'unfinished.txt', text: 'Synthetic'}, status: 'running'});
  activity.finish('Synthetic task finished.');
  await page.evaluate(input => window.__qaEvents(input), events.slice(unconfirmedStart));
  await work.locator('.activity-updates .status-unknown').waitFor();
  await work.locator('.activity-updates .status-stopped').waitFor();
  await work.getByText('Reading a file (result not confirmed)', {exact: true}).waitFor();
  await work.getByText('Writing a file (completion not confirmed)', {exact: true}).waitFor();
  assert.equal(await work.locator('.tool.status-unknown .step-state.done,.tool.status-stopped .step-state.done').count(), 0);
  report.checks.unknownAndUnfinishedActionsStayVisibleWithTruthfulTitles = true;
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
  if (page) await page.screenshot({path: path.join(output, 'failure.png')}).catch(() => {});
} finally {
  if (app) {await app.evaluate(({app}) => app.exit(0)).catch(() => {}); await app.close().catch(() => {});}
  await server.close(); await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
