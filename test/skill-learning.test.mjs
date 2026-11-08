import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SkillLibrary } from '../desktop/skill-library.mjs';
import { learningHash } from '../desktop/skill-learning.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-learning-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let tick = Date.parse('2026-11-08T01:00:00Z');
  const outcomes = new Map(), approvals = [], chats = new Map([['a', { id: 'a', projectId: 'p' }], ['b', { id: 'b', projectId: 'p' }], ['private', { id: 'private', private: true }]]);
  const config = { dir, getChat: id => chats.get(id), getSettings: () => ({ memoryEnabled: true }), getOutcome: (chatId, id) => outcomes.get(`${chatId}:${id}`), now: () => new Date(tick), approve: async request => { approvals.push(request); return true; } };
  const library = await new SkillLibrary(config).init(), call = args => library.call(args, 'a');
  const training = { client: 'ClientAlpha', artifact: 'alpha-report.txt' }, holdouts = [{ id: 'first', values: { client: 'ClientBeta', artifact: 'beta-report.txt' } }, { id: 'second', values: { client: 'ClientGamma', artifact: 'gamma-report.txt' } }];
  const source = (await call({ action: 'create', name: 'Report for ClientAlpha', description: 'Prepare ClientAlpha records', instructions: 'Review ClientAlpha records and save alpha-report.txt. Preserve {{client}} approval.', references: [{ name: 'client.md', text: 'ClientAlpha source notes' }], procedure: { parameters: [{ name: 'client', description: 'ClientAlpha name', required: true }, { name: 'artifact', description: 'Output file', required: true }], preconditions: ['ClientAlpha permits this report'], dataScope: ['Only ClientAlpha records'], tools: ['workspace_write'], outputs: ['{{artifact}}'], checks: [{ id: 'file', label: 'Saved file', kind: 'file', subject: 'file {{artifact}}', minBytes: 10 }], recovery: ['Keep ClientAlpha draft; reconcile uncertain delivery.'] } })).skill;
  async function accept(skill, values, id) {
    tick += 1000; const plan = await call({ action: 'prepare', id: skill.id, revision: skill.revision, hash: skill.hash, values });
    tick += 1000; outcomes.set(`a:${id}`, { id, at: new Date(tick).toISOString(), checkedBy: 'exomina', status: 'verified', kind: 'file', subject: `file ${values.artifact}`, observed: { exists: true, bytes: 30 } });
    tick += 1000; return call({ action: 'evaluate', id: skill.id, baseRevision: skill.revision, hash: skill.hash, planRef: plan.planRef, values, outcomes: { file: id } });
  }
  await accept(source, training, 'training');
  const sourceRead = await call({ action: 'read', id: source.id });
  const learnArgs = { action: 'learn', id: source.id, baseRevision: source.revision, hash: source.hash, sourceEvaluationHash: sourceRead.evaluations[0].evaluationHash, holdouts };
  const learn = () => { tick += 1000; return call(learnArgs); };
  const promote = candidate => call({ action: 'promote', id: candidate.id, baseRevision: candidate.revision, hash: candidate.hash, review: 'Reviewed meaning and client separation in both withheld files. File checks do not prove prose quality.' });
  return { library, config, call, source, sourceRead, training, holdouts, learn, learnArgs, promote, accept, outcomes, approvals, chats, dir };
}

test('learning generalizes explicit bound values without exporting training receipts or starting actions', async t => {
  const f = await fixture(t), before = f.outcomes.size, candidate = (await f.learn()).skill;
  const read = await f.call({ action: 'read', id: candidate.id });
  assert.equal(read.learningStatus, 'candidate'); assert.equal(read.scope, 'chat'); assert.equal(f.outcomes.size, before);
  const body = f.library.state.skills.at(-1).revisions[0];
  assert.doesNotMatch(JSON.stringify(body), /ClientAlpha|alpha-report\.txt/); assert.match(body.instructions, /\{\{client\}\}/);
  assert.equal(body.references[0].name, 'source-1.txt'); assert.match(body.references[0].text, /\{\{client\}\}/);
  assert.deepEqual(body.dependencies, [{ id: f.source.id, revision: 1, hash: f.source.hash }]);
  assert.doesNotMatch(f.library.context('a'), new RegExp(candidate.id));
  assert.equal(f.approvals.at(-1).requireConfirmation, true); assert.match(f.approvals.at(-1).detail, /generalizedContent|withheldInputs/);
  await assert.rejects(f.library.call({ action: 'read', id: candidate.id }, 'b'), /unavailable/);
  await assert.rejects(f.library.call(f.learnArgs, 'private'), /non-private/);
});

test('learning refuses reused training inputs, duplicate heldout sets and unaccepted source evidence', async t => {
  const f = await fixture(t);
  for (const holdouts of [[f.holdouts[0]], [{ id: 'one', values: f.training }, f.holdouts[1]], [f.holdouts[0], { id: 'other', values: f.holdouts[0].values }], [{ id: 'one', values: { ...f.holdouts[0].values, client: f.training.client } }, f.holdouts[1]]]) await assert.rejects(f.call({ ...f.learnArgs, holdouts }), /withheld|Withheld/);
  await assert.rejects(f.call({ ...f.learnArgs, sourceEvaluationHash: '0'.repeat(64) }), /accepted run/);
  f.outcomes.get('a:training').status = 'refused'; await assert.rejects(f.learn(), /verified host mark/);
  assert.equal(f.library.state.skills.length, 1);
});

test('promotion requires every precommitted case, fresh exact host evidence and a separate reviewed approval', async t => {
  const f = await fixture(t), candidate = (await f.learn()).skill;
  await assert.rejects(f.promote(candidate), /first needs fresh/);
  await f.accept(candidate, f.holdouts[0].values, 'first-mark'); await assert.rejects(f.promote(candidate), /second needs fresh/);
  await f.accept(candidate, f.holdouts[1].values, 'second-mark');
  const promoted = await f.promote(candidate); assert.equal(promoted.skill.learningStatus, 'promoted');
  assert.match(f.library.context('a'), new RegExp(candidate.id)); assert.equal(f.approvals.at(-1).requireConfirmation, true);
  const restarted = await new SkillLibrary(f.config).init(), read = await restarted.call({ action: 'read', id: candidate.id }, 'a');
  assert.equal(read.learningStatus, 'promoted'); assert.equal(read.learning.evaluations.length, 2);
  assert.match(read.learning.notice, /not semantic correctness/);
  f.outcomes.delete('a:first-mark'); assert.equal((await f.call({ action: 'read', id: candidate.id })).learningStatus, 'needs-review'); assert.doesNotMatch(f.library.context('a'), new RegExp(candidate.id));
});

test('new revisions and changed source dependencies cannot retain learned acceptance', async t => {
  const f = await fixture(t), candidate = (await f.learn()).skill;
  await f.call({ action: 'revise', id: f.source.id, baseRevision: 1, instructions: 'Changed source method.' });
  await assert.rejects(f.call({ action: 'prepare', id: candidate.id, revision: 1, hash: candidate.hash, values: f.holdouts[0].values }), /pinned dependency changed/);
  await assert.rejects(f.promote(candidate), /dependencies changed/);
  const revised = await f.call({ action: 'revise', id: candidate.id, baseRevision: 1, instructions: 'Changed candidate method.' });
  assert.equal(revised.skill.learningStatus, 'needs-review'); await assert.rejects(f.promote(revised.skill), /candidate changed/);
});

test('revocation or changed evidence during learning or promotion approval prevents persistence', async t => {
  const f = await fixture(t);
  f.library.approve = async request => { if (request.title.includes('generalized')) f.outcomes.get('a:training').status = 'contradicted'; return true; };
  await assert.rejects(f.learn(), /verified host mark/); assert.equal(f.library.state.skills.length, 1);
  f.outcomes.get('a:training').status = 'verified'; f.library.approve = async () => true;
  const candidate = (await f.learn()).skill;
  await f.accept(candidate, f.holdouts[0].values, 'first-mark'); await f.accept(candidate, f.holdouts[1].values, 'second-mark');
  f.library.approve = async request => { if (request.title.includes('Promote')) f.outcomes.delete('a:first-mark'); return true; };
  await assert.rejects(f.promote(candidate), /verified host mark/); assert.equal(f.library.state.skills.at(-1).learning.status, 'candidate');
});

test('portable learned records reject tampered inputs or missing pinned acceptance observations', async t => {
  const f = await fixture(t), candidate = (await f.learn()).skill;
  await f.accept(candidate, f.holdouts[0].values, 'first-mark'); await f.accept(candidate, f.holdouts[1].values, 'second-mark'); await f.promote(candidate);
  const file = path.join(f.dir, 'library.json'), original = JSON.parse(await readFile(file, 'utf8'));
  for (const change of [record => { record.learning.cases[0].values.artifact = 'changed.txt'; }, record => { record.learning.evaluations[0].evaluationHash = '0'.repeat(64); }, record => { record.evaluations = []; }, record => { record.learning.cases[1] = record.learning.cases[0]; }]) {
    const changed = structuredClone(original); change(changed.skills.at(-1)); await writeFile(file, JSON.stringify(changed), 'utf8');
    await assert.rejects(new SkillLibrary(f.config).init(), /withheld|promoted|procedure/i);
  }
  assert.equal(learningHash(f.training), original.skills.at(-1).learning.trainingBindingsHash);
});
