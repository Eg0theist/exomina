// Deterministic tree entries for machine output; no model request is needed.
export const SEARCH_ONLY_CHARS = 12000;
export const searchOnlyNote = length => `(tool output, ${length.toLocaleString('en-US')} characters, kept out of summaries; find it with conversation_find or conversation_zoom)`;
export const searchOnlyRangeNote = '(range contains only search-only tool output; originals remain available through conversation_find or conversation_zoom)';

// Tool calls and their output are most of a long chat's records and the least
// valuable part of its memory, so they get excerpts, never model summaries.
export const MACHINE_KINDS = ['tool', 'echo'];
export const isMachineKind = kind => MACHINE_KINDS.includes(kind);

const utf8 = value => Buffer.byteLength(value, 'utf8');
function head(text, maxBytes) {
  let result = '', bytes = 0;
  for (const point of text) {
    // A source clipped mid-pair ends in a lone surrogate, which is not valid text.
    if (point.length === 1 && /[\uD800-\uDFFF]/.test(point)) break;
    const size = utf8(point);
    if (bytes + size > maxBytes) break;
    result += point; bytes += size;
  }
  return result;
}
function tail(text, maxBytes) {
  const points = [...text];
  let result = '', bytes = 0;
  for (let k = points.length - 1; k >= 0; k--) {
    const point = points[k];
    if (point.length === 1 && /[\uD800-\uDFFF]/.test(point)) break;
    const size = utf8(point);
    if (bytes + size > maxBytes) break;
    result = point + result; bytes += size;
  }
  return result;
}

/** A leaf's opening text, flattened and cut on a code point to fit maxBytes with its label. */
export function machineExcerpt(label, text, maxBytes, length = String(text).length) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const suffix = ` … (excerpt of ${length.toLocaleString('en-US')} characters; conversation_zoom for the whole)`;
  const room = maxBytes - utf8(`${label} `) - utf8(suffix);
  // Too small a budget for a useful excerpt: the caller queues a summary instead.
  return room >= 48 ? `${label} ${head(flat, room)}${suffix}` : null;
}

export const toolName = text => {
  const first = String(text).slice(0, 200).split('\n', 1)[0].trim();
  return /^[\w.:/-]{1,64}$/.test(first) ? first : 'tool';
};

/** A range of only tool calls and output: which tools ran, how often, and how many failed. */
/** Code points, as SQLite's length() counts them, so new and caught-up records classify alike. */
export function characters(text) { let n = 0; for (const _ of String(text)) n++; return n; }

/** Counts, then the range's first call and its last output (where outcomes usually are), each in half the room left. */
export function machineRangeNote({ calls, outputs, errors, names, first = '', last = '' }, maxBytes) {
  let note = machineRangeCounts({ calls, outputs, errors, names }, maxBytes);
  const parts = [[calls ? ' First call: ' : ' First output: ', first], [' Last output: ', calls && outputs ? last : '']]
    .map(([lead, text]) => [lead, String(text).replace(/\s+/g, ' ').trim()]).filter(([, text]) => text);
  for (const [k, [lead, text]] of parts.entries()) {
    const room = Math.floor((maxBytes - utf8(note)) / (parts.length - k)) - utf8(lead + '…');
    if (room < 48) continue;
    const cut = utf8(text) > room, ending = lead === ' Last output: ';
    note += lead + (cut && ending ? '…' + tail(text, room) : head(text, room) + (cut ? '…' : ''));
  }
  return utf8(note) <= maxBytes ? note : null;
}
function machineRangeCounts({ calls, outputs, errors, names }, maxBytes) {
  const tail = `; ${outputs} output${outputs === 1 ? '' : 's'}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}. Inputs and outputs: conversation_zoom.`;
  let note = `[tool steps] ${calls} call${calls === 1 ? '' : 's'}`, shown = 0;
  for (const { name, count } of names) {
    const item = `${shown ? ', ' : ': '}${name}×${count}`, more = names.length - shown - 1;
    const reserve = more ? utf8(` (+${more} more)`) : 0;
    if (utf8(note + item + tail) + reserve > maxBytes) break;
    note += item; shown++;
  }
  if (shown < names.length) note += ` (+${names.length - shown} more)`;
  return note + tail;
}
