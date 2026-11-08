// Task-specific retrieval only. No global importance weight or stored classification.
// How shared notes reach each turn: 'relevant' sends a bounded brief matched to the request;
// 'chronological' sends the newest-first memory_wake page.
export const MEMORY_CONTEXT_MODES=['relevant','chronological'];
export function memoryContextMode(settings={}){return MEMORY_CONTEXT_MODES.includes(settings.memoryContext)?settings.memoryContext:'relevant';}
// Question words carry no topic: "Which clinic was my question about?" is about "clinic" and "question".
const STOP=new Set(['the','and','for','with','that','this','from','have','what','which','please','find','about','memory','memories','notes','der','die','das','und','für','mit','von','ist','ein','eine',
  'was','were','is','are','am','be','been','did','does','do','my','me','you','your','our','its','it','of','to','in','on','at','or','an','as','by','if','so','yet','any','how','why','when','where','who','whom','whose','can','could','would','should','will','there','then','than','into','just','only','still','also',
  'war','sind','bin','hat','haben','mein','meine','dein','wie','wer','was','wann','wo','warum','noch','schon','auch','nur','oder','aber','den','dem','des','einen','einem']);
export function memoryQuery(value) {
  const phrase=String(value||'').trim().slice(0,500).toLowerCase();
  const raw=(phrase.match(/[\p{L}\p{N}_][\p{L}\p{N}_.:/\\-]{0,79}/gu)||[]).map(term=>term.replace(/[.:/\\-]+$/g,''));
  // Hyphenated words also search for their parts ("single-room" finds "single rooms"); identifiers stay whole.
  const parts=raw.flatMap(term=>/^\p{L}+(?:-\p{L}+)+$/u.test(term)?[term,...term.split('-')]:[term]);
  const terms=[...new Set(parts.filter(term=>term.length>=2&&!STOP.has(term)))].slice(0,12);
  return {phrase,terms:terms.length?terms:phrase?[phrase]:[]};
}
// German and English notes share many cognates that differ only in spelling ("clinic"/"Klinikum",
// "certificate"/"Zertifikat", "process"/"Prozess"). Folding makes those spellings meet; it is a
// fallback after literal matching and only applies to words long enough to carry a topic.
export function foldWord(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss')
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 'z').replace(/c/g, 'k').replace(/y/g, 'i').replace(/(.)\1+/g, '$1');
}
const SUFFIX = /(?:ungen|ung|ation|ismus|isch|ical|ieren|iert|en|er|es|um|e|s)$/;
export function foldStem(term) {
  const folded = foldWord(term), stem = folded.replace(SUFFIX, '');
  return stem.length >= 5 ? stem : folded;
}
const WORDS = /[\p{L}\p{N}_]{5,}/gu;
/** term is a lower-case query term; lower is lower-case text. Literal first, then folded word prefixes. */
export function termMatches(lower, term) {
  if (lower.includes(term)) return true;
  if (term.length < 5 || /\d/.test(term) || /[^\p{L}]/u.test(term)) return false;
  const stem = foldStem(term);
  for (const word of lower.match(WORDS) || []) if (foldWord(word).startsWith(stem)) return true;
  return false;
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
    const lower=row.text.toLowerCase(),matched=terms.filter(term=>termMatches(lower,term));
    if(!matched.length&&!row.entityMatch)return null;
    const tokens=new Set((lower.match(/[\p{L}\p{N}_][\p{L}\p{N}_.:/\\-]{0,79}/gu)||[]).map(term=>term.replace(/[.:/\\-]+$/g,''))),whole=matched.filter(term=>tokens.has(term)),sameChat=!!conversationId&&row.sourceChatIds?.includes(conversationId);
    const exact=!!phrase&&lower.includes(phrase)&&(terms.length>1||tokens.has(phrase));
    return {...row,match:{terms:matched,exactTerms:whole,phrase:exact,sameChat,kind:memoryKind(row.text),...(row.entityMatch?{entities:row.entityMatch.names,ambiguousEntity:row.entityMatch.ambiguous}: {})},_score:matched.length*100+whole.length*4+(row.entityMatch?80:0)+(exact?2:0)+(sameChat?1:0)-(row.evidence?.supersededBy?10000:0)};
  }).filter(Boolean).sort((a,b)=>b._score-a._score||(b.seq||0)-(a.seq||0)).slice(0,limit).map(({_score,...row})=>row);
}
