// Permission-bound integration companion to qa-report-workflow.mjs.
// Synthetic bridge records local calls only; no token or network connection.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const destination = path.resolve(process.argv[2] || '../Workspace/daily-proof-20261108/workflow-permissions');
const modules = path.resolve(process.argv[3] || path.join(root, 'desktop'));
await mkdir(destination, { recursive: true });
try { await readFile(path.join(destination, 'report.json')); throw Error('Choose a fresh permission-proof destination.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const load = name => import(pathToFileURL(path.join(modules, name + '.mjs')).href);
const [{ Store }, { Workbench }, { PermissionPolicy }, { workflowDelivery }, { MessagingHub }] = await Promise.all(
  ['store', 'workbench', 'permissions', 'workflow-delivery', 'messaging'].map(load));
const report = { at: new Date().toISOString(), modules, passed: false, checks: {}, scope: 'Production Workbench, journal, policy, workflow delivery and MessagingHub. Local bridge only; no network, token, external message or owner authorization.' };
try {
  const settings = { permissionMode: 'full', permissionRules: [], messaging: { telegram: { enabled: true, paired: [{ id: 'synthetic-user', chatKey: 'synthetic-paired' }] } } };
  const policy = new PermissionPolicy({ getSettings: () => settings });
  const hub = new MessagingHub({ dataDir: destination, getSettings: () => settings, saveSettings: async patch => Object.assign(settings, patch) });
  let sends = 0, reviews = 0, changeDuringReview = false;
  hub.bridges.set('telegram', { send: async () => { sends++; return [{ messageId: String(100 + sends) }]; } }); hub.generations.set('telegram', 1);
  const callbacks = workflowDelivery({ policy, getSettings: () => settings, getHub: () => hub, requestApproval: async request => {
    reviews++; assert.equal(request.requireConfirmation, true);
    assert.equal(request.action.target, 'telegram:synthetic-paired'); assert.match(request.detail, /SHA-256: [a-f0-9]{64}/);
    if (changeDuringReview) settings.permissionMode = 'read-only';
    return true;
  } });
  const store = new Store(path.join(destination, 'state')); await store.init();
  const wb = new Workbench({ store, ...callbacks });
  const task = { id: 'permission-report', name: 'Current source report', provider: 'codex', model: 'auto', prompt: 'Approved synthetic current source report.', delivery: 'telegram', recipient: 'synthetic-paired' };
  store.state.schedules = [task];
  const run = wb.workflows.begin(task, 'synthetic-planned'); await wb.workflows.commit();
  await wb.workflows.generated(run, { text: 'Approved synthetic current report. Revenue remains unknown. Source SHA-256 retained.', conversationId: 'synthetic-report-chat' });
  settings.permissionRules = [{ effect: 'deny', tool: 'workflow_delivery', match: 'telegram:synthetic-paired' }];
  await wb.workflows.resume(run.id); assert.equal(run.delivery.status, 'blocked'); assert.equal(reviews, 0); assert.equal(sends, 0);
  report.checks.explicitDestinationDenialStopsBeforeReviewAndDispatch = true;
  settings.permissionRules = []; changeDuringReview = true;
  await wb.workflows.resume(run.id); assert.equal(run.delivery.status, 'blocked'); assert.equal(reviews, 1); assert.equal(sends, 0);
  assert.match(run.delivery.error, /blocks|changed/);
  report.checks.revocationDuringExactReportReviewStopsDispatch = true;
  changeDuringReview = false; settings.permissionMode = 'full';
  await wb.workflows.resume(run.id); assert.equal(run.status, 'complete'); assert.equal(run.delivery.status, 'sent'); assert.equal(reviews, 2); assert.equal(sends, 1);
  assert.equal(run.delivery.attempts.length, 1); assert.equal(run.delivery.attempts[0].parts[0].status, 'acknowledged');
  report.checks.freshReviewAfterRestoredPermissionRecordsOneLocalAcknowledgment = true;
  const reopened = new Store(path.join(destination, 'state')); await reopened.init();
  assert.equal(reopened.state.workflowRuns[0].delivery.attempts[0].parts[0].messageId, '101');
  report.checks.blockedHistoryAndAcknowledgmentSurviveReopening = true;
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally { await writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report, null, 2)); }
