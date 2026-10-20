// Continue only the restart/UI checks left unfinished by an existing calm QA
// report. Reuse its protected synthetic profile and launcher without reseeding.
import {_electron as electron} from 'playwright';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
assert.ok(process.argv[2], 'Pass the exact existing synthetic calm QA output directory.');
const output = path.resolve(process.argv[2]), originalReport = path.join(output, 'result.json');
const originalBytes = await readFile(originalReport), original = JSON.parse(originalBytes);
assert.equal(path.resolve(original.output), output);
assert.equal(original.artifact.version, '0.5.0-beta.63');
assert.equal(original.passed, false);
assert.equal(original.checks.packagedAdvancedKeepsFullDiagnosticHistory, true);
const profile = path.join(output, 'data'), launcher = path.join(output, 'launcher.cjs');
assert.match(await readFile(path.join(profile, 'synthetic-profile.txt'), 'utf8'), /Synthetic Exomina QA profile/);
assert.match(await readFile(launcher, 'utf8'), /globalThis\.qaCalm/);
const env = {...process.env, EXOMINA_DATA_DIR: profile, EXOMINA_ACCOUNTS_DIR: path.join(profile, 'accounts'), EXOMINA_WORKSPACE_DIR: path.join(profile, 'workspace'), TEMP: output, TMP: output, TMPDIR: output};
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/token|secret|password|api_?key|credential|authorization/i.test(key)) delete env[key];
const report = {scope: 'Remaining restart/UI persistence checks only. The exact synthetic protected profile, packaged host and saved data from the prior run are reused. No live/UI checks repeated, no data reseeded, no provider requests or external network.', output,
  originalReport: {path: originalReport, sha256: createHash('sha256').update(originalBytes).digest('hex'), artifact: original.artifact, completedChecks: Object.keys(original.checks).filter(key => original.checks[key])}, checks: {}, errors: []};
let app, page;
const invoke = (method, payload = {}) => page.evaluate(({method, payload}) => window.studio.invoke(method, payload), {method, payload});
async function until(read, accept) {const deadline = Date.now() + 15000; for (;;) {const value = await read(); if (accept(value)) return value; if (Date.now() > deadline) throw Error('Existing synthetic host startup timed out'); await new Promise(resolve => setTimeout(resolve, 60));}}
try {
  app = await electron.launch({args: [launcher], cwd: root, env, timeout: 30000});
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', {name: 'Exomina home', exact: true}).waitFor();
  const state = await until(() => invoke('bootstrap'), value => value.connections.some(row => row.id === 'codex' && row.connected));
  const chat = state.conversations.find(chat => chat.title === 'Packaged calm activity QA'); assert.ok(chat, 'Reuse the existing saved QA conversation');
  await page.locator('[data-chat-id="' + chat.id + '"] .chat-open').click();
  await page.getByRole('button', {name: 'Close question popup', exact: true}).click();
  await page.getByRole('combobox', {name: 'Interface view', exact: true}).selectOption('standard');
  const savedWork = page.locator('.activity').first(), liveWork = page.locator('.activity').last();
  await liveWork.locator('.activity-warning').waitFor();
  assert.equal(await liveWork.locator('.activity-done').count(), 0);
  assert.equal(await liveWork.locator('.activity-updates .status-error').count(), 0);
  assert.equal(await liveWork.locator('.activity-updates .status-denied').count(), 1);
  await liveWork.locator('.activity-updates .status-unknown').waitFor();
  await liveWork.locator('.activity-updates .status-stopped').waitFor();
  await liveWork.locator('.activity-head').click();
  await liveWork.getByText('The same action succeeded on a later attempt.', {exact: true}).waitFor();
  await liveWork.locator('.activity-work-details .tool.status-unknown').getByText('Running a command (result not confirmed)', {exact: true}).waitFor();
  await liveWork.locator('.activity-work-details .tool.status-stopped').getByText('Writing a file (completion not confirmed)', {exact: true}).waitFor();
  assert.equal(await liveWork.locator('.tool.status-unknown .step-state.done,.tool.status-stopped .step-state.done').count(), 0);
  report.checks.restoredUnknownStoppedAndDeniedActionsHaveWarningsAndTruthfulTitles = true;
  await savedWork.getByRole('button', {name: 'Send answer', exact: true}).waitFor();
  await savedWork.getByText('Needs attention', {exact: true}).waitFor();
  report.checks.savedQuestionAndBlockedFollowupRemainAccessibleAfterRestart = true;
  assert.equal(await app.evaluate(() => qaCalm.requests), 0);
  assert.equal(await app.evaluate(() => qaCalm.emitted.length), 0);
  report.checks.reopeningDidNotRequestAProviderOrInjectMoreEvents = true;
  await page.setViewportSize({width: 760, height: 900});
  const bounds = await liveWork.evaluate(element => {const box = element.getBoundingClientRect(); return {left: box.left, right: box.right, width: innerWidth};});
  assert.equal(bounds.width, 760); assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1);
  await page.screenshot({path: path.join(output, 'continuation-restored-760.png')}); report.checks.restoredTimelineFits760pxViewport = true;
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
  if (page) await page.screenshot({path: path.join(output, 'continuation-failure.png')}).catch(() => {});
} finally {
  if (app) {await app.evaluate(({app}) => app.exit(0)).catch(() => {}); await app.close().catch(() => {});}
  await writeFile(path.join(output, 'continuation-result.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report, null, 2));
}
