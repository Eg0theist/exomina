const DIFFICULTIES = ['simple', 'standard', 'complex'];
export const HELPER_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const collaborationInstructions = 'When useful for the current user task, model_consult can ask another connected AI for a bounded analysis or draft in this same chat. Check model_available first: it reports supported efforts, image input and suggested task roles. Exomina supports delegation in both directions when the target has verified available usage: a ChatGPT/Codex chat can call model_consult with provider:"claude", and a Claude chat can call it with provider:"codex" for a ChatGPT/Codex helper. These are Exomina helper requests; provider-native subagents remain within their own provider. Each contribution records its source chat, requested target, reported model and status. Assess task difficulty: simple for extraction or a quick check, standard for drafting and ordinary review, complex for difficult reasoning, architecture or a thorough critique. Supply difficulty and a short rationale. Choose an explicit provider, model and supported effort, or omit provider/model to use the difficulty recommendation. Role recommendations are routing heuristics, not measured quality rankings. Use higher effort when warranted; do not always select the largest model. Attach image_ids from chat attachments or image_paths inside this chat\'s workspace when visual evidence matters. Helpers receive actual pixels, have no tools and cannot delegate further. You remain responsible for checking their claims. Only send needed context. Never ask helpers to redeem resets, buy credits or enable extra usage. image_generate can request native ChatGPT images for an explicit user image request.\n';

export function helperRole(model) {
  const name = `${model.model || model.id || ''} ${model.label || ''}`.toLowerCase();
  if (/\b(haiku|luna|mini|nano|flash|small)\b/.test(name)) return 'light';
  if (/\b(opus|astra|terra|pro|deep)\b/.test(name)) return 'deep';
  return 'balanced';
}
export function difficultyEffort(model, difficulty) {
  const supported = model.efforts || [];
  const preferences = difficulty === 'simple' ? ['low', 'minimal', 'medium', 'high'] : difficulty === 'complex' ? ['high', 'xhigh', 'max', 'ultra', 'medium', 'low'] : ['medium', 'high', 'low', 'xhigh', 'max', 'ultra', 'minimal'];
  return preferences.find(effort => supported.includes(effort)) || model.defaultEffort || supported[0] || '';
}
export function selectHelper(models, args = {}) {
  const difficulty = args.difficulty || 'standard';
  if (!DIFFICULTIES.includes(difficulty)) throw Error('Choose simple, standard or complex task difficulty.');
  if (args.provider !== undefined && (typeof args.provider !== 'string' || args.provider.length > 100)) throw Error('Choose a valid helper provider.');
  if (args.model !== undefined && (typeof args.model !== 'string' || args.model.length > 300)) throw Error('Choose a valid helper model.');
  if (args.effort !== undefined && (typeof args.effort !== 'string' || args.effort.length > 30)) throw Error('Choose a supported helper effort.');
  const hasImages = Boolean(args.image_ids?.length || args.image_paths?.length);
  const explicitModel = Boolean(args.model && args.model !== 'auto');
  const candidates = models.filter(model => model.available && (!args.provider || args.provider === 'auto' || model.provider === args.provider) && (!explicitModel || model.model === args.model) && (!hasImages || model.supportsImages));
  if (!candidates.length) throw Error(hasImages ? 'None of the available selected helpers can read images. Choose a helper that supports images from model_available.' : 'This helper is unavailable or its usage could not be verified. Choose an available model from model_available.');
  const desired = difficulty === 'simple' ? 'light' : difficulty === 'complex' ? 'deep' : 'balanced';
  const roleOrder = desired === 'light' ? ['light', 'balanced', 'deep'] : desired === 'deep' ? ['deep', 'balanced', 'light'] : ['balanced', 'deep', 'light'];
  const explicitEffort = Boolean(args.effort && !['auto', 'default'].includes(args.effort));
  const eligible = explicitEffort ? candidates.filter(model => model.efforts.includes(args.effort)) : candidates;
  if (!eligible.length) throw Error('This helper does not support that reasoning setting. Choose one of its supported settings from model_available.');
  const choice = [...eligible].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role))[0];
  const runtimeDefault = args.effort === 'default';
  return { ...choice, difficulty, effort: runtimeDefault ? '' : explicitEffort ? args.effort : difficultyEffort(choice, difficulty), effortSource: runtimeDefault ? 'runtime-default' : explicitEffort ? 'explicit' : choice.efforts.length ? 'difficulty' : 'runtime-default', selectionMode: explicitModel ? 'explicit' : 'difficulty' };
}

export const helperConsultSchema = { type: 'object', properties: {
  provider: { type: 'string', description: 'Optional provider ID; omit or use auto for difficulty-based selection.' }, model: { type: 'string', description: 'Optional explicit model ID from model_available.' }, effort: { type: 'string', description: 'Optional reasoning setting supported by the selected model. If omitted, Exomina chooses it for the task difficulty. Use default to let the provider choose.' },
  difficulty: { type: 'string', enum: DIFFICULTIES }, rationale: { type: 'string', maxLength: 1000, description: 'Why this task needs the selected model and effort.' },
  task: { type: 'string', minLength: 1, maxLength: 30000 }, context: { type: 'string', maxLength: 50000 },
  image_ids: { type: 'array', maxItems: 5, items: { type: 'string', pattern: '^[a-f0-9]{64}$' }, description: 'Generated or uploaded image IDs accessible to this chat.' },
  image_paths: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 4000 }, description: 'PNG, JPEG or WebP files inside this chat\'s trusted workspace, including rendered designs or screenshots.' }
}, required: ['task'], additionalProperties: false };
