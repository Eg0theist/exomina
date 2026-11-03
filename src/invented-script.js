// A script that never existed: two or three strokes on a 3x4 lattice, sometimes a dot.
// It reads as writing and means nothing. Shared by the Palimpsest theme and the Sigil companion,
// so the avatar's rings and the theme's underwriting are the same alphabet. Seeded, so it never changes.

export function seeded(seed) {
  let state = seed | 0;
  return () => {
    state = state + 0x6D2B79F5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function inventScript(random, count = 72) {
  const pick = n => Math.floor(random() * n), glyphs = [];
  for (let i = 0; i < count; i++) {
    const strokes = [];
    // Most letters stand on a stem, which is what makes a field of them look like one hand wrote it.
    if (random() < .65) { const x = pick(3); strokes.push([x, random() < .3 ? 1 : 0, x, random() < .3 ? 2 : 3, 0]); }
    for (let s = 0, extra = strokes.length ? 1 + pick(2) : 2 + pick(2); s < extra; s++) {
      const a = [pick(3), pick(4)]; let b;
      do b = [pick(3), pick(4)]; while (b[0] === a[0] && b[1] === a[1]);
      strokes.push([a[0], a[1], b[0], b[1], random() < .35 ? (random() < .5 ? -1 : 1) : 0]);
    }
    glyphs.push({ strokes, dot: random() < .22 ? [pick(3), random() < .5 ? -.45 : 3.45] : null });
  }
  return glyphs;
}

const point = (column, row, cx, cy, size) => [cx + (column - 1) * size * .3, cy + (row - 1.5) * size / 3];
function curve(stroke, cx, cy, size) {
  const [x1, y1] = point(stroke[0], stroke[1], cx, cy, size), [x2, y2] = point(stroke[2], stroke[3], cx, cy, size);
  if (!stroke[4]) return [x1, y1, x2, y2];
  const length = Math.hypot(x2 - x1, y2 - y1) || 1, bend = stroke[4] * size * .22;
  return [x1, y1, x2, y2, (x1 + x2) / 2 - (y2 - y1) / length * bend, (y1 + y2) / 2 + (x2 - x1) / length * bend];
}

/** Strokes one glyph centred on (cx, cy) with the context's current stroke style. */
export function traceGlyph(context, glyph, cx, cy, size) {
  context.lineWidth = size * .085;
  context.beginPath();
  for (const stroke of glyph.strokes) {
    const [x1, y1, x2, y2, qx, qy] = curve(stroke, cx, cy, size);
    context.moveTo(x1, y1);
    if (qx === undefined) context.lineTo(x2, y2); else context.quadraticCurveTo(qx, qy, x2, y2);
  }
  context.stroke();
  if (glyph.dot) { const [x, y] = point(glyph.dot[0], glyph.dot[1], cx, cy, size); context.beginPath(); context.arc(x, y, size * .07, 0, Math.PI * 2); context.fill(); }
}

/** The same glyph as an SVG path; the dot is a zero-length segment drawn by a round line cap. */
export function glyphPath(glyph, cx, cy, size) {
  const n = value => Math.round(value * 100) / 100, parts = [];
  for (const stroke of glyph.strokes) {
    const [x1, y1, x2, y2, qx, qy] = curve(stroke, cx, cy, size);
    parts.push(qx === undefined ? `M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}` : `M${n(x1)} ${n(y1)}Q${n(qx)} ${n(qy)} ${n(x2)} ${n(y2)}`);
  }
  if (glyph.dot) { const [x, y] = point(glyph.dot[0], glyph.dot[1], cx, cy, size); parts.push(`M${n(x)} ${n(y)}l0 .01`); }
  return parts.join('');
}
