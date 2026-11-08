import {createHash} from 'node:crypto';
import {prepareDictation} from '../desktop/dictation.mjs';

export const corpusHash=corpus=>createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
const words=text=>String(text||'').normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{M}\p{N}]+(?:[.,]\p{N}+)*/gu)||[];
export function wordErrorRate(reference,hypothesis){
 const a=words(reference),b=words(hypothesis);if(a.length>1000||b.length>1000)throw Error('Evaluation text is limited to 1000 words.');
 const rows=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));for(let i=0;i<=a.length;i++)rows[i][0]=i;for(let j=0;j<=b.length;j++)rows[0][j]=j;
 for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)rows[i][j]=Math.min(rows[i-1][j]+1,rows[i][j-1]+1,rows[i-1][j-1]+Number(a[i-1]!==b[j-1]));
 let i=a.length,j=b.length,substitutions=0,deletions=0,insertions=0;
 while(i||j){if(i&&j&&rows[i][j]===rows[i-1][j-1]+Number(a[i-1]!==b[j-1])){if(a[i-1]!==b[j-1])substitutions++;i--;j--;}else if(i&&rows[i][j]===rows[i-1][j]+1){deletions++;i--;}else{insertions++;j--;}}
 const errors=substitutions+deletions+insertions;return {referenceWords:a.length,hypothesisWords:b.length,substitutions,deletions,insertions,errors,wer:a.length?errors/a.length:b.length?null:0};
}
const lexical=value=>words(value).join(' ');
function containsPhrase(text,phrase){const full=' '+lexical(text)+' ',needle=' '+lexical(phrase)+' ';return needle.trim()&&full.includes(needle);}
export function protectedAccuracy(reference,hypothesis,protectedItems={}){
 const out={};for(const category of ['names','numbers','negations','commands']){
  const checks=(protectedItems[category]||[]).map(item=>{const value=typeof item==='string'?{label:item,variants:[item]}:item;if(!value?.label||!Array.isArray(value.variants)||!value.variants.length)throw Error('Protected items need a label and nonempty variants.');
   if(!value.variants.some(variant=>category==='commands'?String(reference).includes(variant):containsPhrase(reference,variant)))throw Error('Protected target must occur in its reference.');
   const preserved=value.variants.some(variant=>category==='commands'?String(hypothesis).includes(variant):containsPhrase(hypothesis,variant));return {label:value.label,preserved};});
  out[category]={total:checks.length,preserved:checks.filter(item=>item.preserved).length,checks};
 }
 return out;
}
export function percentile(values,p){const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!sorted.length)return null;return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];}
const quantiles=values=>({samples:values.filter(Number.isFinite).length,p50:percentile(values,0.5),p95:percentile(values,0.95)});
export function evaluateDictation(corpus,recordings,{engine,mode='raw',vocabulary=[]}={}){
 if(!['raw','minimal'].includes(mode))throw Error('Use raw or minimal mode.');if(!engine||!engine.name)throw Error('Identify the evaluated engine.');
 const seen=new Set(),byId=new Map(recordings.map(row=>{if(seen.has(row.id))throw Error('Duplicate recognition case.');seen.add(row.id);return[row.id,row];})),cases=[];
 for(const item of corpus.cases){const recording=byId.get(item.id);if(!recording||recording.skipped){cases.push({id:item.id,language:item.language,skipped:true,reason:recording?.reason||'No recording supplied'});continue;}
  const raw=String(recording.text||''),prepared=prepareDictation(raw,{dictationMode:mode,dictationVocabularies:[{projectId:'evaluation',terms:vocabulary}]},'evaluation'),score=wordErrorRate(item.reference,prepared.text),protectedScore=protectedAccuracy(item.reference,prepared.text,item.protected),rawProtected=protectedAccuracy(item.reference,raw,item.protected);
  const introduced=Object.keys(protectedScore).flatMap(category=>protectedScore[category].checks.filter((check,index)=>!check.preserved&&rawProtected[category].checks[index].preserved).map(check=>({category,label:check.label})));
  cases.push({id:item.id,language:item.language,reference:item.reference,recognized:raw,output:prepared.text,changed:prepared.changed,score,protected:protectedScore,cleanupIntroducedErrors:introduced,confidence:recording.confidence??null,timing:{recognitionProcessingMs:recording.recognitionProcessingMs??null,coldLoadMs:recording.coldLoadMs??null,audioDurationMs:recording.audioDurationMs??null},...(recording.error?{error:recording.error}:{})});
 }
 const evaluated=cases.filter(row=>!row.skipped),referenceWords=evaluated.reduce((n,row)=>n+row.score.referenceWords,0),errors=evaluated.reduce((n,row)=>n+row.score.errors,0),protection={};
 for(const category of ['names','numbers','negations','commands']){const total=evaluated.reduce((n,row)=>n+row.protected[category].total,0),preserved=evaluated.reduce((n,row)=>n+row.protected[category].preserved,0);protection[category]={total,preserved,accuracy:total?preserved/total:null};}
 return {corpus:{id:corpus.id,sha256:corpusHash(corpus),languages:[...new Set(corpus.cases.map(item=>item.language))],kind:corpus.kind},engine,mode,vocabulary,summary:{cases:evaluated.length,skipped:cases.length-evaluated.length,errors,referenceWords,wer:referenceWords?errors/referenceWords:null,protected:protection,cleanupIntroducedErrors:evaluated.reduce((n,row)=>n+row.cleanupIntroducedErrors.length,0),recognitionProcessingMs:quantiles(evaluated.map(row=>row.timing.recognitionProcessingMs)),coldLoadMs:quantiles(evaluated.map(row=>row.timing.coldLoadMs)),realTimeFactor:quantiles(evaluated.filter(row=>row.timing.audioDurationMs>0).map(row=>row.timing.recognitionProcessingMs/row.timing.audioDurationMs))},cases,limits:['Synthetic TTS corpus is not human dictation, background noise or device acceptance.','File recognition processing time is not streaming first-result or post-speech latency.','WER uses case-folded lexical tokens; names/numbers/negations use corpus-declared accepted variants; command spans require exact raw substring.','Missing protected targets identify lexical loss, not a complete semantic meaning assessment.']};
}
