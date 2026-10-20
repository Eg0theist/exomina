import React,{useId,useState} from 'react';
import {Check,ChevronRight,FolderTree,LoaderCircle,RefreshCw,Search,Square,Undo2,X} from 'lucide-react';
import './notebook-board.css';

export function notebookNoteGroups(notes,organization){
 if(organization?.appliedUnavailable)return [];
 const seen=new Set(),groups=[],byId=new Map(notes.map(note=>[note.id,note]));
 for(const group of organization?.applied?.groups||[]){
  const members=[];
  for(const item of group.items){const note=byId.get(item.noteId);if(note&&!seen.has(note.id)){seen.add(note.id);members.push(note);}}
  if(members.length)groups.push({title:group.title,notes:members});
 }
 if(!groups.length)return [];
 const rest=notes.filter(note=>!seen.has(note.id));if(rest.length)groups.push({title:'Other notes',notes:rest});return groups;
}

export function NotebookOverview({plan,notes,onSource}){
 const [query,setQuery]=useState(''),[expanded,setExpanded]=useState([]),[collapsedMatches,setCollapsedMatches]=useState([]),prefix=useId(),byId=new Map(notes.map(note=>[note.id,note]));
 const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),matches=text=>terms.every(term=>String(text||'').toLocaleLowerCase().includes(term));
 const groups=plan.groups.map((group,index)=>({...group,index,items:!terms.length||matches([group.title,group.summary].filter(Boolean).join(' '))?group.items:group.items.filter(item=>matches([item.title,item.summary,item.quote].filter(Boolean).join(' ')))})).filter(group=>group.items.length);
 const items=groups.reduce((total,group)=>total+group.items.length,0),total=plan.groups.reduce((sum,group)=>sum+group.items.length,0);
 return <div className="notebook-overview notebook-board">
  <div className="notebook-counts" role="group" aria-label="Overview contents"><span><strong>{plan.groups.length}</strong> topics</span><span><strong>{total}</strong> items</span><span><strong>{plan.sources.length}</strong> {plan.sources.length===1?'source note':'source notes'}</span></div>
  <details className="notebook-intro"><summary>About this overview</summary><p className="notebook-summary">{plan.overview}</p></details>
  <div className="notebook-board-search"><Search size={15} aria-hidden="true"/><input type="search" aria-label="Search notebook overview" placeholder="Find an idea or topic…" maxLength={200} value={query} onChange={event=>{setQuery(event.target.value);setCollapsedMatches([]);}}/>{query&&<button type="button" aria-label="Clear overview search" onClick={()=>{setQuery('');setCollapsedMatches([]);}}><X size={14}/></button>}</div>
  <div className="notebook-board-results"><p role="status">{terms.length?`${items} matching ${items===1?'item':'items'}`:'Topics'}</p>{terms.length>0&&<button type="button" className="text-button" onClick={()=>{setQuery('');setCollapsedMatches([]);}}>Show all topics</button>}</div>
  {!groups.length&&<p className="scratchpad-hint">No matching ideas. Try another word.</p>}
  <div className="notebook-topic-cards">{groups.map(group=>{const searching=!!terms.length,open=searching?!collapsedMatches.includes(group.index):expanded.includes(group.index),bodyId=prefix+'-'+group.index;return <section key={group.index} className={`notebook-topic notebook-topic-card${open?' is-open':''}`}>
   <h3><button type="button" className="notebook-topic-heading notebook-topic-card-heading" aria-expanded={open} aria-controls={bodyId} onClick={event=>{const card=event.currentTarget.closest('.notebook-topic-card');if(searching)setCollapsedMatches(current=>open?[...current,group.index]:current.filter(index=>index!==group.index));else setExpanded(current=>open?current.filter(index=>index!==group.index):[...current,group.index]);if(!open)requestAnimationFrame(()=>{if(card?.isConnected)card.scrollIntoView({block:'nearest',inline:'nearest'});});}}><span className="notebook-topic-symbol" aria-hidden="true"><FolderTree size={20}/><i>{String(group.index+1).padStart(2,'0')}</i></span><span className="notebook-topic-title">{group.title}</span><span className="notebook-topic-card-footer"><span>{group.items.length} {group.items.length===1?'item':'items'}</span><ChevronRight size={15} className={open?'is-open':''} aria-hidden="true"/></span></button></h3>
   <div id={bodyId} hidden={!open}>{open&&<><p className="notebook-group-summary">{group.summary}</p>{group.items.map(item=><article key={item.id}>
    <strong>{item.title}</strong><p>{item.summary}</p>
    <button type="button" className="text-button" onClick={()=>onSource(item)}>{byId.get(item.noteId)?.title||item.noteTitle} <span aria-hidden="true">↗</span><span className="sr-only">: open original note</span></button>
    <details><summary>Original excerpt</summary><blockquote>{item.quote}</blockquote></details>
   </article>)}</>}</div>
  </section>;})}</div>
 </div>;
}

export default function NotebookOrganization({organization={},notes=[],choices=[],providers=[],defaultProvider='',busy=false,workRunning=false,onAction,onSource}){
 const [selected,setSelected]=useState(''),[instructions,setInstructions]=useState('');
 const proposal=organization.proposalUnavailable?null:organization.proposal,applied=organization.appliedUnavailable?null:organization.applied;
 const provider=selected||organization.refreshProvider||defaultProvider||choices[0]?.id||'',plan=proposal||applied;
 const stale=proposal?organization.proposalStale:organization.appliedStale,blocked=busy||organization.running||organization.committing||organization.stopping||workRunning;
 return <div className="notebook-organizer">
  <div className="notebook-plan-heading notebook-main-heading"><h3><FolderTree size={17}/>{plan?(proposal?'Review proposal':'Your organized notebook'):'Organize notebook'}</h3>{plan&&<span>{plan.sources.length} {plan.sources.length===1?'source note':'source notes'}</span>}</div>
  {organization.running&&<div className="scratchpad-actions"><p className="notebook-progress" role="status"><LoaderCircle size={14} className="spin"/>{organization.progress}</p><button type="button" className="secondary-button" disabled={busy||organization.committing} onClick={()=>onAction('notes.organization.stop')}><Square size={13}/>Stop organizing</button></div>}
  {organization.stopping&&<p className="notebook-progress" role="status"><LoaderCircle size={14} className="spin"/>Stopping the previous AI request…</p>}
  {!organization.running&&organization.refreshMessage&&<p className="notebook-progress" role="status">{organization.refreshPending&&<LoaderCircle size={14} className="spin"/>}{organization.refreshMessage}</p>}
  {organization.error&&<p className="inline-error" role="alert">{organization.error}</p>}
  {(organization.appliedUnavailable||organization.proposalUnavailable)&&<p className="scratchpad-hint">A source note was deleted or made private. The affected overview is hidden. Create a new proposal from currently shared notes.</p>}
  {organization.notice&&<p className="scratchpad-hint" role="status">{organization.notice}</p>}
  {plan&&<>
   {stale&&<p className="notebook-stale" role="status">Your notes changed since this overview. Refresh organization to include the current contents.</p>}
   <p className="scratchpad-hint">Open an original note for the full text and every link.{proposal?' Apply to group the note picker; Undo restores the previous organization.':' Idea cleanup removes the exact implemented or discarded passages from both the overview and source notes. Undo cleanup restores both.'}</p>
   <div className="scratchpad-actions">
    {!proposal&&<button type="button" className="secondary-button" disabled={blocked||!provider||!organization.eligibleCount||!choices.some(item=>item.id===provider)} onClick={()=>onAction('notes.organization.refresh',{provider,...(instructions?{instructions}:{})})}><RefreshCw size={14}/>Refresh overview</button>}
    {proposal&&<><button type="button" className="primary-button" disabled={blocked||stale} onClick={()=>onAction('notes.organization.apply',{id:plan.id})}><Check size={14}/>Apply organization</button><button type="button" className="secondary-button" disabled={blocked} onClick={()=>onAction('notes.organization.discard',{id:plan.id})}>Discard proposal</button></>}
    {organization.canUndo&&<button type="button" className="secondary-button" disabled={blocked} onClick={()=>onAction('notes.organization.undo')}><Undo2 size={13}/>{organization.undoKind==='cleanup'?'Undo cleanup':'Undo organization'}</button>}
   </div>
   <NotebookOverview key={plan.id} plan={plan} notes={notes} onSource={onSource}/>
  </>}
  <details className="scratchpad-work-settings notebook-setup" open={!plan}>
  <summary>{plan?'Sources, AI & refresh':'AI & grouping preference'}</summary>
  <p className="scratchpad-hint">Group shared notes by topic and make a readable overview of scattered ideas. Apply the proposal to organize the note picker. Your original writing and links stay intact.</p>
  <label className="scratchpad-check"><input type="checkbox" aria-label="Keep overview up to date" disabled={busy||organization.running&&!organization.refreshPending} checked={organization.autoRefresh!==false} onChange={event=>onAction('notes.organization.configure',{autoRefresh:event.target.checked,...(provider?{provider}:{})})}/><span>Keep overview up to date<small>After a short pause in editing, categorize new or changed shared notes. No daily cap. Unchanged notes use no AI; a failed refresh waits for an edit or manual retry. Undo restores the previous overview.</small></span></label>
  <p className={`notebook-scope${plan?' notebook-scope-compact':''}`}><strong>{organization.eligibleCount||0} of {organization.totalCount||0} notes shared with AI</strong>{organization.eligibleCount<organization.totalCount&&<span>Private and empty notes are excluded.{!plan&&' Open a note and enable “Allow AI to read this note” to include it.'}</span>}</p>
  <label className="scratchpad-label">AI<select aria-label="Notebook organization AI" disabled={blocked} value={provider} onChange={event=>setSelected(event.target.value)}><option value="">Choose a connected subscription</option>{provider&&!choices.some(item=>item.id===provider)&&<option value={provider}>{provider} · disconnected</option>}{choices.map(item=><option key={item.id} value={item.id}>{providers.find(option=>option.id===item.id)?.name||item.id}</option>)}</select></label>
  <label className="scratchpad-label">Organization preference <span>(optional)</span><textarea aria-label="Notebook organization preference" rows={2} maxLength={2000} disabled={blocked} value={instructions} placeholder="For example: separate projects, questions and loose ideas…" onChange={event=>setInstructions(event.target.value)}/></label>
  <p className="scratchpad-hint">Processes {(organization.characters||0).toLocaleString()} shared characters in {organization.requestCount||0} AI {organization.requestCount===1?'request':'requests'}, using your subscription allowance. Longer notebooks are read in parts; blank sections are skipped. This creates an overview and groups; it does not start tasks.</p>
  <div className="scratchpad-actions">
   <button type="button" className={plan?'secondary-button':'primary-button'} disabled={blocked||!provider||!organization.eligibleCount||!choices.some(item=>item.id===provider)} onClick={()=>onAction('notes.organization.prepare',{provider,instructions})}><FolderTree size={14}/>{proposal?'Regenerate proposal':applied?'Refresh organization':'Create organization proposal'}</button>
  </div>
  </details>
 </div>;
}
