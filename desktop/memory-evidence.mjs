import {memoryQuery} from './memory-relevance.mjs';
const GENERIC=new Set(['installed','verified','unverified','source','update','beta','build','passed','tests','notes','said','oct','exomina','currently','still','the','with','that','this','from','were','have','after','before','only','requests','remains','prefers','prefer']);
const tokens=text=>new Set(memoryQuery(text).terms.filter(t=>t.length>2&&!GENERIC.has(t)&&!/^\d+$/.test(t)));
const numbers=text=>[...String(text).matchAll(/\b\d+(?:\.\d+)?\s*(?:%|gb|mb|hours?|days?|\/hour|\/day)\b|\b\d+%/gi)].map(m=>m[0].toLowerCase().replaceAll(' ','')).sort().join('|');
const negative=text=>/\b(?:not|never|no longer|disabled|off|false|unverified|cannot|can't|kein\w*|nicht)\b/i.test(text);
/** A review cue, never a truth judgment. Different dates/scopes can explain it. */
export function memoryConflicts(rows,{limit=30,ignored=new Set()}={}){
 const bounded=rows.slice(0,300),sets=bounded.map(r=>tokens(r.text)),pairs=[];
 for(let i=0;i<bounded.length;i++)for(let j=i+1;j<bounded.length;j++){
  const a=bounded[i],b=bounded[j],id=[a.id,b.id].sort().join(':');if(ignored.has(id)||a.evidence?.supersededBy||b.evidence?.supersededBy)continue;
  const shared=[...sets[i]].filter(t=>sets[j].has(t));if(shared.length<2)continue;
  const an=numbers(a.text),bn=numbers(b.text),reason=an&&bn&&an!==bn?'Different quantities for a related topic':negative(a.text)!==negative(b.text)?'Different affirmative and negative wording':null;
  if(reason)pairs.push({id,a,b,shared,reason,notice:'Possible change or difference in scope. Check the original chats before deciding.'});
 }
 return pairs.sort((a,b)=>b.shared.length-a.shared.length).slice(0,limit);
}
