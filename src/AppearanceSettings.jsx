import React, { useId, useState } from 'react';
import { Check, Monitor, RotateCcw, Search, X } from 'lucide-react';
import { CHAT_WIDTHS, READING_FONTS, TEXT_SIZES, THEMES, contrastRatio, normalizeAppearance, resolveTheme } from '../desktop/themes.mjs';
import { themeArtwork } from './appearance.js';
import './appearance.css';
import {UI_SCALES} from '../desktop/ui-zoom.mjs';
import PaletteEditor from './PaletteEditor.jsx';
import './settings-appearance.css';

/** A miniature Exomina window using the theme's actual artwork and colours. */
function ThemePreview({ theme }) {
  const { ground, ink, accent, leaf, warm } = theme.colors;
  return <span className={`tp ${theme.effect ? 'tp-' + theme.effect : ''} ${theme.artwork ? 'tp-artwork' : ''}`} style={{ '--g': ground, '--i': ink, '--a': accent, '--l': leaf, '--w': warm, '--theme-art': themeArtwork(theme) }} aria-hidden="true">
    {theme.effect === 'matrix' && <span className="tp-rain">{['ﾏ01ﾘｸ7', 'ｼ9ﾄ0ﾒ', '01ﾈﾊ6', 'ｳ7ﾐ10', '8ﾖｶ01', 'ﾆ0ﾑ9ﾗ'].map((code, i) => <i key={i}>{code}</i>)}</span>}
    <span className="tp-side"><i /><i /><i /><i /></span>
    <span className="tp-main"><span className="tp-bubble" /><span className="tp-line" /><span className="tp-line short" /><span className="tp-composer"><s /><b /></span></span>
  </span>;
}

function Segmented({ label, value, options, onChange, disabled, render }) {
  function move(event,index){if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1)+options.length)%options.length;onChange(options[next].id);event.currentTarget.parentElement.children[next]?.focus();}
  return <div className="segmented" role="radiogroup" aria-label={label}>{options.map((option,index) => <button type="button" role="radio" key={option.id} aria-checked={value === option.id} tabIndex={value===option.id?0:-1} disabled={disabled} className={value === option.id ? 'selected' : ''} onKeyDown={event=>move(event,index)} onClick={() => value !== option.id && onChange(option.id)}>{render ? render(option) : option.name}</button>)}</div>;
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
  return <div className="settings-row text-color-row"><div><strong>Text colour</strong><p>Use the theme colour, or choose your own.</p>
    {ratio !== null && ratio < 4.5 && <p className="inline-error" role="status">Low contrast on {theme.name} ({ratio.toFixed(1)}:1). Text may be hard to read; 4.5:1 or more is recommended.</p>}</div>
    <div className="text-color-controls">
      <button type="button" className={`text-swatch theme-default ${!color ? 'selected' : ''}`} disabled={busy} onClick={() => color && onChange({ textColor: '' })} title="Use the theme’s text colour" aria-pressed={!color}><span style={{ background: theme.colors.ink }} />Theme</button>
      {TEXT_PRESETS[theme.scheme].map(([hex, name]) => <button type="button" key={hex} className={`text-swatch ${color === hex ? 'selected' : ''}`} disabled={busy} title={name} aria-label={`Text colour ${name}`} aria-pressed={color === hex} onClick={() => onChange({ textColor: hex })}><span style={{ background: hex }} /></button>)}
      <label className="text-swatch custom" title="Choose any colour"><input type="color" value={color || theme.colors.ink} disabled={busy} onChange={event => onChange({ textColor: event.target.value.toLowerCase() })} aria-label="Custom text colour" /><span>Custom</span></label>
    </div></div>;
}

const MOTION = [{ id: 'system', name: 'Follow system' }, { id: 'reduced', name: 'Always reduce' }];
const APPEARANCE_TABS=[['theme','Theme & colour'],['reading','Reading'],['window','Window & motion']];
const THEME_FILTERS=[['all','All'],['dark','Dark'],['light','Light'],['animated','Animated'],['artwork','Artwork']];

export default function AppearanceSettings({ appearance: value, onChange, Toggle, busy = false, windowState }) {
  const appearance = normalizeAppearance(value);
  const instanceId=useId();
  const [tab,setTab]=useState('theme');
  const [filter,setFilter]=useState('all');
  const [query,setQuery]=useState('');
  const [expanded,setExpanded]=useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  // Removed themes leave the picker; the ones in use stay, so the app can never lose its look.
  const hidden = new Set(appearance.hiddenThemes), inUse = new Set([appearance.theme, appearance.lightTheme, appearance.darkTheme]);
  const shown = theme => !hidden.has(theme.id) || inUse.has(theme.id);
  const darkThemes = THEMES.filter(theme => theme.scheme === 'dark' && shown(theme));
  const lightThemes = THEMES.filter(theme => theme.scheme === 'light' && shown(theme));
  const animated = theme => theme.effect === 'matrix' || theme.effect === 'palimpsest';
  const themes=THEMES.filter(theme=>shown(theme)&&(filter==='all'||filter==='animated'&&animated(theme)||filter==='artwork'&&theme.artwork||theme.scheme===filter)&&[theme.name,theme.description].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const ordered=themes;
  const visibleThemes=expanded||query.trim()?ordered:ordered.slice(0,8);
  const byId = id => THEMES.find(theme => theme.id === id);
  const current=resolveTheme(appearance,typeof window!=='undefined'&&window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const setHidden = ids => onChange({ hiddenThemes: [...new Set(ids)].sort() });
  function themeKey(event){if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...event.currentTarget.closest('.theme-grid').querySelectorAll('[role="radio"]')],index=buttons.indexOf(event.currentTarget);const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();buttons[next]?.click();}
  const card = (id, name, description, preview, removable = true) => <div className="theme-card-wrap" key={id}><button type="button" role="radio" aria-label={name} title={description} aria-checked={appearance.theme === id} tabIndex={appearance.theme===id||(!visibleThemes.some(theme=>theme.id===appearance.theme)&&visibleThemes[0]?.id===id)?0:-1} disabled={busy} className={`theme-card ${appearance.theme === id ? 'selected' : ''}`} onKeyDown={themeKey} onClick={() => appearance.theme !== id && onChange({ theme: id })}>
    {preview}<span className="theme-card-text"><strong>{name}</strong></span>{appearance.theme === id && <span className="theme-card-check"><Check size={12} strokeWidth={2.6} /></span>}
  </button>{removable && !inUse.has(id) && <button type="button" className="theme-remove" disabled={busy} aria-label={`Remove ${name} from the theme list`} title="Remove from the list (you can restore it below)" onClick={() => setHidden([...hidden, id])}><X size={12} /></button>}</div>;
  return <section className="settings-section appearance-studio" id="settings-appearance">
    <div className="section-title"><h2>Appearance</h2></div>
    <div className="appearance-tabs" role="tablist" aria-label="Appearance sections">{APPEARANCE_TABS.map(([id,label],index)=><button type="button" key={id} id={`${instanceId}-${id}-tab`} role="tab" aria-selected={tab===id} tabIndex={tab===id?0:-1} aria-controls={`${instanceId}-${id}`} onClick={()=>setTab(id)} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?APPEARANCE_TABS.length-1:(index+(event.key==='ArrowRight'?1:-1)+APPEARANCE_TABS.length)%APPEARANCE_TABS.length;setTab(APPEARANCE_TABS[next][0]);event.currentTarget.parentElement.children[next]?.focus();}}>{label}</button>)}</div>
    <div role="tabpanel" id={`${instanceId}-theme`} aria-labelledby={`${instanceId}-theme-tab`} hidden={tab!=='theme'}>
    <div className="appearance-current"><ThemePreview theme={current}/><div><span>Current theme</span><strong>{appearance.theme==='system'?`${current.name} · System`:current.name}</strong><p>{appearance.customPalette?'Custom colours':current.description}</p></div></div>
    <div className="settings-row appearance-system"><div><strong>Match system appearance</strong><p>Switch with your system’s light and dark mode.</p></div><Toggle label="Match system appearance" checked={appearance.theme==='system'} disabled={busy} onChange={enabled=>onChange({theme:enabled?'system':current.id})}/></div>
    {hidden.size > 0 && <div className="theme-removed"><button type="button" className="theme-removed-toggle" aria-expanded={showRemoved} onClick={() => setShowRemoved(!showRemoved)}>{hidden.size} removed {hidden.size === 1 ? 'theme' : 'themes'} · {showRemoved ? 'Hide' : 'Show'}</button>
      {showRemoved && <div className="theme-removed-list">{[...hidden].map(byId).filter(Boolean).map(theme => <span key={theme.id}><ThemePreview theme={theme} /><strong>{theme.name}</strong><button type="button" className="secondary-button" disabled={busy} onClick={() => setHidden([...hidden].filter(id => id !== theme.id))}><RotateCcw size={12} />Restore</button></span>)}</div>}</div>}
    {appearance.theme === 'system' && <div className="settings-row theme-pair"><div><strong><Monitor size={14} />Follows your system light or dark mode</strong><p>Choose which theme to use for each.</p></div><div className="theme-pair-selects">
      <label>Light<select value={appearance.lightTheme} disabled={busy} onChange={event => onChange({ lightTheme: event.target.value })}>{lightThemes.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label>
      <label>Dark<select value={appearance.darkTheme} disabled={busy} onChange={event => onChange({ darkTheme: event.target.value })}>{darkThemes.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label>
    </div></div>}
    <div className="theme-browser"><div className="theme-browser-toolbar"><div className="theme-filters" aria-label="Theme filters">{THEME_FILTERS.map(([id,label])=><button type="button" key={id} aria-pressed={filter===id} onClick={()=>{setFilter(id);setExpanded(false);}}>{label}</button>)}</div><label className="theme-search"><Search size={14} aria-hidden="true"/><input type="search" aria-label="Find themes" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Find a theme"/></label></div><div className="theme-grid" role="radiogroup" aria-label="Theme">{visibleThemes.map(theme=>card(theme.id,theme.name,theme.description,<ThemePreview theme={theme}/>))}</div>{!visibleThemes.length&&<p className="theme-empty" role="status">No themes match this search.</p>}{ordered.length>8&&!query.trim()&&<button className="theme-expand" type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Show fewer themes':`Show all ${ordered.length} themes`}</button>}</div>
    <PaletteEditor appearance={appearance} onChange={onChange} busy={busy}/>
    </div>
    <div role="tabpanel" id={`${instanceId}-reading`} aria-labelledby={`${instanceId}-reading-tab`} hidden={tab!=='reading'}>
    <div className="reading-sample" style={{ fontFamily: READING_FONTS.find(font => font.id === appearance.readingFont).stack, fontSize: `${TEXT_SIZES.find(size => size.id === appearance.textSize).px}px` }}><span className="reading-sample-label">Reading preview</span><p>A quiet place for a complicated thought. Your messages use this font and size. <code>Code stays monospaced.</code></p></div>
    <div className="settings-row reading-row"><div><strong>Reading font</strong><p>For your conversations.</p></div><Segmented label="Reading font" value={appearance.readingFont} options={READING_FONTS} disabled={busy} onChange={readingFont => onChange({ readingFont })} render={font => <span style={{ fontFamily: font.stack }}>{font.name}</span>} /></div>
    <div className="settings-row"><div><strong>Text size</strong><p>Size of messages in chats.</p></div><Segmented label="Text size" value={appearance.textSize} options={TEXT_SIZES} disabled={busy} onChange={textSize => onChange({ textSize })} render={size => <span style={{ fontSize: `${11.5 + TEXT_SIZES.indexOf(size) * 0.75}px` }}>{size.name}</span>} /></div>
    <TextColor appearance={appearance} onChange={onChange} busy={busy} />
    <div className="settings-row"><div><strong>Conversation width</strong><p>How wide messages and the message box may grow.</p></div><Segmented label="Conversation width" value={appearance.chatWidth} options={CHAT_WIDTHS} disabled={busy} onChange={chatWidth => onChange({ chatWidth })} /></div>
    </div>
    <div role="tabpanel" id={`${instanceId}-window`} aria-labelledby={`${instanceId}-window-tab`} hidden={tab!=='window'}>
    <div className="settings-row"><div><strong>Interface size</strong><p>Scale menus, buttons and text. Ctrl/Cmd + plus or minus; Ctrl/Cmd + 0 resets.</p></div><select aria-label="Interface size" disabled={busy} value={appearance.uiScale} onChange={event=>onChange({uiScale:Number(event.target.value)})}>{UI_SCALES.map(scale=><option key={scale} value={scale}>{Math.round(scale*100)}%</option>)}</select></div>
    {windowState && <div className="settings-row"><div><strong>Borderless window</strong><p>Use a theme-matched title bar.</p>{windowState.borderless !== appearance.borderless && <p className="window-style-notice" role="status">Applies when Exomina next starts.</p>}</div><Toggle label="Borderless window" checked={appearance.borderless} disabled={busy} onChange={borderless => onChange({ borderless })} /></div>}
    <div className="settings-row"><div><strong>Ambient glow</strong><p>A faint wash of the theme’s accent behind your chats.</p></div><Toggle label="Ambient glow" checked={appearance.glow} disabled={busy} onChange={glow => onChange({ glow })} /></div>
    <div className="settings-row"><div><strong>Reduce motion</strong><p>Turns off animations and transitions.</p></div><Segmented label="Reduce motion" value={appearance.motion} options={MOTION} disabled={busy} onChange={motion => onChange({ motion })} /></div>
    </div>
  </section>;
}
