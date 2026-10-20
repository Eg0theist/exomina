import React, { Children, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, Brain, MessageSquare, Palette, Search, Settings2, Unplug, X, Zap } from 'lucide-react';
import './settings-layout.css';
import InterfaceView from './InterfaceView.jsx';

const STANDARD_SECTIONS = new Set(['general', 'updates', 'about', 'usage', 'local-ai', 'marketing', 'connections', 'phone', 'sounds', 'personalization', 'appearance', 'permissions', 'memory', 'data']);

const groups = [
  { id: 'general', label: 'General', icon: Settings2, description: 'Project folder, startup and app updates.' },
  { id: 'models', label: 'Models & usage', icon: Zap, description: 'Default AI, available models, usage and automatic handoffs.' },
  { id: 'conversation', label: 'Conversation', icon: MessageSquare, description: 'Reply style, personal instructions and spelling.' },
  { id: 'experience', label: 'Appearance & audio', icon: Palette, description: 'Themes, window appearance, sounds and voice.' },
  { id: 'privacy', label: 'Privacy & data', icon: Brain, description: 'What your AI may do, memory, recovery and exports.' },
  { id: 'integrations', label: 'Connections & sync', icon: Unplug, description: 'External tools, cloud sync and messaging.' },
];
const sections = [
  { id: 'general', group: 'general', label: 'App behavior', description: 'Project folder, quick access, automatic chat titles and tray behavior.', keywords: 'workspace directory terminal shortcut ctrl shift space startup close window name chats' },
  { id: 'updates', group: 'general', label: 'Updates', description: 'Check, download and apply updates; choose the release source.', keywords: 'version release automatic feed install restart', desktop: true },
  { id: 'about', group: 'general', label: 'About Exomina', description: 'Installed version and current theme.', keywords: 'build app information' },
  { id: 'defaults', group: 'models', label: 'Default AI', description: 'Provider and model used for new chats.', keywords: 'chatgpt codex claude gemini antigravity grok muse default ai' },
  { id: 'models', group: 'models', label: 'Models & continuity', description: 'Visible providers and models; automatic usage fallback and handoff order.', keywords: 'connection picker options hide enabled usage limit switch provider automatic fallback billing api subscription' },
  { id: 'usage', group: 'models', label: 'Usage', description: 'Provider limits, reset times, reset credits and safety limits.', keywords: 'quota rate subscription remaining refresh limit credits redeem safety guard pause budget', desktop: true },
  { id: 'local-ai', group: 'models', label: 'Local AI & background tasks', description: 'Hardware tiers, local decisions, demanding-app priority and automatic folder triggers.', keywords: 'decision layer tier 1 2 3 onnx model download cpu gpu render video export gaming pause learning agent always on inbox budget', desktop: true },
  { id: 'marketing', group: 'conversation', label: 'Marketing helper', description: 'Draft posts about Exomina in your style for you to review and publish.', keywords: 'marketing posts social drafts approval queue style release notes promote', desktop: true },
  { id: 'personalization', group: 'conversation', label: 'Personalisation', description: 'Character, visual companion, tone, instructions and writing styles.', keywords: 'personalization response language concise formal learn samples documents soul pet mascot avatar companion character' },
  { id: 'spelling', group: 'conversation', label: 'Spelling', description: 'Spellcheck languages and suggestions while typing.', keywords: 'dictionary grammar editor composer language', desktop: true },
  { id: 'appearance', group: 'experience', label: 'Appearance', description: 'Theme, type size, motion, contrast, artwork and window appearance.', keywords: 'light dark system font scale typography animation accent color glass transparency titlebar' },
  { id: 'sounds', group: 'experience', label: 'Sounds & notifications', description: 'Windows notifications, notification sounds, volume and previews.', keywords: 'notification audio alert tone mute toast popup question approval hidden taskbar tray', desktop: true },
  { id: 'voice', group: 'experience', label: 'Voice', description: 'Realtime voice, dictation, speech voices and playback.', keywords: 'microphone speech speaking read aloud windows sample sound realtime chatgpt', desktop: true },
  { id: 'permissions', group: 'privacy', label: 'Permissions', description: 'Default agent permissions, allow and deny rules and chat overrides.', keywords: 'approval ask safety read only full access command shell file editing tools security', desktop: true },
  { id: 'memory', group: 'privacy', label: 'Memory & privacy', description: 'Saved notes, chat history, recovery backup and local data.', keywords: 'shared context summaries automatic capture review clear delete privacy encrypted encryption recovery certificate storage folder', },
  { id: 'data', group: 'privacy', label: 'Export & transfer', description: 'Export chats and context, or import saved context from another device.', keywords: 'download backup json markdown archive export import move migrate transfer new device' },
  { id: 'connections', group: 'integrations', label: 'AI connections', description: 'Connect an AI provider or manage an existing connection.', keywords: 'login sign in subscription chatgpt codex claude grok muse provider setup' },
  { id: 'integrations', group: 'integrations', label: 'Tools & sync', description: 'External MCP servers, cloud sync and paired devices.', keywords: 'plugins connector custom server mcp configuration computer browser sync cloud mobile qr pair' },
  { id: 'phone', group: 'integrations', label: 'Phone access', description: 'Pair your phone to this computer through your private relay.', keywords: 'phone mobile qr pair remote desktop relay invitation revoke', desktop: true },
  { id: 'messaging', group: 'integrations', label: 'Messaging', description: 'Remote messaging connections and their provider.', keywords: 'telegram discord whatsapp bot remote phone', desktop: true },
  { id: 'workspace', group: 'integrations', label: 'Private workspace', description: 'Server connection and sign out.', keywords: 'account session login logout sign out server', web: true },
];

export function SettingsPanel({ children }) { return children; }

/** Keeps settings drafts mounted while presenting one related group at a time. */
export default function SettingsLayout({ section = 'general', selectionRequest = 0, desktop, onSelect, onNavigate, children, view = 'advanced', onView }) {
  const available = sections.filter(item => (!item.desktop || desktop) && (!item.web || !desktop));
  const chosen = available.find(item => item.id === section) || available[0];
  // Keep a section opened by a deep link visible, and keep every draft mounted.
  const shown = view === 'standard' ? available.filter(item => STANDARD_SECTIONS.has(item.id) || item.id === chosen.id) : available;
  const currentGroup = groups.find(item => item.id === chosen.group);
  const groupSections = shown.filter(item => item.group === chosen.group);
  const [query, setQuery] = useState('');
  const scroller = useRef(null);
  const searchInput = useRef(null);
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = terms.length ? available.filter(item => terms.every(term => `${item.label} ${item.description} ${item.keywords} ${groups.find(group => group.id === item.group).label}`.toLocaleLowerCase().includes(term))) : [];
  useLayoutEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [chosen.group]);
  useLayoutEffect(() => { setQuery(''); }, [selectionRequest]);
  function select(id) { setQuery(''); if (view === 'standard' && !STANDARD_SECTIONS.has(id)) onView?.('advanced'); onSelect(id); }
  return <div className="content-page settings-page settings-organized">
    <div className="page-heading"><div><div className="eyebrow">PREFERENCES</div><h1>Settings</h1><p>Find a setting or choose a category.</p>{view === 'standard' && <p className="settings-view-note">Showing everyday settings. Search also finds Advanced controls. Permissions, usage and privacy stay available.</p>}</div>{onView && <InterfaceView view={view} onChange={onView}/>}</div>
    {view==='diagnostics'&&<p className="settings-view-note">Diagnostics adds a searchable event inspector to each reply. It uses the same tools, permissions and AI settings as Advanced.</p>}
    <div className="settings-layout">
      <aside className="settings-navigation">
        <div className="settings-search"><Search size={15} aria-hidden="true" /><input ref={searchInput} type="search" aria-label="Search settings" placeholder="Find a setting…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); if (event.key === 'Enter' && matches.length) { event.preventDefault(); select(matches[0].id); } }} />{query && <button type="button" aria-label="Clear settings search" onClick={() => { setQuery(''); searchInput.current?.focus(); }}><X size={13} /></button>}</div>
        <nav className="settings-nav" aria-label="Settings categories">{groups.filter(group => shown.some(item => item.group === group.id)).map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={!terms.length && chosen.group === id ? 'page' : undefined} className={!terms.length && chosen.group === id ? 'selected' : ''} onClick={() => select(shown.find(item => item.group === id).id)}><Icon size={16} aria-hidden="true" /><span>{label}</span></button>)}</nav>
      </aside>
      <div className="settings-panel-scroll" ref={scroller}>
        {terms.length ? <div className="settings-search-results" aria-label="Settings search results"><div className="settings-category-heading"><h2>Search results</h2><p role="status">{matches.length} {matches.length === 1 ? 'section' : 'sections'} found for “{query.trim()}”.</p></div>{matches.map(item => <button className="settings-search-result" type="button" key={item.id} onClick={() => select(item.id)}><span><small>{groups.find(group => group.id === item.group).label}</small><strong>{item.label}</strong>{view === 'standard' && !STANDARD_SECTIONS.has(item.id) && <small className="advanced-setting-label">Opens in Advanced</small>}<span>{item.description}</span></span><ArrowRight size={16} aria-hidden="true" /></button>)}{!matches.length && <p className="settings-no-results">Try a word such as “voice”, “fallback”, “memory” or “updates”.</p>}</div> : <div className="settings-category-heading"><h2>{currentGroup.label}</h2><p>{currentGroup.description}</p><nav className="settings-section-links" aria-label="Settings sections">{groupSections.map(item => <button type="button" key={item.id} aria-current={chosen.id === item.id ? 'location' : undefined} onClick={() => select(item.id)}>{item.label}</button>)}</nav>{currentGroup.id === 'integrations' && <div className="settings-related-pages"><button type="button" className="text-button" onClick={() => onNavigate('connections')}>AI connections<ArrowRight size={13} /></button><button type="button" className="text-button" onClick={() => onNavigate('tools')}>Browser, computer &amp; file tools<ArrowRight size={13} /></button></div>}</div>}
        {Children.toArray(children).map(child => { const item = shown.find(item => item.id === child.props.section); return <div key={child.props.section} className="settings-panel" hidden={!!terms.length || !item || item.group !== chosen.group}>{child}</div>; })}
      </div>
    </div>
  </div>;
}
