import { normalizeSounds } from '../desktop/sound-settings.mjs';

/** Synthesised notification sounds: short, soft envelopes through a gentle
 * low-pass and a touch of echo, so nothing clicks or shrieks. */
let context = null;
function audio() {
  if (typeof window === 'undefined' || !(window.AudioContext || window.webkitAudioContext)) return null;
  context ??= new (window.AudioContext || window.webkitAudioContext)();
  if (context.state === 'suspended') context.resume().catch(() => {});
  return context;
}

/** One voice: oscillator, optional partials, exponential decay. */
function tone(ctx, out, { at = 0, freq, type = 'sine', attack = 0.006, decay = 0.9, gain = 0.5, partials = [], glide = 0 }) {
  const start = ctx.currentTime + at;
  for (const [ratio, level, life = 1] of [[1, 1, 1], ...partials]) {
    const osc = ctx.createOscillator(), env = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq * ratio, start);
    if (glide) osc.frequency.exponentialRampToValueAtTime(freq * ratio * glide, start + decay * life);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(gain * level, start + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay * life);
    osc.connect(env).connect(out); osc.start(start); osc.stop(start + attack + decay * life + 0.05);
  }
}

const VOICES = {
  glass: (ctx, out) => { tone(ctx, out, { freq: 1046.5, decay: 0.7, gain: 0.32, partials: [[2.01, 0.18, 0.5], [3.98, 0.06, 0.3]] }); tone(ctx, out, { at: 0.11, freq: 1567.98, decay: 0.95, gain: 0.28, partials: [[2.01, 0.15, 0.5]] }); },
  chime: (ctx, out) => [659.25, 830.61, 987.77].forEach((freq, index) => tone(ctx, out, { at: index * 0.085, freq, decay: 0.9 - index * 0.1, gain: 0.26, partials: [[2, 0.12, 0.6]] })),
  bell: (ctx, out) => { tone(ctx, out, { freq: 784, decay: 1.4, gain: 0.3, partials: [[2.76, 0.32, 0.45], [5.4, 0.12, 0.25], [0.5, 0.15, 1]] }); },
  marimba: (ctx, out) => { tone(ctx, out, { freq: 523.25, decay: 0.42, gain: 0.42, partials: [[4, 0.22, 0.2], [10, 0.05, 0.08]] }); tone(ctx, out, { at: 0.12, freq: 783.99, decay: 0.5, gain: 0.38, partials: [[4, 0.2, 0.2]] }); },
  droplet: (ctx, out) => { tone(ctx, out, { freq: 900, decay: 0.16, gain: 0.4, glide: 1.9, attack: 0.003 }); tone(ctx, out, { at: 0.07, freq: 1500, decay: 0.12, gain: 0.16, glide: 1.4, attack: 0.003 }); },
  pluck: (ctx, out) => { tone(ctx, out, { freq: 392, type: 'triangle', decay: 0.38, gain: 0.4, attack: 0.003, partials: [[2, 0.3, 0.4], [3, 0.12, 0.25]] }); tone(ctx, out, { at: 0.09, freq: 587.33, type: 'triangle', decay: 0.45, gain: 0.32, attack: 0.003, partials: [[2, 0.25, 0.4]] }); },
  hum: (ctx, out) => { tone(ctx, out, { freq: 311.13, decay: 0.55, gain: 0.34, attack: 0.03, partials: [[1.5, 0.25, 0.8]] }); tone(ctx, out, { at: 0.16, freq: 233.08, decay: 0.7, gain: 0.3, attack: 0.03, partials: [[1.5, 0.2, 0.8]] }); },
};

export function playPreset(id, volume = 0.55) {
  const voice = VOICES[id], ctx = voice && volume > 0 ? audio() : null;
  if (!ctx) return;
  const master = ctx.createGain(), filter = ctx.createBiquadFilter(), echo = ctx.createDelay(0.5), feedback = ctx.createGain(), wet = ctx.createGain();
  master.gain.value = Math.min(1, volume) * 0.9;
  filter.type = 'lowpass'; filter.frequency.value = 6200; filter.Q.value = 0.4;
  echo.delayTime.value = 0.17; feedback.gain.value = 0.22; wet.gain.value = 0.18;
  const bus = ctx.createGain();
  bus.connect(filter).connect(master).connect(ctx.destination);
  bus.connect(echo); echo.connect(feedback).connect(echo); echo.connect(wet).connect(filter);
  voice(ctx, bus);
  setTimeout(() => { try { bus.disconnect(); master.disconnect(); } catch { /* already released */ } }, 3200);
}

let last = {};
/** Plays the sound configured for an event, at most once per 700 ms per event. */
export function notify(eventId, value, { focused = true } = {}) {
  const sounds = normalizeSounds(value);
  if (!sounds.enabled || (sounds.onlyWhenAway && focused)) return;
  const now = Date.now();
  if (now - (last[eventId] || 0) < 700) return;
  last[eventId] = now;
  playPreset(sounds.events[eventId], sounds.volume);
}
