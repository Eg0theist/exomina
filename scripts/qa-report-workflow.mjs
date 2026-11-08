// Integrated recurring-report proof. Production persistence, retrieval,
// procedures, observations and recovery; deterministic producer/local recipient.
// This deliberately does not claim live inference or external delivery.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const childMode = process.argv[2] === '--child';
const destination = path.resolve((childMode ? process.argv[3] : process.argv[2]) || '../Workspace/daily-proof-20261108/workflow');
const modules = path.resolve((childMode ? process.argv[6] : process.argv[3]) || path.join(root, 'desktop'));
const load = name => import(pathToFileURL(path.join(modules, name + '.mjs')).href);
const [{ Store }, { MemoryStore }, { Workbench }, { SkillLibrary }, { OutcomeMarks }, { OutcomeJournal }, { deliveryPart }] = await Promise.all(
  ['store', 'note-store', 'workbench', 'skill-library', 'outcome-marks', 'outcome-journal', 'delivery-contract'].map(load));
const digest = text => createHash('sha256').update(text).digest('hex');
const json = file => readFile(file, 'utf8').then(JSON.parse);
const writeJSON = (file, value) => writeFile(file, JSON.stringify(value, null, 2), 'utf8');
const safeName = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

async function produce(client, output) {
  assert.match(client, safeName);
  const input = await json(path.join(destination, 'approved', client + '.json'));
  const memory = new MemoryStore(path.join(destination, 'memory', client));
  await memory.init();
  try {
    const rows = await memory.recall(input.alias, { asOf: input.asOf });
    const current = rows.filter(row => row.knowledge?.some(fact => fact.applicable));
    assert.equal(current.length, 1, 'The approved client requires one applicable source.');
    const source = current[0], metrics = JSON.parse(source.text);
    assert.equal(metrics.client, client, 'Client boundary must match the approved source.');
    assert.equal(metrics.period, input.period);
    assert.ok(!source.evidence.supersededBy, 'Do not render a superseded source.');
    const sourceHash = digest(source.text);
    const totals = { visits: metrics.visits, leads: metrics.leads, spendEUR: metrics.spendEUR,
      conversionPercent: Number((100 * metrics.leads / metrics.visits).toFixed(2)),
      costPerLeadEUR: Number((metrics.spendEUR / metrics.leads).toFixed(2)) };
    const report = `${client} | ${input.period}\nAs of ${input.asOf}\nVisits: ${totals.visits}\nLeads: ${totals.leads}\nSpend EUR: ${totals.spendEUR}\nConversion percent: ${totals.conversionPercent}\nCost per lead EUR: ${totals.costPerLeadEUR}\nRevenue: unknown (no approved source)\nSource note: ${source.id}\nSource SHA-256: ${sourceHash}\n`;
    const manifest = { client, period: input.period, asOf: input.asOf, totals,
      source: { id: source.id, sha256: sourceHash, text: source.text, facts: source.knowledge }, reportSha256: digest(report) };
    await writeFile(path.join(destination, output), report, 'utf8');
    await writeJSON(path.join(destination, output + '.sources.json'), manifest);
    return report;
  } finally { memory.close(); }
}

if (childMode) {
  const [client, mode] = process.argv.slice(4, 6);
  assert.match(client || '', safeName); assert.ok(['crash', 'ack'].includes(mode));
  const store = new Store(path.join(destination, 'runs')); await store.init();
  const task = { id: 'monthly-' + client, name: client + ' monthly report', provider: 'codex', model: 'auto',
    prompt: 'Use only the approved current facts, preserve citations, and mark missing revenue unknown.',
    delivery: 'telegram', recipient: 'synthetic-local-' + client, enabled: false, frequency: 'daily', time: '09:00', nextRun: new Date().toISOString() };
  store.state.schedules ||= [];
  store.state.schedules.push(task);
  const workbench = new Workbench({ store, execute: async () => ({ text: await produce(client, client + '.txt'), conversationId: 'synthetic-' + client }),
    approveDelivery: async () => true, checkDelivery: () => 'synthetic-approved-exact-report',
    deliver: async (binding, text) => {
      const part = deliveryPart(text, 0, 1); await binding.recordProgress({ ...part, status: 'dispatching' });
      const receipt = await open(path.join(destination, 'synthetic-recipient.jsonl'), 'a', 0o600);
      try { await receipt.writeFile(JSON.stringify({ runId: binding.binding.runId, client, text }) + '\n', 'utf8'); await receipt.sync(); }
      finally { await receipt.close(); }
      if (mode === 'crash') {
        process.send({ phase: 'accepted', runId: binding.binding.runId });
        setInterval(() => {}, 1000); await new Promise(() => {});
      }
      await binding.recordProgress({ ...part, status: 'acknowledged', messageId: '100' + client.length });
    } });
  await workbench.run(task.id, true);
  const run = workbench.workflows.runs().at(-1); assert.equal(run.status, 'ready');
  await workbench.workflows.resume(run.id);
  process.send({ phase: 'complete', runId: run.id }); process.disconnect();
} else {
  await mkdir(path.join(destination, 'approved'), { recursive: true });
  // Refuse to overwrite an existing run: receipt effects must not be repeated.
  try { await readFile(path.join(destination, 'report.json')); throw Error('Choose a fresh report-workflow destination.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const report = { at: new Date().toISOString(), modules, destination, passed: false, checks: {}, cases: [],
    limits: ['Three synthetic approved client inputs; deterministic arithmetic/report production, no model inference.',
      'Actual production modules with local JSONL recipient and owned child-process termination. No messaging service was contacted.',
      'File outcomes establish byte properties. Report contents and source consistency are independently asserted by this harness.',
      'Synthetic approvals apply only inside this isolated harness. No owner approval or real destination permission is granted.'] };
  const children = new Set(); let archive;
  const start = (client, mode) => {
    const child = fork(fileURLToPath(import.meta.url), ['--child', destination, client, mode, modules], { execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.add(child); let logs = ''; child.stderr.on('data', chunk => { logs += chunk; });
    const receive = phase => new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(Error('Child timed out before ' + phase + ': ' + logs)), 30000);
      const message = value => { if (value?.phase === phase) finish(null, value); };
      const exited = (code, signal) => finish(Error(`Child exited before ${phase}: ${code}/${signal}: ${logs}`));
      function finish(error, value) { clearTimeout(timer); child.off('message', message); child.off('exit', exited); error ? reject(error) : resolve(value); }
      child.on('message', message); child.once('exit', exited); child.once('error', finish);
    });
    return { child, receive };
  };
  try {
    const instances = [
      { client: 'ClientAlder', alias: 'GoldenBee', visits: 1440, leads: 60, spendEUR: 600 },
      { client: 'ClientBirch', alias: 'SilverWren', visits: 800, leads: 20, spendEUR: 300 },
      { client: 'ClientCedar', alias: 'CobaltMoth', visits: 1750, leads: 70, spendEUR: 840 },
    ];
    for (const item of instances) {
      await writeJSON(path.join(destination, 'approved', item.client + '.json'), { alias: item.alias, asOf: '2026-11-08', period: 'October2026' });
      const memory = new MemoryStore(path.join(destination, 'memory', item.client)); await memory.init();
      try {
        const entity = await memory.knowledgeOperation({ action: 'define', name: item.client, type: 'organization', aliases: [item.alias] });
        const old = item.client + '-old', current = item.client + '-current';
        await memory.note(JSON.stringify({ client: item.client, period: 'October2026', visits: 9999, leads: 999, spendEUR: 999 }), { id: old });
        await memory.note(JSON.stringify({ client: item.client, period: 'October2026', visits: item.visits, leads: item.leads, spendEUR: item.spendEUR }), { id: current });
        await memory.knowledgeOperation({ action: 'link', noteId: old, entityId: entity.id, predicate: 'monthly metrics', validTo: '2026-11-01' });
        await memory.knowledgeOperation({ action: 'link', noteId: current, entityId: entity.id, predicate: 'monthly metrics', validFrom: '2026-11-01' });
        await memory.recordEvidence({ id: old, otherId: current, action: 'superseded' });
        await memory.note('Unapproved unrelated client has revenue EUR 888888.', { id: item.client + '-distractor' });
      } finally { memory.close(); }
    }
    const receiptStore = new Store(path.join(destination, 'receipts')); await receiptStore.init();
    const chat = receiptStore.create('codex'); await receiptStore.save();
    archive = await new OutcomeJournal({ dir: path.join(destination, 'outcome-journal') }).init();
    const outcomes = new OutcomeMarks({ store: receiptStore, archive, evaluate: () => ({ decision: 'allow' }), resolveFile: file => {
      const actual = path.resolve(destination, file); assert.ok(actual.startsWith(destination + path.sep)); return actual;
    } });
    const config = { dir: path.join(destination, 'skills'), getChat: id => receiptStore.state.conversations.find(chat => chat.id === id),
      getSettings: () => ({ memoryEnabled: true }), getOutcome: (chatId, id) => outcomes.resolve(chatId, id), approve: async () => true };
    let library = await new SkillLibrary(config).init(); const call = args => library.call(args, chat.id, { userInitiated: true });
    const policy = (await call({ action: 'create', name: 'Approved monthly source policy', description: 'Reviewed source rules', instructions: 'Use applicable approved records. Mark missing fields unknown and cite the exact original note and SHA-256.' })).skill;
    const source = (await call({ action: 'create', name: 'Report for ClientAlder', description: 'Current monthly report for ClientAlder',
      instructions: 'Retrieve approved facts for ClientAlder, calculate conversion and cost per lead, preserve exact source identifiers, mark unavailable revenue unknown and save ClientAlder.txt. Reconcile uncertain deliveries before any retry.',
      dependencies: [{ id: policy.id, revision: policy.revision, hash: policy.hash }],
      procedure: { parameters: [{ name: 'client', description: 'Client name', required: true }, { name: 'artifact', description: 'Relative report filename', required: true }],
        preconditions: ['Approved records and current validity annotations exist for {{client}}.'], dataScope: ['Only {{client}} approved memory store.'], tools: [],
        outputs: ['{{artifact}}', '{{artifact}}.sources.json'], checks: [
          { id: 'artifact', label: 'Report byte properties', kind: 'file', subject: 'file {{artifact}}', minBytes: 200 },
          { id: 'sources', label: 'Traceability manifest byte properties', kind: 'file', subject: 'file {{artifact}}.sources.json', minBytes: 200 }],
        recovery: ['Preserve report bytes; inspect uncertain recipient effects, then reconcile before explicit review.'] } })).skill;
    const evaluate = async (skill, item, mode) => {
      const values = { client: item.client, artifact: item.client + '.txt' };
      const plan = await call({ action: 'prepare', id: skill.id, revision: skill.revision, hash: skill.hash, values });
      const actor = start(item.client, mode), event = await actor.receive(mode === 'crash' ? 'accepted' : 'complete');
      if (mode === 'crash') {
        const exited = once(actor.child, 'exit'); actor.child.kill('SIGKILL'); await exited;
        const store = new Store(path.join(destination, 'runs')); await store.init();
        let replayCalls = 0;
        const wb = new Workbench({ store, deliver: async () => { replayCalls++; }, checkDelivery: () => 'same', approveDelivery: async () => true });
        await wb.workflows.restore(); const run = wb.workflows.get(event.runId);
        assert.equal(run.delivery.status, 'unknown'); assert.equal(run.delivery.attempts[0].parts[0].status, 'dispatching');
        await assert.rejects(wb.workflows.resume(run.id), /Reconcile/); await assert.rejects(wb.run(run.taskId, true), /unfinished/);
        assert.equal(replayCalls, 0); const receipts = (await readFile(path.join(destination, 'synthetic-recipient.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(receipts.filter(row => row.runId === run.id).length, 1);
        await wb.workflows.resolve(run.id, { resolution: 'delivered', evidence: 'Inspected the isolated recipient file and exact report bytes; one complete record exists.' });
        assert.equal(wb.workflows.get(run.id).delivery.status, 'confirmed'); report.checks.crashAfterAcceptancePreservesReportAndPreventsDuplicate = true;
      } else if (actor.child.exitCode === null) await once(actor.child, 'exit');
      const manifest = await json(path.join(destination, values.artifact + '.sources.json')), text = await readFile(path.join(destination, values.artifact), 'utf8');
      assert.deepEqual(manifest.totals, { visits: item.visits, leads: item.leads, spendEUR: item.spendEUR, conversionPercent: Number((100 * item.leads / item.visits).toFixed(2)), costPerLeadEUR: Number((item.spendEUR / item.leads).toFixed(2)) });
      assert.equal(manifest.source.id, item.client + '-current'); assert.equal(digest(manifest.source.text), manifest.source.sha256); assert.equal(digest(text), manifest.reportSha256);
      assert.match(text, /Revenue: unknown/); assert.doesNotMatch(text, /9999|888888/);
      const ids = {};
      for (const [checkId, file] of [['artifact', values.artifact], ['sources', values.artifact + '.sources.json']]) {
        const mark = (await outcomes.call({ action: 'check', kind: 'file', path: file, sha256: digest(await readFile(path.join(destination, file))), minBytes: 200 }, chat.id)).mark;
        assert.equal(mark.status, 'verified'); ids[checkId] = mark.id;
      }
      await call({ action: 'evaluate', id: skill.id, baseRevision: skill.revision, hash: skill.hash, values, planRef: plan.planRef, outcomes: ids });
      report.cases.push({ client: item.client, input: values, manifest, hostOutcomeIds: ids, workflowId: event.runId });
    };
    await evaluate(source, instances[0], 'crash');
    const selected = await call({ action: 'read', id: source.id });
    const candidate = (await call({ action: 'learn', id: source.id, baseRevision: source.revision, hash: source.hash,
      sourceEvaluationHash: selected.evaluations[0].evaluationHash,
      holdouts: instances.slice(1).map((item, index) => ({ id: 'withheld' + index, values: { client: item.client, artifact: item.client + '.txt' } })) })).skill;
    assert.doesNotMatch(library.context(chat.id), new RegExp(candidate.id));
    for (const item of instances.slice(1)) await evaluate(candidate, item, 'ack');
    report.checks.threeCurrentReportsMatchIndependentArithmeticAndOriginalSourceHashes = true;
    await call({ action: 'promote', id: candidate.id, baseRevision: candidate.revision, hash: candidate.hash,
      review: 'Independently compared all three reports with approved metrics and exact source hashes. Both withheld inputs changed client and output filename. Missing revenue stays unknown. This validates this deterministic recipe only; model-authored prose remains untested.' });
    library = await new SkillLibrary(config).init();
    assert.equal((await call({ action: 'read', id: candidate.id })).learningStatus, 'promoted');
    assert.match(library.context(chat.id), new RegExp(candidate.id)); report.checks.acceptedRunBecomesReviewedReusableProcedureWithTwoFreshWithheldCases = true;
    const workflowStore = new Store(path.join(destination, 'runs')); await workflowStore.init();
    assert.equal(workflowStore.state.workflowRuns.length, 3); assert.ok(workflowStore.state.workflowRuns.every(run => run.status === 'complete'));
    assert.ok(workflowStore.state.workflowRuns.every(run => digest(run.artifact.text) === run.artifact.sha256)); report.checks.allThreeRunsAndReceiptHistorySurviveReopening = true;
    const allReceipts = (await readFile(path.join(destination, 'synthetic-recipient.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); assert.equal(allReceipts.length, 3);
    await call({ action: 'revise', id: policy.id, baseRevision: policy.revision, instructions: 'Source policy changed: require a new reviewed input list.' });
    assert.equal((await call({ action: 'read', id: candidate.id })).learningStatus, 'needs-review');
    await assert.rejects(call({ action: 'prepare', id: candidate.id, revision: candidate.revision, hash: candidate.hash, values: { client: 'ClientDogwood', artifact: 'ClientDogwood.txt' } }), /pinned dependency changed/);
    report.checks.changedSourcePolicyInvalidatesProcedureBeforeReuse = true;
    report.passed = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; }
  finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    archive?.close(); await writeJSON(path.join(destination, 'report.json'), report); console.log(JSON.stringify(report, null, 2));
  }
}
