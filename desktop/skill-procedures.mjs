import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const name = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const kinds = ['file', 'update_installed', 'update_staged', 'process_running', 'github_pr_merged', 'github_checks'];
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > max) throw Error(`Provide ${label} in up to ${max} characters.`);
  return value.trim();
};
const rows = (value, label) => {
  if (!Array.isArray(value) || value.length > 12) throw Error(`Use at most twelve ${label}.`);
  return value.map(item => text(item, 500, label));
};
const keys = (value, allowed, label) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error(`Invalid ${label}.`); };

export const PROCEDURE_SCHEMA = {
  type: ['object', 'null'], additionalProperties: false,
  required: ['parameters', 'preconditions', 'dataScope', 'tools', 'outputs', 'checks', 'recovery'],
  properties: {
    parameters: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['name', 'description', 'required'], properties: { name: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,39}$' }, description: { type: 'string', maxLength: 300 }, required: { type: 'boolean' } } } },
    ...Object.fromEntries(['preconditions', 'dataScope', 'tools', 'outputs', 'recovery'].map(key => [key, { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 500 } }])),
    checks: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['id', 'label', 'kind', 'subject'], properties: { id: { type: 'string', maxLength: 40 }, label: { type: 'string', maxLength: 300 }, kind: { type: 'string', enum: kinds }, subject: { type: 'string', maxLength: 500 }, minBytes: { type: 'integer', minimum: 0 }, sha256: { type: 'string', maxLength: 64 } } } },
  },
};

export function normalizeProcedure(value) {
  if (value === undefined || value === null) return undefined;
  keys(value, ['parameters', 'preconditions', 'dataScope', 'tools', 'outputs', 'checks', 'recovery'], 'procedure');
  if (!Array.isArray(value.parameters) || value.parameters.length > 12) throw Error('Use at most twelve procedure parameters.');
  const parameters = value.parameters.map(item => {
    keys(item, ['name', 'description', 'required'], 'procedure parameter');
    if (!name.test(item.name || '') || typeof item.required !== 'boolean') throw Error('Procedure parameters need simple names and a required flag.');
    return { name: item.name, description: text(item.description, 300, 'a parameter description'), required: item.required };
  });
  if (new Set(parameters.map(item => item.name)).size !== parameters.length) throw Error('Procedure parameter names must be unique.');
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > 12) throw Error('A procedure needs one to twelve acceptance checks.');
  const checks = value.checks.map(item => {
    keys(item, ['id', 'label', 'kind', 'subject', 'minBytes', 'sha256'], 'procedure check');
    if (!name.test(item.id || '') || !kinds.includes(item.kind)) throw Error('Acceptance checks need a simple ID and a supported host outcome kind.');
    const result = { id: item.id, label: text(item.label, 300, 'a check description'), kind: item.kind, subject: text(item.subject, 500, 'an exact outcome subject') };
    if (item.minBytes !== undefined) { if (item.kind !== 'file' || !Number.isSafeInteger(item.minBytes) || item.minBytes < 0) throw Error('Minimum bytes apply only to file checks.'); result.minBytes = item.minBytes; }
    if (item.sha256 !== undefined) { if (item.kind !== 'file' || !/^[a-f0-9]{64}$/i.test(item.sha256)) throw Error('File check hashes need 64 hexadecimal characters.'); result.sha256 = item.sha256.toLowerCase(); }
    return result;
  });
  if (new Set(checks.map(item => item.id)).size !== checks.length) throw Error('Acceptance check IDs must be unique.');
  const result = { parameters, ...Object.fromEntries(['preconditions', 'dataScope', 'tools', 'outputs'].map(key => [key, rows(value[key], key)])), checks, recovery: rows(value.recovery, 'recovery steps') };
  const declared = new Set(parameters.map(item => item.name));
  for (const match of JSON.stringify(result).matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)) if (!declared.has(match[1])) throw Error(`Procedure template uses undeclared parameter ${match[1]}.`);
  return result;
}

export function prepareProcedure(revision, values = {}) {
  if (!revision.procedure) throw Error('This skill has no structured procedure.');
  if (!object(values) || Object.keys(values).some(key => !revision.procedure.parameters.some(item => item.name === key))) throw Error('Use only this procedure’s declared parameters.');
  const bindings = {};
  for (const parameter of revision.procedure.parameters) {
    const value = values[parameter.name];
    if (value === undefined || value === '') { if (parameter.required) throw Error(`Provide procedure parameter ${parameter.name}.`); bindings[parameter.name] = ''; }
    else { if (typeof value !== 'string' || value.length > 1000 || /[\u0000-\u001f]/.test(value) || /\{\{|\}\}/.test(value)) throw Error('Parameter values must be plain single-line text without template delimiters, up to 1000 characters.'); bindings[parameter.name] = value; }
  }
  const render = value => value.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_, key) => bindings[key]);
  const contract = Object.fromEntries(['preconditions', 'dataScope', 'tools', 'outputs', 'recovery'].map(key => [key, revision.procedure[key].map(render)]));
  contract.checks = revision.procedure.checks.map(check => ({ ...check, label: render(check.label), subject: render(check.subject) }));
  if (contract.checks.some(check => check.subject.length > 500)) throw Error('A resolved outcome subject exceeds 500 characters.');
  const plan = { revision: revision.revision, skillHash: revision.hash, bindings, ...contract };
  return { ...plan, planHash: hash(plan), notice: 'Prepared checklist only. Preconditions, declared tools and data scope grant no access and run no actions. Checked conditions cover host observations at their recorded time, not semantic correctness or general performance.' };
}

export function evaluateProcedure(plan, ids, resolve, revision, now) {
  keys(ids, plan.checks.map(check => check.id), 'acceptance evidence');
  if (Object.keys(ids).length !== plan.checks.length) throw Error('Each acceptance check needs its own host outcome mark.');
  const used = new Set();
  const checks = plan.checks.map(check => {
    const id = ids[check.id];
    if (typeof id !== 'string' || used.has(id)) throw Error('Use a distinct host outcome mark for each acceptance check.');
    used.add(id);
    const mark = resolve(id);
    if (!mark || mark.id !== id || mark.checkedBy !== 'exomina' || mark.status !== 'verified' || mark.kind !== check.kind || mark.subject !== check.subject) throw Error(`Check ${check.id} needs a verified host mark for its exact kind and subject.`);
    if (check.kind === 'file' && (mark.observed?.exists !== true || !Number.isSafeInteger(mark.observed?.bytes) || mark.observed.bytes < 0)) throw Error(`Check ${check.id} needs a host-observed file and byte count.`);
    if (!Number.isFinite(Date.parse(mark.at)) || Date.parse(mark.at) < Date.parse(plan.preparedAt || revision.createdAt) || Date.parse(mark.at) > Date.parse(now)) throw Error('Acceptance evidence must have been observed after this checklist was prepared.');
    if (check.minBytes !== undefined && !(mark.observed?.bytes >= check.minBytes)) throw Error(`Check ${check.id} needs an observed file size of at least ${check.minBytes} bytes.`);
    if (check.sha256 && mark.observed?.sha256 !== check.sha256) throw Error(`Check ${check.id} needs the expected observed file hash.`);
    return { checkId: check.id, outcomeId: id, kind: mark.kind, subject: mark.subject, at: mark.at, observed: structuredClone(mark.observed || {}) };
  });
  return { revision: revision.revision, skillHash: revision.hash, planHash: plan.planHash, bindings: plan.bindings, preparedAt: plan.preparedAt, checkedAt: now, checks, notice: 'These exact acceptance conditions matched host observations after preparation. Preconditions, meaning, procedure quality and performance on other inputs remain unverified.' };
}

export function validateProcedureEvaluations(skill) {
  if (skill.evaluations === undefined) return;
  if (!Array.isArray(skill.evaluations) || skill.evaluations.length > 12) throw Error('Invalid procedure evaluation history.');
  for (const evaluation of skill.evaluations) {
    const revision = skill.revisions.find(item => item.revision === evaluation.revision);
    if (!revision?.procedure || evaluation.skillHash !== revision.hash || prepareProcedure(revision, evaluation.bindings).planHash !== evaluation.planHash || !Number.isFinite(Date.parse(evaluation.checkedAt)) || !Number.isFinite(Date.parse(evaluation.preparedAt)) || Date.parse(evaluation.preparedAt) < Date.parse(revision.createdAt) || Date.parse(evaluation.checkedAt) < Date.parse(evaluation.preparedAt) || !Array.isArray(evaluation.checks) || evaluation.checks.length !== revision.procedure.checks.length) throw Error('Procedure evaluation integrity check failed.');
    const ids = {}, marks = new Map(), plan = { ...prepareProcedure(revision, evaluation.bindings), preparedAt: evaluation.preparedAt };
    for (const check of evaluation.checks) {
      keys(check, ['checkId', 'outcomeId', 'kind', 'subject', 'at', 'observed'], 'stored procedure evidence');
      if (typeof check.checkId !== 'string' || typeof check.outcomeId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(check.outcomeId) || !object(check.observed)) throw Error('Invalid stored procedure evidence.');
      ids[check.checkId] = check.outcomeId;
      marks.set(check.outcomeId, { id: check.outcomeId, at: check.at, kind: check.kind, subject: check.subject, observed: check.observed, status: 'verified', checkedBy: 'exomina' });
    }
    // Portable validation checks structure and contract matching; a backup is
    // not a cryptographic attestation of the original host observation.
    evaluateProcedure(plan, ids, id => marks.get(id), revision, evaluation.checkedAt);
  }
}
