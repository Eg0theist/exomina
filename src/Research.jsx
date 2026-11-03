import React,{useCallback,useEffect,useState} from 'react';
import {Microscope,Square,ArrowRight} from 'lucide-react';
import {api} from './transport.js';
import {RESEARCH_BUDGETS,RESEARCH_APPROACHES} from '../desktop/research-guide.mjs';
import './research.css';

export default function Research({connections=[],providers=[],onOpenChat}) {
  const [view,setView]=useState(null),[topic,setTopic]=useState(''),[provider,setProvider]=useState(''),[budget,setBudget]=useState('standard'),[approach,setApproach]=useState('source_review'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const load=useCallback(()=>api.invoke('research.view').then(setView).catch(e=>setError(e.message)),[]);
  useEffect(()=>{load();return api.onEvent(event=>{if(event.type==='research.changed')load();});},[load]);
  const choices=connections.filter(item=>item.connected&&['codex','claude'].includes(item.id)),selected=provider||choices[0]?.id||'',running=view?.busy||view?.runs?.some(run=>run.status==='running');
  async function action(fn){setBusy(true);setError('');try{setView(await fn());}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <details className="research-workspace"><summary><Microscope size={18}/><strong>Research</strong><span>A sourced report on one question</span></summary><section aria-label="Research workspace">
    <form onSubmit={event=>{event.preventDefault();action(()=>api.invoke('research.start',{topic,provider:selected,budget,approach}));}}>
      <label>Research question<textarea aria-label="Research question" required maxLength={2000} rows={3} value={topic} disabled={busy||!!running} onChange={event=>setTopic(event.target.value)} placeholder="What question should the evidence help answer?"/></label>
      <label className="research-approach">Approach<select aria-label="Research approach" aria-describedby="research-approach-description" value={approach} disabled={busy||!!running} onChange={event=>setApproach(event.target.value)}>{Object.entries(RESEARCH_APPROACHES).map(([id,value])=><option value={id} key={id}>{value.label}</option>)}</select><span id="research-approach-description" className="connection-small">{RESEARCH_APPROACHES[approach].description}</span></label>
      <div className="research-fields"><label>Research with<select aria-label="Research AI" value={selected} disabled={busy||!!running} onChange={event=>setProvider(event.target.value)}><option value="">Choose a connected AI</option>{choices.map(item=><option key={item.id} value={item.id}>{providers.find(p=>p.id===item.id)?.name||item.id}</option>)}</select></label><label>Budget<select aria-label="Research budget" value={budget} disabled={busy||!!running} onChange={event=>setBudget(event.target.value)}>{Object.entries(RESEARCH_BUDGETS).map(([id,value])=><option value={id} key={id}>{value.minutes} minutes · {value.calls} browser calls</option>)}</select></label></div>
      <div className="research-consent"><p>Start allows public page reads in your selected browser and uses your subscription allowance.</p><details><summary>Scope and limits</summary><p>Explicit deny rules still apply. Private memories and files are excluded. Results stay in a saved chat, with no publishing, scheduling or automatic retry. A run may be inconclusive; it cannot run experiments or certify a discovery.</p></details></div>
      {!view?.browserEnabled&&<p role="status">Enable browser tools in Tools to start research.</p>}
      {error&&<p className="inline-error" role="alert">{error}</p>}
      <button className="primary-button" disabled={busy||!!running||!view?.browserEnabled||!selected||!topic.trim()}>Start research<ArrowRight size={14}/></button>
    </form>
    <div className="research-history" aria-label="Research runs">{view?.runs?.map(run=><article key={run.id}><div><strong>{run.topic}</strong><small>{run.status} · {RESEARCH_APPROACHES[run.approach]?.label||RESEARCH_APPROACHES.source_review.label} · {run.minutes} min · {new Date(run.startedAt).toLocaleString()}</small>{run.error&&<p>{run.error}</p>}</div>{run.status==='running'&&<button className="secondary-button" disabled={busy} onClick={()=>action(()=>api.invoke('research.stop',{id:run.id}))}><Square size={13}/>Stop</button>}{run.conversationId&&<button className="text-button" onClick={()=>onOpenChat(run.conversationId)}>Open report</button>}</article>)}</div>
  </section></details>;
}
