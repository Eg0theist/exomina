/** Appearance catalog shared by the renderer (applies a theme) and the main
 * process (window background, native light/dark, settings validation).
 *
 * A theme is a handful of anchors. Every colour in the stylesheets is an OKLab
 * mix of them (see src/theme.css): neutrals run from `ground` to `ink`, and
 * tinted colours add one hue anchor. Light themes simply swap ground and ink.
 * `lift` (0–1) darkens the neutral mid-tones of a light theme so secondary text
 * keeps its contrast; test/theme.test.mjs checks every theme against WCAG ratios.
 */
import { THEMES } from './theme-catalog.mjs';
import {normalizeUiScale} from './ui-zoom.mjs';
import {normalizeCompanionDesign,normalizeCompanionArtwork,DEFAULT_COMPANION_DESIGN} from './companion-design.mjs';
import {paletteContrastReport} from './palette-contrast.mjs';
export {paletteContrastReport} from './palette-contrast.mjs';
export { THEMES, THEME_PROFILE } from './theme-catalog.mjs';

export const DEFAULT_THEME = 'verdigris';
export const DEFAULT_APPEARANCE = { theme: DEFAULT_THEME, lightTheme: 'paper', darkTheme: DEFAULT_THEME, readingFont: 'sans', textSize: 'default', uiScale: 1, chatWidth: 'default', glow: false, motion: 'system', textColor: '', customPalette: null, hiddenThemes: [], borderless: true, companionEnabled: false, companionAvatar: 'fox', companionColor: '#b2c9bb', companionLabel: '', companionAnimate: true,companionExpressive:true,companionDesign:DEFAULT_COMPANION_DESIGN,companionArtwork:null };

export const READING_FONTS = [
  { id: 'sans', name: 'Sans', stack: "'Bahnschrift','DIN Alternate','Aptos','Segoe UI Variable Text','Segoe UI',system-ui,sans-serif" },
  { id: 'serif', name: 'Serif', stack: "'Sitka Text','Iowan Old Style','Palatino Linotype','Book Antiqua',Georgia,serif" },
  { id: 'mono', name: 'Mono', stack: "'Cascadia Code','Cascadia Mono',Consolas,'SFMono-Regular',monospace" },
];
export const TEXT_SIZES = [{ id: 'small', name: 'Small', px: 13.5 }, { id: 'default', name: 'Default', px: 14.5 }, { id: 'large', name: 'Large', px: 16 }, { id: 'xl', name: 'Larger', px: 17.5 }];
export const CHAT_WIDTHS = [{ id: 'narrow', name: 'Focused', px: 700 }, { id: 'default', name: 'Default', px: 820 }, { id: 'wide', name: 'Wide', px: 1080 }, { id: 'full', name: 'Full width', px: null }];
const MOTION = ['system', 'reduced'];

const themeIds = new Set(THEMES.map(theme => theme.id));
const pick = (list, value, fallback) => list.some(item => item.id === value) ? value : fallback;
export const PALETTE_ANCHORS = ['ground', 'ink', 'accent', 'leaf', 'lilac', 'warm', 'danger', 'warn', 'info'];
const paletteValidity = new Map();
function normalizedPalette(value, themeId, textColor) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['baseTheme','colors'].includes(key))) return null;
  const base = THEMES.find(theme => theme.id === themeId);
  if (!base || value.baseTheme !== themeId || !value.colors || typeof value.colors !== 'object' || Array.isArray(value.colors)) return null;
  const entries = Object.entries(value.colors);
  if (!entries.length || entries.some(([key, color]) => !PALETTE_ANCHORS.includes(key) || typeof color !== 'string' || !/^#[0-9a-f]{6}$/.test(color))) return null;
  const colors = Object.fromEntries(entries);
  // normalizeAppearance is used during rendering as well as saving. Cache only
  // the bounded validation result, never the caller's mutable colour object.
  const key = JSON.stringify([themeId, textColor, ...PALETTE_ANCHORS.map(name=>colors[name]||null)]);
  if (!paletteValidity.has(key)) {
    if (paletteValidity.size >= 32) paletteValidity.delete(paletteValidity.keys().next().value);
    paletteValidity.set(key, paletteContrastReport({...base, colors:{...base.colors, ...colors}}, textColor).passed);
  }
  if (!paletteValidity.get(key)) return null;
  return {baseTheme:themeId, colors};
}

/** Coerces any stored or submitted value into a complete, valid appearance. */
export function normalizeAppearance(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const theme = input.theme === 'system' || themeIds.has(input.theme) ? input.theme : DEFAULT_APPEARANCE.theme;
  const light = THEMES.find(item => item.id === input.lightTheme && item.scheme === 'light')?.id || DEFAULT_APPEARANCE.lightTheme;
  const dark = THEMES.find(item => item.id === input.darkTheme && item.scheme === 'dark')?.id || DEFAULT_APPEARANCE.darkTheme;
  const textColor = typeof input.textColor === 'string' && /^#[0-9a-f]{6}$/.test(input.textColor) ? input.textColor : '';
  return {
    theme, lightTheme: light, darkTheme: dark, uiScale: normalizeUiScale(input.uiScale),
    readingFont: pick(READING_FONTS, input.readingFont, DEFAULT_APPEARANCE.readingFont),
    textSize: pick(TEXT_SIZES, input.textSize, DEFAULT_APPEARANCE.textSize),
    chatWidth: pick(CHAT_WIDTHS, input.chatWidth, DEFAULT_APPEARANCE.chatWidth),
    glow: input.glow === true,
    motion: MOTION.includes(input.motion) ? input.motion : DEFAULT_APPEARANCE.motion,
    // Optional custom text colour (#rrggbb) that overrides the theme's text; empty follows the theme.
    textColor,
    customPalette: normalizedPalette(input.customPalette, theme, textColor),
    // Themes removed from the picker. The ones in use can never be hidden.
    hiddenThemes: Array.isArray(input.hiddenThemes) ? [...new Set(input.hiddenThemes)].filter(id => themeIds.has(id) && ![theme, light, dark].includes(id)).sort() : [],
    borderless: typeof input.borderless === 'boolean' ? input.borderless : DEFAULT_APPEARANCE.borderless,
    companionEnabled: input.companionEnabled === true,
    companionAvatar: ['fox', 'cat', 'star','sigil','custom','artwork'].includes(input.companionAvatar)&&!(input.companionAvatar==='artwork'&&!normalizeCompanionArtwork(input.companionArtwork)) ? input.companionAvatar : DEFAULT_APPEARANCE.companionAvatar,
    companionColor: typeof input.companionColor === 'string' && /^#[0-9a-f]{6}$/.test(input.companionColor) ? input.companionColor : DEFAULT_APPEARANCE.companionColor,
    companionLabel: typeof input.companionLabel === 'string' ? input.companionLabel.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '',
    companionAnimate: typeof input.companionAnimate === 'boolean' ? input.companionAnimate : true,
    companionExpressive:input.companionExpressive!==false,
    companionDesign:normalizeCompanionDesign(input.companionDesign),companionArtwork:normalizeCompanionArtwork(input.companionArtwork),
  };
}

/** Strict validation for settings.save; the stored value is always normalized. */
export function validateAppearance(patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid appearance settings.');
  const next = { ...normalizeAppearance(current), ...patch };
  // A palette belongs to exactly one base theme; choosing another explicitly
  // restores that theme. A caller cannot smuggle a mismatched palette in a patch.
  if ('theme' in patch && patch.theme !== normalizeAppearance(current).theme && !('customPalette' in patch)) next.customPalette = null;
  const normalized = normalizeAppearance(next);
  if (next.customPalette != null && normalized.customPalette === null) throw new Error('Custom palette is invalid or its mixed text and button colours have insufficient contrast. Choose a fixed base theme and readable six-digit hex colours.');
  const same = (a, b) => Array.isArray(a) ? JSON.stringify(a) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b) : a&&typeof a==='object'?b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>same(a[key],b[key])):a===b;
  for (const key of Object.keys(patch)) if (!(key in normalized) || !same(normalized[key], patch[key])) throw new Error(`Invalid appearance setting: ${key}.`);
  return normalized;
}

/** The concrete theme for a given appearance and OS preference. */
export function resolveTheme(appearance, prefersDark = true) {
  const value = normalizeAppearance(appearance);
  const id = value.theme === 'system' ? (prefersDark ? value.darkTheme : value.lightTheme) : value.theme;
  const theme = THEMES.find(theme => theme.id === id) || THEMES[0];
  return value.customPalette?.baseTheme === id ? {...theme, colors:{...theme.colors, ...value.customPalette.colors}} : theme;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a, b) {
  const luminance = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
