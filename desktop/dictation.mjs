const protectedWords = new Set(['not', 'never', 'without', 'no', 'nicht', 'nie', 'niemals', 'ohne', 'kein', 'keine', 'keinen', 'keiner', 'keinem', 'keines']);
const projectKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

/** User-entered spellings only. No fuzzy replacement, inference or external context. */
export function dictationTerms(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter(term => typeof term === 'string' && /^[\p{L}\p{M}]{3,64}$/u.test(term) && !protectedWords.has(term.toLocaleLowerCase('en-US')))
    .filter(term => { const key = term.toLocaleLowerCase('en-US'); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 40);
}

export function dictationVocabularies(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter(item => item && projectKey(item.projectId) && !seen.has(item.projectId) && seen.add(item.projectId))
    .map(item => ({ projectId: item.projectId, terms: dictationTerms(item.terms) })).filter(item => item.terms.length).slice(0, 32);
}

/** Cleanup changes spaces and explicit preferred casing only, never word identity. */
export function prepareDictation(value, settings = {}, projectId = '') {
  const original = String(value || '').trim();
  const protectedSyntax = original.length > 12000 || /[\\/`]|(?:^|\s)--?[\p{L}\d]|["“”'‘’]/u.test(original);
  let text = original;
  if (settings.dictationMode === 'minimal' && !protectedSyntax) {
    text = text.replace(/[ \t]+/g, ' ');
    const vocabulary = dictationVocabularies(settings.dictationVocabularies).find(item => item.projectId === projectId)?.terms || [];
    const preferred = new Map(vocabulary.map(term => [term.toLocaleLowerCase('en-US'), term]));
    text = text.replace(/[\p{L}\p{M}]+/gu, word => preferred.get(word.toLocaleLowerCase('en-US')) || word);
  }
  return { original, text, changed: original !== text, protectedSyntax };
}

export function appendDictationText(before, text) { return before.trim() ? before + ' ' + text : text; }

/** Refuse to overwrite subsequent manual edits, a sent draft or another chat. */
export function recoverDictationText(current, receipt, original) {
  if (!receipt || current !== receipt.after) throw Error('Your draft changed. The original is shown below so you can copy the part you need.');
  return appendDictationText(receipt.before, original);
}
