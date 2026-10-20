// First real gate of the local decision layer: "will the user want this next-prompt
// suggestion?". Every shown suggestion is labelled by what the user does next (sends it,
// or something similar = used; anything else = ignored). Once the quick classifier has
// enough of these and is very sure a suggestion will be ignored, it is hidden.
// Tier 1 only: this runs at the end of every reply, so it must never wait for, or load,
// a chat model. It costs no request and no subscription usage.
import {repeatsUserRequest} from './next-prompt.mjs';

export const NEXT_PROMPT_GATE = {gate: 'next-prompt.useful', kind: 'choice', options: ['used', 'ignored']};
const HIDE_THRESHOLD = 0.9;

const tail = (value, length) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > length ? '…' + text.slice(-length) : text; };

/** The text the gate sees: the suggestion plus the request and reply it follows. */
export function nextPromptGateInput({suggestion, request, reply}) {
  return `Suggestion: ${suggestion}\nRequest: ${tail(request, 600)}\nReply end: ${tail(reply, 600)}`;
}

/** The latest reply's suggestion still waiting for its label, with the context it was made in. */
export function pendingSuggestion(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let index = list.length - 1;
  while (index >= 0 && list[index].role !== 'assistant') index--;
  const message = list[index];
  if (!message || message.error || message.nextPromptRecorded) return null;
  const suggestion = message.nextPrompt || message.nextPromptHidden;
  if (!suggestion) return null;
  let request = '';
  for (let i = index - 1; i >= 0; i--) if (list[i].role === 'user') { request = list[i].content; break; }
  return {message, suggestion, hidden: !message.nextPrompt, input: nextPromptGateInput({suggestion, request, reply: message.content})};
}

const plain = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Exact matches cover short suggestions such as "Go on", which have no words the overlap test counts.
export const suggestionOutcome = (suggestion, text) => (plain(suggestion) === plain(text) || repeatsUserRequest(suggestion, [text]) ? 'used' : 'ignored');

/**
 * Wires the gate to a DecisionLayer. `record` runs when the user sends the next message;
 * `shouldHide` runs when a reply finishes. Both swallow their own errors: the gate may
 * only ever remove a suggestion, never break a reply.
 */
export function createNextPromptGate(layer, {enabled = () => true} = {}) {
  return {
    /** `source` is the chat id, so deleting the chat also deletes this decision. */
    record(messages, text, source = null) {
      if (!enabled()) return Promise.resolve(null);
      const pending = pendingSuggestion(messages);
      if (!pending) return Promise.resolve(null);
      pending.message.nextPromptRecorded = true;
      const answer = suggestionOutcome(pending.suggestion, text);
      // A hidden suggestion was never seen, so "ignored" says nothing and would only
      // reinforce the hiding. Typing it anyway is the informative case: the gate was wrong.
      if (pending.hidden && answer === 'ignored') return Promise.resolve(null);
      return layer.record({...NEXT_PROMPT_GATE, input: pending.input, answer, source}).then(() => answer, () => null);
    },
    async shouldHide({suggestion, request, reply}) {
      if (!enabled()) return false;
      try {
        const result = await layer.ask({...NEXT_PROMPT_GATE, input: nextPromptGateInput({suggestion, request, reply}), threshold: HIDE_THRESHOLD, maxTier: 1});
        return !result.abstained && result.answer === 'ignored';
      } catch { return false; }
    }
  };
}
