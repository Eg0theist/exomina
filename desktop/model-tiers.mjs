// One classifier for model cost tiers, shared by helper delegation, background
// work and quick requests. Tiers are a naming heuristic, not measured pricing.

export const MODEL_TIERS = ['light', 'balanced', 'deep'];

const LIGHT = /\b(haiku|luna|mini|nano|flash|lite|small)\b/;
const DEEP = /\b(opus|astra|terra|pro|deep)\b/;

/** @returns {'light'|'balanced'|'deep'} */
export function modelTier(model) {
  const name = typeof model === 'string' ? model.toLowerCase() : `${model?.model || model?.id || ''} ${model?.label || ''}`.toLowerCase();
  if (LIGHT.test(name)) return 'light';
  if (DEEP.test(name)) return 'deep';
  return 'balanced';
}

const effortIds = efforts => (Array.isArray(efforts) ? efforts : []).map(option => typeof option === 'string' ? option : option?.id).filter(id => typeof id === 'string' && id);

/** The cheapest supported reasoning setting, or '' for the runtime default. */
export function backgroundEffort(efforts) {
  const ids = effortIds(efforts);
  return ['minimal', 'low'].find(effort => ids.includes(effort)) || '';
}

/**
 * Background work (titles, summaries, note planning, extraction) runs on the
 * lightest model available within one provider. Returns null when the list has
 * no model, so the caller keeps its own choice.
 * @param {Array<{id?:string, model?:string, label?:string, efforts?:Array}>} models
 */
export function chooseBackgroundModel(models) {
  const list = (Array.isArray(models) ? models : []).filter(item => item && (item.model || item.id) && item.available !== false);
  if (!list.length) return null;
  const rank = item => MODEL_TIERS.indexOf(modelTier(item));
  const chosen = [...list].sort((a, b) => rank(a) - rank(b))[0];
  return { model: chosen.model || chosen.id, effort: backgroundEffort(chosen.efforts), tier: modelTier(chosen) };
}

/**
 * API connections store one chosen model, so the light model per provider is a
 * known default. Callers must fall back to the connection's own model when the
 * light model is refused, since account access differs.
 */
export const LIGHT_API_MODELS = Object.freeze({
  'anthropic-api': 'claude-haiku-5-5',
  'openai-api': 'gpt-5-mini',
  gemini: 'gemini-flash-latest',
});

/** The light model to try first for a background API request, or '' to use the connection's model. */
export function backgroundApiModel(provider, chosenModel = '') {
  if (chosenModel && modelTier(chosenModel) === 'light') return '';
  return LIGHT_API_MODELS[provider] || '';
}
