import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { THEMES, THEME_PROFILE, DEFAULT_APPEARANCE, normalizeAppearance, validateAppearance, resolveTheme } from '../desktop/themes.mjs';

const src = new URL('../src/', import.meta.url);
const sheets = readdirSync(src).filter(name => name.endsWith('.css'));
const css = name => readFileSync(new URL(name, src), 'utf8');

// Minimal OKLab evaluator for the token grammar theme.css establishes.
const lin = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const gam = c => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
function oklab(hex) {
  const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function luminance([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const clamp = v => lin(Math.min(1, Math.max(0, gam(v))));
  return 0.2126 * clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) + 0.7152 * clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) + 0.0722 * clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, t) => a.map((v, i) => v * t + b[i] * (1 - t));
const tokens = Object.fromEntries([...css('refresh.css').match(/:root\{([^}]*)\}/)[1].matchAll(/--([\w-]+):([^;]+);/g)].map(match => [match[1], match[2].trim()]));
function evaluate(expr, theme) {
  let match;
  if ((match = expr.match(/^var\(--n-(\d+)\)$/))) { const step = Number(match[1]); return mix(oklab(theme.colors.ink), oklab(theme.colors.ground), (step + (theme.lift || 0) * step * (100 - step) / 100) / 100); }
  if ((match = expr.match(/^var\(--t-([a-z]+)\)$/))) return oklab(theme.colors[match[1]]);
  if ((match = expr.match(/^var\(--([a-z0-9-]+)\)$/))) return evaluate(tokens[match[1]], theme);
  if ((match = expr.match(/^color-mix\(in oklab,var\(--t-([a-z]+)\) (\d+)%,(.+)\)$/))) return mix(oklab(theme.colors[match[1]]), evaluate(match[3], theme), Number(match[2]) / 100);
  throw new Error(`Unsupported token expression: ${expr}`);
}

test('stylesheets use theme tokens instead of hex colours', () => {
  for (const name of sheets.filter(item => item !== 'theme.css')) {
    const hex = css(name).match(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b(?![^{]*\{)/gi);
    assert.equal(hex, null, `${name} contains hard-coded colours: ${hex?.slice(0, 5).join(', ')}`);
  }
  const ramp = css('theme.css');
  for (const step of new Set(sheets.flatMap(name => [...css(name).matchAll(/var\(--n-(\d+)\)/g)].map(match => match[1]))))
    assert.match(ramp, new RegExp(`--n-${step}:`), `--n-${step} is used but not defined in theme.css`);
});

test('every theme defines all anchors as opaque hex colours', () => {
  const anchors = Object.keys(THEMES[0].colors);
  assert.equal(new Set(THEMES.map(theme => theme.id)).size, THEMES.length);
  for (const theme of THEMES) {
    assert.deepEqual(Object.keys(theme.colors).sort(), [...anchors].sort(), theme.id);
    for (const [name, value] of Object.entries(theme.colors)) assert.match(value, name === 'shadow' ? /^#[0-9a-f]{6}([0-9a-f]{2})?$/ : /^#[0-9a-f]{6}$/, `${theme.id}.${name}`);
    assert.ok(['dark', 'light'].includes(theme.scheme));
  }
});

test('every theme keeps text, muted text and accents legible', () => {
  for (const theme of THEMES) {
    const bg = evaluate(tokens.bg, theme), surface = evaluate(tokens['surface-2'], theme);
    const check = (name, against, minimum) => { const ratio = contrast(evaluate(tokens[name], theme), against); assert.ok(ratio >= minimum, `${theme.id}: --${name} contrast ${ratio.toFixed(2)} < ${minimum}`); };
    check('text', bg, 12); check('text', surface, 10);
    check('text-2', bg, 7); check('text-3', bg, 4.5); check('text-3', surface, 4);
    check('accent', bg, 4.5); check('danger', bg, 4.5); check('warn', bg, 4.5); check('info', bg, 4.5);
    const ink = contrast(evaluate(tokens['accent-ink'], theme), oklab(theme.colors.accent));
    assert.ok(ink >= 4.5, `${theme.id}: text on accent buttons contrast ${ink.toFixed(2)} < 4.5`);
  }
});

test('appearance values are normalized and strictly validated', () => {
  assert.deepEqual(normalizeAppearance(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance({ theme: 'nope', textSize: 'huge', glow: 'yes' }), DEFAULT_APPEARANCE);
  assert.equal(normalizeAppearance({ lightTheme: 'midnight' }).lightTheme, 'paper', 'a dark theme cannot be the light choice');
  assert.deepEqual(validateAppearance({ theme: 'graphite' }, { glow: true }), { ...DEFAULT_APPEARANCE, theme: 'graphite', glow: true });
  assert.throws(() => validateAppearance({ theme: 'nope' }, {}), /theme/);
  assert.throws(() => validateAppearance({ darkTheme: 'paper' }, {}), /darkTheme/);
  assert.throws(() => validateAppearance({ unknown: 1 }, {}), /unknown/);
  assert.throws(() => validateAppearance(null, {}));
});

test('Match Windows resolves to the chosen light or dark theme', () => {
  const appearance = { theme: 'system', lightTheme: 'daylight', darkTheme: 'midnight' };
  assert.equal(resolveTheme(appearance, true).id, 'midnight');
  assert.equal(resolveTheme(appearance, false).id, 'daylight');
  assert.equal(resolveTheme({ theme: 'daylight' }, true).id, 'daylight');
});

test('themes can be removed from the picker and restored, but never the ones in use', () => {
  const current = { ...DEFAULT_APPEARANCE, theme: 'midnight' };
  assert.deepEqual(validateAppearance({ hiddenThemes: ['daylight', 'graphite'] }, current).hiddenThemes, ['daylight', 'graphite']);
  assert.throws(() => validateAppearance({ hiddenThemes: ['midnight'] }, current), /hiddenThemes/);
  assert.throws(() => validateAppearance({ hiddenThemes: ['paper'] }, current), /hiddenThemes/);
  assert.deepEqual(normalizeAppearance({ theme: 'midnight', hiddenThemes: ['midnight', 'nope', 'graphite'] }).hiddenThemes, ['graphite']);
  assert.deepEqual(validateAppearance({ hiddenThemes: [] }, { ...current, hiddenThemes: ['graphite'] }).hiddenThemes, []);
  if (THEME_PROFILE === 'personal') for (const id of ['dusk', 'deep-sea', 'ink-wash', 'dune', 'sakura']) assert.ok(THEMES.find(theme => theme.id === id)?.calm, id);
});
