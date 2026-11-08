// Evidence-based correction pass over shared notes. Deterministic and local: no model call.
// It never edits or deletes a note. It derives, per note:
//  - checks: Exomina outcome marks (outcome_verify) about the same build, commit or PR;
//  - later: newer notes or later checks that report a different status for the same identifier,
//    or a newer note that announces a correction of the same topic.
// These are review cues with sources, never truth judgments: the original notes stay authoritative.

const STATE_RANK={failed:0,open:1,staged:2,done:3};
const FAILED=/\b(?:fail(?:ed|s|ure)?|rolled back|rollback|blocked|broke(?:n)?|revert(?:ed)?|crash(?:ed|es)?|contradicted|was false|timed out|not merged)\b/i;
const STAGED=/\b(?:staged|packaged|queued)\b/i;
const OPEN=/\b(?:not (?:yet )?(?:installed|merged|packaged|built|pushed|published|verified|tested|deployed)|pending|unverified|untested|unknown|unresolved|unconfirmed|awaits?|awaiting|in progress|not tested)\b/i;
const DONE=/\b(?:installed|merged|published|deployed|verified|passed|completed|running|restored|live)\b/i;
// A note that announces a correction: "Correction ..." / "Oct14 TLOU2 correction:" near its start, or an explicit retraction.
// Mentions of correction as a feature ("memory correction links") are not announcements.
const announcesCorrection=text=>/^(?:\S+\s+){0,3}correction\b(?!\s+links?)/i.test(text)||/\bcorrection:/i.test(text)||/\b(?:was|were) (?:false|wrong|incorrect|mistaken)\b|\bmisreported\b|\bretract(?:s|ed)?\b|\bsupersedes?\b/i.test(text);
// Words too common in notes to show that two notes concern the same topic.
const GENERIC=new Set(['installed','verified','unverified','source','update','beta','build','passed','tests','notes','said','exomina','currently','still','with','that','this','from','were','have','after','before','only','remains','prefers','prefer','nathan','wants','user','assistant','pending','untested','unknown','report','nov','oct','not','now','new','also','then','than','into','fixed','added','checks','check','correction','corrected','actually','does','prove','proven']);

/** Clause-level state, so "1b9af14d staged, not installed; 831cb8e5 running" reads per identifier. */
export function clauseState(clause){
  if(FAILED.test(clause))return 'failed';
  if(STAGED.test(clause))return 'staged';
  if(OPEN.test(clause))return 'open';
  if(DONE.test(clause))return 'done';
  return null;
}
const clauses=text=>String(text).split(/;|\.(?=\s|$)|:\s|\n/).map(part=>part.trim()).filter(Boolean);
const hexKey=value=>'hex:'+value.slice(0,7).toLowerCase();
// Builds and commits mix digits and letters; Windows status codes such as c0000005 are not identifiers.
const isHexId=value=>/[0-9]/.test(value)&&/[a-f]/i.test(value)&&!/000/.test(value);
const uuidPattern=/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const predicateOf=text=>{
  // A check observes one predicate, never the entire note. In particular, CI success does
  // not establish installation, publication or a merge even when the same SHA is named.
  if(/\b(?:not (?:yet )?merged|merged)\b/i.test(text))return 'github_pr_merged';
  if(/\bstaged\b/i.test(text))return 'update_staged';
  if(/\b(?:not (?:yet )?installed|installed|restored)\b/i.test(text))return 'update_installed';
  if(/\b(?:CI|checks?|test(?:s|ing)?)\b/i.test(text)&&/\b(?:passed|pass|failed|pending|running|unverified)\b/i.test(text))return 'github_checks';
  if(/\brunning\b/i.test(text))return 'update_installed';
  return null;
};
const identityOf=(key,text)=>{
  if(key.startsWith('hex:')){
    const raw=[...(String(text).match(uuidPattern)||[]),...String(text).replace(uuidPattern,' ').matchAll(/(?<![\w-])([0-9a-f]{7,40})(?![\w-])/gi)].map(value=>typeof value==='string'?value:value[1]).find(value=>hexKey(value)===key);
    return raw?.toLowerCase()||null;
  }
  if(key.startsWith('pr:'))return String(text).match(new RegExp('([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:#|/pull/)'+key.slice(3)+'\\b','i'))?.[1]?.toLowerCase()||null;
  return key;
};
const repositoryOf=text=>String(text).match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:[#@]|\/(?:pull|commit)\/)/i)?.[1]?.toLowerCase()||null;
const compatibleIdentity=(key,left,right,identities)=>{
  const all=identities.get(key)||new Set();
  if(key.startsWith('hex:')){
    if(!left||!right||!(left.startsWith(right)||right.startsWith(left)))return false;
    // Short prefixes must not choose between two different full identifiers.
    const prefix=left.length<right.length?left:right;
    const expanded=[...all].filter(value=>value.startsWith(prefix));
    return expanded.every(a=>expanded.every(b=>a.startsWith(b)||b.startsWith(a)));
  }
  if(key.startsWith('pr:'))return left&&right?left===right:all.size<=1;
  return true;
};

/** Strong identifiers in one piece of text: builds/commits (hex), PRs, Actions runs and dated work folders. */
export function noteIdentifiers(text){
  const keys=new Set(),source=String(text);
  for(const m of source.matchAll(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi))keys.add(hexKey(m[1]));
  for(const m of source.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,' ').matchAll(/(?<![\w-])([0-9a-f]{7,40})(?![\w-])/gi))if(isHexId(m[1]))keys.add(hexKey(m[1]));
  for(const m of source.matchAll(/\bPRs?\s?#?(\d{1,5})\b/gi))keys.add('pr:'+Number(m[1]));
  for(const m of source.matchAll(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#|\/pull\/)(\d{1,5})\b/gi))keys.add('pr:'+Number(m[1]));
  for(const m of source.matchAll(/\b(?:PR|#)(\d{1,5})\/([0-9a-f]{7,40})\b/gi))if(isHexId(m[2]))keys.add(hexKey(m[2]));
  for(const m of source.matchAll(/\brun\s?#?(\d{8,})\b/gi))keys.add('run:'+m[1]);
  for(const m of source.matchAll(/\b([a-z][a-z0-9-]*-20\d{6})\//gi))keys.add('dir:'+m[1].toLowerCase());
  return [...keys];
}
/** Identifier -> state of the clause that mentions it (null when the clause states none). */
export function identifierStates(text){
  const states=new Map(),parts=clauses(text),ids=parts.map(noteIdentifiers);
  parts.forEach((clause,index)=>{
    // "PR37 adds X; 2242 tests pass; CI pending": a status may follow in the next clauses that name nothing else.
    let state=clauseState(clause);
    for(let next=index+1;!state&&next<parts.length&&next<=index+2&&!ids[next].length;next++)state=clauseState(parts[next]);
    for(const key of ids[index])if(!states.has(key)||state)states.set(key,state);
  });
  for(const key of noteIdentifiers(text))if(!states.has(key))states.set(key,null);
  return states;
}
/** Predicate and complete identity alongside the legacy compact key. */
export function identifierClaims(text){
  const parts=clauses(text),ids=parts.map(noteIdentifiers),claims=new Map();
  parts.forEach((clause,index)=>{
    let context=clause;
    for(let next=index+1;next<parts.length&&next<=index+2&&!ids[next].length;next++)context+='; '+parts[next];
    for(const key of ids[index]){
      const predicate=predicateOf(clause)||(key.startsWith('pr:')?'github_pr_merged':predicateOf(context));
      // Explicit negative/unknown wording belongs to the predicate it qualifies.
      let state=clauseState(predicateOf(clause)?clause:context);
      if(key.startsWith('pr:')&&predicate==='github_pr_merged'&&!/\bmerged\b/i.test(context)&&['done','staged'].includes(state))state=null;
      if(predicate==='github_checks'&&/\b(?:running|pending|in progress)\b/i.test(context)&&!/\b(?:passed|success)\b/i.test(context))state='open';
      claims.set(key,{key,state,predicate,identity:identityOf(key,clause),repository:repositoryOf(clause)});
    }
  });
  return claims;
}

/** Outcome marks recorded by Exomina itself, indexed by the identifiers they observed. */
export function indexMarks(marks=[]){
  const index=new Map(),add=(key,mark,state,identity)=>{if(!key)return;const list=index.get(key)||[];list.push({id:mark.id,at:mark.at,kind:mark.kind,status:mark.status,subject:mark.subject,state,identity:identity||identityOf(key,mark.subject),repository:repositoryOf(mark.subject)});index.set(key,list);};
  for(const mark of marks){
    if(!mark||typeof mark!=='object'||!['verified','contradicted'].includes(mark.status))continue;
    const observed=mark.observed||{},subject=String(mark.subject||'');
    // A contradicted mark observed something else: the claimed identifier is in its subject.
    if(mark.kind==='update_installed'){const id=(mark.status==='verified'&&observed.buildId)||subject.match(/installed build ([\w-]+)/)?.[1];if(id&&isHexId(id.slice(0,8)))add(hexKey(id),mark,'done',id.toLowerCase());}
    else if(mark.kind==='update_staged'){const id=(mark.status==='verified'&&observed.buildId)||subject.match(/waiting update ([\w-]+)/)?.[1];if(id&&isHexId(id.slice(0,8)))add(hexKey(id),mark,'staged',id.toLowerCase());}
    else if(mark.kind==='github_pr_merged'){const number=subject.match(/#(\d+) merged/)?.[1];if(number)add('pr:'+Number(number),mark,'done');if(mark.status==='verified'&&observed.mergeCommit)add(hexKey(observed.mergeCommit),mark,'done',String(observed.mergeCommit).toLowerCase());}
    else if(mark.kind==='github_checks'){const sha=subject.match(/@([0-9a-f]{7,40})/i)?.[1];if(sha)add(hexKey(sha),mark,'done');}
  }
  for(const list of index.values())list.sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  return index;
}

// Uncapped (memoryQuery keeps only 12 search terms); dates such as "nov6" carry no topic.
const topicTokens=text=>new Set((String(text).toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_.:/\\-]{0,79}/gu)||[]).map(term=>term.replace(/[.:/\\-]+$/g,'')).filter(term=>term.length>3&&!GENERIC.has(term)&&!/^\d+$/.test(term)&&!/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{1,2}$/.test(term)));
const DAY=86400000;
// Topic words for progress links: also split names such as model-tiers.mjs or switchBriefing,
// and fold plurals, so "tiers"/"tier" and "briefings"/"switchBriefing" meet.
const progressTokens=text=>{
  const out=new Set();
  for(const raw of String(text).match(/[\p{L}\p{N}_][\p{L}\p{N}_.:/\\-]{0,79}/gu)||[])for(const part of [raw,...raw.split(/[-_.:/\\]+|(?<=\p{Ll})(?=\p{Lu})/u)]){
    const term=part.toLowerCase().replace(/[.:/\\-]+$/g,'').replace(/(?<=\p{L}{4})s$/u,'');
    if(term.length>3&&!GENERIC.has(term)&&!/^\d/.test(term)&&!/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{1,2}$/.test(term)&&!['mjs','json','proposed','design','built','implemented','planned','packaged'].includes(term))out.add(term);
  }
  return out;
};
// Planning-stage notes and the notes that later report the same work as built. Both sides are explicit
// in the text, so plain topic overlap between two finished pieces of work never links them.
const PLANNED=/\b(?:not (?:yet )?(?:built|implemented)|(?:design(?:ed)?|plan(?:ned)?|concept) only|unimplemented|no implementation yet|(?:design|plan) proposed)\b/i;
const BUILT=/\b(?:implemented|built|added|shipped|merged|packaged|installed|in Source|\d[\d,]* ?(?:tests? )?pass(?:ed)?)\b|^\S+\s+Source:/i;
const STILL_PLANNED=/\bnot (?:yet )?(?:built|implemented)\b|\bproposed\b/i;

/**
 * notes: [{id,seq,text,date|createdAt}] in any order. marks: outcome marks from saved chats.
 * Returns Map(noteId -> {checks,later,claim}) for notes with anything to report.
 */
export function assessNotes(notes,marks=[],{correctionWindow=80,progressWindow=60}={}){
  const rows=[...notes].filter(note=>note&&typeof note.text==='string').sort((a,b)=>a.seq-b.seq),markIndex=indexMarks(marks),result=new Map();
  const entry=note=>{let value=result.get(note.id);if(!value){value={checks:[],later:[],claim:null};result.set(note.id,value);}return value;};
  const time=note=>Date.parse(note.createdAt||note.date||'')||0;
  const latestByKey=new Map(),parsed=rows.map(note=>({note,claims:identifierClaims(note.text),states:identifierStates(note.text),at:time(note)}));
  const identities=new Map(),rememberIdentity=(key,value)=>{if(value){const known=identities.get(key)||new Set();known.add(value);identities.set(key,known);}};
  for(const {claims} of parsed)for(const [key,claim] of claims)rememberIdentity(key,claim.identity);
  for(const [key,marks] of markIndex)for(const mark of marks)rememberIdentity(key,mark.identity);
  const repositories=new Map(),rememberRepository=(key,predicate,repo)=>{if(!repo||!predicate?.startsWith('github_'))return;const lookup=key+':'+predicate,known=repositories.get(lookup)||new Set();known.add(repo);repositories.set(lookup,known);};
  for(const {claims} of parsed)for(const [key,claim] of claims)rememberRepository(key,claim.predicate,claim.repository);
  for(const [key,marks] of markIndex)for(const mark of marks)rememberRepository(key,mark.kind,mark.repository);
  const compatibleRepository=(key,predicate,left,right)=>!predicate?.startsWith('github_')||(left&&right?left===right:(repositories.get(key+':'+predicate)?.size||0)<=1);
  const family=predicate=>['update_installed','update_staged'].includes(predicate)?'deployment':predicate;
  // 1. Newer notes reporting a different status for the same identifier (walk newest first).
  for(let index=parsed.length-1;index>=0;index--){
    const {note,claims}=parsed[index];
    for(const [key,claim] of claims){
      const {state,predicate,identity,repository}=claim;if(!state||!predicate)continue;const lookup=key+':'+family(predicate),newer=latestByKey.get(lookup);
      if(newer&&newer.state!==state&&compatibleIdentity(key,identity,newer.identity,identities)&&compatibleRepository(key,predicate,repository,newer.repository)){const list=entry(note).later;if(!list.some(item=>item.seq===newer.note.seq))list.push({seq:newer.note.seq,id:newer.note.id,reason:'status',key,state:newer.state,was:state,predicate:newer.predicate});}
      if(!newer)latestByKey.set(lookup,{note,state,predicate,identity,repository});
    }
  }
  // 2. Exomina checks: corroborate, contradict or supersede the note's stated status.
  for(const {note,claims,at} of parsed){
    let corroborated=false,contradicted=false,claimed=false;
    for(const [key,{state,predicate,identity,repository}] of claims){
      const found=(markIndex.get(key)||[]).filter(mark=>compatibleIdentity(key,identity,mark.identity,identities)&&compatibleRepository(key,predicate,repository,mark.repository));if(state==='done'||state==='staged')claimed=true;if(!found.length||!state||!predicate)continue;
      // Historical claims can only be corroborated by a check that already existed when
      // the note was recorded. A later successful install must not retroactively turn
      // an earlier premature installation claim into a verified one.
      const near=found.filter(mark=>{const observed=Date.parse(mark.at)||0;return at&&observed&&observed<=at&&at-observed<=3*DAY;});
      const agree=near.filter(mark=>mark.kind===predicate&&mark.status==='verified'&&mark.state===state);
      const against=near.filter(mark=>mark.kind===predicate&&mark.status==='contradicted'&&mark.state===state);
      if(agree.length){corroborated=true;const mark=agree.at(-1);entry(note).checks.push({key,status:'verified',kind:mark.kind,at:mark.at,subject:mark.subject,markId:mark.id});}
      else if(against.length&&(state==='done'||state==='staged')){contradicted=true;const mark=against.at(-1);entry(note).checks.push({key,status:'contradicted',kind:mark.kind,at:mark.at,subject:mark.subject,markId:mark.id});}
      const later=found.filter(mark=>at&&family(mark.kind)===family(predicate)&&mark.status==='verified'&&(Date.parse(mark.at)||0)>at&&(STATE_RANK[mark.state]>STATE_RANK[state]||mark.kind===predicate&&mark.state===state)).at(-1);
      if(later&&!entry(note).later.some(item=>item.key===key))entry(note).later.push({check:later.id,reason:later.state===state?'observation':'check',key,state:later.state,was:state,at:later.at,subject:later.subject,predicate:later.kind});
    }
    if(claimed)entry(note).claim=contradicted?'contradicted':corroborated?'checked':'reported';
  }
  // 3. Notes that announce a correction of a recent topic.
  const tokens=parsed.map(({note})=>topicTokens(note.text)),frequency=new Map();
  for(const set of tokens)for(const term of set)frequency.set(term,(frequency.get(term)||0)+1);
  for(let index=0;index<parsed.length;index++){
    const {note}=parsed[index];if(!announcesCorrection(note.text))continue;
    for(let older=Math.max(0,index-correctionWindow);older<index;older++){
      const shared=[...tokens[index]].filter(term=>tokens[older].has(term));
      if(shared.length>=3&&shared.filter(term=>(frequency.get(term)||0)<=8).length>=2){const target=parsed[older].note,list=entry(target).later;if(!list.some(item=>item.seq===note.seq))list.push({seq:note.seq,id:note.id,reason:'correction',shared:shared.slice(0,4)});}
    }
  }
  // 4. Progress without a shared identifier: "X designed, not built" followed by a note that reports X built.
  const progress=parsed.map(({note})=>PLANNED.test(note.text)||BUILT.test(note.text)?progressTokens(note.text):null),progressFrequency=new Map();
  for(const set of progress)if(set)for(const term of set)progressFrequency.set(term,(progressFrequency.get(term)||0)+1);
  for(let index=0;index<parsed.length;index++){
    const {note,at}=parsed[index];if(!PLANNED.test(note.text))continue;
    for(let newer=index+1;newer<parsed.length&&newer<=index+progressWindow;newer++){
      const later=parsed[newer];if(at&&later.at&&later.at-at>14*DAY)break;
      if(!BUILT.test(later.note.text)||STILL_PLANNED.test(later.note.text))continue;
      const shared=[...progress[index]].filter(term=>progress[newer].has(term)),distinct=shared.filter(term=>(progressFrequency.get(term)||0)<=6);
      if(distinct.length>=3){const list=entry(note).later;if(!list.some(item=>item.seq===later.note.seq))list.push({seq:later.note.seq,id:later.note.id,reason:'progress',shared:distinct.slice(0,4)});break;}
    }
  }
  for(const [id,value] of result)if(!value.checks.length&&!value.later.length&&!value.claim)result.delete(id);
  return result;
}

/** Compact, model-facing label for one note's assessment. */
export function assessmentLabel(value){
  if(!value)return null;const out={};
  if(value.claim==='checked')out.check='Exomina-verified: '+value.checks.filter(c=>c.status==='verified').map(c=>`${c.subject} (${String(c.at).slice(0,10)})`).slice(0,2).join('; ')+'; only these named conditions were checked';
  else if(value.claim==='contradicted')out.check='Contradicted by an Exomina check: '+value.checks.filter(c=>c.status==='contradicted').map(c=>`${c.subject} (${String(c.at).slice(0,10)})`).slice(0,2).join('; ');
  else if(value.claim==='reported')out.check='reported; no Exomina check';
  const later=value.later.slice(0,3).map(item=>item.reason==='observation'?`later observation: ${item.subject} (${String(item.at).slice(0,10)}); does not verify the earlier time`:item.reason==='check'?`later check: ${item.subject} → ${item.state} (${String(item.at).slice(0,10)})`:item.reason==='status'?`#${item.seq} reports ${item.key.replace(/^hex:/,'')} as ${item.state}, here ${item.was}`:item.reason==='progress'?`#${item.seq} reports this work as built or further along`:`#${item.seq} announces a correction`);
  if(later.length)out.later=(value.later.every(item=>item.reason==='observation')?'Later evidence available: ':'Possibly outdated: ')+later.join('; ');
  return Object.keys(out).length?out:null;
}

/** On-demand relation inspector for memory_recall. Briefs keep only the compact labels. */
export function assessmentDetails(value){
  const label=assessmentLabel(value);if(!label)return null;
  return {...label,
    evidence:value.checks.slice(0,8).map(item=>({...item,notice:'Host observation of this predicate at this time; other claims are not established.'})),
    relations:value.later.slice(0,8).map(item=>({
      kind:item.reason,source:item.seq?{noteId:item.id,seq:item.seq}:null,
      ...(item.check?{markId:item.check}:{}),...(item.key?{identifier:item.key}:{}),
      ...(item.predicate?{predicate:item.predicate}:{}),...(item.was?{earlierState:item.was,laterState:item.state}:{}),
      ...(item.at?{observedAt:item.at}:{}),...(item.shared?{matchingTerms:item.shared}:{}),
      notice:['correction','progress'].includes(item.reason)?'Topic similarity suggests review; this is not an owner-recorded supersession.':'Same identifier and compatible outcome predicate; inspect both sources before reusing a historical claim.'
    }))};
}
