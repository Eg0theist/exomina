import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SkillLibrary } from '../desktop/skill-library.mjs';

const draft = { action: 'create', name: 'Method', description: 'Test method', instructions: 'Read and check.' };
const procedure = { parameters: [], preconditions: [], dataScope: [], tools: ['workspace_read'], outputs: [], checks: [{ id: 'file', label: 'File exists', kind: 'file', subject: 'file result.txt' }], recovery: [] };
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skill-dependency-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let scope = 'one', catalog = [{ name: 'workspace_read', description: 'Read a file.', inputSchema: { type: 'object', properties: {} } }];
  const marks = new Map();
  const lib = await new SkillLibrary({ dir, getChat: id => ({ id }), getSettings: () => ({ memoryEnabled: true }), getTools: () => catalog, getToolScope: () => scope, getOutcome: (_, id) => marks.get(id), approve: async () => true }).init();
  const create = async extra => (await lib.call({ ...draft, ...extra }, 'a')).skill;
  return { lib, marks, create, scope: value => { scope = value; }, catalog: value => { catalog = value; } };
}
test('changed pinned input blocks preparation without altering historical source', async t => {
  const f = await fixture(t), source = await f.create(), dep = { id: source.id, revision: source.revision, hash: source.hash };
  const consumer = await f.create({ procedure, dependencies: [dep] });
  assert.equal((await f.lib.call({ action: 'dependencies', id: consumer.id }, 'a')).status, 'current');
  await f.lib.call({ action: 'revise', id: source.id, baseRevision: 1, instructions: 'Changed brief' }, 'a');
  assert.equal((await f.lib.call({ action: 'read', id: consumer.id }, 'a')).procedureStatus, 'needs-review');
  await assert.rejects(f.lib.call({ action: 'prepare', id: consumer.id, hash: consumer.hash }, 'a'), /dependency changed/);
  assert.equal((await f.lib.call({ action: 'read', id: source.id, revision: 1 }, 'a')).text, draft.instructions);
});
test('schema or authorization change invalidates the prepared checklist', async t => {
  for (const change of ['scope', 'catalog']) {
    const f = await fixture(t), skill = await f.create({ procedure });
    const plan = await f.lib.call({ action: 'prepare', id: skill.id, hash: skill.hash }, 'a');
    assert.equal(plan.capabilities.tools[0].status, 'available');
    f.marks.set('observed', { id: 'observed', checkedBy: 'exomina', status: 'verified', kind: 'file', subject: 'file result.txt', observed: { exists: true, bytes: 10 }, at: new Date().toISOString() });
    f[change](change === 'scope' ? 'revoked' : []);
    await assert.rejects(f.lib.call({ action: 'evaluate', id: skill.id, baseRevision: 1, hash: skill.hash, planRef: plan.planRef, outcomes: { file: 'observed' } }, 'a'), /tools or permission scope changed/);
  }
});
test('permission changes during approval cannot record stale evidence', async t => {
  const f = await fixture(t), skill = await f.create({ procedure }), plan = await f.lib.call({ action: 'prepare', id: skill.id, hash: skill.hash }, 'a');
  f.marks.set('observed', { id: 'observed', checkedBy: 'exomina', status: 'verified', kind: 'file', subject: 'file result.txt', observed: { exists: true, bytes: 10 }, at: new Date().toISOString() });
  f.lib.approve = async () => { f.scope('revoked'); return true; };
  await assert.rejects(f.lib.call({ action: 'evaluate', id: skill.id, baseRevision: 1, hash: skill.hash, planRef: plan.planRef, outcomes: { file: 'observed' } }, 'a'), /permission scope changed/);
  assert.deepEqual((await f.lib.call({ action: 'read', id: skill.id }, 'a')).evaluations, []);
});
