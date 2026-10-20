/** Unsent text belongs to its chat, including callbacks that finish after navigation. */
export function updateDraft(drafts, key, value) {
  const current = drafts[key] || '';
  const next = typeof value === 'function' ? value(current) : value;
  if (next === current) return drafts;
  const result = { ...drafts };
  if (next) result[key] = next; else delete result[key];
  return result;
}

export function restoreDraft(drafts, key, text) {
  return updateDraft(drafts, key, current => !current.trim() ? text : current === text ? current : `${text}\n\n${current}`);
}

export function moveDraft(drafts, from, to) {
  if (from === to || !drafts[from]) return drafts;
  const result = restoreDraft(drafts, to, drafts[from]);
  delete result[from];
  return result;
}
