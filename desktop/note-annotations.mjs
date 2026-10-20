import {randomUUID} from 'node:crypto';

const labels={partial:'PARTIAL','needs-clarification':'NEEDS CLARIFICATION',pending:'PENDING',reviewed:'REVIEWED'};
const required=(value,max,label)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`Use ${label} up to ${max.toLocaleString()} characters.`);return value;};

function source(pad,conversationId,input){
 pad.readNotes(conversationId,{id:input?.id,limit:1});
 const note=pad.data().notes.find(item=>item.id===input.id);
 if(!note||!Number.isSafeInteger(input.revision)||input.revision!==note.revision)throw Error('This note changed. Read it again before annotating.');
 const job=pad.active?.job?.conversationId===conversationId?pad.active.job:null;
 if(job&&job.noteId!==note.id)throw Error('This note is outside the current task.');
 return {note,scope:job?job.goal:note.text};
}

function insideFence(text,end){
 let fence=null;
 for(const line of text.slice(0,end).split(/\r?\n/)){
  const match=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);if(!match)continue;
  if(!fence)fence=match[1];else if(match[1][0]===fence[0]&&match[1].length>=fence.length&&!match[2].trim())fence=null;
 }
 return !!fence;
}

function plan(pad,conversationId,input){
 const {note,scope}=source(pad,conversationId,input);
 if(input.action==='undo'){
  const previous=note.lastAnnotations;
  if(!previous||previous.id!==input.annotationId||previous.revision!==note.revision||!previous.items.every(item=>scope.includes(item.quote)))throw Error('These annotations changed or are outside this task. Keep newer edits and read the note again.');
  return {note,undo:true,previous,text:previous.beforeText};
 }
 if(input.action!==undefined&&input.action!=='add')throw Error('Choose add or undo for note annotations.');
 if(!Array.isArray(input.annotations)||!input.annotations.length||input.annotations.length>20)throw Error('Add 1 to 20 annotations at a time.');
 const at=pad.now().toISOString(),eol=note.text.includes('\r\n')?'\r\n':'\n',items=input.annotations.map(item=>{
  const quote=required(item?.quote,8000,'an exact source passage'),body=required(item?.text,2000,'annotation text');
  if(!Object.hasOwn(labels,item.status))throw Error('Choose partial, needs-clarification, pending or reviewed.');
  if(!scope.includes(quote))throw Error('An annotation is outside this chat’s approved note scope.');
  const start=note.text.indexOf(quote),end=start+quote.length;
  if(start<0||note.text.indexOf(quote,start+1)!==-1)throw Error('Each source passage must occur exactly once. Include more surrounding text.');
  if(start>0&&note.text[start-1]!=='\n'||end<note.text.length&&!['\n','\r'].includes(note.text[end]))throw Error('Quote a complete source passage ending at a line break.');
  if(insideFence(note.text,end))throw Error('Quote the complete fenced block so comments follow its closing fence.');
  const insertion=eol+eol+'> [AI review '+at.slice(0,10)+' | '+labels[item.status]+']'+eol+body.trim().split(/\r?\n/).map(line=>'> '+line).join(eol)+eol;
  return {quote,text:body.trim(),status:item.status,start,end,insertion};
 }).sort((a,b)=>a.start-b.start);
 if(items.some((item,index)=>index&&item.start<items[index-1].end))throw Error('Choose separate, non-overlapping source passages.');
 let text=note.text;for(const item of [...items].reverse())text=text.slice(0,item.end)+item.insertion+text.slice(item.end);
 if(text.length>100000||pad.data().notes.reduce((sum,item)=>sum+(item.id===note.id?text.length:item.text.length),0)>1000000)throw Error('Make room in the notebook before adding these annotations.');
 return {note,text,at,items};
}

export async function annotateNote(pad,conversationId,input,approve){
 const first=plan(pad,conversationId,input),detail=JSON.stringify(first.undo?{note:first.note.title,action:'Remove the last annotations',items:first.previous.items}:{note:first.note.title,annotations:first.items.map(({quote,text,status})=>({quote,text,status}))},null,2);
 if(detail.length>24000)throw Error('Choose fewer annotations so the exact changes fit in the approval preview.');
 if(!await approve({title:first.undo?`Undo annotations in “${first.note.title}”?`:`Annotate “${first.note.title}”?`,conversationId,detail,input,action:{kind:'write',tool:'notes_annotate',target:input.id},reason:first.undo?'Remove the last annotation batch and restore the original text. Newer note edits prevent Undo.':'Add status comments after the exact source passages. Original text and links stay intact; Undo is available in Notes.'}))throw Error('Note annotations were declined.');
 const fresh=plan(pad,conversationId,input);
 const note=fresh.undo?await restoreAnnotations(pad,{id:input.id,revision:input.revision,annotationId:input.annotationId}):await pad.persistNoteChange(fresh.note,{text:fresh.text,lastAnnotations:{id:randomUUID(),at:fresh.at,revision:fresh.note.revision+1,beforeText:fresh.note.text,items:fresh.items.map(({quote,text,status})=>({quote,text,status}))}});
 return {id:note.id,title:note.title,revision:note.revision,action:fresh.undo?'undo':'add',added:fresh.undo?0:fresh.items.length,characters:note.text.length,annotationId:note.lastAnnotations?.id||null,undo:fresh.undo?'Annotations removed.':'Notes → AI annotations → Undo last annotations. Later edits prevent overwrite.'};
}

export async function restoreAnnotations(pad,{id,revision,annotationId}={}){
 const note=pad.data().notes.find(item=>item.id===id),previous=note?.lastAnnotations;
 if(!note||!Number.isSafeInteger(revision)||revision!==note.revision||!previous||previous.id!==annotationId||previous.revision!==revision)throw Error('This note changed after annotation. Remove the comments manually to preserve newer edits.');
 if(pad.data().notes.reduce((sum,item)=>sum+(item.id===id?previous.beforeText.length:item.text.length),0)>1000000)throw Error('Make room in the notebook before undoing annotations.');
 return pad.persistNoteChange(note,{text:previous.beforeText,lastAnnotations:null});
}

export const NOTE_ANNOTATION_TOOL={name:'notes_annotate',description:'Add dated status comments beside exact complete passages in a shared note when the user requests annotation. Read notes_read first and use its current revision. Preserves all original text and links. Status is partial, needs-clarification, pending or reviewed; explain what is done, remains, or needs a decision. Never claim unverified completion. Each quote must be unique and end at a line break. Existing read/write permissions apply. The last annotation batch can be undone in Notes, or with action undo, its current revision and annotationId; newer edits block Undo. Scoped note tasks can annotate only their approved passages.',inputSchema:{type:'object',properties:{action:{enum:['add','undo']},id:{type:'string'},revision:{type:'integer',minimum:1},annotationId:{type:'string'},annotations:{type:'array',minItems:1,maxItems:20,items:{type:'object',properties:{quote:{type:'string',minLength:1,maxLength:8000},status:{enum:['partial','needs-clarification','pending','reviewed']},text:{type:'string',minLength:1,maxLength:2000}},required:['quote','status','text'],additionalProperties:false}}},required:['id','revision'],additionalProperties:false}};
