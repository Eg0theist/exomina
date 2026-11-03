// Mirrors the semantic colours in src/refresh.css. A test checks these expressions
// against that stylesheet so a token change cannot silently weaken palette checks.
export const PALETTE_TOKENS = {
  bg: 'var(--n-4)',
  'surface-2': 'color-mix(in oklab,var(--t-accent) 5%,var(--n-7))',
  text: 'color-mix(in oklab,var(--t-lilac) 4%,var(--n-100))',
  'text-2': 'color-mix(in oklab,var(--t-accent) 14%,var(--n-79))',
  'text-3': 'color-mix(in oklab,var(--t-accent) 16%,var(--n-57))',
  accent: 'var(--t-accent)',
  danger: 'var(--t-danger)', warn: 'var(--t-warn)', info: 'var(--t-info)',
  'accent-ink': 'color-mix(in oklab,var(--t-leaf) 17%,var(--n-0))',
};

const linear = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
const gamma = value => value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055;
const mix = (a, b, amount) => a.map((value, index) => value * amount + b[index] * (1 - amount));
function lab(hex) {
  const [r, g, b] = [1, 3, 5].map(index => linear(parseInt(hex.slice(index, index + 2), 16) / 255));
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
}
function luminance([L, A, B]) {
  const l = (L + .3963377774 * A + .2158037573 * B) ** 3;
  const m = (L - .1055613458 * A - .0638541728 * B) ** 3;
  const s = (L - .0894841775 * A - 1.291485548 * B) ** 3;
  const clamp = value => linear(Math.min(1, Math.max(0, gamma(value))));
  return .2126 * clamp(4.0767416621 * l - 3.3077115913 * m + .2309699292 * s) + .7152 * clamp(-1.2684380046 * l + 2.6097574011 * m - .3413193965 * s) + .0722 * clamp(-.0041960863 * l - .7034186147 * m + 1.707614701 * s);
}
const contrast = (a, b) => {
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + .05) / (dark + .05);
};

/** Same mixed-text and accent requirements as the built-in theme palette tests.
 * These sample semantic tokens, not every overlay, image or animation frame. */
export function paletteContrastReport(theme, textColor = '') {
  const colors = Object.fromEntries(Object.entries(theme.colors).map(([key, value]) => [key, lab(value)]));
  const text = textColor ? lab(textColor) : colors.ink;
  const evaluate = expression => {
    let match;
    if ((match = expression.match(/^var\(--n-(\d+)\)$/))) {
      const step = Number(match[1]);
      return mix(step >= 30 ? text : colors.ink, colors.ground, (step + (theme.lift || 0) * step * (100 - step) / 100) / 100);
    }
    if ((match = expression.match(/^var\(--t-([a-z]+)\)$/))) return colors[match[1]];
    if ((match = expression.match(/^color-mix\(in oklab,var\(--t-([a-z]+)\) (\d+)%,(.+)\)$/))) return mix(colors[match[1]], evaluate(match[3]), Number(match[2]) / 100);
    throw new Error('Unknown palette colour expression.');
  };
  const token = key => evaluate(PALETTE_TOKENS[key]);
  const pairings = [
    ['Main text', 'text', 'bg', 12], ['Main text on cards', 'text', 'surface-2', 10],
    ['Secondary text', 'text-2', 'bg', 7], ['Muted text', 'text-3', 'bg', 4.5],
    ['Muted text on cards', 'text-3', 'surface-2', 4], ['Accent', 'accent', 'bg', 4.5],
    ['Error text', 'danger', 'bg', 4.5], ['Warning text', 'warn', 'bg', 4.5],
    ['Information text', 'info', 'bg', 4.5], ['Button text', 'accent-ink', 'accent', 4.5],
  ];
  const checks = pairings.map(([label, foreground, background, minimum]) => {
    const ratio = contrast(token(foreground), token(background));
    return { label, ratio, minimum, passed: Number.isFinite(ratio) && ratio >= minimum };
  });
  return { passed: checks.every(check => check.passed), checks };
}
