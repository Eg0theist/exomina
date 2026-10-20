/** Notification sound settings, shared by the main process (validation) and the
 * renderer (playback in src/sounds.js). Sounds are synthesised, not sampled. */
export const SOUND_PRESETS = [
  { id: 'glass', name: 'Glass', description: 'Two bright, airy notes' },
  { id: 'chime', name: 'Chime', description: 'A soft rising triad' },
  { id: 'bell', name: 'Bell', description: 'A small struck bell' },
  { id: 'marimba', name: 'Marimba', description: 'Warm wooden mallet' },
  { id: 'droplet', name: 'Droplet', description: 'A quick water drop' },
  { id: 'pluck', name: 'Pluck', description: 'A muted string' },
  { id: 'hum', name: 'Low hum', description: 'A gentle low tone' },
  { id: 'none', name: 'No sound', description: 'Silent' },
];
export const SOUND_EVENTS = [
  { id: 'done', name: 'Reply finished', description: 'An AI finished answering.', fallback: 'glass' },
  { id: 'attention', name: 'Needs your approval', description: 'An AI asks permission or a question. Also used for the Windows notification.', fallback: 'bell' },
  { id: 'error', name: 'Something went wrong', description: 'A reply failed or was blocked.', fallback: 'hum' },
  { id: 'followup', name: 'Follow-up sent', description: 'A queued follow-up was sent.', fallback: 'droplet' },
];
export const DEFAULT_SOUNDS = { enabled: true, volume: 0.55, onlyWhenAway: false, events: Object.fromEntries(SOUND_EVENTS.map(event => [event.id, event.fallback])) };
const presetIds = new Set(SOUND_PRESETS.map(preset => preset.id));

export function normalizeSounds(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const volume = Number(input.volume);
  return {
    enabled: input.enabled !== false,
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, Math.round(volume * 100) / 100)) : DEFAULT_SOUNDS.volume,
    onlyWhenAway: input.onlyWhenAway === true,
    events: Object.fromEntries(SOUND_EVENTS.map(event => [event.id, presetIds.has(input.events?.[event.id]) ? input.events[event.id] : event.fallback])),
  };
}
