// Task-specific retrieval only. No global importance weight or stored classification.
const STOP=new Set(['the','and','for','with','that','this','from','have','what','which','please','find','about','memory','memories','notes','der','die','das','und','für','mit','von','ist','ein','eine']);
export function memoryQuery(value) {
  const phrase=String(value||'').trim().slice(0,500).toLowerCase();
  const terms=[...new Set((phrase.match(/[\p{L}\p{N}_][\p{L}\p{N}_.:/\\-]{0,79}/gu)||[]).map(term=>term.replace(/[.:/\\-]+$/g,'')).filter(term=>term.length>=2&&!STOP.has(term)))].slice(0,12);
  return {phrase,terms:terms.length?terms:phrase?[phrase]:[]};
}
export function memoryKind(text) {
  if(/\b(prefer\w*|wants?\b|always\b|never\b|preference|bevorzug\w*)/i.test(text))return 'preference';
  if(/\b(decid\w*|chose\b|chosen\b|agreed\b|decision|entschied\w*)/i.test(text))return 'decision';
  if(/\b(verified\b|tested\b|installed\b|passed\b|completed\b|unverified\b|outcome)/i.test(text))return 'outcome';
  return 'context';
}
export function rankMemories(rows,query,{conversationId,limit=500}={}) {
  const {phrase,terms}=memoryQuery(query);
  return rows.map(row=>{
    const lower=row.text.toLowerCase(),matched=terms.filter(term=>lower.includes(term)),exact=!!phrase&&lower.includes(phrase),sameChat=!!conversationId&&row.sourceChatIds?.includes(conversationId);
    return {...row,match:{terms:matched,phrase:exact,sameChat,kind:memoryKind(row.text)},_score:matched.length*10+(exact?5:0)+(sameChat?1:0)-(row.evidence?.supersededBy?1000:0)};
  }).filter(row=>row.match.terms.length||row.match.phrase).sort((a,b)=>b._score-a._score||(b.seq||0)-(a.seq||0)).slice(0,limit).map(({_score,...row})=>row);
}
