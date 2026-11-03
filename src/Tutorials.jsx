import React, { useState, useEffect } from 'react';
import { ArrowRight, ArrowLeft, Check, X, CircleHelp } from 'lucide-react';
import './tutorials.css';

import {TUTORIALS} from './tutorial-catalog.mjs';
export {TUTORIALS};
export const TIPS = [
  { text:'Keep one long chat per project. Quick questions can go in a fresh chat.', tutorial:'good-habits', step:0 },
  { text:'Settled something? Say “remember this”. Shared-memory settings control which chats can use the note.', tutorial:'good-habits', step:1 },
  { text:'Starting a chat that builds on older work? Mention it in a few words.', tutorial:'good-habits', step:2 },
  { text:'Switching AI keeps the chat’s context. Pick the one that suits the task.', tutorial:'good-habits', step:3 },
  { text:'When an exact detail matters, ask the AI to check the original.', tutorial:'good-habits', step:4 },
  { text:'Dictation prepares a draft. Review the words before sending.', tutorial:'voice', step:0 },
  { text:'Tools lets you turn capabilities off without restarting the app.', tutorial:'features-tools', step:0 }
];
const TIPS_KEY='exomina.tips.hidden';
export function tipsHidden() { try { return localStorage.getItem(TIPS_KEY)==='true'; } catch { return false; } }
export function setTipsHidden(hidden) { try { localStorage.setItem(TIPS_KEY,String(hidden)); } catch {} }
/** One tip per local day, so returning users see something new without being nagged. */
export function tipOfTheDay(date = new Date()) { return Math.floor((date.getTime()-date.getTimezoneOffset()*60000)/86400000)%TIPS.length; }

export default function Tutorials({ completed = {}, onStart }) {
  const [showTips,setShowTips] = useState(()=>!tipsHidden()),[query,setQuery]=useState('');
  const shown=TUTORIALS.filter(t=>`${t.title} ${t.description} ${t.steps.map(step=>step.text).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="content-page tutorials-page"><div className="page-heading"><div><div className="eyebrow">LEARN AT YOUR PACE</div><h1>Learn Exomina</h1><p>Start with your first conversation. Explore the other guides when you need them.</p></div><label className="tutorial-tips-toggle"><input type="checkbox" checked={showTips} onChange={event=>{setShowTips(event.target.checked);setTipsHidden(!event.target.checked);}}/>Show a tip on the start screen</label></div><label className="tutorial-search">Find a guide<input type="search" placeholder="Try files, voice, memory or tools" value={query} onChange={event=>setQuery(event.target.value)}/></label><div className="tutorial-grid">{shown.map(t=><button className="tutorial-card" key={t.id} onClick={()=>onStart(t.id)}><CircleHelp size={22}/><strong>{t.title}</strong>{t.id==='first-chat'&&!completed[t.id]&&<em className="tutorial-badge">Start here</em>}<span>{t.description}</span><small>{t.steps.length} steps · {completed[t.id]?'Completed · Replay':'Start tutorial'}<ArrowRight size={14}/></small></button>)}</div></div>;
}
export function TutorialGuide({ tutorial, step, onStep, onClose, onComplete, onNavigate, onExample }) {
  const [highlight,setHighlight] = useState(0),[targetMessage,setTargetMessage]=useState('');
  const current = tutorial.steps[step];
  useEffect(()=>{
    setTargetMessage('');if (!highlight) return;
    const timer=setTimeout(()=>{const candidates=[...document.querySelectorAll(current.target)];for(const candidate of candidates)for(let parent=candidate.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;const el=candidates.find(item=>item.getClientRects().length&&getComputedStyle(item).visibility!=='hidden');if(el){el.classList.add('tutorial-highlight');el.scrollIntoView({block:'nearest',behavior:'smooth'});}else setTargetMessage('This control is unavailable in the current view or device. Continue the guide or return to this step later.');},220);
    return ()=>{clearTimeout(timer); document.querySelectorAll('.tutorial-highlight').forEach(el=>el.classList.remove('tutorial-highlight'));};
  },[highlight,current]);
  return <aside className="tutorial-guide" aria-label="Tutorial walkthrough"><div aria-live="polite" aria-atomic="true"><small>{tutorial.title} · Step {step+1} of {tutorial.steps.length}</small><h2 id="tutorial-step-title">{current.title}</h2><p>{current.text}</p>{targetMessage&&<p className="tutorial-target-message" role="status">{targetMessage}</p>}</div><div className="tutorial-guide-actions"><button className="secondary-button" onClick={()=>{onNavigate(current); setHighlight(value=>value+1);}}>Show me<ArrowRight size={13}/></button>{current.example&&<button className="secondary-button" onClick={()=>onExample(current.example)}>Put example in message box</button>}<button className="icon-button" disabled={step===0} aria-label="Previous tutorial step" onClick={()=>{setHighlight(false);onStep(step-1);}}><ArrowLeft size={16}/></button>{step<tutorial.steps.length-1?<button className="primary-button" onClick={()=>{setHighlight(false);onStep(step+1);}}>Next<ArrowRight size={14}/></button>:<button className="primary-button" onClick={onComplete}>Finish<Check size={14}/></button>}<button className="icon-button" aria-label="Close tutorial" onClick={onClose}><X size={17}/></button></div></aside>;
}
