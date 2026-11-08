import React, { Children, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, Brain, MessageSquare, Palette, Search, Settings2, Unplug, X, Zap } from 'lucide-react';
import './settings-layout.css';
import { findDestinations } from './navigation-search.js';

const groups = [
  { id: 'general', label: 'Application', icon: Settings2 },
  { id: 'experience', label: 'Look & feel', icon: Palette },
  { id: 'conversation', label: 'Conversation', icon: MessageSquare },
  { id: 'models', label: 'AI & usage', icon: Zap },
  { id: 'privacy', label: 'Privacy & data', icon: Brain },
  { id: 'integrations', label: 'Connections & tools', icon: Unplug },
];
const sections = [
  { id: 'general', group: 'general', label: 'App behavior', description: 'Project folder, quick access, automatic chat titles and tray behavior.', keywords: 'workspace directory terminal shortcut ctrl shift space startup close window name chats' },
  { id: 'updates', group: 'general', label: 'Updates', description: 'Check, download and apply updates; choose the release source.', keywords: 'version release automatic feed install restart', desktop: true },
  { id: 'about', group: 'general', label: 'About Exomina', description: 'Installed version and current theme.', keywords: 'build app information' },
  { id: 'defaults', group: 'models', label: 'Default AI', description: 'Provider and model used for new chats.', keywords: 'chatgpt codex claude gemini antigravity grok muse default ai' },
  { id: 'models', group: 'models', label: 'Models & continuity', description: 'Visible providers and models; automatic usage fallback and handoff order.', keywords: 'connection picker options hide enabled usage limit switch provider automatic fallback billing api subscription' },
  { id: 'usage', group: 'models', label: 'Usage', description: 'Provider limits, reset times, reset credits and safety limits.', keywords: 'quota rate subscription remaining refresh limit credits redeem safety guard pause budget', desktop: true },
  { id: 'local-ai', group: 'models', label: 'Local AI & background tasks', description: 'Hardware tiers, local decisions, demanding-app priority and automatic folder triggers.', keywords: 'decision layer tier 1 2 3 onnx model download cpu gpu render video export gaming pause learning agent always on inbox budget', desktop: true },
  { id: 'personalization', group: 'conversation', label: 'Personalisation', description: 'Character, visual companion, tone, instructions and writing styles.', keywords: 'personalization response language concise formal learn samples documents soul pet mascot avatar companion character' },
  { id: 'spelling', group: 'conversation', label: 'Spelling', description: 'Spellcheck languages and suggestions while typing.', keywords: 'dictionary grammar editor composer language', desktop: true },
  { id: 'marketing', group: 'conversation', label: 'Marketing helper', description: 'Draft posts about Exomina in your style for you to review and publish.', keywords: 'marketing posts social drafts approval queue style release notes promote', desktop: true },
  { id: 'appearance', group: 'experience', label: 'Appearance', description: 'Theme, type size, motion, contrast, artwork and window appearance.', keywords: 'light dark system font scale typography animation accent color glass transparency titlebar' },
  { id: 'sounds', group: 'experience', label: 'Sounds & notifications', description: 'Windows notifications, notification sounds, volume and previews.', keywords: 'notification audio alert tone mute toast popup question approval hidden taskbar tray', desktop: true },
  { id: 'voice', group: 'experience', label: 'Voice', description: 'Realtime voice, dictation, speech voices and playback.', keywords: 'microphone speech speaking read aloud windows sample sound realtime chatgpt', desktop: true },
  { id: 'permissions', group: 'privacy', label: 'Permissions', description: 'Default agent permissions, allow and deny rules and chat overrides.', keywords: 'approval ask safety read only full access command shell file editing tools security', desktop: true },
  { id:'clients',group:'privacy',label:'Client workspaces',description:'Separate client memory and conversations in fresh projects.',keywords:'organization company client isolation access project memory',desktop:true},
  { id: 'memory', group: 'privacy', label: 'Memory & privacy', description: 'Saved notes, chat history, recovery backup and local data.', keywords: 'shared context summaries automatic capture review clear delete privacy encrypted encryption recovery certificate storage folder', },
  { id: 'data', group: 'privacy', label: 'Export & transfer', description: 'Export chats and context, or import saved context from another device.', keywords: 'download backup json markdown archive export import move migrate transfer new device' },
  { id: 'connections', group: 'integrations', label: 'AI connections', description: 'Connect an AI provider or manage an existing connection.', keywords: 'login sign in subscription chatgpt codex claude grok muse provider setup' },
  { id: 'integrations', group: 'integrations', label: 'Tools & sync', description: 'External MCP servers, cloud sync and paired devices.', keywords: 'plugins connector custom server mcp configuration computer browser sync cloud mobile qr pair' },
  { id: 'phone', group: 'integrations', label: 'Phone access', description: 'Pair your phone to this computer through your private relay.', keywords: 'phone mobile qr pair remote desktop relay invitation revoke', desktop: true },
  { id: 'messaging', group: 'integrations', label: 'Messaging', description: 'Remote messaging connections and their provider.', keywords: 'telegram discord whatsapp bot remote phone', desktop: true },
  { id:'skills',group:'integrations',label:'Shared skills',description:'Reusable procedures with lazy references, evidence and version history.',keywords:'skills library procedures learning task refine version references',desktop:true},
  { id:'workers',group:'integrations',label:'Workers',description:'Approved commands in isolated Docker projects or SSH workers.',keywords:'workers docker ssh containers remote isolated commands jobs',desktop:true},
  { id: 'workspace', group: 'integrations', label: 'Private workspace', description: 'Server connection and sign out.', keywords: 'account session login logout sign out server', web: true },
];

export function settingsDestinations(desktop) {
  return sections.filter(item=>(!item.desktop||desktop)&&(!item.web||!desktop)).map(item=>({...item,id:'settings:'+item.id,section:item.id,category:'Settings · '+groups.find(group=>group.id===item.group).label}));
}

export function SettingsPanel({ children }) { return children; }

/** Open panels on first use, then retain their drafts while showing one section. */
export default function SettingsLayout({ section = 'general', selectionRequest = 0, desktop, onSelect, onNavigate, children }) {
  const available = sections.filter(item => (!item.desktop || desktop) && (!item.web || !desktop));
  const chosen = available.find(item => item.id === section) || available[0];
  const currentGroup = groups.find(item => item.id === chosen.group);
  const [query, setQuery] = useState('');
  const [visited, setVisited] = useState(() => new Set([chosen.id]));
  const [resultIndex, setResultIndex] = useState(0);
  const scroller = useRef(null);
  const searchInput = useRef(null);
  const navigation = useRef(null);
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = terms.length ? findDestinations(available.map(item=>({...item,category:groups.find(group=>group.id===item.group).label})),query) : [];
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    setVisited(previous=>previous.has(chosen.id)?previous:new Set([...previous,chosen.id]));
    const active=navigation.current?.querySelector('[aria-current="page"]');
    if(active && navigation.current.clientHeight) {
      const item=active.getBoundingClientRect(),rail=navigation.current.getBoundingClientRect();
      if(item.top<rail.top||item.bottom>rail.bottom)active.scrollIntoView({block:'nearest'});
    }
  }, [chosen.id]);
  useLayoutEffect(() => { setQuery(''); setResultIndex(0); }, [selectionRequest]);
  function select(id) { setQuery(''); if(id==='connections'&&onNavigate){onNavigate('connections');return;} onSelect(id); }
  function searchKey(event) {
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setQuery('');}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();setResultIndex(index=>matches.length?(index+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length:0);
    }
    if(event.key==='Enter'&&matches.length){event.preventDefault();select(matches[Math.min(resultIndex,matches.length-1)].id);}
  }
  return <div className="content-page settings-page settings-organized">
    <div className="settings-header"><h1>Settings</h1>
      <div className="settings-search"><Search size={17} aria-hidden="true" /><input ref={searchInput} type="search" aria-label="Search settings" placeholder="Find a setting…" value={query} onChange={event => {setQuery(event.target.value);setResultIndex(0);}} onKeyDown={searchKey} aria-controls={terms.length?'settings-search-results':undefined} />{query && <button type="button" aria-label="Clear settings search" onClick={() => { setQuery(''); searchInput.current?.focus(); }}><X size={15} /></button>}</div>
    </div>
    <div className="settings-layout">
      <aside className="settings-navigation">
        <label className="settings-mobile-select"><span>Section</span><select aria-label="Settings section" value={chosen.id} onChange={event=>select(event.target.value)}>{groups.map(group=><optgroup key={group.id} label={group.label}>{available.filter(item=>item.group===group.id).map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>)}</select></label>
        <nav className="settings-nav" aria-label="Settings sections" ref={navigation}>{groups.filter(group => available.some(item => item.group === group.id)).map(({ id, label, icon: Icon }) => <div className="settings-nav-group" key={id}><h2><Icon size={14} aria-hidden="true" />{label}</h2>{available.filter(item=>item.group===id).map(item=><button type="button" key={item.id} aria-current={!terms.length&&chosen.id===item.id?'page':undefined} onClick={()=>select(item.id)}><span>{item.label}</span>{chosen.id===item.id&&!terms.length&&<span className="settings-active-dot" aria-hidden="true"/>}</button>)}</div>)}</nav>
      </aside>
      <div className="settings-panel-scroll" ref={scroller}>
        {terms.length ? <div className="settings-search-results" id="settings-search-results" aria-label="Settings search results"><div className="settings-category-heading"><h2>Search results</h2><p role="status">{matches.length} {matches.length === 1 ? 'section' : 'sections'} for “{query.trim()}”</p></div>{matches.map((item,index) => <button className={`settings-search-result ${index===resultIndex?'keyboard-selected':''}`} type="button" key={item.id} onClick={() => select(item.id)}><span><small>{groups.find(group => group.id === item.group).label}</small><strong>{item.label}</strong><span>{item.description}</span></span><ArrowRight size={16} aria-hidden="true" /></button>)}{!matches.length && <div className="settings-no-results"><p>Try “voice”, “sign in”, “text size” or “backup”.</p><button type="button" className="text-button" onClick={()=>{setQuery('');searchInput.current?.focus();}}>Clear search</button></div>}</div> : <div className="settings-section-context"><span>{currentGroup.label}</span>{chosen.id==='integrations'&&onNavigate&&<button type="button" onClick={()=>onNavigate('tools')}>Tool permissions<ArrowRight size={13}/></button>}</div>}
        {Children.toArray(children).map(child => { const id=child.props.section; return (id===chosen.id||visited.has(id))&&<div key={id} className="settings-panel" hidden={!!terms.length || id!==chosen.id}>{child}</div>; })}
      </div>
    </div>
  </div>;
}
