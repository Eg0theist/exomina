import React,{useState} from 'react';
import {api} from './transport.js';
import './memory-knowledge.css';

export default function MemoryKnowledge({invoke=api.invoke}){
  const [value,setValue]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState(''),[asOf,setAsOf]=useState('');
  const [selected,setSelected]=useState(''),[name,setName]=useState(''),[type,setType]=useState('project'),[aliases,setAliases]=useState('');
  const [noteId,setNoteId]=useState(''),[predicate,setPredicate]=useState('status'),[validFrom,setValidFrom]=useState(''),[validTo,setValidTo]=useState(''),[dependentId,setDependentId]=useState('');
  async function operation(input){setBusy(true);setError('');try{const result=await invoke('memory.knowledge',input);if(input.action==='inspect')setValue(result);else setValue(await invoke('memory.knowledge',{action:'inspect',query,asOf:asOf||undefined,...((input.noteId||noteId)?{noteId:input.noteId||noteId}:{})}));return result;}catch(e){setError(e.message);}finally{setBusy(false);}}
  function choose(id){setSelected(id);const entity=value?.entities.find(item=>item.id===id);setName(entity?.name||'');setType(entity?.type||'project');setAliases(entity?.aliases.join(', ')||'');}
  return <details className="memory-evidence memory-knowledge"><summary>Entities, aliases and dated facts</summary>
    <p>Link shared notes to a person, project or system. Explicit aliases improve recall across renamed projects. Dates describe when a fact applies; they do not verify its truth.</p>
    <form onSubmit={e=>{e.preventDefault();operation({action:'inspect',query,asOf:asOf||undefined});}}>
      <label>Find an entity<input aria-label="Entity search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Name or alias"/></label>
      <label>As of<input aria-label="Entity facts as of" type="date" value={asOf} onChange={e=>setAsOf(e.target.value)}/></label>
      <button disabled={busy}>Inspect index</button>
    </form>
    {value&&<>
      <p>{value.notice}</p>{value.ambiguous&&<p role="status">Several entities share this name. Their notes remain separate.</p>}
      {value.nextOffset!==null&&<button type="button" disabled={busy} onClick={()=>operation({action:'inspect',query,asOf:asOf||undefined,offset:value.nextOffset})}>Next index page</button>}
      <form onSubmit={async e=>{e.preventDefault();const result=await operation({action:'define',...(selected?{id:selected}:{}),type,name,aliases:aliases.split(',').map(item=>item.trim()).filter(Boolean)});if(result?.id)setSelected(result.id);}}>
        <label>Entity<select aria-label="Memory entity" value={selected} onChange={e=>choose(e.target.value)}><option value="">New entity</option>{value.entities.map(entity=><option key={entity.id} value={entity.id}>{entity.name} ({entity.type})</option>)}</select></label>
        <label>Name<input aria-label="Entity name" value={name} onChange={e=>setName(e.target.value)} required maxLength={120}/></label>
        <label>Type<select aria-label="Entity type" value={type} onChange={e=>setType(e.target.value)}>{value.types.map(item=><option key={item}>{item}</option>)}</select></label>
        <label>Aliases, separated by commas<input aria-label="Entity aliases" value={aliases} onChange={e=>setAliases(e.target.value)}/></label>
        <button disabled={busy}>{selected?'Save entity changes':'Create entity'}</button>{selected&&<button type="button" disabled={busy} onClick={async()=>{if(await operation({action:'forget',id:selected}))choose('');}}>Remove entity annotations</button>}
      </form>
      {selected&&<form onSubmit={e=>{e.preventDefault();operation({action:'link',noteId,entityId:selected,predicate,validFrom:validFrom||undefined,validTo:validTo||undefined});}}>
        <p>Choose a note below to annotate it, or paste its ID from memory recall.</p>
        <label>Shared note ID<input aria-label="Fact source note ID" value={noteId} onChange={e=>setNoteId(e.target.value)} required/></label>
        <label>Fact label<input aria-label="Fact label" value={predicate} onChange={e=>setPredicate(e.target.value)} required maxLength={80}/></label>
        <label>Valid from<input aria-label="Fact valid from" type="date" value={validFrom} onChange={e=>setValidFrom(e.target.value)}/></label>
        <label>Valid until (exclusive)<input aria-label="Fact valid until" type="date" value={validTo} onChange={e=>setValidTo(e.target.value)}/></label>
        <button disabled={busy}>Link shared note</button>
      </form>}
      {value.notes.map(note=><article key={note.id}><p>{note.text}</p><small>Note ID: {note.id}</small><button type="button" disabled={busy} onClick={()=>{setNoteId(note.id);operation({action:'inspect',noteId:note.id,query,asOf:asOf||undefined});}}>Inspect this note</button>
        {note.knowledge.map((fact,index)=><p key={index}>{fact.entity.name} · {fact.predicate} · {fact.validFrom?.slice(0,10)||'no start'} to {fact.validTo?.slice(0,10)||'no end'} · {fact.stale?'source changed, review needed':fact.applicable?'applies at selected date':'outside validity'}</p>)}
      </article>)}
      {value.note&&<article><p>{value.note.text}</p>{value.facts.map((fact,index)=><div key={index}><p>{fact.entity.name} · {fact.predicate} · {fact.stale?'Source changed; review this link':fact.applicable?'Applies at selected date':'Outside validity'}</p><button disabled={busy} onClick={()=>operation({action:'unlink',noteId:value.note.id,entityId:fact.entity.id,predicate:fact.predicate})}>Remove fact link</button></div>)}
        <p>{value.dependents.length} dependent notes need review if this source changes.</p>{value.dependents.map(note=><p key={note.id}>{note.text}</p>)}
        <form onSubmit={e=>{e.preventDefault();operation({action:'depends',sourceId:value.note.id,dependentId});}}><label>Dependent note ID<input aria-label="Dependent note ID" required value={dependentId} onChange={e=>setDependentId(e.target.value)}/></label><button disabled={busy}>Record dependency</button><button type="button" disabled={busy||!dependentId} onClick={()=>operation({action:'depends',sourceId:value.note.id,dependentId,remove:true})}>Remove dependency</button></form>
      </article>}
    </>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </details>;
}
