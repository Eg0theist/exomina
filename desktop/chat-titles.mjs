import { randomUUID } from 'node:crypto';
import { normalizeChatTitle } from './chat-management.mjs';
import { getProvider } from './provider-catalog.mjs';

const MAX_WORDS = 8;
const MAX_LENGTH = 60;
// Conversational openers that never describe a topic (English and German).
const FILLER = /^(?:(?:hey|hi|hello|hallo|moin|servus|ok(?:ay)?|so|also|yo)\b[\s,!.:-]*)+|^(?:(?:can|could|would|will) you(?: please)?|please|pls|bitte|kannst du(?: bitte)?|könntest du(?: bitte)?|würdest du(?: bitte)?|i (?:want|need|would like) (?:you )?to|i'd like (?:you )?to|ich (?:will|möchte|hätte gern|brauche),? dass du|ich (?:will|möchte)|help me(?: to)?|hilf mir(?: bei| dabei)?|let's|lass uns)\b[\s,]*/iu;

function stripMarkup(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/([^/\s]+)\S*/gi, '$1')
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*([^\\\s]+)/g, '$1')
    .replace(/[#>*_~|]/g, ' ');
}

/** Offline fallback: a topic-like phrase from the first request. */
export function heuristicTitle(text) {
  let value = stripMarkup(text).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) { const next = value.replace(FILLER, '').trim(); if (next === value) break; value = next; }
  const sentence = value.split(/(?<=[.!?])\s|\n/)[0] || value;
  const words = sentence.replace(/[.!?,;:]+$/u, '').split(' ').filter(Boolean).slice(0, MAX_WORDS);
  let title = words.join(' ');
  if (Array.from(title).length > MAX_LENGTH) title = Array.from(title).slice(0, MAX_LENGTH - 1).join('').replace(/\s+\S*$/, '') + '…';
  if (!title) return 'New chat';
  return title.charAt(0).toLocaleUpperCase() + title.slice(1);
}

/** Model output → a clean single-line title, or null when unusable. */
export function cleanTitle(raw) {
  let value = String(raw || '').split('\n').map(line => line.trim()).find(Boolean) || '';
  value = value.replace(/^(?:title|titel|chat title)\s*[:：-]\s*/i, '');
  for (let i = 0; i < 2; i++) value = value.replace(/^["'“”„«»*#`\s]+|["'“”„«»*`.。\s]+$/gu, '');
  value = value.replace(/\s+/g, ' ').trim();
  if (!value || /^new chat$/i.test(value)) return null;
  if (Array.from(value).length > MAX_LENGTH) value = Array.from(value).slice(0, MAX_LENGTH - 1).join('').replace(/\s+\S*$/, '') + '…';
  try { return normalizeChatTitle(value); } catch { return null; }
}

export function titlePrompt(chat) {
  const messages = (chat.messages || []).filter(message => !message.error && typeof message.content === 'string' && message.content.trim());
  const user = messages.find(message => message.role === 'user')?.content || '';
  const reply = messages.find(message => message.role === 'assistant')?.content || '';
  return 'You name chats in a sidebar. Write a concise title of 2 to 6 words that describes the topic of this conversation. '
    + 'Use the same language as the user. Do not answer the request, do not use quotes, emoji or a trailing period, and leave out secrets and personal details. Reply with the title only.\n\n'
    + `<user_message>\n${user.slice(0, 2500)}\n</user_message>\n`
    + (reply ? `<assistant_reply_excerpt>\n${reply.slice(0, 1200)}\n</assistant_reply_excerpt>\n` : '');
}

/** True while a chat still carries the placeholder title from its creation. */
export function canGenerateTitle(chat) {
  return !!chat && chat.archived !== true && chat.titleSource === 'pending' && (chat.messages || []).some(message => message.role === 'user');
}

/** Names new chats from their first exchange using a quick, tool-less request to
 * a connected account; falls back to an offline heuristic. Never blocks a reply.
 */
export class TitleService {
  constructor({ getProviders, getApiAgent, getConnections, timeout = 45000 }) {
    Object.assign(this, { getProviders, getApiAgent, getConnections, timeout });
    this.pending = new Map();
  }
  candidates(preferred) {
    const connected = (this.getConnections() || []).filter(item => item.connected || item.configured);
    const ids = connected.map(item => item.id);
    // Subscriptions first: naming a chat should not spend paid API credit when avoidable.
    const subscriptions = ['claude', 'codex'];
    const order = subscriptions.includes(preferred) ? [preferred, ...subscriptions] : [...subscriptions, preferred];
    order.push(...ids.filter(id => !order.includes(id)));
    return [...new Set(order)].filter(id => ids.includes(id) && this.supports(id));
  }
  supports(id) { return id === 'claude' || id === 'codex' || getProvider(id)?.mode === 'api'; }
  async ask(provider, prompt) {
    if (provider === 'claude' || provider === 'codex') return this.getProviders().oneShot(provider, prompt, { timeout: this.timeout });
    const agent = this.getApiAgent();
    if (!agent) throw new Error('No API runner.');
    const result = await agent.run({ provider, conversationId: `title-${randomUUID()}`, prompt, ephemeral: true });
    return result?.text || '';
  }
  /** Any short tool-less request, with the same provider order (style guides). */
  async askAny(prompt, { preferred } = {}) {
    for (const provider of this.candidates(preferred)) {
      try { const text = await this.ask(provider, prompt); if (text && text.trim()) return text.trim(); } catch { /* try the next connected account */ }
    }
    return '';
  }
  /** @returns {Promise<{title:string, source:'model'|'heuristic'}>} */
  async generate(chat, { preferred } = {}) {
    if (this.pending.has(chat.id)) return this.pending.get(chat.id);
    const task = (async () => {
      const prompt = titlePrompt(chat);
      for (const provider of this.candidates(preferred ?? chat.provider)) {
        try {
          const title = cleanTitle(await this.ask(provider, prompt));
          if (title) return { title, source: 'model' };
        } catch { /* try the next connected account */ }
      }
      const first = (chat.messages || []).find(message => message.role === 'user')?.content || '';
      return { title: heuristicTitle(first), source: 'heuristic' };
    })();
    this.pending.set(chat.id, task);
    try { return await task; } finally { this.pending.delete(chat.id); }
  }
}
