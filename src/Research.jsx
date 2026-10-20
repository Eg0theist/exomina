import React,{useCallback,useEffect,useState} from 'react';
import {Microscope,Square,ArrowRight} from 'lucide-react';
import {api} from './transport.js';
import {RESEARCH_BUDGETS} from '../desktop/research-guide.mjs';
import './research.css';

export default function Research({connections=[],providers=[],onOpenChat}) {
  const [view,setView]=useState(null),[topic,setTopic]=useState(''),[provider,setProvider]=useState(''),[budget,setBudget]=useState('standard'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const load=useCallback(()=>api.invoke('research.view').then(setView).catch(e=>setError(e.message)),[]);
  useEffect(()=>{load();return api.onEvent(event=>{if(event.type==='research.changed')load();});},[load]);
  const choices=connections.filter(item=>item.connected&&['codex','claude'].includes(item.id)),selected=provider||choices[0]?.id||'',running=view?.busy||view?.runs?.some(run=>run.status==='running');
  async function action(fn){setBusy(true);setError('');try{setView(await fn());}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <details className="research-workspace"><summary><Microscope size={18}/><strong>Research workspace</strong><span>One question, a fixed budget, a sourced report</span></summary><section aria-label="Research workspace">
    <p>Explore a public question, check a claim, or scope a scientific problem. Results stay in a saved chat. A run can finish inconclusively; this mode cannot run experiments or certify a discovery.</p>
    <form onSubmit={event=>{event.preventDefault();action(()=>api.invoke('research.start',{topic,provider:selected,budget}));}}>
      <label>Research question<textarea aria-label="Research question" required maxLength={2000} rows={3} value={topic} disabled={busy||!!running} onChange={event=>setTopic(event.target.value)} placeholder="What question should the evidence help answer?"/></label>
      <div className="research-fields"><label>Research with<select aria-label="Research AI" value={selected} disabled={busy||!!running} onChange={event=>setProvider(event.target.value)}><option value="">Choose a connected AI</option>{choices.map(item=><option key={item.id} value={item.id}>{providers.find(p=>p.id===item.id)?.name||item.id}</option>)}</select></label><label>Budget<select aria-label="Research budget" value={budget} disabled={busy||!!running} onChange={event=>setBudget(event.target.value)}>{Object.entries(RESEARCH_BUDGETS).map(([id,value])=><option value={id} key={id}>{value.minutes} minutes · {value.calls} browser calls</option>)}</select></label></div>
      <p className="connection-small">Start permits public page reads in your selected shared browser for this run. Explicit deny rules still apply. Uses your subscription allowance. Private memories and files are excluded. No publishing, schedule or automatic retry.</p>
      {!view?.browserEnabled&&<p role="status">Enable browser tools in Tools to start research.</p>}
      {error&&<p className="inline-error" role="alert">{error}</p>}
      <button className="primary-button" disabled={busy||!!running||!view?.browserEnabled||!selected||!topic.trim()}>Start research<ArrowRight size={14}/></button>
    </form>
    <div className="research-history" aria-label="Research runs">{view?.runs?.map(run=><article key={run.id}><div><strong>{run.topic}</strong><small>{run.status} · {run.minutes} min · {new Date(run.startedAt).toLocaleString()}</small>{run.error&&<p>{run.error}</p>}</div>{run.status==='running'&&<button className="secondary-button" disabled={busy} onClick={()=>action(()=>api.invoke('research.stop',{id:run.id}))}><Square size={13}/>Stop</button>}{run.conversationId&&<button className="text-button" onClick={()=>onOpenChat(run.conversationId)}>Open report</button>}</article>)}</div>
  </section></details>;
}
