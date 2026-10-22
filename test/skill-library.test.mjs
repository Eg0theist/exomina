import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SkillLibrary, SKILL_LIMITS } from '../desktop/skill-library.mjs';
import { durableReplace } from '../desktop/durable-state.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-skills-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = { memoryEnabled: true }, chats = new Map([['a', { id: 'a', projectId: 'p' }], ['b', { id: 'b', projectId: 'p' }], ['c', { id: 'c', projectId: 'other' }], ['private', { id: 'private', private: true }]]), refinements = new Map(), requests = [], events = [];
  const config = { dir, getChat: id => chats.get(id), getSettings: () => settings, getRefinement: (chatId, id) => refinements.get(chatId + ':' + id), approve: async request => { requests.push(request); return true; }, emit: event => events.push(event), ...options };
  const library = await new SkillLibrary(config).init();
  return { library, config, dir, settings, chats, refinements, requests, events };
}
const draft = overrides => ({ action: 'create', name: 'Bounded reading', description: 'Read large documents in pages.', instructions: 'FIRST_SECRET_PAGE\nSECOND_SECRET_PAGE', tags: ['reading'], appliesWhen: 'A document exceeds one page.', caveat: 'Does not establish OCR correctness.', references: [{ name: 'details.md', text: 'REFERENCE_SECRET_TEXT' }], ...overrides });
const create = async (f, overrides = {}, chat = 'a') => (await f.library.call(draft(overrides), chat)).skill;

test('catalogs contain metadata only and instructions/references load by immutable paginated revision', async t => {
  const f = await fixture(t), skill = await create(f);
  const catalog = await f.library.call({ action: 'catalog' }, 'a');
  assert.equal(catalog.skills.length, 1);
  assert.doesNotMatch(JSON.stringify(catalog), /FIRST_SECRET|REFERENCE_SECRET/);
  assert.doesNotMatch(f.library.context('a'), /FIRST_SECRET|REFERENCE_SECRET/);
  assert.match(f.library.context('a'), /metadata only/);
  const page = await f.library.call({ action: 'read', id: skill.id, revision: 1, hash: skill.hash, limit: 6 }, 'a');
  assert.equal(page.text, 'FIRST_'); assert.equal(page.nextOffset, 6);
  const rest = await f.library.call({ action: 'read', id: skill.id, revision: 1, offset: page.nextOffset }, 'a');
  assert.equal(page.text + rest.text, draft().instructions);
  const reference = await f.library.call({ action: 'read', id: skill.id, revision: 1, reference: 'details.md', offset: 3, limit: 5 }, 'a');
  assert.equal(reference.text, 'ERENC');
  await assert.rejects(f.library.call({ action: 'read', id: skill.id, hash: '0'.repeat(64) }, 'a'), /changed/);
  for (const name of ['../escape', 'C:\\secret', 'https://example.com/file', '__missing__']) await assert.rejects(f.library.call({ action: 'read', id: skill.id, reference: name }, 'a'), /reference/i);
  const revised = await f.library.call({ action: 'revise', id: skill.id, baseRevision: 1, instructions: 'REVISED_CONTENT' }, 'a');
  assert.equal(revised.skill.revision, 2);
  assert.equal((await f.library.call({ action: 'read', id: skill.id, revision: 1 }, 'a')).text, draft().instructions);
  assert.equal((await f.library.call({ action: 'read', id: skill.id }, 'a')).text, 'REVISED_CONTENT');
});

test('chat/project/all scopes and metadata obey privacy and shared-memory changes', async t => {
  const f = await fixture(t), local = await create(f), project = await create(f, { scope: 'project', name: 'Project skill' }), global = await create(f, { scope: 'all', name: 'Shared skill' });
  assert.equal(f.requests[0].requireConfirmation, false);
  assert.equal(f.requests[1].requireConfirmation, true); assert.equal(f.requests[2].requireConfirmation, true);
  assert.deepEqual((await f.library.call({ action: 'catalog' }, 'b')).skills.map(s => s.id).sort(), [project.id, global.id].sort());
  assert.deepEqual((await f.library.call({ action: 'catalog' }, 'c')).skills.map(s => s.id), [global.id]);
  await assert.rejects(f.library.call({ action: 'read', id: local.id }, 'b'), /unavailable/);
  await assert.rejects(f.library.call({ action: 'catalog' }, 'private'), /non-private/);
  await assert.rejects(f.library.call(draft(), 'private'), /non-private/);
  assert.equal(f.library.context('private'), '');
  f.settings.memoryEnabled = false;
  assert.deepEqual((await f.library.call({ action: 'catalog' }, 'b')).skills, []);
  await assert.rejects(f.library.call({ action: 'read', id: global.id }, 'a'), /unavailable/);
  await assert.rejects(create(f, { scope: 'project' }), /shared memory/);
  assert.equal((await f.library.call({ action: 'catalog' }, 'a')).skills.length, 1);
});

test('sharing requires approval of full content and rechecks current scope afterward', async t => {
  const f = await fixture(t);
  f.library.approve = async request => { assert.equal(request.requireConfirmation, true); assert.match(request.detail, /FIRST_SECRET_PAGE/); f.settings.memoryEnabled = false; return true; };
  await assert.rejects(create(f, { scope: 'all' }), /shared memory/);
  assert.equal(f.library.state.skills.length, 0);
  f.settings.memoryEnabled = true; f.library.approve = async () => false;
  await assert.rejects(create(f, { scope: 'project' }), /declined/);
  f.library.approve = async () => { f.chats.get('a').projectId = 'moved'; return true; };
  await assert.rejects(create(f, { scope: 'project' }), /scope changed/);
  f.library.approve = async () => assert.fail('Oversized sharing preview must fail before approval');
  await assert.rejects(create(f, { scope: 'all', instructions: 'x'.repeat(SKILL_LIMITS.instructions) }), /sharing preview is too large/);
});

test('other chats can read shared skills but cannot change them or widen an existing skill scope', async t => {
  const f = await fixture(t), skill = await create(f, { scope: 'project' });
  await assert.rejects(f.library.call({ action: 'revise', id: skill.id, baseRevision: 1, instructions: 'another chat' }, 'b'), /originating chat/);
  await assert.rejects(f.library.call({ action: 'retire', id: skill.id, baseRevision: 1 }, 'b'), /originating chat/);
  await assert.rejects(f.library.call({ action: 'revise', id: skill.id, baseRevision: 1, scope: 'all' }, 'a'), /scope is fixed/);
  await assert.rejects(f.library.call({ action: 'catalog', userInitiated: true }, 'b'), /valid.*action/);
  const changed = await f.library.call({ action: 'revise', id: skill.id, baseRevision: 1, instructions: 'User-approved revision' }, 'b', { userInitiated: true });
  assert.equal(changed.skill.revision, 2); assert.equal(f.requests.at(-1).requireConfirmation, true);
});

test('comparison evidence must be adopted, local, distinct and later; revisions clear old evidence', async t => {
  const f = await fixture(t), evidence = (id, time) => ({ id, tool: 'workspace_shell', status: 'completed', digest: id === 'before' ? 'a'.repeat(64) : 'b'.repeat(64), completedAt: time });
  const record = { id: 'comparison', status: 'adopted', createdAt: '2026-10-20T10:00:00Z', adoptedAt: '2026-10-20T10:02:00Z', baselineEvidence: [evidence('before', '2026-10-20T09:59:00Z')], candidateEvidence: [evidence('after', '2026-10-20T10:01:00Z')] };
  await assert.rejects(create(f, { refinementId: 'comparison' }), /adopted comparison/);
  f.refinements.set('b:comparison', record); await assert.rejects(create(f, { refinementId: 'comparison' }), /adopted comparison/);
  f.refinements.set('a:comparison', record);
  const skill = await create(f, { refinementId: 'comparison' });
  const read = await f.library.call({ action: 'read', id: skill.id }, 'a');
  assert.equal(read.evidence.skillHash, skill.hash); assert.equal(read.evidence.refinementId, 'comparison');
  assert.doesNotMatch(JSON.stringify(read.evidence), /FIRST_SECRET|REFERENCE_SECRET/);
  await f.library.call({ action: 'revise', id: skill.id, baseRevision: 1, instructions: 'New instructions' }, 'a');
  assert.equal((await f.library.call({ action: 'read', id: skill.id }, 'a')).evidence, null);
  record.candidateEvidence = record.baselineEvidence;
  await assert.rejects(create(f, { refinementId: 'comparison' }), /distinct later/);
  record.status = 'retired'; await assert.rejects(create(f, { refinementId: 'comparison' }), /adopted comparison/);
});

test('failed saves roll back state and successful revisions survive restart with integrity checks', async t => {
  let fail = true;
  const f = await fixture(t, { writeState: async (file, text) => { if (fail) throw Error('Synthetic disk failure'); return durableReplace(file, text); } });
  await assert.rejects(create(f), /disk failure/); assert.equal(f.library.state.skills.length, 0);
  fail = false; const skill = await create(f);
  const restarted = await new SkillLibrary(f.config).init();
  assert.equal((await restarted.call({ action: 'read', id: skill.id }, 'a')).text, draft().instructions);
  const saved = JSON.parse(await readFile(path.join(f.dir, 'library.json'), 'utf8'));
  saved.skills[0].revisions[0].instructions = 'Tampered content';
  await writeFile(path.join(f.dir, 'library.json'), JSON.stringify(saved), 'utf8');
  await assert.rejects(new SkillLibrary(f.config).init(), /integrity/);
});

test('optimistic revisions prevent stale edits and retirement removes future catalog discovery', async t => {
  const f = await fixture(t), skill = await create(f);
  const changes = await Promise.allSettled([f.library.call({ action: 'revise', id: skill.id, baseRevision: 1, instructions: 'first' }, 'a'), f.library.call({ action: 'revise', id: skill.id, baseRevision: 1, instructions: 'second' }, 'a')]);
  assert.equal(changes[0].status, 'fulfilled'); assert.equal(changes[1].status, 'rejected');
  await f.library.call({ action: 'retire', id: skill.id, baseRevision: 2 }, 'a');
  assert.equal(f.library.context('a'), '');
  assert.equal((await f.library.call({ action: 'catalog' }, 'a')).skills.length, 0);
  assert.equal((await f.library.call({ action: 'catalog', includeRetired: true }, 'a')).skills[0].status, 'retired');
  assert.equal((await f.library.call({ action: 'read', id: skill.id, revision: 1 }, 'a')).text, draft().instructions);
  await assert.rejects(f.library.call({ action: 'revise', id: skill.id, baseRevision: 2, instructions: 'revive' }, 'a'), /retired/);
});

test('reference names and storage files never follow supplied filesystem paths', async t => {
  const f = await fixture(t);
  await assert.rejects(create(f, { references: [{ name: '../secret', text: 'no' }] }), /without paths/);
  await assert.rejects(create(f, { references: [{ name: 'a.md', text: 'one' }, { name: 'A.md', text: 'two' }] }), /unique/);
  await assert.rejects(create(f, { instructions: 'x'.repeat(SKILL_LIMITS.instructions + 1) }), /instructions/);
  const linked = path.join(f.dir, 'linked'); await symlink(f.dir, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new SkillLibrary({ ...f.config, dir: linked }).init(), /must not be a link/);
});

test('literal instruction/reference whitespace survives revisions and reference digest corruption is rejected', async t => {
  const f = await fixture(t), instructions = '  indented instruction\n\n', reference = '\n  literal reference\n';
  const skill = await create(f, { instructions, references: [{ name: 'literal.md', text: reference }] });
  assert.equal((await f.library.call({ action: 'read', id: skill.id }, 'a')).text, instructions);
  assert.equal((await f.library.call({ action: 'read', id: skill.id, reference: 'literal.md' }, 'a')).text, reference);
  const saved = JSON.parse(await readFile(path.join(f.dir, 'library.json'), 'utf8'));
  saved.skills[0].revisions[0].references[0].hash = '0'.repeat(64);
  await writeFile(path.join(f.dir, 'library.json'), JSON.stringify(saved), 'utf8');
  await assert.rejects(new SkillLibrary(f.config).init(), /integrity/);
});

test('context ranks relevant metadata without requiring every word in a user request to match', async t => {
  const f = await fixture(t), skill = await create(f);
  await create(f, { name: 'Photo tagging', description: 'Organize photographs.', tags: ['photos'], appliesWhen: 'A picture collection needs labels.' });
  const context = f.library.context('a', { query: 'Please help me read documents with bounded reading today' });
  assert.match(context, new RegExp(skill.id)); assert.doesNotMatch(context, /Photo tagging|FIRST_SECRET/);
  assert.equal(f.library.context('a', { query: 'Orchestral counterpoint' }), '');
});

test('shared comparison metadata is included in the exact approval and revalidated before saving', async t => {
  const f = await fixture(t), before = { id: 'before', tool: 'workspace_read', status: 'completed', digest: 'a'.repeat(64), completedAt: '2026-10-20T09:59:00Z' }, after = { ...before, id: 'after', digest: 'b'.repeat(64), completedAt: '2026-10-20T10:01:00Z' };
  const record = { id: 'comparison', status: 'adopted', createdAt: '2026-10-20T10:00:00Z', adoptedAt: '2026-10-20T10:02:00Z', baselineEvidence: [before], candidateEvidence: [after] };
  f.refinements.set('a:comparison', record);
  f.library.approve = async request => {
    const shown = JSON.parse(request.detail);
    assert.equal(shown.evidence.sourceChatId, 'a'); assert.equal(shown.evidence.refinementId, 'comparison'); assert.equal(shown.evidence.baseline[0].digest, before.digest);
    assert.match(shown.evidence.skillHash, /^[a-f0-9]{64}$/); assert.equal(request.requireConfirmation, true);
    record.status = 'retired'; return true;
  };
  await assert.rejects(create(f, { scope: 'project', refinementId: 'comparison' }), /adopted comparison/);
  assert.equal(f.library.state.skills.length, 0);
});
