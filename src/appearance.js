import { CHAT_WIDTHS, READING_FONTS, TEXT_SIZES, normalizeAppearance, resolveTheme } from '../desktop/themes.mjs';
import { cyberpunkFrame } from './artwork-framing.js';

const CACHE_KEY = 'exomina.appearance';
const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let current = null;
let switchTimer = 0;
const artworkFrames = new Map();
const artworkLoading = new Set();
let currentArtwork = null;

function artworkAspect(theme) {
  const root = document.documentElement;
  const apply = frame => {
    root.style.setProperty('--theme-art-aspect', String(frame?.aspect || theme.artworkFrame?.sourceAspect || 16/9));
    window.dispatchEvent(new Event('exomina-artwork-change'));
  };
  apply(artworkFrames.get(theme.artwork));
  if (!theme.artwork || artworkFrames.has(theme.artwork) || artworkLoading.has(theme.artwork)) return;
  artworkLoading.add(theme.artwork);
  const image = new Image();
  image.onload = () => {
    const frame = { aspect: image.naturalWidth / image.naturalHeight };
    artworkFrames.set(theme.artwork, frame); artworkLoading.delete(theme.artwork);
    if (root.dataset.theme === theme.id) apply(frame);
  };
  image.onerror = () => artworkLoading.delete(theme.artwork);
  image.src = new URL(theme.artwork, document.baseURI).href;
}

/** Resolve beside the app document, including packaged file:// windows. */
export function themeArtwork(theme) {
  return theme.artwork ? `url(${JSON.stringify(new URL(theme.artwork, document.baseURI).href)})` : 'none';
}

/** Writes a theme's anchors and the reading preferences onto <html>. */
export function applyAppearance(value, { animate = false } = {}) {
  const appearance = normalizeAppearance(value);
  current = appearance;
  const root = document.documentElement;
  const theme = resolveTheme(appearance, darkQuery ? darkQuery.matches : true);
  currentArtwork = theme;
  if (animate && root.dataset.theme && root.dataset.theme !== theme.id) {
    root.classList.add('theme-switching');
    clearTimeout(switchTimer);
    switchTimer = setTimeout(() => root.classList.remove('theme-switching'), 360);
  }
  for (const [name, color] of Object.entries(theme.colors)) root.style.setProperty(`--t-${name}`, color);
  if (theme.artwork) {
    root.dataset.artwork = theme.calm ? 'calm' : 'vivid';
    root.style.setProperty('--theme-art', themeArtwork(theme));
  } else {
    delete root.dataset.artwork;
    root.style.removeProperty('--theme-art');
  }
  root.style.setProperty('--t-lift', String(theme.lift || 0));
  if (appearance.textColor) root.style.setProperty('--t-text', appearance.textColor); else root.style.removeProperty('--t-text');
  root.style.setProperty('--reading-font', READING_FONTS.find(item => item.id === appearance.readingFont).stack);
  root.style.setProperty('--reading-size', `${TEXT_SIZES.find(item => item.id === appearance.textSize).px}px`);
  const chatWidth = CHAT_WIDTHS.find(item => item.id === appearance.chatWidth).px;
  root.style.setProperty('--chat-width', chatWidth === null ? '100%' : `${chatWidth}px`);
  root.dataset.theme = theme.id;
  artworkAspect(theme);
  root.dataset.scheme = theme.scheme;
  root.dataset.motion = appearance.motion;
  if (appearance.glow) root.dataset.glow = ''; else delete root.dataset.glow;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.colors.ground);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(appearance)); } catch { /* storage may be unavailable */ }
  return theme;
}

/** Applies the last used appearance before React renders, so the first paint matches. */
export function applyCachedAppearance() {
  let cached;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { cached = null; }
  applyAppearance(cached || {});
}

/** Keep a panorama's subject scale and horizon stable as the available canvas changes. */
export function watchArtworkFrame() {
  // The workspace layout can re-create .main-shell, so look it up again instead of keeping the first element.
  let canvas = null;
  const update = () => {
    if (!canvas?.isConnected) return;
    const bounds = canvas.getBoundingClientRect(), { width, height } = bounds, root = document.documentElement;
    const aspect = Number(root.style.getPropertyValue('--theme-art-aspect')) || 16/9;
    const frame = currentArtwork?.artworkFrame;
    if (!frame || width <= 0 || height <= 0) {
      root.dataset.artworkFit = 'standard';
      for (const name of ['size','width','height','position']) root.style.removeProperty(`--artwork-${name}`);
      return;
    }
    if (frame.kind) {
      const surfaces = [...canvas.querySelectorAll('.assistant, .user-bubble, .composer, .welcome')];
      const readingRight = Math.min(width, Math.max(0, ...surfaces.map(element => element.getBoundingClientRect().right - bounds.left)));
      const geometry = cyberpunkFrame({ width, height, aspect, readingRight, frame });
      root.dataset.artworkFit = frame.kind;
      for (const [name, value] of Object.entries(geometry)) root.style.setProperty(`--cp-${name}`, `${value}${name.startsWith('fade') || name.includes('Start') || name.includes('End') ? '%' : 'px'}`);
      root.style.setProperty('--artwork-width', `${geometry.imageWidth}px`);
      root.style.setProperty('--artwork-height', `${geometry.imageHeight}px`);
      return;
    }
    // Use one framing scale for ordinary and 32:9 displays. Crop quiet scenery at
    // narrower widths; never stretch sampled edge strips or enlarge just the sun.
    const artWidth = Math.max(width, height * frame.aspect), artHeight = artWidth / aspect;
    const headerHeight = canvas.querySelector(':scope > .topbar')?.getBoundingClientRect().height || 0;
    const focusX = Math.max(width / 2, Math.min(width * .82, width - height * .26));
    const cropX = Math.max(0, Math.min(artWidth - width, frame.focus * artWidth - focusX));
    const horizonY = headerHeight + (height - headerHeight) * .53;
    const cropY = Math.max(0, Math.min(artHeight - height, frame.horizon * artHeight - horizonY));
    const positionX = artWidth > width ? cropX / (artWidth - width) * 100 : 50;
    const positionY = artHeight > height ? cropY / (artHeight - height) * 100 : 50;
    root.dataset.artworkFit = 'panorama';
    root.style.setProperty('--artwork-size', `${artWidth}px ${artHeight}px`);
    root.style.setProperty('--artwork-width', `${artWidth}px`);
    root.style.setProperty('--artwork-height', `${artHeight}px`);
    root.style.setProperty('--artwork-position', `${positionX}% ${positionY}%`);
  };
  const observer = new ResizeObserver(update);
  const observeSurfaces = () => { observer.disconnect(); canvas = document.querySelector('.main-shell'); if (!canvas) return; observer.observe(canvas); canvas.querySelectorAll('.composer, .welcome, .messages').forEach(element => observer.observe(element)); update(); };
  const changes = new MutationObserver(observeSurfaces); changes.observe(document.getElementById('root') || document.body, { childList: true, subtree: true }); observeSurfaces();
  window.addEventListener('exomina-artwork-change',update);
  return () => {observer.disconnect();changes.disconnect();window.removeEventListener('exomina-artwork-change',update);};
}

// "Match Windows" follows the OS live.
darkQuery?.addEventListener?.('change', () => { if (current?.theme === 'system') applyAppearance(current, { animate: true }); });
