import {createHash} from 'node:crypto';

// Memory and the archive summary are most of each turn's context. A resumed session already holds them,
// so unchanged parts are named instead of repeated, and a part that only grew sends just its additions
// (as OptMem sessions read memory once and then add to it). Every few turns, and after compaction,
// everything is sent again.
export const CONTEXT_REFRESH_TURNS=8,SHARED_LABELS={memory:'shared memory notes (memory_wake)',archive:'imported-context summary (archive_search)'};
/** parts: {name: text}. versions: {name: value}, saved with the session. delta(name, previousVersion) returns text or null. */
export function planSharedContext(c,provider,session,parts,{versions={},delta=()=>null}={}){
  const hashes=Object.fromEntries(Object.entries(parts).map(([key,text])=>[key,createHash('sha256').update(text).digest('hex')]));
  const sent=session?c.contextSent?.[provider]:null,current=!!sent&&sent.session===session&&sent.turns<CONTEXT_REFRESH_TURNS;
  const skipped=[],partial=[],pieces=[];
  for(const [key,text] of Object.entries(parts)){
    if(current&&sent.hashes?.[key]===hashes[key]){skipped.push(key);continue;}
    const addition=current&&sent.versions?.[key]!==undefined?delta(key,sent.versions[key]):null;
    if(typeof addition==='string'&&addition){partial.push(key);pieces.push(addition);}else pieces.push(text);
  }
  const text=pieces.join('')+(skipped.length?'Unchanged since your earlier turn in this conversation, so not repeated: '+skipped.map(key=>SHARED_LABELS[key]).join(', ')+'. Re-read them with the named tools if they are no longer in view.\n':'');
  return {hashes,versions,skipped,partial,text,turns:skipped.length+partial.length?sent.turns+1:1};
}
export function rememberSharedContext(c,provider,plan,result,compacted){
  const target=result?.selection?.provider;if(!target)return;c.contextSent??={};
  if(compacted||!result.sessionId){delete c.contextSent[target];return;}
  c.contextSent[target]={session:result.sessionId,hashes:plan.hashes,versions:plan.versions,turns:target===provider?plan.turns:1};
}
