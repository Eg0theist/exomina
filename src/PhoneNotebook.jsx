import React,{useEffect,useRef,useState} from 'react';
import {NotebookOverview} from './NotebookOrganization.jsx';
import './scratchpad.css';

const signature=note=>JSON.stringify([note?.title||'',note?.text||'']);
const oldDesktop=error=>/Unknown method|only available on the computer/i.test(error.message);

export default function PhoneNotebook({remote,active,online,onUse}) {
  const [view,setView]=useState({notes:[],organization:{}}),[section,setSection]=useState('notes');
  const [draft,setDraft]=useState(null),[saved,setSaved]=useState(''),[conflict,setConflict]=useState(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const current=useRef(null),baseline=useRef(''),mounted=useRef(false),loading=useRef(0),legacy=useRef(false),editor=useRef(null),excerpt=useRef(null),activeRef=useRef(active),saving=useRef(false);
  current.current=draft;baseline.current=saved;activeRef.current=active;
  const dirty=!!draft&&signature(draft)!==saved;
  function adopt(note) { current.current=note;baseline.current=signature(note);setDraft(note);setSaved(signature(note));setConflict(null); }
  async function getNote(id) {
    if(!legacy.current)return remote.invoke('notes.get',{id});
    const data=await remote.invoke('notes.view'),note=data.notes?.find(item=>item.id===id);
    if(!note)throw Error('This note was removed on your computer. Your phone draft is unchanged.');
    return note;
  }
  async function reload() {
    const generation=++loading.current;
    let next;
    try { next=await remote.invoke(legacy.current?'notes.view':'notes.phone.view'); }
    catch(failure) {
      if(legacy.current||!oldDesktop(failure))throw failure;
      legacy.current=true;next=await remote.invoke('notes.view');
    }
    if(!mounted.current||generation!==loading.current)return;
    setView(next);
    const local=current.current;if(!local||saving.current)return;
    const metadata=next.notes.find(item=>item.id===local.id);
    if(!metadata) { setConflict({removed:true});return; }
    if(metadata.revision===local.revision)return;
    const latest=await getNote(local.id);
    if(!mounted.current||generation!==loading.current||current.current?.id!==local.id)return;
    if(signature(current.current)===baseline.current||signature(current.current)===signature(latest)) {
      adopt(latest);setError('');setNotice('Up to date with your computer.');
    } else if(signature(latest)===baseline.current) {
      // Sharing and other metadata changes advance the revision too. Preserve
      // the phone text while rebasing onto unchanged computer content.
      const rebased={...current.current,revision:latest.revision};current.current=rebased;setDraft(rebased);setConflict(null);setError('');setNotice('Computer changes synced. Your phone edits are unchanged.');
    } else setConflict(latest);
  }
  useEffect(()=>{
    mounted.current=true;let timer;
    const queue=()=>{if(!activeRef.current||timer)return;timer=setTimeout(()=>{timer=null;reload().catch(failure=>{if(mounted.current)setError(failure.message);});},200);};
    const off=remote.onEvent(event=>{if(event.type==='transport.connected')legacy.current=false;if(/^(notes\.|state\.changed|transport\.connected)/.test(event.type))queue();});
    const visible=()=>{if(document.visibilityState==='visible')queue();};
    document.addEventListener('visibilitychange',visible);
    return()=>{mounted.current=false;loading.current++;clearTimeout(timer);off();document.removeEventListener('visibilitychange',visible);};
  },[remote]);
  useEffect(()=>{if(active&&online)reload().catch(failure=>{if(mounted.current)setError(failure.message);});},[active,online]);
  useEffect(()=>{
    if(!excerpt.current||!editor.current||section!=='notes')return;
    const item=excerpt.current;excerpt.current=null;const field=editor.current;
    const at=field.value.indexOf(item.quote,item.offset),start=at<0?field.value.indexOf(item.quote):at;
    field.focus();if(start>=0)field.setSelectionRange(start,start+item.quote.length);
  },[draft?.id,section,busy]);
  async function action(work) {
    setBusy(true);setError('');setNotice('');
    try { await work(); } catch(failure) { if(mounted.current)setError(failure.message); }
    finally { if(mounted.current)setBusy(false); }
  }
  async function open(id,item) {
    if(dirty&&id!==draft.id){setError('Save or discard your phone edits before opening another note.');return;}
    if(dirty){excerpt.current=item||null;setSection('notes');return;}
    await action(async()=>{const note=await getNote(id);if(!mounted.current)return;
      adopt(note);excerpt.current=item||null;setSection('notes');
    });
  }
  async function save() {
    await action(async()=>{
      saving.current=true;loading.current++;
      try { const note=await remote.invoke('notes.save',{id:draft.id,title:draft.title,text:draft.text,revision:draft.revision});if(mounted.current){adopt(note);setNotice('Saved on your computer.');} }
      finally { saving.current=false; }
    });
    // A write can have succeeded despite a lost reply. Reconcile exact content,
    // but keep any different local draft when the desktop revision moved ahead.
    await reload().catch(()=>{});
  }
  const organization=view.organization||{},plan=organization.appliedUnavailable?null:organization.applied;
  return <section className="phone-card phone-notebook" hidden={!active} aria-label="Phone notebook">
    <h1>Notes</h1>
    <nav className="phone-notebook-tabs" aria-label="Notebook sections"><button type="button" aria-pressed={section==='notes'} onClick={()=>setSection('notes')}>Your notes</button><button type="button" aria-pressed={section==='overview'} onClick={()=>setSection('overview')}>Overview</button><button type="button" disabled={busy||!online} onClick={()=>action(reload)}>Refresh notebook</button></nav>
    {error&&<p className="phone-error" role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {dirty&&<p className="phone-draft-status" role="status">Unsaved phone edits. Keep this page open until you save or copy them.</p>}
    {section==='overview'?<>
      <p>Read the overview and open original notes. Your computer refreshes shared notes automatically when enabled. AI sharing and organization settings stay on your computer.</p>
      {organization.notice&&<p role="status">{organization.notice}</p>}
      {organization.refreshMessage&&<p role="status">{organization.refreshMessage}</p>}
      {organization.appliedStale&&!organization.refreshPending&&<p className="notebook-stale" role="status">Your notes changed since this overview. Refresh organization on your computer.</p>}
      {plan?<NotebookOverview key={plan.id} plan={plan} notes={view.notes} onSource={item=>open(item.noteId,item)}/>:<p>{legacy.current?'Update Exomina on your computer to read its notebook overview here.':organization.appliedUnavailable?'A source note was made private or removed. This overview is hidden.':'Create and apply a notebook overview on your computer to read it here.'}</p>}
    </>:<>
      <div className="phone-note-list">{view.notes.map(item=><button type="button" className="phone-note-link" key={item.id} aria-pressed={draft?.id===item.id} disabled={busy||dirty&&draft?.id!==item.id} onClick={()=>open(item.id)}>{item.title||'Untitled note'}</button>)}</div>
      <button type="button" disabled={busy||dirty||!online} onClick={()=>action(async()=>{const note=await remote.invoke('notes.create');if(!mounted.current)return;adopt(note.note||note);setSection('notes');await reload();})}>New note</button>
      {draft&&<form onSubmit={event=>{event.preventDefault();save();}}>
        <label>Title<input aria-label="Note title" value={draft.title||''} maxLength={100} disabled={busy} onChange={event=>setDraft({...draft,title:event.target.value})}/></label>
        <label>Note<textarea ref={editor} aria-label="Note text" value={draft.text||''} rows={10} maxLength={100000} disabled={busy} onChange={event=>setDraft({...draft,text:event.target.value})}/></label>
        {conflict&&<div className="phone-note-conflict" role="alert"><p>{conflict.removed?'This note was removed on your computer. Your phone draft is still here.':'This note changed on your computer. Your phone draft is still here.'}</p>{!conflict.removed&&<details><summary>Computer version</summary><strong>{conflict.title}</strong><pre>{conflict.text}</pre></details>}<p>Use your draft in chat or copy it before discarding changes.</p></div>}
        <div className="phone-note-actions"><button className="primary-button" disabled={busy||!dirty||!online||!!conflict}>Save note</button>{(dirty||conflict?.removed)&&<button type="button" disabled={busy} onClick={()=>action(async()=>{if(conflict?.removed){adopt(null);return;}adopt(await getNote(draft.id));setNotice('Phone edits discarded. Showing the computer version.');})}>{dirty?'Discard phone edits':'Close removed note'}</button>}<button type="button" disabled={busy||!draft.text?.trim()} onClick={()=>onUse(`Note: ${draft.title||'Untitled note'}\n\n${draft.text}`)}>Use in chat</button></div>
        <p className="phone-note-hint">Use in chat prepares a message for review. It does not send it.{!online?' Your computer must reconnect before saving.':''}</p>
      </form>}
    </>}
  </section>;
}
