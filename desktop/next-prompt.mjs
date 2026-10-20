// Next-prompt prediction without an extra request: the replying model appends one
// hidden line, the host strips it from the stored reply and the composer offers it.
const OPEN = '<next-prompt>', CLOSE = '</next-prompt>';
const MAX = 240;

export const nextPromptInstructions = `If, after your final answer, there is an obvious next request the user is likely to make, end the reply with one extra line exactly like ${OPEN}request${CLOSE}. Write the request as the user would type it: their language, their phrasing, imperative, under 120 characters, no quotes. Only suggest a step that is still outstanding after your reply: never one the user already asked for, approved or did earlier in this conversation, and never one your own reply just completed. Do not suggest installing, applying, restarting or retrying something unless the user has not yet been asked to and it is certain to be pending. Omit the line when the next step is unclear, when you asked the user a question, or when the task is finished with nothing natural to follow; no suggestion is better than a doubtful one. Exomina hides this line and offers it as an optional suggestion; never mention it.\n`;

const clean = value => {
  const line = String(value || '').replace(/\s+/g, ' ').trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  return line && line.length <= MAX && !line.includes(OPEN) ? line : '';
};

const words = value => String(value || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];

/** True when the suggestion mostly repeats something the user already said recently. */
export function repeatsUserRequest(suggestion, userTexts) {
  const wanted = new Set(words(suggestion));
  if (!wanted.size) return false;
  return userTexts.some(text => {
    const said = new Set(words(text));
    let shared = 0;
    for (const word of wanted) if (said.has(word)) shared++;
    return shared / wanted.size >= 0.75;
  });
}

/** Removes the marker, including a partial one still streaming in at the end. */
export function stripNextPrompt(text) {
  const value = String(text ?? '');
  const at = value.lastIndexOf(OPEN);
  if (at >= 0) return value.slice(0, at).trimEnd();
  // A tag still arriving: "<", "<next", "<next-pro"…
  const tail = value.slice(-OPEN.length).lastIndexOf('<');
  if (tail >= 0) {
    const start = value.length - Math.min(OPEN.length, value.length) + tail;
    if (OPEN.startsWith(value.slice(start)) && /(^|\n)\s*$/.test(value.slice(0, start))) return value.slice(0, start).trimEnd();
  }
  return value;
}

/** Splits a finished reply into its visible text and the suggestion, if any. */
export function extractNextPrompt(text) {
  const value = String(text ?? '');
  const at = value.lastIndexOf(OPEN);
  if (at < 0) return { text: value, suggestion: '' };
  const end = value.indexOf(CLOSE, at);
  const suggestion = clean(value.slice(at + OPEN.length, end < 0 ? undefined : end));
  // Anything after the closing tag is kept, so a stray marker never swallows prose.
  const after = end < 0 ? '' : value.slice(end + CLOSE.length).trim();
  return { text: (value.slice(0, at).trimEnd() + (after ? '\n\n' + after : '')), suggestion };
}
