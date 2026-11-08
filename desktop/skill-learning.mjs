import { createHash } from 'node:crypto';
import { normalizeProcedure, prepareProcedure } from './skill-procedures.mjs';

export const learningHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const HOLDOUT_SCHEMA = { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['id', 'values'], properties: { id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,39}$' }, values: { type: 'object', maxProperties: 12, additionalProperties: { type: 'string', maxLength: 1000 } } } } };
export const LEARNING_NOTICE = 'Explicit generalization from one accepted run. Bound training values are replaced; unbound facts still need review. Withheld host checks cover their exact conditions, not semantic correctness, quality or performance on arbitrary inputs. Nothing runs automatically.';

/** Generalize only explicit bindings. Never infer a private value or run a model. */
export function learnedDraft(source, evaluation, holdouts) {
  if (!source.procedure?.parameters.length) throw Error('Learning needs a parameterized procedure and an accepted source run.');
  const training = prepareProcedure(source, evaluation.bindings);
  if (training.planHash !== evaluation.planHash || evaluation.skillHash !== source.hash || evaluation.revision !== source.revision) throw Error('The source run does not match the exact procedure revision.');
  const bindings = Object.entries(training.bindings).filter(([, value]) => value !== '').sort((a, b) => b[1].length - a[1].length);
  if (!bindings.length || bindings.some(([, value]) => !value.trim()) || new Set(bindings.map(([, value]) => value.toLocaleLowerCase())).size !== bindings.length) throw Error('Training inputs must have distinct nonempty values so replacement is unambiguous.');
  // Keep template names intact. Replace literals only in text, never IDs, kinds or tool names.
  const alternatives = bindings.map(([, literal]) => `${/^[\p{L}\p{N}_]/u.test(literal) ? '(?<![\\p{L}\\p{N}_])' : ''}${escape(literal)}${/[\p{L}\p{N}_]$/u.test(literal) ? '(?![\\p{L}\\p{N}_])' : ''}`);
  const redact = text => String(text).split(/(\{\{[a-zA-Z][a-zA-Z0-9_]*\}\})/g).map(part => /^\{\{/.test(part) ? part : part.replace(new RegExp(alternatives.join('|'), 'giu'), literal => `{{${bindings.find(([, value]) => new RegExp(`^${escape(value)}$`, 'iu').test(literal))[0]}}}`)).join('');
  const procedure = normalizeProcedure({ ...source.procedure,
    parameters: source.procedure.parameters.map(item => ({ ...item, description: redact(item.description) })),
    ...Object.fromEntries(['preconditions', 'dataScope', 'outputs', 'recovery'].map(key => [key, source.procedure[key].map(redact)])),
    checks: source.procedure.checks.map(item => ({ ...item, label: redact(item.label), subject: redact(item.subject) })),
  });
  const learnedName = `Learned: ${redact(source.name)}`;
  const draft = { name: learnedName.length <= 80 ? learnedName : 'Learned procedure', description: redact(source.description), instructions: redact(source.instructions), tags: source.tags.map(redact), appliesWhen: redact(source.appliesWhen), caveat: redact(source.caveat), references: source.references.map((item, index) => ({ name: `source-${index + 1}.txt`, text: redact(item.text) })), procedure, ...(source.dependencies ? { dependencies: source.dependencies } : {}) };
  if (!Array.isArray(holdouts) || holdouts.length < 2 || holdouts.length > 4) throw Error('Commit two to four withheld input cases before trying the candidate.');
  const ids = new Set(), signatures = new Set([learningHash(training.bindings)]);
  const cases = holdouts.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'values'].includes(key)) || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(item.id || '') || ids.has(item.id)) throw Error('Withheld cases need unique simple IDs and input values.');
    ids.add(item.id);
    const plan = prepareProcedure({ ...source, procedure }, item.values), signature = learningHash(plan.bindings);
    if (signatures.has(signature) || procedure.parameters.some(parameter => parameter.required && plan.bindings[parameter.name] === training.bindings[parameter.name])) throw Error('Each withheld case must use different required inputs from training and a distinct complete input set.');
    signatures.add(signature);
    return { id: item.id, values: plan.bindings, bindingsHash: signature };
  });
  return { draft, cases, trainingBindingsHash: learningHash(training.bindings), notice: LEARNING_NOTICE };
}

export function validateLearningRecord(skill) {
  const value = skill.learning;
  if (value === undefined) return;
  if (!object(value) || skill.scope.kind !== 'chat' || !['candidate', 'promoted'].includes(value.status) || !Number.isFinite(Date.parse(value.committedAt)) || !/^[a-f0-9]{64}$/.test(value.trainingBindingsHash || '') || !object(value.source) || !/^[a-f0-9]{64}$/.test(value.source.evaluationHash || '') || !Array.isArray(value.cases) || value.cases.length < 2 || value.cases.length > 4) throw Error('Invalid procedure learning record.');
  const revision = skill.revisions.find(item => item.revision === value.revision && item.hash === value.skillHash);
  if (!revision?.procedure || Date.parse(value.committedAt) < Date.parse(revision.createdAt)) throw Error('Invalid learned procedure revision.');
  const signatures = new Set([value.trainingBindingsHash]), ids = new Set();
  for (const item of value.cases) {
    const plan = prepareProcedure(revision, item.values), signature = learningHash(plan.bindings);
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(item.id || '') || ids.has(item.id) || signature !== item.bindingsHash || signatures.has(signature)) throw Error('Invalid withheld procedure cases.');
    ids.add(item.id); signatures.add(signature);
  }
  if (value.status === 'promoted' && (!Number.isFinite(Date.parse(value.promotedAt)) || Date.parse(value.promotedAt) < Date.parse(value.committedAt) || typeof value.review !== 'string' || value.review.length < 40 || value.review.length > 1500 || !Array.isArray(value.evaluations) || value.evaluations.length !== value.cases.length)) throw Error('Invalid learned procedure promotion.');
  if (value.status === 'promoted') for (const item of value.cases) {
    const pin = value.evaluations.find(pin => pin.caseId === item.id);
    const evaluation = (skill.evaluations || []).find(record => learningHash(record) === pin?.evaluationHash);
    if (!evaluation || evaluation.skillHash !== value.skillHash || evaluation.revision !== value.revision || learningHash(evaluation.bindings) !== item.bindingsHash || Date.parse(evaluation.preparedAt) < Date.parse(value.committedAt) || Date.parse(evaluation.checkedAt) > Date.parse(value.promotedAt)) throw Error('A promoted procedure is missing its withheld acceptance evidence.');
  }
}
