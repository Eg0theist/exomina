// Shared with Settings and prompt composition. No provider, file or tool access.
export const SOUL_SCOPES = ['all', 'technical', 'creative', 'conversation', 'documents', 'voice'];
export const SOUL_DIMENSIONS = ['voice', 'judgment', 'initiative', 'curiosity', 'humor', 'register'];
export const SOUL_LEARNING_LIMITS = { observations: 40, examples: 8, reviews: 30, history: 12, evidence: 8 };
const clean = (value, max = 600) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = value => Array.isArray(value) ? value : [];
export const soulScope = value => SOUL_SCOPES.includes(value) ? value : 'all';
const refs = value => list(value).slice(-SOUL_LEARNING_LIMITS.evidence).map(ref => ({ chatId: clean(ref?.chatId, 100), messageId: clean(ref?.messageId, 100), quote: clean(ref?.quote, 400), at: clean(ref?.at, 40), observedAt: clean(ref?.observedAt, 40), passId: clean(ref?.passId, 80), hash: clean(ref?.hash, 64), quoteHash: clean(ref?.quoteHash, 64) })).filter(ref => ref.chatId && ref.messageId && ref.quote);
const observation = raw => ({ id: clean(raw?.id, 80), key: clean(raw?.key, 80), text: clean(raw?.text, 600), scope: soulScope(raw?.scope), dimension: SOUL_DIMENSIONS.includes(raw?.dimension) ? raw.dimension : 'register', status: ['tentative', 'learned', 'contested'].includes(raw?.status) ? raw.status : 'tentative', support: refs(raw?.support), opposition: refs(raw?.opposition), conflicts: list(raw?.conflicts).filter(id => typeof id === 'string').slice(0, 20), updatedAt: clean(raw?.updatedAt, 40), corrected: raw?.corrected === true });
const observations = value => list(value).slice(-SOUL_LEARNING_LIMITS.observations).map(observation).filter(item => item.id && item.key && item.text);
const examples = value => list(value).slice(-SOUL_LEARNING_LIMITS.examples).map(raw => ({ id: clean(raw?.id, 80), chatId: clean(raw?.chatId, 100), messageId: clean(raw?.messageId, 100), feedbackMessageId: clean(raw?.feedbackMessageId, 100), feedback: clean(raw?.feedback, 300), text: clean(raw?.text, 600), reason: clean(raw?.reason, 240), scope: soulScope(raw?.scope) })).filter(item => item.id && item.chatId && item.messageId && item.feedbackMessageId && item.text);
export function normalizeSoulLearning(value = {}, { prompt = false } = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    enabled: input.enabled !== false,
    provider: clean(input.provider, 80), model: clean(input.model, 200),
    cadence: Number.isInteger(input.cadence) ? Math.max(1, Math.min(20, input.cadence)) : 3,
    dailyLimit: Number.isInteger(input.dailyLimit) ? Math.max(0, Math.min(100, input.dailyLimit)) : 12,
    observations: observations(input.observations), examples: examples(input.examples),
    ...(prompt ? {} : {
      revision: Number.isSafeInteger(input.revision) ? input.revision : 0,
      day: clean(input.day, 10), requests: Math.max(0, Math.floor(Number(input.requests) || 0)),
      checkpoints: list(input.checkpoints).slice(-128).map(item => ({ chatId: clean(item?.chatId, 100), messageId: clean(item?.messageId, 100) })).filter(item => item.chatId && item.messageId),
      attempts: list(input.attempts).slice(-128).map(item => ({ chatId: clean(item?.chatId, 100), messageId: clean(item?.messageId, 100) })).filter(item => item.chatId && item.messageId),
      blockedSources: list(input.blockedSources).slice(-400).map(item => ({ chatId: clean(item?.chatId, 100), messageId: clean(item?.messageId, 100) })).filter(item => item.chatId && item.messageId),
      blockedKeys: list(input.blockedKeys).filter(key => typeof key === 'string').slice(-200),
      reviews: list(input.reviews).slice(-SOUL_LEARNING_LIMITS.reviews).map(item => ({ id: clean(item?.id, 80), at: clean(item?.at, 40), chatId: clean(item?.chatId, 100), provider: clean(item?.provider, 80), model: clean(item?.model, 200), status: clean(item?.status, 30), detail: clean(item?.detail, 500) })),
      history: list(input.history).slice(-SOUL_LEARNING_LIMITS.history).map(item => ({ id: clean(item?.id, 80), at: clean(item?.at, 40), observations: observations(item?.observations), examples: examples(item?.examples) })),
    }),
  };
}

export function soulObservationStatus(item) {
  if (item.corrected) return 'learned';
  const time = ref => /^\d{4}-\d\d-\d\dT/.test(ref.at || '') ? ref.at : ref.observedAt || '';
  const opposition = item.opposition || [], last = opposition.map(time).sort().at(-1);
  const support = (item.support || []).filter(ref => !last || time(ref) > last);
  const independent = new Set(support.map(ref => ref.hash || `${ref.chatId}:${ref.messageId}`)).size >= 2;
  const passes = new Set(support.map(ref => ref.passId).filter(Boolean)).size >= 2;
  return independent && passes && !item.conflicts?.length ? 'learned' : opposition.length ? 'contested' : 'tentative';
}

/** Explicit user scope wins; this is only a default register, never a user diagnosis. */
export function soulRegister(request = '', { voice = false } = {}) {
  if (voice) return 'voice';
  const text = String(request).toLowerCase();
  if (/\b(code|bug|build|test|install|update|app|software|server|gpu|implement|package|debug|fix|fehler|entwickl|programm)\b/u.test(text)) return 'technical';
  if (/\b(novel|lyric|poem|fiction|chapter|suno|manuscript|roman|gedicht|song|prose|kreativ)\b/u.test(text)) return 'creative';
  if (/\b(document|report|proposal|email|letter|article|draft|bericht|entwurf|artikel|schreib)\b/u.test(text)) return 'documents';
  return 'conversation';
}

/** Settings updates are narrow patches; renderer snapshots cannot overwrite learning. */
export function changeSoulLearning(value, args) {
  const state = normalizeSoulLearning(value);
  if (args.action === 'learning.patch') {
    const patch = args.patch || {};
    for (const key of Object.keys(patch)) if (!['enabled', 'provider', 'model', 'cadence', 'dailyLimit'].includes(key)) throw Error('Invalid automatic learning setting.');
    if ('enabled' in patch && typeof patch.enabled !== 'boolean') throw Error('Choose whether to learn automatically.');
    for (const [key, max] of [['provider', 80], ['model', 200]]) if (key in patch && (typeof patch[key] !== 'string' || patch[key].length > max)) throw Error('Choose a valid reflection model.');
    for (const [key, min, max] of [['cadence', 1, 20], ['dailyLimit', 0, 100]]) if (key in patch && (!Number.isInteger(patch[key]) || patch[key] < min || patch[key] > max)) throw Error('Choose a valid reflection frequency or daily limit.');
    return { ...state, ...patch, revision: state.revision + 1 };
  }
  if (args.action === 'learning.restore') {
    const entry = state.history.find(item => item.id === args.id);
    if (!entry) throw Error('That automatic learning snapshot is no longer available.');
    return { ...state, observations: entry.observations.filter(item => !state.blockedKeys.includes(item.key)), examples: entry.examples, history: state.history.slice(0, state.history.indexOf(entry)), revision: state.revision + 1 };
  }
  const found = state.observations.find(item => item.id === args.id);
  if (args.action === 'learning.forget') {
    const example = state.examples.find(item => item.id === args.id);
    if (!found && !example) throw Error('That learned observation or example is no longer available.');
    // No deleted wording or source evidence remains in recovery copies.
    const removedSources = found ? [...found.support, ...found.opposition] : [{ chatId: example.chatId, messageId: example.messageId }, { chatId: example.chatId, messageId: example.feedbackMessageId }];
    return { ...state, observations: state.observations.filter(item => item.id !== args.id), examples: state.examples.filter(item => item.id !== args.id), history: [], blockedKeys: found ? [...new Set([...state.blockedKeys, found.key])].slice(-200) : state.blockedKeys, blockedSources: [...new Map([...state.blockedSources, ...removedSources.map(({ chatId, messageId }) => ({ chatId, messageId }))].map(ref => [`${ref.chatId}:${ref.messageId}`, ref])).values()].slice(-400), revision: state.revision + 1 };
  }
  if (args.action === 'learning.correct') {
    if (!found || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 600) throw Error('Give the corrected observation, up to 600 characters.');
    return { ...state, observations: state.observations.map(item => item === found ? { ...item, text: args.text.trim(), corrected: true, status: 'learned', conflicts: [], opposition: [] } : item), history: [], revision: state.revision + 1 };
  }
  throw Error('Invalid automatic learning edit.');
}

/** Deleting a source chat also removes its quotations, examples and recovery copies. */
export function forgetSoulLearningChat(value, chatId) {
  const state = normalizeSoulLearning(value);
  const next = state.observations.map(item => {
    const support = item.support.filter(ref => ref.chatId !== chatId), opposition = item.opposition.filter(ref => ref.chatId !== chatId);
    return { ...item, support, opposition, status: soulObservationStatus({ ...item, support, opposition }) };
  }).filter(item => item.corrected || item.support.length || item.opposition.length);
  return { ...state, observations: next, examples: state.examples.filter(item => item.chatId !== chatId), checkpoints: state.checkpoints.filter(item => item.chatId !== chatId), attempts: state.attempts.filter(item => item.chatId !== chatId), blockedSources: state.blockedSources.filter(item => item.chatId !== chatId), reviews: state.reviews.filter(item => item.chatId !== chatId), history: [], revision: state.revision + 1 };
}
