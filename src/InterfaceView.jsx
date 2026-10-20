import React, { createContext, useContext, useState } from 'react';
import { ArrowRight, Brain, Download, FileText, Folder, Globe2, KeyRound, Paperclip, PenLine, ShieldCheck, Sparkles } from 'lucide-react';
import { AmbitionIdeas } from './Ambition.jsx';
import GettingStarted from './GettingStarted.jsx';
import './interface-view.css';

const VIEW_KEY = 'exomina.interfaceView';
export const InterfaceViewContext = createContext('standard');
export const useStandardView = () => useContext(InterfaceViewContext) === 'standard';
export const useDiagnosticsView = () => useContext(InterfaceViewContext) === 'diagnostics';

// Standard names a reasoning level by its outcome; the provider's own effort ids stay underneath.
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const TIERS = [['quick', 'Quick', 'Short answers, fastest', ['low', 'minimal', 'none']], ['balanced', 'Balanced', 'Good for most work', ['medium']], ['thorough', 'Thorough', 'Careful work, takes longer', ['high', 'xhigh']]];
export function effortTiers(efforts = []) {
  const ids = efforts.map(item => item.id);
  return TIERS.map(([id, label, note, prefer]) => ({ id, label, note, effort: prefer.find(value => ids.includes(value)) })).filter(tier => tier.effort);
}
export function effortTierLabel(efforts = [], effort) {
  const tier = effortTiers(efforts).find(item => item.effort === effort);
  if (tier) return tier.label;
  const rank = EFFORT_ORDER.indexOf(effort);
  return rank < 0 ? '' : rank <= 2 ? 'Quick' : rank === 3 ? 'Balanced' : 'Thorough';
}

// This device's presentation preference never changes provider or permission settings.
export function useInterfaceView() {
  const [view, setView] = useState(() => {
    try { const saved=localStorage.getItem(VIEW_KEY);return ['standard','advanced','diagnostics'].includes(saved)?saved:'standard'; }
    catch { return 'standard'; }
  });
  function chooseView(next) {
    if (!['standard', 'advanced', 'diagnostics'].includes(next)) return;
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* Still works for this session. */ }
    setView(next);
  }
  return [view, chooseView];
}

export default function InterfaceView({ view, onChange, compact = false }) {
  return <label className={`interface-view ${compact ? 'compact' : ''}`}>
    <span>{compact ? 'View' : 'Interface view'}</span>
    <select aria-label={compact ? 'Interface view' : 'Settings interface view'} value={view} onChange={event => onChange(event.target.value)} title="Standard focuses on tasks. Advanced shows practical controls. Diagnostics adds searchable recorded events. All use the same access and AI settings.">
      <option value="standard">Standard</option><option value="advanced">Advanced</option><option value="diagnostics">Diagnostics</option>
    </select>
  </label>;
}

const STARTS = [['files', Paperclip, 'A file'], ['website', Globe2, 'A website'], ['text', PenLine, 'A text'], ['folder', Folder, 'A folder']];

/** Standard's home: one question, examples of asking for more, and starting points from what people already have. */
export function StandardHome({ Logo, live = [], onStart, onOpen, onImport, onIdea, importing = false,connections,conversations,onConnections,onControls,onTutorials }) {
  return <div className="standard-home">
    <span className="welcome-mark"><Logo /></span>
    <h1>What do you want to get done?</h1>
    <p>Your AI can do the work, not only explain it. Most people never ask.</p>
    <GettingStarted connections={connections} conversations={conversations} onConnections={onConnections} onStart={()=>onStart()} onControls={onControls}/>
    {onTutorials&&<button type="button" className="text-button" onClick={onTutorials}>New here? Learn Exomina<ArrowRight size={13}/></button>}
    {onIdea && <AmbitionIdeas onUse={onIdea}/>}
    <div className="standard-from" role="group" aria-label="Starting points"><span>Or start from</span>{STARTS.map(([id, Icon, title]) => <button type="button" key={id} onClick={() => onStart(id)}><Icon size={14} strokeWidth={1.8}/>{title}</button>)}</div>
    {onImport && <button type="button" className="text-button standard-import" disabled={importing} onClick={onImport}><Download size={14}/>{importing ? 'Importing your chats…' : 'Bring your chats from ChatGPT, Claude, Gemini, Grok or any other AI'}</button>}
    {live.length > 0 && <button type="button" className="welcome-live" onClick={() => onOpen(live[0])}><span className="activity-pulse" />{live.length === 1 ? <>“{live[0].title}” is still working</> : <>{live.length} chats are still working</>}<ArrowRight size={13} /></button>}
  </div>;
}

export function AdvancedViewHint({ onChange, children }) {
  return <div className="advanced-view-hint"><p>{children}</p><button type="button" className="text-button" onClick={() => onChange('advanced')}>Show Advanced view</button></div>;
}
