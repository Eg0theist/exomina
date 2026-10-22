export const MAX_FIND_MATCHES = 1000;
const literal = value => String(value || '').trim().slice(0, 1000);
const expression = query => new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
const visibleMessages = chat => (Array.isArray(chat?.messages) ? chat.messages : []).filter(message => message?.role !== 'system');

/** Indices always refer to the original UTF-16 text, including Unicode case matches. */
export function findTextMatches(text, query, limit = MAX_FIND_MATCHES) {
  const matches = [], needle = literal(query); matches.truncated = false;
  if (!needle || typeof text !== 'string') return matches;
  const bound = Math.max(1, Math.min(MAX_FIND_MATCHES, Number(limit) || MAX_FIND_MATCHES));
  for (const match of text.matchAll(expression(needle))) {
    if (matches.length >= bound) { matches.truncated = true; break; }
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

export function findChatMatches(chat, query) {
  const matches = []; matches.truncated = false;
  const messages = visibleMessages(chat);
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex], remaining = MAX_FIND_MATCHES - matches.length;
    const found = findTextMatches(message.content, query, Math.max(1, remaining));
    if (!remaining && found.length) { matches.truncated = true; break; }
    for (const hit of found) matches.push({ messageIndex, ...hit, ...(message.id ? { messageId: message.id } : {}) });
    if (found.truncated) { matches.truncated = true; break; }
  }
  return matches;
}

function snippet(text, start, end) {
  let from = Math.max(0, start - 50), to = Math.min(text.length, Math.max(end, start + 120));
  if (from && /[\uDC00-\uDFFF]/.test(text[from])) from--;
  if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1])) to++;
  return (from ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : '');
}

export function searchChats(conversations, { query = '', scope = 'active', limit = 20 } = {}) {
  const results = [], needle = literal(query); results.truncated = false;
  if (!needle) return results;
  const bound = Math.max(1, Math.min(100, Number(limit) || 20));
  for (const chat of Array.isArray(conversations) ? conversations : []) {
    if (!chat || (scope === 'archived' ? !chat.archived : scope !== 'all' && chat.archived)) continue;
    const titleMatches = findTextMatches(chat.title, needle, 1);
    let messageIndex = null, preview = '', hit = null;
    const messages = visibleMessages(chat);
    // Selecting a chat by its title is navigation to the latest message. Only
    // content-only results carry a historical message target.
    for (let index = 0; !titleMatches.length && index < messages.length; index++) {
      const found = findTextMatches(messages[index].content, needle, 1);
      if (found.length) { messageIndex = index; hit = found[0]; preview = snippet(messages[index].content, hit.start, hit.end); break; }
    }
    if (!titleMatches.length && messageIndex === null) continue;
    if (results.length >= bound) { results.truncated = true; break; }
    results.push({ chat, messageIndex, snippet: preview || 'Matches the chat title', titleMatch: titleMatches.length > 0, ...(hit ? { start: hit.start, end: hit.end } : {}) });
  }
  return results;
}
