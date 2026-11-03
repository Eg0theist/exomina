// Models have no clock: durations they are not shown, they infer from the amount of work (Oct 2026).
// Dates therefore go into the context passively, local and precomputed, so nothing has to be looked up.

const pad = n => String(n).padStart(2, '0');
const valid = value => { const date = value instanceof Date ? value : new Date(value || NaN); return Number.isNaN(date.getTime()) ? null : date; };

/** Local calendar day, YYYY-MM-DD. */
export function localDay(value) {
  const date = valid(value);
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : null;
}

/** Local day and minute, YYYY-MM-DD HH:mm. */
export function localStamp(value) {
  const date = valid(value);
  return date ? `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}` : null;
}

/** Rounded elapsed time in plain words. */
export function elapsed(from, now = new Date()) {
  const start = valid(from), end = valid(now);
  if (!start || !end) return null;
  const minutes = Math.max(0, Math.round((end - start) / 60000));
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 36) return unit(hours, 'hour');
  const days = Math.round(minutes / 1440);
  return days < 21 ? unit(days, 'day') : unit(Math.round(days / 7), 'week');
}

const messageTime = message => message?.createdAt || message?.startedAt || null;

/**
 * Current time, chat age and the gap before the current message. `messages` are the
 * chat's messages before the current request.
 */
export function timeContext(messages = [], now = new Date()) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekday = now.toLocaleDateString('en-US', { weekday: 'short' });
  const parts = [`now ${weekday} ${localStamp(now)}${zone ? ' ' + zone : ''}`];
  const first = messages.find(messageTime), last = [...messages].reverse().find(messageTime);
  if (first) parts.push(`this chat began ${localDay(messageTime(first))} (${elapsed(messageTime(first), now)})`);
  if (last) parts.push(`the previous message was ${localStamp(messageTime(last))} (${elapsed(messageTime(last), now)})`);
  return 'Time (host clock): ' + parts.join('; ') + '. Message "at" values, dated <chat> lines and note dates are stored timestamps; base durations, ages and "today" on them, never on how much work a transcript contains.\n';
}
