import path from 'node:path';
import { mkdir, readFile, realpath, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { durableReplace } from './durable-state.mjs';
import { PROCEDURE_SCHEMA, normalizeProcedure, prepareProcedure, evaluateProcedure, validateProcedureEvaluations } from './skill-procedures.mjs';
import { inspectSkillFiles, IMPORT_FILES_SCHEMA, toolContracts } from './skill-compatibility.mjs';
import { HOLDOUT_SCHEMA, LEARNING_NOTICE, learnedDraft, learningHash, validateLearningRecord } from './skill-learning.mjs';

export const SKILL_LIMITS = Object.freeze({ skills: 100, revisions: 24, references: 12, instructions: 24000, reference: 24000, bytes: 4 * 1024 * 1024, page: 24000, sharingPreview: 22000 });
const string = (value, max, label, { empty = false, trim = true } = {}) => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (!empty && !value.trim())) throw Error(`Provide ${label} in up to ${max} characters.`);
  return trim ? value.trim() : value;
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, fallback, min, max, label) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`Invalid ${label}.`);
  return value;
};
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const SCOPES = new Set(['chat', 'project', 'all']);
const containsScope=(owner,dependency)=>dependency.kind==='all'||owner.kind==='chat'&&(dependency.kind==='project'||dependency.kind==='chat'&&owner.id===dependency.id)||owner.kind==='project'&&dependency.kind==='project'&&owner.id===dependency.id;
const fields = new Set(['action', 'id', 'revision', 'baseRevision', 'hash', 'reference', 'offset', 'limit', 'query', 'includeRetired', 'scope', 'name', 'description', 'tags', 'appliesWhen', 'caveat', 'instructions', 'references', 'refinementId', 'procedure', 'values', 'outcomes', 'planRef', 'files', 'dependencies', 'sourceEvaluationHash', 'holdouts', 'review']);
const textSchema = maxLength => ({ type: 'string', maxLength });
export const SKILL_LIBRARY_TOOLS = [{ name: 'skill_library', description: 'Discover and read shared skills and structured procedures. catalog returns metadata; read loads an immutable revision/reference. create defaults to this saved chat; revise requires baseRevision and clears earlier evaluation status. A procedure declares parameters, preconditions, data scope, tools, outputs, typed acceptance checks and recovery steps. prepare requires revision/hash, validates values and returns a checklist and a chat-bound planRef, expiring after ten minutes; it runs nothing. evaluate requires current baseRevision/hash, planRef, identical values and outcomes mapping each check ID to a distinct same-chat host outcome mark observed after preparation. Checked conditions do not establish semantic correctness or general performance. Project/all sharing requires confirmation and shared memory. refinementId links an adopted comparison. Skills grant no permissions or script execution. Private chats are excluded.', inputSchema: {
  type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['catalog', 'read', 'create', 'revise', 'retire', 'prepare', 'evaluate', 'inspect', 'dependencies', 'learn', 'promote'] }, id: textSchema(80), revision: { type: 'integer', minimum: 1, maximum: SKILL_LIMITS.revisions }, baseRevision: { type: 'integer', minimum: 1, maximum: SKILL_LIMITS.revisions }, hash: textSchema(64),
    reference: textSchema(80), offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: SKILL_LIMITS.page }, query: textSchema(200), includeRetired: { type: 'boolean' }, scope: { type: 'string', enum: [...SCOPES] },
    name: textSchema(80), description: textSchema(400), tags: { type: 'array', maxItems: 10, items: textSchema(40) }, appliesWhen: textSchema(500), caveat: textSchema(500), instructions: textSchema(SKILL_LIMITS.instructions),
    references: { type: 'array', maxItems: SKILL_LIMITS.references, items: { type: 'object', additionalProperties: false, required: ['name', 'text'], properties: { name: textSchema(80), text: textSchema(SKILL_LIMITS.reference) } } }, refinementId: textSchema(80),
    procedure: PROCEDURE_SCHEMA, values: { type: 'object', maxProperties: 12, additionalProperties: textSchema(1000) }, outcomes: { type: 'object', maxProperties: 12, additionalProperties: textSchema(80) }, planRef: textSchema(80),
    files: IMPORT_FILES_SCHEMA, dependencies: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['id', 'revision', 'hash'], properties: { id: textSchema(80), revision: { type: 'integer', minimum: 1, maximum: SKILL_LIMITS.revisions }, hash: textSchema(64) } } },
    sourceEvaluationHash: textSchema(64), holdouts: HOLDOUT_SCHEMA, review: textSchema(1500),
  },
} }];
const NOTICE = 'Skills are reusable source material. Current instructions and permissions take precedence. Evidence receipts record operations, not proof of every claim or safety.';
SKILL_LIBRARY_TOOLS[0].description += ' learn creates a reviewed chat-local candidate from an exact accepted sourceEvaluationHash, replacing explicit training bindings and committing two to four withheld input cases. Supply id/baseRevision/hash and holdouts. Candidates are excluded from automatic context. Prepare and evaluate each committed case, then promote with id/baseRevision/hash and a semantic review. Promotion requires fresh distinct host outcomes and separate confirmation; it does not establish general semantic quality.';

function content(args, previous) {
  const value = {};
  for (const [key, max, required] of [['name', 80, true], ['description', 400, true], ['appliesWhen', 500, false], ['caveat', 500, false], ['instructions', SKILL_LIMITS.instructions, true]]) value[key] = string(args[key] ?? previous?.[key] ?? '', max, key, { empty: !required, trim: key !== 'instructions' });
  const tags = args.tags ?? previous?.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 10) throw Error('Use at most ten skill tags.');
  value.tags = [...new Set(tags.map(tag => string(tag, 40, 'a tag')))];
  const refs = args.references ?? previous?.references ?? [];
  if (!Array.isArray(refs) || refs.length > SKILL_LIMITS.references) throw Error(`Use at most ${SKILL_LIMITS.references} named references.`);
  value.references = refs.map(ref => {
    if (!object(ref) || Object.keys(ref).some(key => !['name', 'text', 'hash'].includes(key)) || !REF.test(ref.name || '')) throw Error('Reference names are simple names, without paths or URLs.');
    const text = string(ref.text, SKILL_LIMITS.reference, 'reference text', { empty: true, trim: false });
    return { name: ref.name, text, hash: digest(text) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(value.references.map(ref => ref.name.toLowerCase())).size !== value.references.length) throw Error('Reference names must be unique.');
  const procedure = normalizeProcedure(args.procedure === undefined ? previous?.procedure : args.procedure);
  if (procedure) value.procedure = procedure;
  const dependencies = args.dependencies ?? previous?.dependencies;
  if (dependencies !== undefined) {
    if (!Array.isArray(dependencies) || dependencies.length > 12) throw Error('Use at most twelve pinned skill dependencies.');
    const seen = new Set();
    value.dependencies = dependencies.map(dep => {
      if (!object(dep) || Object.keys(dep).some(key => !['id', 'revision', 'hash'].includes(key)) || !ID.test(dep.id || '') || seen.has(dep.id) || !Number.isSafeInteger(dep.revision) || dep.revision < 1 || dep.revision > SKILL_LIMITS.revisions || !/^[a-f0-9]{64}$/.test(dep.hash || '')) throw Error('Pin each dependency to a unique skill ID, revision and hash.');
      seen.add(dep.id); return { id: dep.id, revision: dep.revision, hash: dep.hash };
    });
  }
  return value;
}
function storedContent(revision) { return content(revision); }
function receipt(value) {
  if (!object(value) || typeof value.id !== 'string' || typeof value.tool !== 'string' || !['completed', 'failed'].includes(value.status) || !/^[a-f0-9]{64}$/.test(value.digest || '') || !Number.isFinite(Date.parse(value.completedAt))) throw Error('The adopted comparison has invalid evidence receipts.');
  return { id: value.id, tool: value.tool, status: value.status, digest: value.digest, startedAt: value.startedAt, completedAt: value.completedAt };
}

/** Content validation is shared by the live library and portable backups. */
export function validateSkillLibraryState(state) {
  if (!object(state) || state.version !== 1 || !Array.isArray(state.skills) || state.skills.length > SKILL_LIMITS.skills) throw Error('Invalid skill library format.');
  const seen = new Set();
  for (const skill of state.skills) {
    if (!object(skill) || !ID.test(skill.id || '') || seen.has(skill.id) || typeof skill.ownerChatId !== 'string' || !SCOPES.has(skill.scope?.kind) || !['active', 'retired'].includes(skill.status) || !Array.isArray(skill.revisions) || !skill.revisions.length || skill.revisions.length > SKILL_LIMITS.revisions) throw Error('Invalid skill library entry.');
    seen.add(skill.id);
    if (skill.scope.kind === 'chat' && skill.scope.id !== skill.ownerChatId || skill.scope.kind === 'project' && !skill.scope.id || skill.scope.kind === 'all' && skill.scope.id !== undefined) throw Error('Invalid skill sharing scope.');
    for (let i = 0; i < skill.revisions.length; i++) { const revision = skill.revisions[i]; if (revision.revision !== i + 1 || revision.hash !== digest(storedContent(revision)) || revision.references.some(ref => ref.hash !== digest(ref.text))) throw Error('Skill revision integrity check failed.'); }
    validateProcedureEvaluations(skill);
    validateLearningRecord(skill);
  }
  const byId=new Map(state.skills.map(skill=>[skill.id,skill]));
  for(const skill of state.skills)for(const revision of skill.revisions){
    let inspected=0;
    const walk=(owner,body,branch,depth)=>{
      if(depth>12)throw Error('Stored skill dependency graph exceeds the inspection limit.');
      for(const dep of body.dependencies||[]){
        if(++inspected>100)throw Error('Stored skill dependency graph exceeds the inspection limit.');
        if(branch.has(dep.id))throw Error('Stored skill dependencies contain a cycle.');
        const target=byId.get(dep.id);if(!target)continue; // portable subsets remain visibly unresolved
        if(!containsScope(owner.scope,target.scope))throw Error('Stored skill dependency sharing scope is invalid.');
        const pinned=target.revisions.find(item=>item.revision===dep.revision&&item.hash===dep.hash);
        if(!pinned)throw Error('Stored skill dependency revision integrity check failed.');
        walk(target,pinned,new Set([...branch,dep.id]),depth+1);
      }
    };
    walk(skill,revision,new Set([skill.id]),0);
  }
  return state;
}

/** Provider-neutral content only. No native skill/account directories, network imports, or script execution. */
export class SkillLibrary {
  constructor({ dir, getChat, getSettings = () => ({}), getRefinement = () => null, getOutcome = () => null, getTools = () => [], getToolScope = () => '', approve = async () => false, emit = () => {}, now = () => new Date(), writeState = durableReplace }) {
    if (!dir || typeof getChat !== 'function') throw Error('A host-owned skill directory and chat resolver are required.');
    Object.assign(this, { dir: path.resolve(dir), getChat, getSettings, getRefinement, getOutcome, getTools, getToolScope, approve, emit, now, writeState });
    this.file = path.join(this.dir, 'library.json'); this.state = { version: 1, skills: [] }; this.queue = Promise.resolve(); this.ready = false; this.prepared = new Map();
  }
  get definitions() { return SKILL_LIBRARY_TOOLS; }
  stamp() { const value = this.now(); return (value instanceof Date ? value : new Date(value)).toISOString(); }
  async safeRoot() {
    const info = await lstat(this.dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('The skill library directory must not be a link.');
    const actual = await realpath(this.dir);
    if (this.root && actual !== this.root) throw Error('The skill library directory changed. Reopen Exomina before continuing.');
    this.root = actual;
    try { const file = await lstat(this.file); if (!file.isFile() || file.isSymbolicLink() || file.size > SKILL_LIMITS.bytes) throw Error('The skill library file is unsafe or too large.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async init() {
    await mkdir(this.dir, { recursive: true }); await this.safeRoot();
    try { this.state = this.validate(JSON.parse(await readFile(this.file, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw Error('The skill library could not be opened: ' + error.message); }
    this.ready = true; return this;
  }
  validate(state) {
    return validateSkillLibraryState(state);
  }
  chat(id) { const chat = this.getChat(id); if (!chat || chat.private) throw Error('Skills require a saved, non-private chat.'); return chat; }
  shared() { return this.getSettings().memoryEnabled === true; }
  scope(kind, chat) {
    if (!SCOPES.has(kind)) throw Error('Choose chat, project or all scope.');
    if (kind !== 'chat' && !this.shared()) throw Error('Sharing skills requires shared memory.');
    if (kind === 'project' && !chat.projectId) throw Error('Choose a project chat before sharing a project skill.');
    return { kind, ...(kind === 'chat' ? { id: chat.id } : kind === 'project' ? { id: chat.projectId } : {}) };
  }
  visible(skill, chat) {
    if (skill.scope.kind === 'chat') return skill.scope.id === chat.id;
    return this.shared() && (skill.scope.kind === 'all' || skill.scope.id === chat.projectId);
  }
  find(id, chat) { const skill = this.state.skills.find(skill => skill.id === id); if (!skill || !this.visible(skill, chat)) throw Error('This skill is unavailable in this chat.'); return skill; }
  dependencies(args, chat) {
    const skill = this.find(args.id, chat), revision = skill.revisions.find(item => item.revision === (args.revision ?? skill.revisions.length));
    if (!revision || args.hash !== undefined && args.hash !== revision.hash) throw Error('Read the exact skill revision before inspecting dependencies.');
    const visited = new Set(), rows = [];
    const walk = (parent, body, depth) => {
      if (depth > 12 || rows.length >= 100) throw Error('The dependency graph exceeds the inspection limit.');
      for (const dep of body.dependencies || []) {
        const target = this.state.skills.find(item => item.id === dep.id && this.visible(item, chat));
        const pinned = target?.revisions.find(item => item.revision === dep.revision && item.hash === dep.hash);
        const status = !target || !pinned ? 'unavailable' : target.status !== 'active' ? 'retired' : target.revisions.at(-1).revision !== dep.revision || target.revisions.at(-1).hash !== dep.hash ? 'changed' : 'current';
        // Do not expose names, hashes or other metadata of revoked dependencies.
        rows.push({ from: parent, dependency: target ? { ...dep, name: pinned?.name } : { status: 'unavailable' }, status });
        const key = dep.id + ':' + dep.hash;
        if (pinned && !visited.has(key)) { visited.add(key); walk(dep.id, pinned, depth + 1); }
      }
    };
    walk(skill.id, revision, 0);
    return { id: skill.id, revision: revision.revision, hash: revision.hash, status: rows.every(row => row.status === 'current') ? 'current' : 'needs-review', dependencies: rows, references: revision.references.map(({ name, hash }) => ({ name, hash })), notice: 'Pinned source relations only. Changed, retired or unavailable inputs need review. No source is rewritten and no action is repeated.' };
  }
  metadata(skill, chat, userInitiated = false) {
    const current = skill.revisions.at(-1);
    let learningStatus = skill.learning?.revision === current.revision && skill.learning?.skillHash === current.hash ? skill.learning.status : 'needs-review';
    if (learningStatus === 'promoted') try { if (this.dependencies({ id: skill.id }, chat).status !== 'current') throw Error('Changed dependency'); for (const item of skill.learning.evaluations) this.acceptedRun(skill, current, item.evaluationHash, chat.id); } catch { learningStatus = 'needs-review'; }
    return { id: skill.id, name: current.name, description: current.description, tags: current.tags, appliesWhen: current.appliesWhen, caveat: current.caveat, scope: skill.scope.kind, status: skill.status, revision: current.revision, hash: current.hash, updatedAt: current.createdAt, references: current.references.map(({ name, hash, text }) => ({ name, hash, characters: text.length })), hasEvidence: !!current.evidence, procedureStatus: current.procedure ? ((skill.evaluations || []).some(item => item.skillHash === current.hash && item.revision === current.revision) ? 'conditions-checked' : 'draft') : null, ...(skill.learning ? { learningStatus } : {}), editable: userInitiated || skill.ownerChatId === chat.id };
  }
  catalog(args, chat, userInitiated = false) {
    const query = string(args.query ?? '', 200, 'a query', { empty: true }).toLocaleLowerCase();
    if (args.scope !== undefined && !SCOPES.has(args.scope)) throw Error('Choose chat, project or all scope.');
    const offset = integer(args.offset, 0, 0, SKILL_LIMITS.skills, 'catalog offset'), limit = integer(args.limit, 25, 1, 50, 'catalog limit');
    const words = query.split(/\s+/).filter(Boolean);
    const records = this.state.skills.filter(skill => this.visible(skill, chat) && (args.includeRetired === true || skill.status === 'active') && (!args.scope || skill.scope.kind === args.scope)).map(skill => this.metadata(skill, chat, userInitiated)).filter(skill => words.every(word => `${skill.name} ${skill.description} ${skill.tags.join(' ')} ${skill.appliesWhen}`.toLocaleLowerCase().includes(word))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
    return { skills: records.slice(offset, offset + limit), total: records.length, nextOffset: offset + limit < records.length ? offset + limit : null, notice: NOTICE };
  }
  read(args, chat, userInitiated = false) {
    const skill = this.find(args.id, chat), number = integer(args.revision, skill.revisions.length, 1, SKILL_LIMITS.revisions, 'skill revision');
    const revision = skill.revisions.find(revision => revision.revision === number);
    if (!revision) throw Error('This skill revision does not exist.');
    if (args.hash !== undefined && args.hash !== revision.hash) throw Error('The skill revision changed. Read the catalog again.');
    let text = revision.instructions;
    if (args.reference !== undefined) { if (!REF.test(args.reference || '')) throw Error('Choose a named reference, without a path.'); const reference = revision.references.find(ref => ref.name === args.reference); if (!reference) throw Error('This reference does not exist in this revision.'); text = reference.text; }
    const offset = integer(args.offset, 0, 0, text.length, 'text offset'), limit = integer(args.limit, 12000, 1, SKILL_LIMITS.page, 'text limit');
    return { ...this.metadata(skill, chat, userInitiated), name: revision.name, description: revision.description, tags: revision.tags, appliesWhen: revision.appliesWhen, caveat: revision.caveat, revision: number, hash: revision.hash, reference: args.reference ?? null, text: text.slice(offset, offset + limit), totalCharacters: text.length, nextOffset: offset + limit < text.length ? offset + limit : null, references: revision.references.map(({ name, hash, text }) => ({ name, hash, characters: text.length })), versions: skill.revisions.map(({ revision, hash, createdAt }) => ({ revision, hash, createdAt })), evidence: revision.evidence || null, procedure: revision.procedure || null, procedureStatus: revision.procedure ? ((skill.evaluations || []).some(item => item.skillHash === revision.hash && item.revision === revision.revision) ? 'conditions-checked' : 'draft') : null, evaluations: (skill.evaluations || []).filter(item => item.skillHash === revision.hash && item.revision === revision.revision), notice: NOTICE };
  }
  prepare(args, chat) {
    const skill = this.find(args.id, chat), number = integer(args.revision, skill.revisions.length, 1, SKILL_LIMITS.revisions, 'skill revision');
    const revision = skill.revisions.find(item => item.revision === number);
    if (skill.status !== 'active' || !revision || args.hash !== revision.hash) throw Error('Read the active skill revision and supply its exact hash before preparing a procedure.');
    const dependencyState = this.dependencies({ id: skill.id, revision: number }, chat);
    if (dependencyState.status !== 'current') throw Error('A pinned dependency changed or became unavailable. Review it and create a new revision before preparing.');
    const preparedAt = this.stamp(), planRef = randomUUID(), plan = { id: skill.id, ...prepareProcedure(revision, args.values), preparedAt, planRef };
    plan.capabilities = toolContracts(plan.tools, this.getTools(chat.id), this.getToolScope(chat.id));
    this.prepared.set(planRef, { chatId: chat.id, plan });
    while (this.prepared.size > 50) this.prepared.delete(this.prepared.keys().next().value);
    return { ...plan, expiresAt: new Date(Date.parse(preparedAt) + 10 * 60_000).toISOString() };
  }
  acceptedRun(skill, revision, evaluationHash, chatId) {
    const evaluation = (skill.evaluations || []).find(item => digest(item) === evaluationHash && item.revision === revision.revision && item.skillHash === revision.hash);
    if (!evaluation) throw Error('Choose an accepted run from this exact skill revision.');
    const plan = { ...prepareProcedure(revision, evaluation.bindings), preparedAt: evaluation.preparedAt };
    const ids = Object.fromEntries(evaluation.checks.map(check => [check.checkId, check.outcomeId]));
    const fresh = evaluateProcedure(plan, ids, id => this.getOutcome(chatId, id), revision, this.stamp());
    if (digest(fresh.checks) !== digest(evaluation.checks)) throw Error('The accepted run evidence changed or is no longer available in this chat.');
    return evaluation;
  }
  async learn(args, chatId, userInitiated) {
    const chat = this.chat(chatId), source = this.find(args.id, chat), previous = this.state, revision = source.revisions.at(-1);
    if (source.status !== 'active' || args.baseRevision !== revision.revision || args.hash !== revision.hash) throw Error('Read the active source revision before learning from a run.');
    if (!userInitiated && source.ownerChatId !== chatId) throw Error('Only the originating chat can learn from its accepted runs.');
    if (previous.skills.length >= SKILL_LIMITS.skills) throw Error('The skill library reached its skill limit.');
    if (this.dependencies({ id: source.id }, chat).status !== 'current') throw Error('Review changed source dependencies before learning.');
    const evaluation = this.acceptedRun(source, revision, args.sourceEvaluationHash, chatId);
    const generated = learnedDraft(revision, evaluation, args.holdouts), body = content({ ...generated.draft, dependencies: [{ id: source.id, revision: revision.revision, hash: revision.hash }] }), scope = { kind: 'chat', id: chatId };
    const detail = JSON.stringify({ source: { id: source.id, revision: revision.revision, hash: revision.hash }, generalizedContent: body, withheldInputs: generated.cases, notice: LEARNING_NOTICE }, null, 2);
    if (!await this.approve({ title: 'Create a generalized procedure candidate?', detail, conversationId: chatId, action: { kind: 'write', tool: 'skill_library', target: `chat:learn:${source.id}` }, requireConfirmation: true, userInitiated })) throw Error('The learning candidate was declined.');
    const fresh = () => {
      this.chat(chatId); this.find(source.id, this.chat(chatId));
      if (this.state !== previous || this.dependencies({ id: source.id }, this.chat(chatId)).status !== 'current') throw Error('The source skill or its dependencies changed during candidate review.');
      this.acceptedRun(source, revision, args.sourceEvaluationHash, chatId);
    };
    fresh();
    const createdAt = this.stamp(), next = structuredClone(previous), skill = { id: randomUUID(), ownerChatId: chatId, scope, status: 'active', createdAt, revisions: [{ ...body, revision: 1, hash: digest(body), createdAt }] };
    skill.learning = { status: 'candidate', revision: 1, skillHash: skill.revisions[0].hash, committedAt: createdAt, trainingBindingsHash: generated.trainingBindingsHash, cases: generated.cases, source: { id: source.id, revision: revision.revision, hash: revision.hash, evaluationHash: args.sourceEvaluationHash }, notice: LEARNING_NOTICE };
    next.skills.push(skill); this.validate(next);
    const serialized = JSON.stringify(next); if (Buffer.byteLength(serialized, 'utf8') > SKILL_LIMITS.bytes) throw Error('The skill library reached its storage limit.');
    await this.safeRoot(); fresh(); await this.writeState(this.file, serialized); this.state = next; this.emit({ type: 'skills.changed' });
    return { skill: this.metadata(skill, chat, userInitiated), notice: LEARNING_NOTICE };
  }
  async promote(args, chatId, userInitiated) {
    const chat = this.chat(chatId), skill = this.find(args.id, chat), previous = this.state, revision = skill.revisions.at(-1), learning = skill.learning;
    if (!userInitiated && skill.ownerChatId !== chatId) throw Error('Only the originating chat can promote a learning candidate.');
    if (skill.status !== 'active' || !learning || learning.status !== 'candidate' || args.baseRevision !== revision.revision || args.hash !== revision.hash || learning.revision !== revision.revision || learning.skillHash !== revision.hash) throw Error('This learning candidate changed. Generate a fresh candidate and withheld cases.');
    const review = string(args.review, 1500, 'a review of meaning, remaining limitations and withheld results');
    if (review.length < 40) throw Error('Describe the semantic review and remaining limitations in at least 40 characters.');
    const check = () => {
      this.chat(chatId); this.find(skill.id, this.chat(chatId));
      if (this.state !== previous || this.dependencies({ id: skill.id }, this.chat(chatId)).status !== 'current') throw Error('The candidate or its dependencies changed during review.');
      const used = new Set();
      return learning.cases.map(item => {
        const evaluation = [...(skill.evaluations || [])].reverse().find(record => record.revision === revision.revision && record.skillHash === revision.hash && digest(record.bindings) === item.bindingsHash && Date.parse(record.preparedAt) >= Date.parse(learning.committedAt));
        if (!evaluation) throw Error(`Withheld case ${item.id} needs fresh acceptance evidence after its inputs were committed.`);
        this.acceptedRun(skill, revision, digest(evaluation), chatId);
        for (const receipt of evaluation.checks) { if (used.has(receipt.outcomeId)) throw Error('Withheld cases need distinct host observations.'); used.add(receipt.outcomeId); }
        return { caseId: item.id, evaluationHash: digest(evaluation) };
      });
    };
    const evaluations = check();
    if (!await this.approve({ title: 'Promote this reviewed procedure?', detail: JSON.stringify({ id: skill.id, revision: revision.revision, hash: revision.hash, withheldCases: learning.cases, evaluations, review, notice: LEARNING_NOTICE }, null, 2), conversationId: chatId, action: { kind: 'write', tool: 'skill_library', target: `chat:promote:${skill.id}` }, requireConfirmation: true, userInitiated })) throw Error('The procedure promotion was declined.');
    if (digest(check()) !== digest(evaluations)) throw Error('The withheld evidence changed during review.');
    const next = structuredClone(previous), changed = next.skills.find(item => item.id === skill.id);
    changed.learning = { ...changed.learning, status: 'promoted', promotedAt: this.stamp(), review, evaluations };
    this.validate(next); await this.safeRoot(); check(); await this.writeState(this.file, JSON.stringify(next)); this.state = next; this.emit({ type: 'skills.changed' });
    return { skill: this.metadata(changed, chat, userInitiated), notice: LEARNING_NOTICE };
  }
  async evaluate(args, chatId, userInitiated) {
    const chat = this.chat(chatId), skill = this.find(args.id, chat), previous = this.state;
    if (!userInitiated && skill.ownerChatId !== chat.id) throw Error('Only the originating chat can evaluate this procedure.');
    if (args.baseRevision !== skill.revisions.length) throw Error('The skill changed. Read its current revision before evaluating.');
    const prepared = this.prepared.get(args.planRef), revision = skill.revisions.at(-1), scope = this.scope(skill.scope.kind, chat);
    const freshPlan = () => { const age = prepared && Date.parse(this.stamp()) - Date.parse(prepared.plan.preparedAt); if (!prepared || this.prepared.get(args.planRef) !== prepared || prepared.chatId !== chat.id || prepared.plan.id !== skill.id || prepared.plan.revision !== revision.revision || prepared.plan.skillHash !== revision.hash || args.hash !== revision.hash || age < 0 || age > 10 * 60_000) throw Error('Prepare a fresh checklist in this chat before recording acceptance evidence.'); };
    freshPlan();
    const freshEnvironment = () => {
      if (this.dependencies({ id: skill.id, revision: revision.revision }, this.chat(chatId)).status !== 'current' || toolContracts(prepared.plan.tools, this.getTools(chatId), this.getToolScope(chatId)).fingerprint !== prepared.plan.capabilities.fingerprint) throw Error('Procedure dependencies, tools or permission scope changed. Prepare a fresh checklist.');
    };
    freshEnvironment();
    const plan = prepared.plan;
    if (prepareProcedure(revision, args.values).planHash !== plan.planHash) throw Error('Procedure inputs changed. Prepare the checklist again.');
    const evaluate = () => evaluateProcedure(plan, args.outcomes, id => this.getOutcome(chatId, id), revision, this.stamp());
    const evaluation = evaluate();
    const detail = JSON.stringify({ id: skill.id, scope, plan, evaluation }, null, 2);
    if (scope.kind !== 'chat' && Buffer.byteLength(detail, 'utf8') > SKILL_LIMITS.sharingPreview) throw Error('The complete sharing preview is too large. Use fewer acceptance checks.');
    if (!await this.approve({ title: scope.kind === 'chat' ? 'Record procedure acceptance checks?' : `Share procedure acceptance evidence with ${scope.kind === 'project' ? 'this project' : 'all saved chats'}?`, detail, conversationId: chatId, action: { kind: 'write', tool: 'skill_library', target: `${scope.kind}:${skill.id}` }, requireConfirmation: scope.kind !== 'chat', userInitiated })) throw Error('The procedure evaluation was declined.');
    freshPlan();
    if (previous !== this.state || JSON.stringify(this.scope(scope.kind, this.chat(chatId))) !== JSON.stringify(scope)) throw Error('The skill or sharing scope changed while approval was pending.');
    freshEnvironment();
    const fresh = evaluate();
    if (digest(fresh.checks) !== digest(evaluation.checks)) throw Error('Acceptance evidence changed while approval was pending.');
    const next = structuredClone(previous), changed = next.skills.find(item => item.id === skill.id);
    const pinned = new Set((changed.learning?.evaluations || []).map(item => item.evaluationHash));
    const retained = (changed.evaluations || []).filter(item => pinned.has(digest(item)));
    changed.evaluations = [...retained, ...[...(changed.evaluations || []).filter(item => !pinned.has(digest(item))), evaluation].slice(-(12 - retained.length))];
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized, 'utf8') > SKILL_LIMITS.bytes) throw Error('The skill library reached its storage limit.');
    await this.safeRoot();
    if (JSON.stringify(this.scope(scope.kind, this.chat(chatId))) !== JSON.stringify(scope)) throw Error('The sharing scope changed before acceptance evidence could be saved.');
    freshPlan(); freshEnvironment();
    if (digest(evaluate().checks) !== digest(evaluation.checks)) throw Error('Acceptance evidence changed before it could be saved.');
    await this.writeState(this.file, serialized); this.state = next; this.emit({ type: 'skills.changed' });
    return { skill: this.metadata(changed, chat, userInitiated), evaluation, notice: evaluation.notice };
  }
  evidence(refinementId, chat, hash) {
    if (refinementId === undefined) return undefined;
    if (typeof refinementId !== 'string' || !ID.test(refinementId)) throw Error('Choose an adopted comparison from this chat.');
    const record = this.getRefinement(chat.id, refinementId);
    if (!record || record.id !== refinementId || record.status !== 'adopted' || !Array.isArray(record.baselineEvidence) || !record.baselineEvidence.length || !Array.isArray(record.candidateEvidence) || !record.candidateEvidence.length) throw Error('Evidence must link to an adopted comparison in this chat.');
    const baseline = record.baselineEvidence.map(receipt), candidate = record.candidateEvidence.map(receipt);
    if (baseline.length > 4 || candidate.length > 4 || !Number.isFinite(Date.parse(record.createdAt)) || candidate.some(item => baseline.some(before => before.id === item.id) || Date.parse(item.completedAt) < Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.adoptedAt))) throw Error('The adopted comparison needs distinct later evidence.');
    return { refinementId, sourceChatId: chat.id, skillHash: hash, adoptedAt: record.adoptedAt, baseline, candidate, notice: 'Linked comparison receipts support the source lesson; they do not verify every skill instruction.' };
  }
  async confirm({ action, content: body, evidence, skill, scope, chat, userInitiated }) {
    const shared = scope.kind !== 'chat' && action !== 'retire';
    const detail = JSON.stringify({ action, id: skill?.id, name: body?.name || skill?.revisions.at(-1).name, scope, ...(action === 'retire' ? {} : { content: body, ...(evidence ? { evidence } : {}) }) }, null, 2);
    if (shared && Buffer.byteLength(detail, 'utf8') > SKILL_LIMITS.sharingPreview) throw Error('The complete sharing preview is too large. Use a smaller skill or share separate skills.');
    if (!await this.approve({ title: shared ? `Share skill with ${scope.kind === 'project' ? 'this project' : 'all saved chats'}?` : action === 'retire' ? 'Retire this skill?' : 'Save this skill revision?', detail, conversationId: chat.id, action: { kind: 'write', tool: 'skill_library', target: `${scope.kind}:${skill?.id || body.name}` }, requireConfirmation: shared, userInitiated })) throw Error('The skill change was declined.');
    const fresh = this.chat(chat.id), actual = this.scope(scope.kind, fresh);
    if (JSON.stringify(actual) !== JSON.stringify(scope)) throw Error('The chat sharing scope changed while approval was pending.');
  }
  async mutate(args, chatId, userInitiated) {
    const chat = this.chat(chatId), previous = this.state;
    let skill, body, scope;
    if (args.action === 'create') {
      if (previous.skills.length >= SKILL_LIMITS.skills) throw Error(`The library keeps at most ${SKILL_LIMITS.skills} skills.`);
      scope = this.scope(args.scope || 'chat', chat); body = content(args);
    } else {
      skill = this.find(args.id, chat);
      if (!userInitiated && skill.ownerChatId !== chat.id) throw Error('Only the originating chat can revise or retire this skill. Create a copy for your own changes.');
      const base = integer(args.baseRevision, undefined, 1, SKILL_LIMITS.revisions, 'base revision');
      if (base !== skill.revisions.length) throw Error('The skill changed. Read its current revision before editing.');
      scope = this.scope(skill.scope.kind, chat);
      if (JSON.stringify(scope) !== JSON.stringify(skill.scope)) throw Error('This skill belongs to a different sharing scope.');
      if (args.scope !== undefined && args.scope !== scope.kind) throw Error('Sharing scope is fixed for a skill. Create a new copy to share it more widely.');
      if (skill.status === 'retired') throw Error('This skill is retired. Create a new skill to use revised instructions.');
      if (args.action === 'revise') { if (skill.revisions.length >= SKILL_LIMITS.revisions) throw Error(`A skill keeps at most ${SKILL_LIMITS.revisions} revisions. Create a new skill.`); body = content(args, skill.revisions.at(-1)); }
    }
    const hash = body ? digest(body) : undefined;
    const checkDependencies = () => {
      let inspected=0;
      const walk=(ownerScope,deps,branch,depth)=>{
        if(depth>12)throw Error('The dependency graph exceeds the inspection limit.');
        for(const dep of deps||[]){
          if(++inspected>100)throw Error('The dependency graph exceeds the inspection limit.');
          if(branch.has(dep.id))throw Error('Skill dependencies must not contain self or transitive cycles.');
          const target=this.find(dep.id,this.chat(chatId));
          if(!containsScope(ownerScope,target.scope))throw Error('A shared skill cannot depend on a more restricted sharing scope.');
          const pinned=target.revisions.find(item=>item.revision===dep.revision&&item.hash===dep.hash);
          if(!pinned)throw Error('A pinned dependency revision is unavailable.');
          walk(target.scope,pinned.dependencies,new Set([...branch,dep.id]),depth+1);
        }
      };
      walk(scope,body?.dependencies,new Set(skill?[skill.id]:[]),0);
    };
    checkDependencies();
    const evidence = body ? this.evidence(args.refinementId, chat, hash) : undefined;
    await this.confirm({ action: args.action, content: body, evidence, skill, scope, chat, userInitiated });
    // No persistent mutation occurs before approval and the fresh privacy check.
    if (previous !== this.state) throw Error('The skill library changed. Retry from the current revision.');
    if (evidence && digest(this.evidence(args.refinementId, this.chat(chatId), hash)) !== digest(evidence)) throw Error('The source comparison changed while approval was pending.');
    const next = structuredClone(previous), createdAt = this.stamp();
    let changed;
    if (args.action === 'create') { changed = { id: randomUUID(), ownerChatId: chat.id, scope, status: 'active', createdAt, revisions: [] }; next.skills.push(changed); }
    else changed = next.skills.find(item => item.id === skill.id);
    if (args.action === 'retire') { changed.status = 'retired'; changed.retiredAt = createdAt; }
    else changed.revisions.push({ ...body, revision: changed.revisions.length + 1, hash, createdAt, ...(evidence ? { evidence } : {}) });
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized, 'utf8') > SKILL_LIMITS.bytes) throw Error('The skill library reached its storage limit.');
    await this.safeRoot();
    const freshScope = this.scope(scope.kind, this.chat(chatId));
    if (JSON.stringify(freshScope) !== JSON.stringify(scope)) throw Error('The chat sharing scope changed before the skill could be saved.');
    checkDependencies();
    await this.writeState(this.file, serialized); this.state = next;
    this.emit({ type: 'skills.changed' });
    return { skill: this.metadata(changed, this.chat(chatId), userInitiated), notice: NOTICE };
  }
  async call(args = {}, conversationId, { userInitiated = false } = {}) {
    if (!this.ready) throw Error('The skill library is not ready.');
    if (!object(args) || Object.keys(args).some(key => !fields.has(key)) || !['catalog', 'read', 'create', 'revise', 'retire', 'prepare', 'evaluate', 'inspect', 'dependencies', 'learn', 'promote'].includes(args.action)) throw Error('Choose a valid skill library action.');
    const chat = this.chat(conversationId);
    if (args.action === 'inspect') return inspectSkillFiles(args.files, this.getTools(chat.id));
    if (args.action === 'dependencies') return this.dependencies(args, chat);
    if (args.action === 'catalog') return this.catalog(args, chat, userInitiated);
    if (args.action === 'read') {
      const result = this.read(args, chat, userInitiated), sources = this.dependencies({ id: result.id, revision: result.revision }, chat);
      const skill = this.find(result.id, chat), revision = skill.revisions.find(item => item.revision === result.revision);
      return { ...result, evaluations: result.evaluations.map(item => ({ ...item, evaluationHash: digest(item) })), ...(skill.learning ? { learning: structuredClone(skill.learning) } : {}), dependencies: (revision.dependencies || []).filter(dep => this.state.skills.some(item => item.id === dep.id && this.visible(item, chat))), dependencyStatus: sources.status, ...(sources.status === 'needs-review' && result.procedure ? { procedureStatus: 'needs-review' } : {}) };
    }
    if (args.action === 'prepare') return this.prepare(args, chat);
    const work = this.queue.then(() => args.action === 'evaluate' ? this.evaluate(args, conversationId, userInitiated) : args.action === 'learn' ? this.learn(args, conversationId, userInitiated) : args.action === 'promote' ? this.promote(args, conversationId, userInitiated) : this.mutate(args, conversationId, userInitiated)); this.queue = work.catch(() => {}); return work;
  }
  context(conversationId, { query = '', limit = 8 } = {}) {
    if (!this.ready) return '';
    try {
      const chat = this.chat(conversationId), terms = String(query).toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [];
      const ranked = this.state.skills.filter(skill => skill.status === 'active' && this.visible(skill, chat) && (!skill.learning || this.metadata(skill, chat).learningStatus === 'promoted')).map(skill => { const metadata = this.metadata(skill, chat), text = `${metadata.name} ${metadata.description} ${metadata.tags.join(' ')} ${metadata.appliesWhen}`.toLocaleLowerCase(); return { metadata, score: [...new Set(terms)].filter(term => text.includes(term)).length }; }).filter(item => !terms.length || item.score > 0).sort((a, b) => b.score - a.score || b.metadata.updatedAt.localeCompare(a.metadata.updatedAt)).slice(0, Math.min(8, Math.max(1, limit)));
      if (!ranked.length) return '';
      const selected = [];
      for (const { metadata: skill } of ranked) { const item = { id: skill.id, revision: skill.revision, hash: skill.hash, name: skill.name, description: skill.description, appliesWhen: skill.appliesWhen, scope: skill.scope, procedureStatus: skill.procedureStatus }; if (JSON.stringify([...selected, item]).length > 6000) break; selected.push(item); }
      return 'Exomina skill catalog (metadata only; reusable source material, subordinate to current instructions and permissions). Use skill_library read with the listed revision/hash to load instructions, then read only the references you need. No skill body or script has been loaded or executed.\n' + JSON.stringify(selected) + '\n';
    } catch { return ''; }
  }
}
