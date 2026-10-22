import React, { useState } from 'react';
import { Check, Monitor, RotateCcw, X } from 'lucide-react';
import { CHAT_WIDTHS, READING_FONTS, TEXT_SIZES, THEMES, THEME_PROFILE, contrastRatio, normalizeAppearance, resolveTheme } from '../desktop/themes.mjs';
import { themeArtwork } from './appearance.js';
import './appearance.css';
import {UI_SCALES} from '../desktop/ui-zoom.mjs';

/** A miniature Exomina window using the theme's actual artwork and colours. */
function ThemePreview({ theme }) {
  const { ground, ink, accent, leaf } = theme.colors;
  return <span className={`tp ${theme.effect ? 'tp-' + theme.effect : ''} ${theme.artwork ? 'tp-artwork' : ''}`} style={{ '--g': ground, '--i': ink, '--a': accent, '--l': leaf, '--theme-art': themeArtwork(theme) }} aria-hidden="true">
    {theme.effect === 'matrix' && <span className="tp-rain">{['ﾏ01ﾘｸ7', 'ｼ9ﾄ0ﾒ', '01ﾈﾊ6', 'ｳ7ﾐ10', '8ﾖｶ01', 'ﾆ0ﾑ9ﾗ'].map((code, i) => <i key={i}>{code}</i>)}</span>}
    <span className="tp-side"><i /><i /><i /><i /></span>
    <span className="tp-main"><span className="tp-bubble" /><span className="tp-line" /><span className="tp-line short" /><span className="tp-composer"><s /><b /></span></span>
  </span>;
}

function Segmented({ label, value, options, onChange, disabled, render }) {
  return <div className="segmented" role="radiogroup" aria-label={label}>{options.map(option => <button type="button" role="radio" key={option.id} aria-checked={value === option.id} disabled={disabled} className={value === option.id ? 'selected' : ''} onClick={() => value !== option.id && onChange(option.id)}>{render ? render(option) : option.name}</button>)}</div>;
}

const TEXT_PRESETS = {
  dark: [['#f4ede1', 'Warm white'], ['#e6e9ef', 'Cool white'], ['#d4f0e0', 'Mint'], ['#d3e2ff', 'Sky'], ['#e5d9ff', 'Lavender'], ['#ffdcae', 'Amber']],
  light: [['#111111', 'Ink'], ['#3a2a1b', 'Sepia'], ['#18284a', 'Navy'], ['#1c3a2a', 'Forest'], ['#3d1f3f', 'Plum'], ['#4a1f1a', 'Oxblood']],
};

/** Custom text colour over any theme, with a live contrast check against its background. */
function TextColor({ appearance, onChange, busy }) {
  const prefersDark = typeof window === 'undefined' || !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = resolveTheme(appearance, prefersDark);
  const color = appearance.textColor;
  const ratio = color ? contrastRatio(color, theme.colors.ground) : null;
  return <div className="settings-row text-color-row"><div><strong>Text colour</strong><p>Overrides the theme’s text colour everywhere. Backgrounds and accents stay with the theme.</p>
    {ratio !== null && ratio < 4.5 && <p className="inline-error" role="status">Low contrast on {theme.name} ({ratio.toFixed(1)}:1). Text may be hard to read; 4.5:1 or more is recommended.</p>}</div>
    <div className="text-color-controls">
      <button type="button" className={`text-swatch theme-default ${!color ? 'selected' : ''}`} disabled={busy} onClick={() => color && onChange({ textColor: '' })} title="Use the theme’s text colour" aria-pressed={!color}><span style={{ background: theme.colors.ink }} />Theme</button>
      {TEXT_PRESETS[theme.scheme].map(([hex, name]) => <button type="button" key={hex} className={`text-swatch ${color === hex ? 'selected' : ''}`} disabled={busy} title={name} aria-label={`Text colour ${name}`} aria-pressed={color === hex} onClick={() => onChange({ textColor: hex })}><span style={{ background: hex }} /></button>)}
      <label className="text-swatch custom" title="Choose any colour"><input type="color" value={color || theme.colors.ink} disabled={busy} onChange={event => onChange({ textColor: event.target.value.toLowerCase() })} aria-label="Custom text colour" /><span>Custom</span></label>
    </div></div>;
}

const MOTION = [{ id: 'system', name: 'Follow system' }, { id: 'reduced', name: 'Always reduce' }];

export default function AppearanceSettings({ appearance: value, onChange, Toggle, busy = false, windowState }) {
  const appearance = normalizeAppearance(value);
  const [showRemoved, setShowRemoved] = useState(false);
  // Removed themes leave the picker; the ones in use stay, so the app can never lose its look.
  const hidden = new Set(appearance.hiddenThemes), inUse = new Set([appearance.theme, appearance.lightTheme, appearance.darkTheme]);
  const shown = theme => !hidden.has(theme.id) || inUse.has(theme.id);
  const darkThemes = THEMES.filter(theme => theme.scheme === 'dark' && shown(theme));
  const lightThemes = THEMES.filter(theme => theme.scheme === 'light' && shown(theme));
  const groups = [['Animated', THEMES.filter(theme => theme.effect === 'matrix')], ['Extravagant', THEMES.filter(theme => theme.artwork && !theme.calm)], ['Atmospheric', THEMES.filter(theme => theme.calm)], ['Dark', THEMES.filter(theme => theme.scheme === 'dark' && !theme.artwork && theme.effect !== 'matrix')], ['Light', THEMES.filter(theme => theme.scheme === 'light' && !theme.artwork)]]
    .map(([label, themes]) => [label, themes.filter(shown)]).filter(([, themes]) => themes.length);
  const byId = id => THEMES.find(theme => theme.id === id);
  const setHidden = ids => onChange({ hiddenThemes: [...new Set(ids)].sort() });
  const card = (id, name, description, preview, removable = true) => <div className="theme-card-wrap" key={id}><button type="button" role="radio" aria-checked={appearance.theme === id} disabled={busy} className={`theme-card ${appearance.theme === id ? 'selected' : ''}`} onClick={() => appearance.theme !== id && onChange({ theme: id })}>
    {preview}<span className="theme-card-text"><strong>{name}</strong><small>{description}</small></span>{appearance.theme === id && <span className="theme-card-check"><Check size={12} strokeWidth={2.6} /></span>}
  </button>{removable && !inUse.has(id) && <button type="button" className="theme-remove" disabled={busy} aria-label={`Remove ${name} from the theme list`} title="Remove from the list (you can restore it below)" onClick={() => setHidden([...hidden, id])}><X size={12} /></button>}</div>;
  return <section className="settings-section" id="settings-appearance">
    <div className="section-title"><h2>Appearance</h2><span>Atmosphere, colour and reading</span></div>
    {THEME_PROFILE === 'beta' && <p className="theme-design-note">Want a different look? Ask Exomina in chat to help design your own theme.</p>}
    {windowState && <div className="settings-row"><div><strong>Borderless window</strong><p>A header that matches your theme, with the standard window buttons and snapping.</p>{windowState.borderless !== appearance.borderless && <p className="window-style-notice" role="status">This window style will apply when Exomina next starts.</p>}</div><Toggle label="Borderless window" checked={appearance.borderless} disabled={busy} onChange={borderless => onChange({ borderless })} /></div>}
    <div className="theme-groups" role="radiogroup" aria-label="Theme">
      {groups.map(([label, themes]) => <div className={`theme-group ${['Extravagant', 'Atmospheric'].includes(label) ? 'extravagant' : ''}`} key={label}><h3>{label}</h3><div className="theme-grid">{themes.map(theme => card(theme.id, theme.name, theme.description, <ThemePreview theme={theme} />))}</div></div>)}
      <div className="theme-group"><h3>Automatic</h3><div className="theme-grid">{card('system', 'Match system', `${byId(appearance.darkTheme).name} at night, ${byId(appearance.lightTheme).name} by day.`, <span className="tp-split"><ThemePreview theme={byId(appearance.lightTheme)} /><ThemePreview theme={byId(appearance.darkTheme)} /></span>, false)}</div></div>
    </div>
    {hidden.size > 0 && <div className="theme-removed"><button type="button" className="theme-removed-toggle" aria-expanded={showRemoved} onClick={() => setShowRemoved(!showRemoved)}>{hidden.size} removed {hidden.size === 1 ? 'theme' : 'themes'} · {showRemoved ? 'Hide' : 'Show'}</button>
      {showRemoved && <div className="theme-removed-list">{[...hidden].map(byId).filter(Boolean).map(theme => <span key={theme.id}><ThemePreview theme={theme} /><strong>{theme.name}</strong><button type="button" className="secondary-button" disabled={busy} onClick={() => setHidden([...hidden].filter(id => id !== theme.id))}><RotateCcw size={12} />Restore</button></span>)}</div>}</div>}
    {appearance.theme === 'system' && <div className="settings-row theme-pair"><div><strong><Monitor size={14} />Follows your system light or dark mode</strong><p>Choose which theme to use for each.</p></div><div className="theme-pair-selects">
      <label>Light<select value={appearance.lightTheme} disabled={busy} onChange={event => onChange({ lightTheme: event.target.value })}>{lightThemes.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label>
      <label>Dark<select value={appearance.darkTheme} disabled={busy} onChange={event => onChange({ darkTheme: event.target.value })}>{darkThemes.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label>
    </div></div>}
    <div className="settings-row reading-row"><div><strong>Reading font</strong><p>The typeface for conversation text. Code stays monospaced.</p></div><Segmented label="Reading font" value={appearance.readingFont} options={READING_FONTS} disabled={busy} onChange={readingFont => onChange({ readingFont })} render={font => <span style={{ fontFamily: font.stack }}>{font.name}</span>} /></div>
    <div className="settings-row"><div><strong>Text size</strong><p>Size of messages in chats.</p></div><Segmented label="Text size" value={appearance.textSize} options={TEXT_SIZES} disabled={busy} onChange={textSize => onChange({ textSize })} render={size => <span style={{ fontSize: `${11.5 + TEXT_SIZES.indexOf(size) * 0.75}px` }}>{size.name}</span>} /></div>
    <div className="settings-row"><div><strong>Interface size</strong><p>Scale menus, buttons and text together. Use Ctrl/Cmd + plus or minus; Ctrl/Cmd + 0 resets to 100%.</p></div><select aria-label="Interface size" disabled={busy} value={appearance.uiScale} onChange={event=>onChange({uiScale:Number(event.target.value)})}>{UI_SCALES.map(scale=><option key={scale} value={scale}>{Math.round(scale*100)}%</option>)}</select></div>
    <TextColor appearance={appearance} onChange={onChange} busy={busy} />
    <div className="reading-sample" style={{ fontFamily: READING_FONTS.find(font => font.id === appearance.readingFont).stack, fontSize: `${TEXT_SIZES.find(size => size.id === appearance.textSize).px}px` }}>
      <p>Every answer reads like this: measured, legible, easy on long nights. <code>inline code</code> keeps its own face.</p>
    </div>
    <div className="settings-row"><div><strong>Conversation width</strong><p>How wide messages and the message box may grow.</p></div><Segmented label="Conversation width" value={appearance.chatWidth} options={CHAT_WIDTHS} disabled={busy} onChange={chatWidth => onChange({ chatWidth })} /></div>
    <div className="settings-row"><div><strong>Ambient glow</strong><p>A faint wash of the theme’s accent behind your chats.</p></div><Toggle label="Ambient glow" checked={appearance.glow} disabled={busy} onChange={glow => onChange({ glow })} /></div>
    <div className="settings-row"><div><strong>Reduce motion</strong><p>Turns off animations and transitions.</p></div><Segmented label="Reduce motion" value={appearance.motion} options={MOTION} disabled={busy} onChange={motion => onChange({ motion })} /></div>
  </section>;
}
