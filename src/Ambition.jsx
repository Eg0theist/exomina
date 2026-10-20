import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, MessagesSquare, Microscope, Mountain, Users, X, Zap } from 'lucide-react';
import { LIFTS, FURTHER, IDEAS, IDEA_AREAS, splitAmbition, toggleLift } from '../desktop/ambition.mjs';
import './ambition.css';

const ICONS = { faster: Zap, bigger: Mountain, deeper: Microscope, wider: Users, check: MessagesSquare, next: Mountain };
const liftLabel = id => LIFTS.find(lift => lift.id === id)?.label || '';

/** Standard home: what most people ask, next to what they could ask. Using one only fills the message box. */
export function AmbitionIdeas({ onUse }) {
  const [area, setArea] = useState('life');
  return <section className="ambition-ideas" aria-labelledby="ambition-ideas-title">
    <div className="ambition-ideas-head"><h2 id="ambition-ideas-title">Ask for the finished result</h2>
      <div className="ambition-areas" role="group" aria-label="Idea topics">{IDEA_AREAS.map(([id, label]) => <button type="button" key={id} aria-pressed={area === id} className={area === id ? 'selected' : ''} onClick={() => setArea(id)}>{label}</button>)}</div></div>
    <div className="ambition-cards">{IDEAS.filter(idea => idea.area === area).map(idea => {
      const Icon = ICONS[idea.lift];
      return <button type="button" key={idea.headline} className="ambition-card" title={idea.prompt} onClick={() => onUse(idea.prompt)}>
        <span className="ambition-before"><small>Most people ask</small>“{idea.before}”</span>
        <span className="ambition-after"><small>Try asking for</small><strong>{idea.headline}</strong></span>
        <span className="ambition-card-foot"><span className="ambition-tag"><Icon size={12}/>{liftLabel(idea.lift)}</span><span className="ambition-use">Use this<ArrowRight size={13}/></span></span>
      </button>;
    })}</div>
  </section>;
}

/** Optional message guidance stays tucked away; selected lifts remain visible and removable. */
export function AmbitionBar({ draft, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const optionsId = useId(), trigger = useRef(null);
  useEffect(() => { if (!draft.trim()) setOpen(false); }, [draft]);
  if (!draft.trim()) return null;
  const { ids } = splitAmbition(draft);
  return <div className="ambition-bar" role="group" aria-label="Aim higher" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <div className="ambition-bar-summary">
      <button ref={trigger} type="button" className="ambition-trigger" aria-label="Aim higher" aria-expanded={open} aria-controls={optionsId} disabled={disabled} title="Add optional instructions to this message" onClick={() => setOpen(value => !value)}>Aim higher{ids.length > 0 && <span className="ambition-count" aria-hidden="true">{ids.length}</span>}<ChevronDown size={12} aria-hidden="true"/></button>
      {!open && LIFTS.filter(lift => ids.includes(lift.id)).map(lift => { const Icon = ICONS[lift.id];
        return <button type="button" key={lift.id} className="selected ambition-selected" aria-label={`Remove ${lift.label}`} disabled={disabled} title={`Remove this instruction: “${lift.text}”`} onClick={() => { onChange(toggleLift(draft, lift.id)); trigger.current?.focus(); }}><Icon size={12} aria-hidden="true"/>{lift.label}<X size={11} aria-hidden="true"/></button>;
      })}
    </div>
    {open && <div id={optionsId} className="ambition-options">
      <p>For this message. Combine options; their instructions appear in your draft.</p>
      <div className="ambition-option-buttons">{LIFTS.map(lift => { const Icon = ICONS[lift.id], on = ids.includes(lift.id);
        return <button type="button" key={lift.id} className={on ? 'selected' : ''} aria-pressed={on} disabled={disabled} title={`${lift.hint}. Adds this to your message: “${lift.text}”`} onClick={() => onChange(toggleLift(draft, lift.id))}><Icon size={12} aria-hidden="true"/>{lift.label}</button>;
      })}</div>
    </div>}
  </div>;
}

/** Under the latest reply: the same ideas, applied to what the AI just produced. */
export function FurtherActions({ onPick }) {
  return <div className="further-actions" role="group" aria-label="Take it further"><span>Take it further</span>
    {FURTHER.map(item => { const Icon = ICONS[item.id]; return <button type="button" key={item.id} title={item.text} onClick={() => onPick(item.text)}><Icon size={12}/>{item.label}</button>; })}
  </div>;
}
