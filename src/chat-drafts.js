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

/** Draft changes notify their editors without rendering the application shell. */
export function createDraftStore() {
  let drafts = {};
  const listeners = new Map();
  return {
    get: key => drafts[key] || '',
    update: change => {
      const next = typeof change === 'function' ? change(drafts) : change;
      if (next === drafts) return;
      const previous = drafts;
      drafts = next;
      for (const [key, callbacks] of listeners) {
        if ((previous[key] || '') !== (next[key] || '')) for (const callback of callbacks) callback();
      }
    },
    subscribe: (key, callback) => {
      if (!listeners.has(key)) listeners.set(key, new Set());
      const callbacks = listeners.get(key);
      callbacks.add(callback);
      return () => { callbacks.delete(callback); if (!callbacks.size) listeners.delete(key); };
    },
  };
}
