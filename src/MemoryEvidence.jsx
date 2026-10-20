import React,{useState} from 'react';
import {api} from './transport.js';
export default function MemoryEvidence({onOpenChat}){
 const[query,setQuery]=useState(''),[value,setValue]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function load(){setBusy(true);setError('');try{setValue(await api.invoke('memory.quality',{query}));}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function record(args){setBusy(true);setError('');try{await api.invoke('memory.evidence',args);setValue(await api.invoke('memory.quality',{query}));}catch(e){setError(e.message);}finally{setBusy(false);}}
 const sources=note=><div>{note.sourceChatIds?.map((id,index)=><button key={id} type="button" className="text-button" onClick={()=>onOpenChat?.(id)}>Open source chat {index+1}</button>)}</div>;
 return <details className="memory-evidence"><summary>Review memory changes and possible contradictions</summary>
  <p>Review related notes before treating old information as current. Confirmation records your review of the note.</p>
  <form onSubmit={e=>{e.preventDefault();load();}}><input aria-label="Memory review topic" value={query} onChange={e=>setQuery(e.target.value)} placeholder="A name, project, setting or topic"/><button className="secondary-button" disabled={busy}>Find related notes</button></form>
  {value&&<><p>{value.scanned} notes checked, up to 300 per search. {value.notice}</p>
   {value.conflicts.map(pair=><article key={pair.id}><strong>{pair.reason}</strong><p>{pair.a.text}</p>{sources(pair.a)}<p>{pair.b.text}</p>{sources(pair.b)}<small>{pair.notice}</small>
    <div className="modal-actions"><button disabled={busy} onClick={()=>record({id:pair.a.id,otherId:pair.b.id,action:'superseded'})}>Second note replaces first</button><button disabled={busy} onClick={()=>record({id:pair.b.id,otherId:pair.a.id,action:'superseded'})}>First note replaces second</button><button disabled={busy} onClick={()=>record({id:pair.a.id,otherId:pair.b.id,action:'coexist'})}>Both can apply</button></div>
   </article>)}
   {!value.conflicts.length&&<p>No potential contradictions found in this bounded search.</p>}
   {value.notes.slice(0,30).map(note=><article key={note.id}><p>{note.text}</p><small>Saved {note.date||'date unknown'} · {note.evidence?.confirmedAt?'Confirmed '+new Date(note.evidence.confirmedAt).toLocaleString():'Not explicitly confirmed'}</small>{sources(note)}
    {note.evidence?.supersededBy&&<p>Updated by: {note.evidence.supersededBy.text} <button disabled={busy} onClick={()=>record({id:note.id,otherId:note.evidence.supersededBy.id,action:'clear'})}>Undo correction link</button></p>}
    <button disabled={busy} onClick={()=>record({id:note.id,action:'confirm'})}>Confirm this note</button>
   </article>)}
  </>}{error&&<p className="inline-error" role="alert">{error}</p>}
 </details>;
}
