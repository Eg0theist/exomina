import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SkillLibrary } from '../desktop/skill-library.mjs';

const procedure = () => ({ parameters: [{ name: 'artifact', description: 'Relative output file', required: true }], preconditions: ['Read the approved source'], dataScope: ['Current project only'], tools: ['workspace_read', 'workspace_write', 'outcome_verify'], outputs: ['{{artifact}}'], checks: [{ id: 'output', label: 'Saved output exists', kind: 'file', subject: 'file {{artifact}}', minBytes: 10 }], recovery: ['Keep drafts; inspect unknown external outcomes before retrying.'] });
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-procedure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let time = '2026-11-07T10:00:00Z';
  const chats = new Map([['a', { id: 'a', projectId: 'p' }], ['b', { id: 'b', projectId: 'p' }], ['private', { id: 'private', private: true }]]), outcomes = new Map(), settings = { memoryEnabled: true }, approvals = [];
  const config = { dir, getChat: id => chats.get(id), getSettings: () => settings, getOutcome: (chatId, id) => outcomes.get(chatId + ':' + id), now: () => new Date(time), approve: async request => { approvals.push(request); return true; } };
  const library = await new SkillLibrary(config).init();
  const create = async (overrides = {}) => (await library.call({ action: 'create', name: 'Report', description: 'Prepare a reviewed report', instructions: 'Read, produce, review, verify.', procedure: procedure(), ...overrides }, 'a')).skill;
  const mark = (id = 'mark', patch = {}) => { const value = { id, at: '2026-11-07T10:02:00Z', checkedBy: 'exomina', status: 'verified', kind: 'file', subject: 'file report.txt', observed: { exists: true, bytes: 20 }, ...patch }; outcomes.set('a:' + id, value); return value; };
  const prepare = skill => { time = '2026-11-07T10:01:00Z'; return library.call({ action: 'prepare', id: skill.id, revision: skill.revision, hash: skill.hash, values: { artifact: 'report.txt' } }, 'a'); };
  const evaluate = (skill, plan, patch = {}) => { time = '2026-11-07T10:03:00Z'; return library.call({ action: 'evaluate', id: skill.id, baseRevision: skill.revision, hash: skill.hash, planRef: plan.planRef, values: plan.bindings, outcomes: { output: 'mark' }, ...patch }, 'a'); };
  return { library, config, create, mark, prepare, evaluate, outcomes, settings, approvals, chats, dir, clock: value => { time = value; } };
}

test('preparation validates bindings and only materializes a revision-bound checklist without side effects', async t => {
  const f = await fixture(t), skill = await f.create(), count = f.approvals.length;
  const args = { action: 'prepare', id: skill.id, revision: 1, hash: skill.hash };
  await assert.rejects(f.library.call(args, 'a'), /parameter artifact/);
  await assert.rejects(f.library.call({ ...args, values: { artifact: 'report.txt', extra: 'secret' } }, 'a'), /declared parameters/);
  await assert.rejects(f.library.call({ ...args, values: { artifact: '{{other}}' } }, 'a'), /plain single-line/);
  await assert.rejects(f.library.call({ ...args, hash: '0'.repeat(64), values: { artifact: 'report.txt' } }, 'a'), /exact hash/);
  const plan = await f.prepare(skill);
  assert.equal(plan.checks[0].subject, 'file report.txt'); assert.deepEqual(plan.outputs, ['report.txt']); assert.equal(plan.skillHash, skill.hash); assert.equal(plan.revision, 1);
  assert.match(plan.notice, /run no actions/); assert.equal(f.approvals.length, count); assert.equal(f.library.state.skills[0].evaluations, undefined);
  const catalog = await f.library.call({ action: 'catalog' }, 'a');
  assert.equal(catalog.skills[0].procedureStatus, 'draft'); assert.doesNotMatch(JSON.stringify(catalog), /Keep drafts|workspace_write/);
});

test('acceptance uses exact same-chat host outcomes after preparation and survives restart as historical evidence', async t => {
  const f = await fixture(t), skill = await f.create(), plan = await f.prepare(skill);
  f.mark(); const result = await f.evaluate(skill, plan);
  assert.equal(result.skill.procedureStatus, 'conditions-checked'); assert.equal(result.evaluation.planHash, plan.planHash); assert.match(result.evaluation.notice, /remain unverified/);
  const restarted = await new SkillLibrary(f.config).init(), read = await restarted.call({ action: 'read', id: skill.id }, 'a');
  assert.equal(read.evaluations.length, 1); assert.deepEqual(read.evaluations[0].bindings, { artifact: 'report.txt' });
  assert.equal(read.evaluations[0].checks[0].outcomeId, 'mark');
  await assert.rejects(restarted.call({ action: 'evaluate', id: skill.id, baseRevision: 1, hash: skill.hash, planRef: plan.planRef, values: plan.bindings, outcomes: { output: 'mark' } }, 'a'), /fresh checklist/);
});

test('wrong subjects, unverified claims, stale marks, altered parameters and expired plans cannot evaluate', async t => {
  const f = await fixture(t), skill = await f.create(), plan = await f.prepare(skill);
  for (const patch of [{ subject: 'file unrelated.txt' }, { kind: 'github_checks' }, { status: 'contradicted' }, { checkedBy: 'model' }, { at: '2026-11-07T10:00:30Z' }, { at: '2026-11-07T10:09:00Z' }, { observed: { exists: true, bytes: 9 } }]) {
    f.mark('mark', patch); await assert.rejects(f.evaluate(skill, plan), /host mark|after this checklist|observed file size/);
  }
  f.mark(); await assert.rejects(f.evaluate(skill, plan, { values: { artifact: 'other.txt' } }), /inputs changed/);
  await assert.rejects(f.evaluate(skill, plan, { outcomes: {} }), /Each acceptance check/);
  f.clock('2026-11-07T10:12:00Z');
  await assert.rejects(f.library.call({ action: 'evaluate', id: skill.id, baseRevision: 1, hash: skill.hash, planRef: plan.planRef, values: plan.bindings, outcomes: { output: 'mark' } }, 'a'), /fresh checklist/);
  assert.equal(f.library.state.skills[0].evaluations, undefined);
});

test('shared scope and permission changes are checked after approval and evidence is never borrowed from other chats', async t => {
  const f = await fixture(t), skill = await f.create({ scope: 'project' }), plan = await f.prepare(skill);
  f.outcomes.set('b:mark', f.mark()); f.outcomes.delete('a:mark');
  await assert.rejects(f.evaluate(skill, plan), /host mark/);
  f.mark();
  f.library.approve = async request => { assert.equal(request.requireConfirmation, true); assert.match(request.detail, /file report.txt/); f.settings.memoryEnabled = false; return true; };
  await assert.rejects(f.evaluate(skill, plan), /shared memory/); assert.equal(f.library.state.skills[0].evaluations, undefined);
  f.settings.memoryEnabled = true;
  await assert.rejects(f.library.call({ action: 'evaluate', id: skill.id, baseRevision: 1, hash: skill.hash, planRef: plan.planRef, values: plan.bindings, outcomes: { output: 'mark' } }, 'b'), /originating chat/);
  await assert.rejects(f.library.call({ action: 'prepare', id: skill.id, revision: 1, hash: skill.hash, values: plan.bindings }, 'private'), /non-private/);
});

test('revising even identical content clears current evaluation status and old checklist references', async t => {
  const f = await fixture(t), skill = await f.create(), plan = await f.prepare(skill); f.mark(); await f.evaluate(skill, plan);
  const revised = (await f.library.call({ action: 'revise', id: skill.id, baseRevision: 1 }, 'a')).skill;
  assert.equal(revised.hash, skill.hash); assert.equal(revised.procedureStatus, 'draft');
  const read = await f.library.call({ action: 'read', id: skill.id }, 'a'); assert.equal(read.evaluations.length, 0);
  await assert.rejects(f.evaluate(revised, plan), /fresh checklist/);
  assert.equal((await f.library.call({ action: 'read', id: skill.id, revision: 1 }, 'a')).evaluations.length, 1);
});

test('contracts reject undeclared placeholders and duplicate checks while ordinary old skills retain their hashes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.create({ procedure: { ...procedure(), outputs: ['{{client}}'] } }), /undeclared parameter/);
  await assert.rejects(f.create({ procedure: { ...procedure(), checks: [...procedure().checks, ...procedure().checks] } }), /unique/);
  await assert.rejects(f.create({ procedure: { ...procedure(), approved: true } }), /Invalid procedure/);
  const skill = await f.create({ procedure: null });
  assert.equal(skill.procedureStatus, null);
  const restarted = await new SkillLibrary(f.config).init(); assert.equal((await restarted.call({ action: 'read', id: skill.id }, 'a')).hash, skill.hash);
  const file = path.join(f.dir, 'library.json'), data = JSON.parse(await readFile(file, 'utf8'));
  data.skills[0].revisions[0].procedure = procedure(); await writeFile(file, JSON.stringify(data), 'utf8');
  await assert.rejects(new SkillLibrary(f.config).init(), /integrity/);
});

test('approval expiry and changed evidence abort before evaluation persistence', async t => {
  const f = await fixture(t), skill = await f.create(), plan = await f.prepare(skill); f.mark();
  f.library.approve = async () => { f.clock('2026-11-07T10:12:00Z'); return true; };
  await assert.rejects(f.evaluate(skill, plan), /fresh checklist/); assert.equal(f.library.state.skills[0].evaluations, undefined);
  const fresh = await f.prepare(skill);
  f.library.approve = async () => { f.mark('mark', { status: 'refused' }); return true; };
  await assert.rejects(f.evaluate(skill, fresh), /host mark/); assert.equal(f.library.state.skills[0].evaluations, undefined);
});

test('portable evaluation records reject missing, mismatched or stale acceptance receipts', async t => {
  const f = await fixture(t), skill = await f.create(), plan = await f.prepare(skill); f.mark(); await f.evaluate(skill, plan);
  const file = path.join(f.dir, 'library.json'), original = JSON.parse(await readFile(file, 'utf8'));
  for (const change of [evaluation => { evaluation.checks = [{}]; }, evaluation => { delete evaluation.preparedAt; }, evaluation => { evaluation.checks[0].subject = 'file unrelated.txt'; }, evaluation => { evaluation.checks[0].at = '2026-11-07T09:59:00Z'; }, evaluation => { evaluation.checks[0].observed.bytes = 2; }]) {
    const data = structuredClone(original); change(data.skills[0].evaluations[0]); await writeFile(file, JSON.stringify(data), 'utf8');
    await assert.rejects(new SkillLibrary(f.config).init(), /procedure|acceptance|host mark|after this checklist|file size/i);
  }
});
