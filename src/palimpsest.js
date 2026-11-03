// Palimpsest: a scraped manuscript in an invented script, read by a wandering lantern.
// The lantern follows the app: it hurries while a reply runs and comes to rest by the composer when
// your answer is needed. Rarely, the underwriting under the light resolves into a phrase and sinks back.
// Runs independently of React, never captures pointer input, and stops when hidden or motion is reduced.
import { seeded, inventScript, traceGlyph } from './invented-script.js';

const PHRASES = ['look closer', 'still here', 'read it twice', 'what doesn’t fit', 'underneath', 'written over', 'who reads whom', 'nothing is erased', 'ask the margin', 'not yet'];
const TILE_W = 1024, TILE_H = 768, LINE = 30, CELL = 20, FPS = 24, BACKGROUND_FPS = 8, TRAIL = 8;
const SERIF = "italic 19px 'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif";

const rgb = hex => { const value = parseInt(String(hex).replace('#', '').slice(0, 6), 16) || 0; return [value >> 16 & 255, value >> 8 & 255, value & 255]; };
const rgba = (color, alpha) => `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
const wrap = (value, size) => ((value % size) + size) % size;
const near = (delta, size) => delta > size / 2 ? delta - size : delta < -size / 2 ? delta + size : delta;
const ease = (from, to, dt, rate) => from + (to - from) * (1 - Math.exp(-dt * rate));

/** Lines of words in the invented script, laid out once on a seamless tile. */
function writeManuscript(script) {
  const random = seeded(0x51ce), field = [];
  for (let line = 0; line < TILE_H / LINE; line++) {
    if (random() < .14) continue;
    const size = random() < .08 ? 16 : 11 + random() * 3, y = line * LINE + LINE / 2 + (random() - .5) * 4;
    let x = 14 + random() * 40;
    while (x < TILE_W - 24) {
      for (let letters = 2 + Math.floor(random() * 6); letters > 0 && x < TILE_W - 12; letters--) {
        field.push({ x, y: y + (random() - .5) * 1.6, size, glyph: Math.floor(random() * script.length), alpha: .05 + random() * .08, flick: random() });
        x += size * (.62 + random() * .18);
      }
      x += 12 + random() * 18;
    }
  }
  return field;
}

export function startPalimpsest(canvas, { motion, accent, ink, lilac, subscribeVisibility }) {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return { stop() {}, setMode() {} };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const script = inventScript(seeded(0x9a1e57)), field = writeManuscript(script);
  const gold = rgb(accent), pale = rgb(ink), violet = rgb(lilac);
  let width = 0, height = 0, ratio = 1, left = 0, top = 0, tile = null, atlases = {};
  let request = 0, timer = 0, last = 0, disposed = false, windowVisible = true, focused = document.hasFocus();
  let mode = 'idle', clock = 0, drift = 0, pace = 1, lens = { x: 0, y: 0, r: 190 }, twin = 0, placed = false;
  let pointer = null, trail = [], phrase = null, nextPhrase = 18 + Math.random() * 14, order = [], seconds = 0;
  const still = () => motion === 'reduced' || reduced.matches;
  const drawable = () => windowVisible && !document.hidden && width > 0 && height > 0;

  function render() {
    const scale = ratio;
    tile = document.createElement('canvas');
    tile.width = Math.round(TILE_W * scale); tile.height = Math.round(TILE_H * scale);
    const page = tile.getContext('2d'); page.setTransform(scale, 0, 0, scale, 0, 0);
    // Ruling: the faint guide lines a scribe would have scored before writing.
    page.fillStyle = rgba(violet, .022);
    for (let line = 0; line < TILE_H / LINE; line++) page.fillRect(0, line * LINE + LINE / 2 + 7, TILE_W, 1);
    page.lineCap = 'round'; page.lineJoin = 'round';
    for (const mark of field) { page.strokeStyle = page.fillStyle = rgba(violet, mark.alpha); traceGlyph(page, script[mark.glyph], mark.x, mark.y, mark.size); }
    for (const [name, color] of [['gold', gold], ['pale', pale]]) {
      const atlas = atlases[name] || document.createElement('canvas'); atlases[name] = atlas;
      atlas.width = Math.round(script.length * CELL * scale); atlas.height = Math.round(CELL * scale);
      const pen = atlas.getContext('2d'); pen.setTransform(scale, 0, 0, scale, 0, 0);
      pen.strokeStyle = pen.fillStyle = rgba(color, 1); pen.lineCap = 'round'; pen.lineJoin = 'round';
      script.forEach((glyph, i) => traceGlyph(pen, glyph, i * CELL + CELL / 2, CELL / 2, 16));
    }
  }
  function populate() {
    const bounds = canvas.getBoundingClientRect();
    width = Math.round(bounds.width); height = Math.round(bounds.height); left = bounds.left; top = bounds.top;
    const next = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(4000000 / Math.max(1, width * height)));
    canvas.width = Math.max(1, Math.round(width * next)); canvas.height = Math.max(1, Math.round(height * next));
    context.setTransform(next, 0, 0, next, 0, 0);
    if (!tile || next !== ratio) { ratio = next; render(); }
    if (!placed && width) { lens.x = width * .72; lens.y = height * .34; placed = true; }
    lens.x = Math.min(Math.max(lens.x, 0), width); lens.y = Math.min(Math.max(lens.y, 0), height);
  }
  function sprite(atlas, glyph, x, y, size) {
    const span = CELL * size / 16;
    context.drawImage(atlases[atlas], glyph * CELL * ratio, 0, CELL * ratio, CELL * ratio, x - span / 2, y - span / 2, span, span);
  }
  function wander(dt) {
    const target = mode === 'waiting' ? .5 : mode === 'working' ? 3 : phrase ? .2 : 1;
    pace = ease(pace, target, dt, 1.2); clock += dt * pace; drift += dt * (mode === 'working' ? 2.4 : 1);
    let x = width * (.5 + .42 * Math.sin(clock * .021 + 1.3) * Math.cos(clock * .013)), y = height * (.47 + .33 * Math.sin(clock * .017 + .4));
    let radius = mode === 'working' ? 130 : 190;
    // Waiting: the light splits in two and settles either side of the composer, breathing until you answer.
    if (mode === 'waiting') { x = width < 1100 ? width - 130 : Math.min(width - 130, width / 2 + Math.min(width * .3, 600)); y = height - 140; radius = 150 + 30 * Math.sin(seconds * 4.2); }
    lens.x = ease(lens.x, x, dt, mode === 'waiting' ? 2.2 : 1.4); lens.y = ease(lens.y, y, dt, mode === 'waiting' ? 2.2 : 1.4); lens.r = ease(lens.r, radius, dt, 3);
    twin = ease(twin, mode === 'waiting' ? 1 : 0, dt, 1.6);
  }
  function surface(now) {
    if (mode !== 'idle' || phrase || seconds < nextPhrase || !width) return;
    if (!order.length) order = PHRASES.map(text => [Math.random(), text]).sort((a, b) => a[0] - b[0]).map(([, text]) => text);
    const text = order.pop(); context.font = SERIF;
    const span = context.measureText(text).width;
    const x = Math.min(Math.max(lens.x - span / 2, 40), Math.max(40, width - span - 40)), y = Math.min(Math.max(lens.y + 10, 70), Math.max(70, height - 130));
    phrase = { text, x, y, born: now, span, letters: [...text].map((ch, i) => ({ ch, x: x + context.measureText(text.slice(0, i)).width, w: context.measureText(ch).width, glyph: Math.floor(Math.random() * script.length) })) };
    nextPhrase = seconds + 45 + Math.random() * 55;
  }
  function drawPhrase(now) {
    const age = now - phrase.born, count = phrase.letters.length;
    if (age > 9.4) { phrase = null; return; }
    const fade = Math.min(1, age / .5) * Math.min(1, (9.4 - age) / 1.4);
    const glow = context.createRadialGradient(phrase.x + phrase.span / 2, phrase.y, 0, phrase.x + phrase.span / 2, phrase.y, phrase.span * .8 + 40);
    glow.addColorStop(0, rgba(gold, .07 * fade)); glow.addColorStop(1, rgba(gold, 0));
    context.globalAlpha = 1; context.fillStyle = glow; context.fillRect(phrase.x - 60, phrase.y - phrase.span, phrase.span + 120, phrase.span * 2);
    context.font = SERIF; context.textBaseline = 'middle';
    phrase.letters.forEach((letter, i) => {
      if (letter.ch === ' ') return;
      // Letters resolve left to right, then dissolve back into the script right to left.
      const resolved = age > .7 + i * .06 && age < 6.6 + (count - i) * .07;
      if (resolved) { context.globalAlpha = .9 * fade; context.fillStyle = rgba(pale, 1); context.fillText(letter.ch, letter.x, phrase.y); }
      else { context.globalAlpha = .7 * fade; sprite('gold', (letter.glyph + Math.floor(now * 11)) % script.length, letter.x + letter.w / 2, phrase.y, 15); }
    });
  }
  function illuminate(light, offX, offY, working, now) {
    const u = wrap(light.x - offX, TILE_W), v = wrap(light.y - offY, TILE_H), r = light.r, r2 = r * r;
    for (const mark of field) {
      const dx = near(mark.x - u, TILE_W); if (dx > r || dx < -r) continue;
      const dy = near(mark.y - v, TILE_H); if (dy > r || dy < -r) continue;
      const d2 = dx * dx + dy * dy; if (d2 > r2) continue;
      const falloff = 1 - Math.sqrt(d2) / r;
      context.globalAlpha = Math.min(1, falloff * falloff * light.strength * (.55 + mark.alpha * 4));
      const glyph = working && mark.flick < .3 ? (mark.glyph + Math.floor(now * 8 + mark.flick * 40)) % script.length : mark.glyph;
      sprite(light.atlas, glyph, light.x + dx, light.y + dy, mark.size);
    }
  }
  function draw(dt, now, animated) {
    if (animated) { seconds += dt; wander(dt); surface(seconds); }
    context.globalAlpha = 1; context.clearRect(0, 0, width, height);
    const offX = wrap(-drift * 3.4, TILE_W), offY = wrap(-drift * 1.3, TILE_H);
    for (let y = offY - TILE_H; y < height; y += TILE_H) for (let x = offX - TILE_W; x < width; x += TILE_W) context.drawImage(tile, x, y, TILE_W, TILE_H);
    const working = animated && mode === 'working', lights = [{ x: lens.x, y: lens.y, r: lens.r, strength: .55 + .3 * twin, glow: .095 + .07 * twin }];
    if (twin > .02) lights.push({ x: width - lens.x, y: lens.y, r: lens.r, strength: .85 * twin, glow: .165 * twin });
    for (const light of lights) {
      const glow = context.createRadialGradient(light.x, light.y, 0, light.x, light.y, light.r * 1.6);
      glow.addColorStop(0, rgba(gold, light.glow)); glow.addColorStop(.55, rgba(gold, light.glow / 3)); glow.addColorStop(1, rgba(gold, 0));
      context.globalAlpha = 1; context.fillStyle = glow; context.fillRect(light.x - light.r * 1.6, light.y - light.r * 1.6, light.r * 3.2, light.r * 3.2);
      illuminate({ ...light, atlas: 'gold' }, offX, offY, working, seconds);
    }
    if (animated) {
      // The pointer is a smaller, paler light whose trail fades over two seconds.
      if (pointer && (!trail.length || seconds - trail[trail.length - 1].t > .09)) { trail.push({ ...pointer, t: seconds }); if (trail.length > TRAIL) trail.shift(); pointer = null; }
      trail = trail.filter(point => seconds - point.t < 2);
      for (const point of trail) illuminate({ x: point.x, y: point.y, r: 96, strength: .72 * (1 - (seconds - point.t) / 2), atlas: 'pale' }, offX, offY, false, seconds);
      if (phrase) drawPhrase(seconds);
    }
    context.globalAlpha = 1;
  }
  function tick(now) {
    request = 0;
    if (disposed || still() || !drawable()) return;
    const fps = focused ? FPS : BACKGROUND_FPS;
    if (!last) last = now - 1000 / fps;
    const delta = Math.min((now - last) / 1000, .25);
    if (delta >= 1 / fps - .002) { draw(delta, now / 1000, true); last = now; }
    timer = setTimeout(() => { timer = 0; request = requestAnimationFrame(tick); }, 1000 / fps);
  }
  function sync() {
    cancelAnimationFrame(request); clearTimeout(timer); request = 0; timer = 0; last = 0;
    const paused = still() || !drawable();
    canvas.dataset.state = still() ? 'static' : paused ? 'paused' : 'running';
    canvas.dataset.mode = mode;
    if (drawable()) draw(0, 0, false);
    if (!paused && !disposed) request = requestAnimationFrame(tick);
  }
  const onPointer = event => {
    const x = event.clientX - left, y = event.clientY - top;
    pointer = x >= 0 && y >= 0 && x <= width && y <= height ? { x, y } : null;
  };
  const onFocus = () => { focused = document.hasFocus(); sync(); };
  const onMove = () => { const bounds = canvas.getBoundingClientRect(); left = bounds.left; top = bounds.top; };
  const observer = new ResizeObserver(() => { populate(); sync(); });
  observer.observe(canvas);
  reduced.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('focus', onFocus); window.addEventListener('blur', onFocus);
  window.addEventListener('resize', onMove);
  populate(); sync();
  const unsubscribeVisibility = subscribeVisibility?.(visible => { windowVisible = visible; sync(); });
  return {
    setMode(next) { if (next === mode) return; mode = next; canvas.dataset.mode = mode; if (mode !== 'idle') phrase = null; },
    stop() {
      disposed = true; cancelAnimationFrame(request); clearTimeout(timer); observer.disconnect(); unsubscribeVisibility?.();
      reduced.removeEventListener('change', sync); document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('pointermove', onPointer); window.removeEventListener('focus', onFocus); window.removeEventListener('blur', onFocus);
      window.removeEventListener('resize', onMove);
      for (const surfaceCanvas of [tile, ...Object.values(atlases)]) if (surfaceCanvas) { surfaceCanvas.width = 0; surfaceCanvas.height = 0; }
    },
  };
}
