import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowRight,Check,FolderTree,LoaderCircle,Pause,Play,Plus,Search,StickyNote,Trash2,X} from 'lucide-react';
import {api} from './transport.js';
import NotebookOrganization,{notebookNoteGroups} from './NotebookOrganization.jsx';
import './scratchpad.css';

const signature=note=>JSON.stringify([note?.title||'',note?.text||'',!!note?.allowAI]);
const errorText=error=>String(error?.message||error).replace(/^Error invoking remote method '[^']+': Error: /,'');
const defaults={enabled:false,onlyWhenIdle:true,provider:'',projectId:'',permissionMode:'read-only',dailyBudget:8,maxSteps:6,instructions:''};
const labels={queued:'Queued',running:'Working',complete:'Complete',blocked:'Needs attention',paused:'Paused','needs-answer':'Needs your answer','waiting-usage':'Waiting for usage','waiting-budget':'Waiting for daily budget'};

function NoteClarification({job,answer,onChange,disabled,deferResume,stepLimit,onAnswer}){
 return <form className="scratchpad-clarification" onSubmit={event=>{event.preventDefault();if(answer.trim())onAnswer({id:job.id,clarificationId:job.clarification.id,answer});}}>
  <p className="scratchpad-clarification-question">{job.clarification.question}</p>
  <label className="scratchpad-label">Your answer<textarea aria-label={`Your answer for ${job.title}`} rows={3} maxLength={4000} value={answer} disabled={disabled} onChange={event=>onChange(event.target.value)}/></label>
  <p className="scratchpad-hint">Your answer stays with this task and leaves the note as written. Permissions and usage limits still apply.</p>
  {deferResume&&<p className="scratchpad-hint">Other note work is running. Save your answer now, then resume this task when it finishes.</p>}
  {stepLimit&&<p className="scratchpad-hint">This task has used its per-task steps. Save your answer, then allow more steps to continue. The daily limit stays in place.</p>}
  <button type="submit" className="secondary-button" disabled={disabled||!answer.trim()}><Play size={12}/>{deferResume||stepLimit?'Save answer':'Save answer & resume'}</button>
 </form>;
}

export default function Scratchpad({disabled=false,embedded=false,openRequest=false,onOpenHandled,onOpenChange,portalTarget,relocationRef,onInsert,onOpenChat,connections=[],providers=[],projects=[],workspace=''}){
 const [opened,setOpen]=useState(false),[tab,setTab]=useState('notes'),[view,setView]=useState(null),[draft,setDraft]=useState(null),[settings,setSettings]=useState(defaults),[status,setStatus]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[deleting,setDeleting]=useState(false),[answerDrafts,setAnswerDrafts]=useState({});
 const open=!disabled&&(embedded||opened);
 useLayoutEffect(()=>{if(embedded)return;onOpenChange?.(open);return()=>onOpenChange?.(false);},[open,embedded,onOpenChange]);
 const panelRef=useRef(null),triggerRef=useRef(null),portalRoot=useRef(null),relocatingFocus=useRef(null),editor=useRef(null),draftRef=useRef(null),revision=useRef(0),saved=useRef(''),pending=useRef(null),flushRef=useRef(null),hydrated=useRef(false),mounted=useRef(true),selection=useRef([0,0]);
 if(!embedded&&!portalRoot.current){portalRoot.current=document.createElement('div');portalRoot.current.className='notes-portal-root';}
 useLayoutEffect(()=>{if(!relocationRef)return;relocationRef.current=()=>{const focused=document.activeElement;relocatingFocus.current=portalRoot.current?.contains(focused)?focused:null;};return()=>{relocationRef.current=null;};},[relocationRef]);
 useLayoutEffect(()=>{
  const root=portalRoot.current;if(embedded||!root)return;
  if(!open){if(root.contains(document.activeElement))triggerRef.current?.focus({preventScroll:true});root.remove();return;}
  const target=portalTarget||document.body;if(root.parentElement===target)return;
  const first=!root.isConnected,focused=root.contains(document.activeElement)?document.activeElement:relocatingFocus.current;
  relocatingFocus.current=null;
  const caret=focused&&'selectionStart' in focused?[focused.selectionStart,focused.selectionEnd,focused.selectionDirection]:null;
  const scroll=root.querySelector('.scratchpad-scroll'),scrollTop=scroll?.scrollTop;
  // Keep a single React portal container. Moving it retains the editor and
  // overview components, including their drafts, search and expansion state.
  target.appendChild(root);
  if(focused){focused.focus({preventScroll:true});if(caret)focused.setSelectionRange(...caret);}else if(first)panelRef.current?.focus({preventScroll:true});
  if(scroll)scroll.scrollTop=scrollTop;
 },[open,embedded,portalTarget]);
 useLayoutEffect(()=>()=>portalRoot.current?.remove(),[]);
 const choices=connections.filter(connection=>connection.connected&&providers.some(provider=>provider.id===connection.id&&provider.mode==='subscription'));
 const provider=settings.provider||choices[0]?.id||'';
 const load=useCallback(async()=>{const next=await api.invoke('notes.view');if(mounted.current){setView(next);const current=draftRef.current,fresh=current&&next.notes.find(note=>note.id===current.id);if(current&&!pending.current&&signature(current)===saved.current&&fresh?.revision!==revision.current)adopt(fresh||null);if(!hydrated.current){hydrated.current=true;setSettings({...defaults,...next.settings});}}return next;},[]);
 function adopt(note){draftRef.current=note;revision.current=note?.revision||0;saved.current=signature(note);selection.current=[0,0];setDraft(note);setStatus(note?'Saved':'');setDeleting(false);}
 async function flush(){
  if(pending.current){await pending.current;return flush();}
  const current=draftRef.current;if(!current||signature(current)===saved.current)return current;
  const snapshot={...current,revision:revision.current};if(mounted.current)setStatus('Saving…');
  const operation=api.invoke('notes.save',snapshot).then(note=>{
   if(draftRef.current?.id===note.id){revision.current=note.revision;saved.current=signature(note);if(mounted.current){setStatus(signature(draftRef.current)===saved.current?'Saved':'Unsaved changes');setView(previous=>previous&&({...previous,notes:previous.notes.map(item=>item.id===note.id?note:item)}));}}
   return note;
  }).catch(error=>{if(mounted.current){setStatus('Not saved');setError(errorText(error));}throw error;}).finally(()=>{pending.current=null;});
  pending.current=operation;await operation;return flush();
 }
 flushRef.current=flush;
 useEffect(()=>{mounted.current=true;return()=>{flushRef.current?.().catch(()=>{});mounted.current=false;};},[]);
 useEffect(()=>{if(!open)return;load().then(next=>{if(!draftRef.current&&next.notes?.length)adopt(next.notes[0]);}).catch(error=>setError(errorText(error)));return api.onEvent(event=>{if(event.type==='notes.changed')load().catch(error=>setError(errorText(error)));});},[open,load]);
 useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
 useEffect(()=>{if(openRequest&&!disabled){setOpen(true);setTab('overview');onOpenHandled?.();}},[openRequest,disabled,onOpenHandled]);
 useEffect(()=>{if(!view)return;const pendingIds=new Set(view.jobs?.map(job=>job.clarification?.id).filter(Boolean));setAnswerDrafts(current=>Object.keys(current).every(id=>pendingIds.has(id))?current:Object.fromEntries(Object.entries(current).filter(([id])=>pendingIds.has(id))));},[view?.jobs]);
 useEffect(()=>{if(!draft||signature(draft)===saved.current)return;const timer=setTimeout(()=>flushRef.current?.().catch(()=>{}),450);return()=>clearTimeout(timer);},[draft]);
 function edit(patch){const next={...draftRef.current,...patch};draftRef.current=next;setDraft(next);setStatus('Unsaved changes');setError('');}
 async function action(work){setBusy(true);setError('');try{return await work();}catch(error){setError(errorText(error));}finally{setBusy(false);}}
 const selectedText=()=>{const text=draftRef.current?.text||'',field=editor.current,[start,end]=field?[field.selectionStart,field.selectionEnd]:selection.current;return end>start?text.slice(start,end):text;};
 const close=()=>action(async()=>{await flush();if(panelRef.current?.contains(document.activeElement))triggerRef.current?.focus({preventScroll:true});setOpen(false);});
 const newNote=()=>action(async()=>{await flush();const note=await api.invoke('notes.create');adopt(note);await load();setTab('notes');setTimeout(()=>editor.current?.focus(),0);});
 const chooseNote=id=>action(async()=>{await flush();const next=await load();adopt(next.notes.find(note=>note.id===id)||null);});
 async function workAction(method,payload={}){await flush();const result=await api.invoke(method,payload);await load();return result;}
 const active=view?.activeId||view?.scanning||view?.organization?.running||view?.organization?.stopping;
 const noteGroups=notebookNoteGroups(view?.notes||[],view?.organization);
 const openSource=item=>action(async()=>{await flush();const next=await load();adopt(next.notes.find(note=>note.id===item.noteId)||null);setTab('notes');setTimeout(()=>{const field=editor.current;if(!field)return;const at=field.value.indexOf(item.quote,item.offset);const start=at<0?field.value.indexOf(item.quote):at;field.focus();if(start>=0)field.setSelectionRange(start,start+item.quote.length);},0);});
 const panel=<aside ref={panelRef} tabIndex={-1} className="scratchpad-panel" role={embedded?'region':'dialog'} aria-label="Notes" onKeyDown={event=>{if(event.key==='Escape'&&!embedded){event.stopPropagation();close();}}}>
  <header><div><StickyNote size={18}/><h2>Notes</h2></div><button type="button" className="icon-button" aria-label="Close notes" onClick={close}><X size={18}/></button></header>
  <nav aria-label="Notes sections"><button type="button" aria-pressed={tab==='notes'} onClick={()=>setTab('notes')}>Your notes</button><button type="button" aria-pressed={tab==='overview'} onClick={()=>setTab('overview')}>Overview</button><button type="button" aria-pressed={tab==='work'} onClick={()=>setTab('work')}>Work queue <span>{view?.jobs?.filter(job=>job.status!=='complete').length||0}</span></button></nav>
  <div className="scratchpad-scroll">
  {error&&<p className="inline-error" role="alert">{error}</p>}
  {tab==='notes'?<>
   <p className="scratchpad-hint">A place for ideas before they become messages. Notes save on this device across chats and restarts, separately from shared memory.</p>
   <button type="button" className="text-button notebook-open" onClick={()=>setTab('overview')}><FolderTree size={14}/>{view?.organization?.applied?'Open organized notebook':'Organize notebook…'}</button>
   <div className="scratchpad-picker"><select aria-label="Choose note" value={draft?.id||''} disabled={busy} onChange={event=>chooseNote(event.target.value)}><option value="">Choose a note</option>{noteGroups.length?noteGroups.map((group,index)=><optgroup key={index} label={group.title}>{group.notes.map(note=><option key={note.id} value={note.id}>{note.title}</option>)}</optgroup>):view?.notes?.map(note=><option key={note.id} value={note.id}>{note.title}</option>)}</select><button type="button" className="secondary-button" disabled={busy} onClick={newNote}><Plus size={14}/>New note</button></div>
   {draft?<>
    <label className="scratchpad-label">Title<input aria-label="Note title" disabled={busy} maxLength={100} value={draft.title} onChange={event=>edit({title:event.target.value})}/></label>
    <textarea className="scratchpad-editor" ref={editor} aria-label="Note text" disabled={busy} maxLength={100000} value={draft.text} placeholder="Everything you want to work on, half-formed ideas included…" onChange={event=>edit({text:event.target.value})} onSelect={event=>{selection.current=[event.target.selectionStart,event.target.selectionEnd];}}/>
    <div className="scratchpad-save"><span role="status">{status}</span><span>{draft.text.length.toLocaleString()} / 100,000</span></div>
    <div className="scratchpad-actions"><button type="button" className="primary-button" disabled={busy||!draft.text.trim()} onClick={()=>action(async()=>{const text=selectedText();await flush();onInsert(text);})}><ArrowRight size={14}/>Add to next message</button><button type="button" className="secondary-button" disabled={busy||!draft.text.trim()} onClick={()=>action(async()=>{const text=selectedText();await flush();await api.invoke('notes.enqueue',{id:draft.id,text});await load();setTab('work');})}>Queue as task</button></div>
    <p className="scratchpad-hint">Select a passage to use just that text; otherwise the whole note is used. Adding to a message preserves your draft and never sends it.</p>
    <label className="scratchpad-check"><input type="checkbox" disabled={busy} checked={draft.allowAI} onChange={event=>{const allowed=event.target.checked;edit({allowAI:allowed});if(!allowed)action(flush);}}/><span>Allow AI to read this note<small>Approved notes can be read on request and considered for automatic work when you enable it. Ordinary notes stay private.</small></span></label>
    {draft.lastAnnotations&&<details className="scratchpad-cleanup"><summary>AI annotations ({draft.lastAnnotations.items.length})</summary><p className="scratchpad-hint">Status comments were added beside the original passages. Undo restores the text from before this batch.</p>{draft.lastAnnotations.items.map((item,index)=><div key={index}><strong>{item.status.replaceAll('-',' ')}</strong><p>{item.text}</p></div>)}<button type="button" className="secondary-button" disabled={busy||draft.lastAnnotations.revision!==revision.current||signature(draft)!==saved.current} onClick={()=>action(async()=>{await flush();adopt(await api.invoke('notes.annotations.restore',{id:draft.id,revision:revision.current,annotationId:draft.lastAnnotations.id}));await load();})}>Undo last annotations</button>{(draft.lastAnnotations.revision!==revision.current||signature(draft)!==saved.current)&&<p className="scratchpad-hint">You edited this note after annotation. Remove individual comments to preserve your newer edits.</p>}</details>}
    {draft.lastCleanup&&<details className="scratchpad-cleanup"><summary>Removed completed items ({draft.lastCleanup.items.length})</summary><p className="scratchpad-hint">The last AI cleanup is kept here so you can recover its passages.</p>{draft.lastCleanup.items.map((item,index)=><div key={index}><pre tabIndex={0}>{item.text}</pre><p>{item.evidence}</p></div>)}<button type="button" className="secondary-button" disabled={busy||draft.lastCleanup.revision!==revision.current||signature(draft)!==saved.current} onClick={()=>action(async()=>{await flush();adopt(await api.invoke('notes.cleanup.restore',{id:draft.id,revision:revision.current,cleanupId:draft.lastCleanup.id}));await load();})}>Undo last cleanup</button>{(draft.lastCleanup.revision!==revision.current||signature(draft)!==saved.current)&&<p className="scratchpad-hint">You edited this note after cleanup. Copy a removed passage back to keep your newer edits.</p>}</details>}
    <div className="scratchpad-delete">{deleting?<><p>Delete this note and its queue entries? Work chats will remain.</p><button type="button" className="text-button danger-text-button" disabled={busy} onClick={()=>action(async()=>{await flush();await api.invoke('notes.remove',{id:draft.id});adopt(null);const next=await load();if(next.notes.length)adopt(next.notes[0]);})}>Delete note</button><button type="button" className="text-button" onClick={()=>setDeleting(false)}>Keep note</button></>:<button type="button" className="text-button" onClick={()=>setDeleting(true)}><Trash2 size={12}/>Delete note…</button>}</div>
   </>:<div className="scratchpad-empty"><StickyNote size={26}/><h3>Catch the next idea here</h3><p>Create a note, then send a passage to the message box whenever it is ready.</p></div>}
  </>:tab==='overview'?<NotebookOrganization organization={view?.organization} notes={view?.notes||[]} choices={choices} providers={providers} defaultProvider={provider} busy={busy} workRunning={!!(view?.activeId||view?.scanning)} onAction={(method,payload)=>action(()=>workAction(method,payload))} onSource={openSource}/>:<>
   <p className="scratchpad-hint">Exomina owns the task across replies and model switches. If an idea needs clarification, its question waits here for your answer. Automatic work is off until you enable it.</p>
   <details className="scratchpad-work-settings" open={!view?.settings?.provider}>
    <summary>Work instructions &amp; limits</summary>
    <label className="scratchpad-check"><input aria-label="Run approved notes automatically" type="checkbox" checked={settings.enabled} disabled={!!active} onChange={event=>setSettings({...settings,enabled:event.target.checked})}/><span>Run approved notes automatically</span></label>
    <label className="scratchpad-check"><input type="checkbox" checked={settings.onlyWhenIdle} onChange={event=>setSettings({...settings,onlyWhenIdle:event.target.checked})}/><span>Start work after two minutes away</span></label>
    <label className="scratchpad-label">AI<select aria-label="Note work AI" value={provider} onChange={event=>setSettings({...settings,provider:event.target.value})}><option value="">Choose a connected subscription</option>{settings.provider&&!choices.some(item=>item.id===settings.provider)&&<option value={settings.provider}>{settings.provider} · disconnected</option>}{choices.map(item=><option key={item.id} value={item.id}>{providers.find(provider=>provider.id===item.id)?.name||item.id}</option>)}</select></label>
    <label className="scratchpad-label">Work folder<select aria-label="Note work project" value={settings.projectId} onChange={event=>setSettings({...settings,projectId:event.target.value})}><option value="">Current workspace</option>{projects.filter(project=>project.folder).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label><p className="scratchpad-folder">{settings.projectId?projects.find(project=>project.id===settings.projectId)?.folder:workspace}</p>
    <label className="scratchpad-label">Allowed actions<select aria-label="Note work permissions" value={settings.permissionMode} onChange={event=>setSettings({...settings,permissionMode:event.target.value})}><option value="read-only">Read and prepare drafts</option><option value="auto-edit">Allow file edits in the work folder</option><option value="full">Full access, including commands</option></select></label>
    <p className="scratchpad-hint">These permissions apply while a note task runs. Explicit deny rules and native approval requirements still apply; blocked actions wait for you. Full access uses your Windows account permissions.</p>
    <label className="scratchpad-label">Standing instructions<textarea aria-label="Note work instructions" rows={3} maxLength={8000} value={settings.instructions} placeholder="What to work on, boundaries, and what counts as finished…" onChange={event=>setSettings({...settings,instructions:event.target.value})}/></label>
    <div className="scratchpad-limits"><label>Daily AI steps<input aria-label="Daily note work steps" type="number" min={1} max={50} value={settings.dailyBudget} onChange={event=>setSettings({...settings,dailyBudget:Number(event.target.value)})}/></label><label>Steps per task<input aria-label="Note work step limit" type="number" min={1} max={12} value={settings.maxSteps} onChange={event=>setSettings({...settings,maxSteps:Number(event.target.value)})}/></label></div>
    <button type="button" className="secondary-button" disabled={busy||!!active} onClick={()=>action(async()=>{await workAction('notes.work.settings',{...settings,provider});setSettings({...settings,provider});})}><Check size={14}/>Save work settings</button>
   </details>
   <div className="scratchpad-actions"><button type="button" className="secondary-button" disabled={busy||!!active||!view?.settings?.provider} onClick={()=>action(()=>workAction('notes.work.scan'))}>{view?.scanning?<LoaderCircle size={13} className="spin"/>:<Search size={13}/>}Pick an idea from approved notes</button>{(active||view?.settings?.enabled)&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>action(async()=>{await workAction('notes.work.pause');setSettings(current=>({...current,enabled:false}));})}><Pause size={13}/>Pause work</button>}</div>
   <p className="scratchpad-hint">{view?.usedToday||0}/{view?.settings?.dailyBudget||8} AI steps today. Planning and continuation use subscription allowance. If every allowed model is exhausted, work stays saved and waits. Model order and effort are in Settings → Models &amp; usage.</p>
   {view?.lastScan&&(view.lastScan.error||view.lastScan.message)&&<p className="scratchpad-hint" role="status">{view.lastScan.error||view.lastScan.message}</p>}
   <div className="scratchpad-jobs">{view?.jobs?.length?view.jobs.map(job=>{
    const stepLimit=job.steps>=(view.settings?.maxSteps||6);
    return <article key={job.id}>
     <div className="scratchpad-job-heading"><strong>{job.title}</strong><span>{labels[job.status]||job.status}</span></div>
     <p className="scratchpad-job-goal">{job.goal}</p>{job.reason&&<p className="scratchpad-job-reason">{job.reason}</p>}
     {job.status==='needs-answer'&&job.clarification&&<NoteClarification key={job.clarification.id} job={job} answer={answerDrafts[job.clarification.id]||''} onChange={answer=>setAnswerDrafts(current=>({...current,[job.clarification.id]:answer}))} disabled={busy} deferResume={!!active} stepLimit={stepLimit} onAnswer={payload=>action(()=>workAction('notes.work.answer',payload))}/>}
     {!!job.clarifications?.length&&<details className="scratchpad-answers"><summary>Your answers ({job.clarifications.length})</summary>{job.clarifications.map(item=><div key={item.id}><p>{item.question}</p><p>{item.answer}</p></div>)}</details>}
     {job.checkpoint&&<details><summary>Progress &amp; evidence</summary><p>{job.checkpoint}</p>{job.evidence?.map((item,index)=><p key={index}>{item}</p>)}</details>}
     <div className="scratchpad-actions">
      {!['running','complete','needs-answer'].includes(job.status)&&<button type="button" className="text-button" disabled={busy||!!active} title={stepLimit?'Resume with a fresh per-task step allowance. The daily limit still applies.':undefined} onClick={()=>action(()=>workAction('notes.work.start',{id:job.id}))}><Play size={12}/>{stepLimit?`Allow ${view.settings?.maxSteps||6} more ${view.settings?.maxSteps===1?'step':'steps'}`:job.steps?'Resume task':'Start task'}</button>}
      {job.conversationId&&<button type="button" className="text-button" onClick={()=>onOpenChat(job.conversationId)}>Open work chat</button>}
      <button type="button" className="text-button" disabled={busy||job.status==='running'} onClick={()=>action(()=>workAction('notes.job.remove',{id:job.id}))}>Remove from queue</button>
     </div>
    </article>;
   }):<p className="scratchpad-hint">Queue a passage from a note, or let the AI pick an idea from notes you approved.</p>}</div>
  </>}
  </div>
 </aside>;
 return <>{!embedded&&<button ref={triggerRef} type="button" className={`composer-chip notes-trigger ${open?'on':''}`} aria-label="Notes" aria-expanded={open} disabled={disabled} title="Keep ideas and prepare messages without sending" onClick={()=>setOpen(value=>!value)}><StickyNote size={14}/><span>Notes</span>{active&&<span className="notes-working-dot"/>}</button>}{open&&(embedded?panel:createPortal(panel,portalRoot.current))}</>;
}
