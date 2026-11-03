import { questionAnswerDisplayMessages } from './question-answer-display.mjs';

export const MAX_FIND_MATCHES = 1000;
const literal = value => String(value || '').trim().slice(0, 1000);
const expression = query => new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
const visibleMessages = chat => questionAnswerDisplayMessages(Array.isArray(chat?.messages) ? chat.messages : []).filter(message => message && message.role !== 'system');

// These are saved conversational text, including prose outside a final reply.
// Never search thinking, provider internals, arbitrary metadata or tool payloads.
function* messageTexts(message) {
  if (typeof message?.content === 'string') yield { text: message.content };
  for (const [index, step] of (Array.isArray(message?.activity) ? message.activity : []).entries()) {
    if (['note', 'status'].includes(step?.kind) && typeof step.text === 'string')
      yield { source: `activity:${index}`, label: step.kind === 'note' ? 'Progress update' : 'Work status', text: step.text };
  }
  for (const [index, item] of (Array.isArray(message?.followups) ? message.followups : []).entries()) {
    for (const [field, label] of [['text', 'Follow-up message'], ['answer', 'Follow-up answer'], ['summary', 'Follow-up resolution']]) {
      if (typeof item?.[field] === 'string') yield { source: `followup:${index}:${field}`, label, text: item[field] };
    }
  }
  for (const [index, group] of (Array.isArray(message?.questions) ? message.questions : []).entries()) {
    for (const [position, question] of (Array.isArray(group?.questions) ? group.questions : []).entries()) {
      if (typeof question?.question === 'string') yield { source: `question:${index}:${position}`, label: 'Question', text: question.question };
      for (const [answerIndex, text] of (Array.isArray(group?.answers?.[question?.id]?.answers) ? group.answers[question.id].answers : []).entries()) {
        if (typeof text === 'string') yield { source: `answer:${index}:${position}:${answerIndex}`, label: 'Your answer', text };
      }
    }
  }
}

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
    const message = messages[messageIndex];
    for (const segment of messageTexts(message)) {
      const remaining = MAX_FIND_MATCHES - matches.length;
      const found = findTextMatches(segment.text, query, Math.max(1, remaining));
      if (!remaining && found.length) { matches.truncated = true; return matches; }
      for (const hit of found) matches.push({ messageIndex, ...hit, ...(message.id ? { messageId: message.id } : {}), ...(segment.source ? { source: segment.source } : {}) });
      if (found.truncated) { matches.truncated = true; return matches; }
    }
  }
  return matches;
}

function excerptRange(text, start, end) {
  let from = Math.max(0, start - 50), to = Math.min(text.length, Math.max(end, start + 120));
  if (from && /[\uDC00-\uDFFF]/.test(text[from])) from--;
  if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1])) to++;
  return { from, to };
}

function snippet(text, start, end) {
  const { from, to } = excerptRange(text, start, end);
  return (from ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : '');
}

/** A bounded, plain-text reveal also works when work details or the HUD hide the source. */
export function chatSearchExcerpt(message, hit) {
  if (!hit?.source) return null;
  for (const segment of messageTexts(message)) {
    if (segment.source !== hit.source) continue;
    if (!Number.isSafeInteger(hit.start) || !Number.isSafeInteger(hit.end) || hit.start < 0 || hit.end <= hit.start || hit.end > segment.text.length) return null;
    const { from, to } = excerptRange(segment.text, hit.start, hit.end);
    return { label: segment.label, before: (from ? '…' : '') + segment.text.slice(from, hit.start), match: segment.text.slice(hit.start, hit.end), after: segment.text.slice(hit.end, to) + (to < segment.text.length ? '…' : '') };
  }
  return null;
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
    for (let index = 0; !titleMatches.length && index < messages.length && !hit; index++) {
      for (const segment of messageTexts(messages[index])) {
        const found = findTextMatches(segment.text, needle, 1);
        if (found.length) { messageIndex = index; hit = { ...found[0], ...(segment.source ? { source: segment.source } : {}) }; preview = snippet(segment.text, hit.start, hit.end); break; }
      }
    }
    if (!titleMatches.length && messageIndex === null) continue;
    if (results.length >= bound) { results.truncated = true; break; }
    results.push({ chat, messageIndex, snippet: preview || 'Matches the chat title', titleMatch: titleMatches.length > 0, ...(hit || {}) });
  }
  return results;
}
