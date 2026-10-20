import {randomUUID} from 'node:crypto';

// The overview excerpt anchors a removal; it does not authorize its whole topic.
export function sourceCleanup(pad,conversationId,items,all,removed){
 const byNote=new Map(),anchors=[],shared=new Map(pad.organizer.sources().map(note=>[note.id,note]));
 for(const item of items){
  const source=all.get(item.id),passages=item.passages??[source.quote];
  const note=shared.get(source.noteId);
  if(!note)throw Error('This source note is private or unavailable.');
  if(typeof source.quote!=='string'||!source.quote.trim()||!Number.isSafeInteger(source.offset)||source.offset<0||note.text.slice(source.offset,source.offset+source.quote.length)!==source.quote)throw Error('The original excerpt or its position is invalid. Refresh the overview before cleanup.');
  if(!Array.isArray(passages)||passages.length!==1||passages.some(value=>typeof value!=='string'||!value.trim()))throw Error('Quote one complete contiguous source passage for each removed idea.');
  if(!passages.some(value=>value.includes(source.quote)))throw Error('Source passages must include the removed item’s original excerpt.');
  anchors.push({source,text:passages[0]});
  const group=byNote.get(source.noteId)||[];
  for(const text of passages){const existing=group.find(entry=>entry.text===text);if(existing)existing.evidence+='\n'+item.evidence;else group.push({text,evidence:item.evidence});}
  byNote.set(source.noteId,group);
 }
 return [...byNote].map(([id,entries])=>{
  const note=shared.get(id),change=pad.cleanupPlan(conversationId,{id,revision:note.revision,items:entries});
  for(const {source,text} of anchors.filter(anchor=>anchor.source.noteId===id))if(!change.items.some(passage=>passage.text===text&&passage.start<=source.offset&&passage.end>=source.offset+source.quote.length))throw Error('The source passage must cover the original excerpt at its saved position.');
  for(const source of all.values())if(source.noteId===id&&!removed.has(source.id)){
   const start=source.offset,end=start+source.quote.length;
   if(!Number.isSafeInteger(start)||note.text.slice(start,end)!==source.quote)throw Error('A retained source excerpt changed. Refresh the overview before cleanup.');
   if(change.items.some(item=>item.start<end&&item.end>start))throw Error('A source passage also contains a retained idea. Keep mixed or unfinished passages until the ideas can be separated.');
  }
  return change;
 });
}

export function cleanupUndoAvailable(pad,undo){
 if(!undo)return false;
 if(!Object.hasOwn(undo,'notes')&&undo.version===undefined)return true; // Legacy overview-only cleanup.
 return undo.version===2&&Array.isArray(undo.notes)&&undo.notes.length>0&&undo.notes.every(record=>typeof record.beforeText==='string'&&record.beforeText.length<=100000&&Array.isArray(record.passages)&&pad.data().notes.some(note=>note.id===record.id&&note.allowAI&&note.revision===record.revision))&&pad.organizer.matches(pad.data().organization.applied?.sources||[]);
}

export async function commitCleanup(pad,fresh){
 const beforeNotes=pad.data().notes,beforeOrganization=pad.data().organization,at=pad.now().toISOString();
 let notes,organization;
 if(fresh.undo){
  const undo=fresh.saved.undo;
  if(!cleanupUndoAvailable(pad,undo))throw Error('Source notes changed after cleanup. Undo would overwrite newer edits.');
  const records=new Map((undo.notes||[]).map(record=>[record.id,record]));
  notes=beforeNotes.map(note=>records.has(note.id)?{...note,text:records.get(note.id).beforeText,revision:note.revision+1,updatedAt:at}:note);
  if(notes.reduce((sum,note)=>sum+note.text.length,0)>1000000)throw Error('Make room in the notebook before restoring removed passages.');
  const applied=undo.notes?{...undo.applied,sources:undo.applied.sources.map(source=>({...source,revision:notes.find(note=>note.id===source.id).revision}))}:undo.applied;
  organization={...fresh.saved,applied,undo:null,invalidated:'',notice:undo.notes?'Cleanup undone. Source passages and overview restored.':'Overview cleanup undone.'};
 }else{
  const changes=new Map(fresh.changes.map(change=>[change.note.id,change]));
  notes=beforeNotes.map(note=>changes.has(note.id)?{...note,text:changes.get(note.id).text,revision:note.revision+1,updatedAt:at}:note);
  const groups=fresh.next.groups.map(group=>({...group,items:group.items.map(item=>{
   const change=changes.get(item.noteId);if(!change)return item;
   return {...item,offset:item.offset-change.items.filter(passage=>passage.end<=item.offset).reduce((sum,passage)=>sum+passage.end-passage.start,0)};
  })}));
  const sources=pad.organizer.sources().flatMap(source=>{const note=notes.find(note=>note.id===source.id);return note.text.trim()?[{id:note.id,revision:note.revision}]:[];});
  const applied={...fresh.next,groups,sources,characters:notes.filter(note=>note.allowAI).reduce((sum,note)=>sum+note.text.length,0)};
  const undo={id:randomUUID(),version:2,kind:'cleanup',applied:fresh.current.plan,notes:fresh.changes.map(change=>({id:change.note.id,revision:change.note.revision+1,beforeText:change.note.text,passages:change.items.map(({text,evidence})=>({text,evidence}))}))};
  organization={...fresh.saved,applied,undo,invalidated:'',notice:`Removed ${fresh.items.length} implemented or discarded idea(s) from the overview and source notes. Undo cleanup restores both.`};
 }
 pad.cleanupCommitting=true;pad.data().notes=notes;pad.data().organization=organization;
 try{await pad.save();}
 catch(error){if(pad.data().notes===notes)pad.data().notes=beforeNotes;if(pad.data().organization===organization)pad.data().organization=beforeOrganization;throw error;}
 finally{pad.cleanupCommitting=false;pad.organizer.notify();}
 clearTimeout(pad.organizer.refreshTimer);pad.organizer.refreshTimer=null;pad.organizer.refreshPending=false;pad.organizer.failedSignature=null;pad.organizer.refreshState='idle';pad.organizer.refreshMessage=pad.organizer.matches(organization.applied?.sources||[])?'Overview is up to date.':'Source notes changed. Refresh the overview.';
 return pad.view();
}
