import React, { useState } from 'react';
import { ArrowRight, Brain, FileCode2, Globe2, Lightbulb, PenLine, Plus, Sparkles, X } from 'lucide-react';
import { ProviderMark, providerReady, providerModeLabel } from './ProviderConnections.jsx';
import { TIPS, tipOfTheDay, tipsHidden, setTipsHidden } from './Tutorials.jsx';
import './welcome.css';
import GettingStarted from './GettingStarted.jsx';

const SUGGESTIONS = [
  { icon: FileCode2, title: 'Explore a project', text: 'Understand a folder and explain what it does.', prompt: 'Help me explore this project. Start by understanding its structure and explain what it does.' },
  { icon: Sparkles, title: 'Plan a task', text: 'Turn a goal into clear next steps.', prompt: 'Help me plan a task. Ask what I want to achieve, then suggest the next steps.' },
  { icon: Globe2, title: 'Research the web', text: 'Read sources in the shared browser and summarise.', prompt: 'Research this for me in the browser and summarise what you find, with sources: ' },
  { icon: PenLine, title: 'Write or edit', text: 'Draft, tighten or restyle a text.', prompt: 'Help me write or edit a text. Ask what it is for and who will read it, then propose a draft.' },
];

function greeting(date = new Date()) {
  const hour = date.getHours();
  return hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}
function ago(value) {
  const ms = Date.now() - Date.parse(value || '');
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days < 7 ? `${days} days ago` : new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A short habit worth knowing, linked to the tutorial step that explains it. */
function WelcomeTip({ onShow }) {
  const [hidden, setHidden] = useState(tipsHidden);
  const [index, setIndex] = useState(tipOfTheDay);
  if (hidden || !onShow) return null;
  const tip = TIPS[index];
  return <div className="welcome-tip" role="note" aria-label="Tip"><Lightbulb size={14} /><span>{tip.text}</span>
    <button type="button" className="text-button" onClick={() => onShow(tip.tutorial, tip.step)}>Show me</button>
    <button type="button" className="text-button" onClick={() => setIndex((index + 1) % TIPS.length)}>Next tip</button>
    <button type="button" className="icon-button" aria-label="Hide tips" title="Hide tips (turn them back on in Tutorials)" onClick={() => { setTipsHidden(true); setHidden(true); }}><X size={13} /></button>
  </div>;
}

/** Above the message box: greeting, and a way back to chats that are still replying. */
export function WelcomeHero({ onTutorials, onTip, Logo, conversations, runningIds = [], onOpen, onTask,connections,onConnections,onControls }) {
  const live = conversations.filter(chat => runningIds.includes(chat.id));
  return <div className="welcome home"><div className="welcome-hero"><span className="welcome-mark"><Logo /></span><h1>{greeting()}.</h1><p>What are we working on today?</p>{onTask && <button type="button" className="primary-button welcome-task-button" onClick={onTask}>Bring your own task<ArrowRight size={15}/></button>}{onTutorials&&<button className="text-button" onClick={onTutorials}>New here? Learn Exomina<ArrowRight size={13}/></button>}</div>
    {live.length > 0 && <button type="button" className="welcome-live" onClick={() => onOpen(live[0])}><span className="activity-pulse" />{live.length === 1 ? <>“{live[0].title}” is still replying</> : <>{live.length} chats are replying</>}<ArrowRight size={13} /></button>}
    <GettingStarted connections={connections} conversations={conversations} onConnections={onConnections} onStart={onTask} onControls={onControls}/><WelcomeTip onShow={onTip} />
  </div>;
}

/** Below the message box: who answers, what to start with, where you left off. */
export default function Welcome({ catalog, connections, selected, onPick, onSuggest, onNavigate, conversations, runningIds = [], onOpen, models = {}, onManageModels, standard = false }) {
  const connected = new Map(connections.map(item => [item.id, item]));
  const choices = [...catalog].sort((a, b) => Number(providerReady(connected.get(b.id))) - Number(providerReady(connected.get(a.id)))).slice(0, 6);
  const recent = [...conversations].filter(chat => !chat.archived && !String(chat.id).startsWith('pending-')).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 3);
  const anyReady = choices.some(item => providerReady(connected.get(item.id)));
  return <div className="welcome-blocks">
    <section className="welcome-block" hidden={standard} aria-labelledby="welcome-who"><h2 id="welcome-who">Who should answer?</h2>
      <div className="provider-cards" role="radiogroup" aria-labelledby="welcome-who">{choices.map(item => {
        const ready = providerReady(connected.get(item.id));
        return <button type="button" key={item.id} role="radio" aria-checked={selected === item.id} className={`provider-card ${selected === item.id ? 'selected' : ''} ${ready ? '' : 'offline'}`} onClick={() => ready ? onPick(item.id) : onNavigate('connections')} title={ready ? `Start with ${item.name}` : `Connect ${item.name} first`}>
          <ProviderMark provider={item.id} info={item} />
          <span className="provider-card-text"><strong>{item.name}</strong><small>{ready ? (models[item.id] || providerModeLabel(item.mode)) : 'Not connected'}</small></span>
          {!ready && <Plus size={14} className="provider-card-add" />}
        </button>;
      })}</div>
      {!anyReady && choices.length > 0 && <p className="welcome-hint">Sign in to a subscription under <button type="button" className="text-button" onClick={() => onNavigate('connections')}>Connections</button> to start.</p>}
      {!choices.length && onManageModels && <p className="welcome-hint">Choose which options appear in <button type="button" className="text-button" onClick={onManageModels}>Models &amp; continuity</button>.</p>}
    </section>
    <section className="welcome-block" hidden={standard} aria-labelledby="welcome-start"><h2 id="welcome-start">Start with</h2>
      <div className="suggestion-cards">{SUGGESTIONS.map(({ icon: Icon, title, text, prompt }) => <button type="button" key={title} className="suggestion-card" onClick={() => onSuggest(prompt)}><span className="suggestion-icon"><Icon size={16} strokeWidth={1.8} /></span><span><strong>{title}</strong><small>{text}</small></span></button>)}
        <button type="button" className="suggestion-card" onClick={() => onNavigate('memory')}><span className="suggestion-icon"><Brain size={16} strokeWidth={1.8} /></span><span><strong>Teach it about you</strong><small>Save a memory every AI here can use.</small></span></button></div>
      {!standard && <p className="welcome-hint">Missing a feature? <button type="button" className="text-button" onClick={()=>onSuggest('Help me add an extension to Exomina. Ask which capability I need, then build and review a local tool for it.')}>Ask Exomina to build an extension.</button></p>}
    </section>
    {recent.length > 0 && <section className="welcome-block" aria-labelledby="welcome-recent"><h2 id="welcome-recent">Pick up where you left off</h2>
      <div className="recent-cards">{recent.map(chat => { const info = catalog.find(item => item.id === chat.provider); return <button type="button" key={chat.id} className="recent-card" onClick={() => onOpen(chat)}>
        <ProviderMark provider={chat.provider} info={info} small /><span className="recent-text"><strong>{chat.title || 'Untitled chat'}</strong><small>{runningIds.includes(chat.id) ? 'Replying now' : `${info?.name || 'AI'} · ${ago(chat.updatedAt)}`}</small></span>{runningIds.includes(chat.id) ? <span className="activity-pulse" /> : <ArrowRight size={14} className="recent-go" />}
      </button>; })}</div>
    </section>}
  </div>;
}
