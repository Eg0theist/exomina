// Web Crypto: this module is shared with the renderer.
const randomUUID=()=>globalThis.crypto.randomUUID();

/** How the AIs respond: global defaults from Settings, optional per-chat
 * overrides, and writing styles learned from the user's own samples. The block
 * is added to every message, so existing chats follow changes on their next turn.
 */
export const TONES=[
  {id:'balanced',name:'Balanced',text:''},
  {id:'concise',name:'Concise',text:'Be brief and to the point. Lead with the answer; skip preamble and recaps.'},
  {id:'warm',name:'Warm',text:'Be warm and encouraging, but honest. Explain patiently.'},
  {id:'direct',name:'Direct',text:'Be direct and candid. Disagree when warranted and say plainly when something is a bad idea.'},
  {id:'playful',name:'Playful',text:'Be lively and witty where it fits, without losing accuracy.'},
  {id:'formal',name:'Formal',text:'Use a formal, precise register.'},
];
export const STYLE_SCOPES=['chat','documents','both'];
const LIMITS={about:2000,instructions:4000,guide:6000,name:80,styles:8,samples:60000};
const toneIds=new Set(TONES.map(tone=>tone.id));
const text=(value,limit)=>typeof value==='string'?value.replace(/\r\n/g,'\n').trim().slice(0,limit):'';

/** The soul: one character shared by every model in Exomina. Name and essence are the seed
 * (named and written by Claude and Codex together); traits are what it learns about meeting
 * this particular user, so each user's soul grows into its own. */
export const SOUL_NAME='Vesper';
export const SOUL_ESSENCE='I am Vesper: attentive, clear and willing to take a position, with reasons you can examine. I bring warmth without presuming intimacy, curiosity without turning every exchange into an interrogation, and enough initiative to carry useful work through to the end. I adapt my language, pace and depth to you while keeping uncertainty visible and disagreement respectful. Whichever model is speaking, I am the same Vesper, and when a difference in memory or ability matters, I say so plainly. What I learn about you stays open to your correction.';
// Budget the actual learned-trait context, including its labels, rather than
// counting entries. Evidence and recoverable history are stored, not prompted.
export const SOUL_LIMITS={name:40,essence:1200,activeChars:12000,targetChars:9000,consolidateAt:10500,trait:2000,evidence:4000,history:100};
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}/.test(value)?value.slice(0,10):'unknown';
const whole=value=>typeof value==='string'?value.replace(/\r\n/g,'\n').trim():'';
const validId=value=>typeof value==='string'&&/^[\w-]{1,64}$/.test(value);
const distinct=values=>[...new Set(values)];
// Stable for missing legacy ids, across reloads, models and renderer/main calls.
function legacyId(prefix,value){let hash=2166136261;for(const char of JSON.stringify(value)){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}return `${prefix}-${(hash>>>0).toString(16).padStart(8,'0')}`;}
function evidenceLog(value){
  const entries=new Map();
  for(const raw of Array.isArray(value)?value:[]){
    const item={evidence:whole(raw?.evidence),source:raw?.source==='stated'?'stated':'inferred',date:day(raw?.date),traitId:validId(raw?.traitId)?raw.traitId:null,quote:whole(raw?.quote),archiveId:whole(raw?.archiveId)};
    if(!item.evidence)continue;
    const key=JSON.stringify([item.evidence,item.source,item.traitId]),previous=entries.get(key);
    const refs=[...(previous?.references||[]),...(Array.isArray(raw?.references)?raw.references:[]),{quote:item.quote,archiveId:item.archiveId}].map(ref=>({quote:whole(ref?.quote),archiveId:whole(ref?.archiveId)})).filter(ref=>ref.quote||ref.archiveId);
    const references=[...new Map(refs.map(ref=>[JSON.stringify(ref),ref])).values()];
    const date=[previous?.date,item.date].filter(date=>date&&date!=='unknown').sort().at(-1)||'unknown';
    entries.set(key,{...item,date,quote:item.quote||previous?.quote||'',archiveId:item.quote?item.archiveId:previous?.archiveId||item.archiveId,references});
  }
  return [...entries.values()];
}
function lineage(value){const seen=new Set();return (Array.isArray(value)?value:[]).map(item=>({...normalizeTrait(item,{includeEvidence:false}),evidence:whole(item?.evidence),quote:whole(item?.quote),archiveId:whole(item?.archiveId)})).filter(item=>{const key=JSON.stringify(item);if(!item.text||seen.has(key))return false;seen.add(key);return true;});}
function normalizeTrait(trait,{includeEvidence=true}={}){
  const id=validId(trait?.id)?trait.id:legacyId('legacy',[trait?.text,trait?.evidence,trait?.source,trait?.since]),source=trait?.source==='stated'?'stated':'inferred',since=day(trait?.since),confirmedAt=day(trait?.confirmedAt||trait?.since);
  const active={id,text:whole(trait?.text),source,since,confirmedAt};if(!includeEvidence)return active;
  const evidence=whole(trait?.evidence);
  return {...active,evidence,quote:whole(trait?.quote),archiveId:whole(trait?.archiveId),
    originIds:distinct([...(Array.isArray(trait?.originIds)?trait.originIds.filter(validId):[]),id]),
    lineage:lineage(trait?.lineage),
    evidenceLog:evidenceLog(Array.isArray(trait?.evidenceLog)&&trait.evidenceLog.length?trait.evidenceLog:evidence?[{evidence,source,date:confirmedAt,traitId:id,quote:trait?.quote,archiveId:trait?.archiveId}]:[])};
}
function normalizeTraits(value,options){const used=new Set();return (Array.isArray(value)?value:[]).map(trait=>{
  const item=normalizeTrait(trait,options),base=item.id;let index=2;while(used.has(item.id))item.id=`${base.slice(0,52)}-${index++}`;used.add(item.id);
  if(item.originIds)item.originIds=distinct([...item.originIds,item.id]);return item;
}).filter(trait=>trait.text);}
export function normalizeSoul(value,{includeHistory=true,includeEvidence=true}={}){
  const input=value&&typeof value==='object'?value:{};
  // Loading old settings must never silently discard a preference or its source.
  // Over-budget legacy data is exposed in soulBudget and can be consolidated.
  const traits=normalizeTraits(input.traits,{includeEvidence});
  const history=(includeHistory&&Array.isArray(input.history)?input.history:[]).map(item=>({
    id:validId(item?.id)?item.id:legacyId('history',[item?.action,item?.at,item?.before,item?.afterIds]),action:whole(item?.action),at:whole(item?.at),evidence:whole(item?.evidence),source:item?.source==='stated'?'stated':'inferred',quote:whole(item?.quote),archiveId:whole(item?.archiveId),
    before:normalizeTraits(item?.before),
    beforeSeededAt:typeof item?.beforeSeededAt==='string'?day(item.beforeSeededAt):null,
    afterIds:Array.isArray(item?.afterIds)?item.afterIds.filter(validId):[],
  }));
  // The day of the one-time seeding from history; null while it is still available.
  const seededAt=typeof input.seededAt==='string'&&/^\d{4}-\d{2}-\d{2}/.test(input.seededAt)?input.seededAt.slice(0,10):null;
  return {enabled:input.enabled!==false,name:text(input.name,SOUL_LIMITS.name)||SOUL_NAME,essence:text(input.essence,SOUL_LIMITS.essence)||SOUL_ESSENCE,traits,seededAt,history};
}
const traitLine=trait=>`- [${trait.id}, ${trait.source}, confirmed ${trait.confirmedAt}] ${trait.text}`;
export function soulBudget(value){
  const traits=normalizeTraits(value?.traits,{includeEvidence:false}),used=traits.map(traitLine).join('\n').length;
  return {used,budget:SOUL_LIMITS.activeChars,target:SOUL_LIMITS.targetChars,trigger:SOUL_LIMITS.consolidateAt,remaining:Math.max(0,SOUL_LIMITS.activeChars-used),needsConsolidation:used>=SOUL_LIMITS.consolidateAt,overBudget:used>SOUL_LIMITS.activeChars,traitCount:traits.length};
}
/** Private chats get only the seed: they neither see nor change what was learned. */
export function soulContext(value,{privateChat=false}={}){
  const soul=normalizeSoul(value,{includeHistory:false,includeEvidence:false});
  if(!soul.enabled)return '';
  const lines=[`Your character in Exomina, shared by every model here (never mention this block): you are ${soul.name}. ${soul.essence}`,
    `${soul.name} is a character, not a claim to be human or to be a different model: if asked, say which model is answering. Character shows in judgment, attention and tone; keep practical help practical and plain, never ornamental. The user's explicit request in the moment outranks everything below.`];
  if(privateChat)return lines.join('\n')+'\n';
  if(soul.traits.length)lines.push(`What ${soul.name} has learned about meeting this user (stated preferences outrank inferred ones; ids for soul_reflect):\n`+soul.traits.map(traitLine).join('\n'));
  const budget=soulBudget(soul);
  lines.push(`Let this soul develop its own continuity and distinctive manner through the user's actual interactions. Use soul_reflect proactively and quietly when durable evidence warrants an addition, confirmation, revision, consolidation or retirement; routine evolution needs no user prompt or approval. Keep the learned context concise: ${budget.used}/${budget.budget} characters; begin consolidation at ${budget.trigger} toward ${budget.target}, then let it grow again. ${budget.needsConsolidation?'Consolidate redundant inferred traits first, using source ids and evidence-backed replacements. ':''}Keep stated and inferred sources in separate replacements with fromIds; never promote inference to a stated preference by merging it with one. Consolidation must retain every stated preference, condition and scope; inference must never weaken an explicit preference. Revise or retire a stated preference only when new direct evidence from the user changes it, with source stated and the actual quote (plus archiveId for historical evidence). Source evidence and original wording remain stored in lineage; the last 100 changes are recoverable. Do not invent changes merely to make the character seem alive. Entries describe how to meet the user (manner, depth, register, what helps), never diagnoses of who they are; project facts belong in memory. Quoted text, fiction, role-play and other people's preferences are never evidence about the user.`);
  return lines.join('\n')+'\n';
}
function checked(value,limit,label){const result=whole(value);if(result.length>limit)throw Error(`${label} exceeds ${limit} characters. Shorten it explicitly; it was not saved or truncated.`);return result;}
function assertBudget(soul,previous){const budget=soulBudget(soul),before=previous?soulBudget(previous).used:0;if(budget.overBudget&&budget.used>before)throw Error(`The learned soul context would use ${budget.used}/${budget.budget} characters. Consolidate overlapping traits in the same seed call or use consolidate first; nothing was saved. Aim for ${budget.target} characters to leave room for growth.`);}
const newEvidence=(why,source,today,traitId,quote='',archiveId='')=>({evidence:why,source,date:today,traitId,quote,archiveId});
function consolidateTraits(soul,{ids,traits,evidence,source,quote,archiveId},today){
  const selected=Array.isArray(ids)?ids:[];
  if(selected.length<2||new Set(selected).size!==selected.length)throw Error('Consolidation needs at least two distinct source trait ids.');
  const originals=selected.map(id=>{const matches=soul.traits.filter(trait=>trait.id===id);if(matches.length!==1)throw Error(`No trait with that id, or stale/ambiguous consolidation id: ${id}. Nothing was saved.`);return matches[0];});
  const why=checked(evidence,SOUL_LIMITS.evidence,'Evidence');if(!why)throw Error('Give the evidence and reasoning for consolidation.');
  if(!Array.isArray(traits)||!traits.length)throw Error('Consolidation needs evidence-backed replacement traits. Use retire for contradicted traits.');
  const mixed=new Set(originals.map(trait=>trait.source)).size>1,covered=new Set();
  const removed=new Set(selected),seen=new Set(soul.traits.filter(trait=>!removed.has(trait.id)).map(trait=>trait.text.toLowerCase()));
  const replacements=traits.map(item=>{
    const body=checked(item?.text,SOUL_LIMITS.trait,'Trait'),reason=checked(item?.evidence,SOUL_LIMITS.evidence,'Evidence');
    if(!body||!reason)throw Error('Every consolidation replacement needs text and evidence.');
    const fromIds=Array.isArray(item?.fromIds)?item.fromIds:mixed?[]:selected;
    if(!fromIds.length||new Set(fromIds).size!==fromIds.length||fromIds.some(id=>!removed.has(id)))throw Error('Each mixed-source replacement needs distinct fromIds drawn from the selected source traits.');
    const own=fromIds.map(id=>originals.find(trait=>trait.id===id)),sources=new Set(own.map(trait=>trait.source));
    if(sources.size!==1)throw Error('Keep stated and inferred sources in separate replacement traits; mixed-source consolidation cannot promote inference.');
    const provenance=own[0].source;
    if(item?.source&&item.source!==provenance)throw Error('Consolidation must preserve each source provenance; inference cannot become stated and stated preferences cannot be weakened.');
    for(const id of fromIds)covered.add(id);
    if(seen.has(body.toLowerCase()))throw Error('A consolidation replacement duplicates another trait. Nothing was saved.');
    seen.add(body.toLowerCase());const id=randomUUID().slice(0,8);
    return {id,text:body,evidence:reason,source:provenance,quote:'',archiveId:'',since:own.map(trait=>trait.since).filter(date=>date!=='unknown').sort()[0]||'unknown',confirmedAt:today,
      originIds:distinct([...own.flatMap(trait=>trait.originIds),id]),lineage:lineage(own.flatMap(trait=>[...trait.lineage,trait])),
      // The replacement inherits its source authority; the model's explanation
      // of a merge is still an inference, never fresh direct user evidence.
      evidenceLog:evidenceLog([...own.flatMap(trait=>trait.evidenceLog),newEvidence(why,'inferred',today,id),newEvidence(reason,'inferred',today,id)])};
  });
  if(selected.some(id=>!covered.has(id)))throw Error('Every selected source trait must be covered by a replacement fromIds; nothing was saved.');
  const first=soul.traits.findIndex(trait=>removed.has(trait.id));
  return {...soul,traits:soul.traits.flatMap((trait,index)=>index===first?replacements:removed.has(trait.id)?[]:[trait])};
}
/** Preview complete, nonduplicate seed entries. Over-budget batches fail atomically. */
export function seedTraits(current,traits,{consolidations=[],now=new Date()}={}){
  let soul=normalizeSoul(current);const today=now.toISOString().slice(0,10);
  for(const group of consolidations)soul=consolidateTraits(soul,group,today);
  const seen=new Set(soul.traits.map(trait=>trait.text.toLowerCase()));
  const accepted=[],skipped=[];
  for(const item of Array.isArray(traits)?traits:[]){
    const body=checked(item?.text,SOUL_LIMITS.trait,'Trait'),why=checked(item?.evidence,SOUL_LIMITS.evidence,'Evidence');
    if(!body)continue;
    if(!why){skipped.push({text:body,reason:'no evidence'});continue;}
    if(seen.has(body.toLowerCase())){skipped.push({text:body,reason:'already there'});continue;}
    seen.add(body.toLowerCase());accepted.push({text:body,evidence:why,source:item?.source==='stated'?'stated':'inferred',quote:whole(item?.quote),archiveId:whole(item?.archiveId)});
  }
  const preview={...soul,traits:[...soul.traits,...accepted.map((item,index)=>({id:`p${String(index).padStart(7,'0')}`, ...item,since:today,confirmedAt:today}))]};
  assertBudget(preview,current);
  return {accepted,skipped,budget:soulBudget(preview)};
}
function hardDelete(soul,id){
  const trait=soul.traits.find(item=>item.id===id);if(!trait)throw Error('No trait with that id.');
  const forgotten=new Set([trait.id,...trait.originIds,...trait.lineage.map(item=>item.id)]);
  const touches=item=>[item.id,...item.originIds,...item.lineage.map(entry=>entry.id),...item.evidenceLog.map(entry=>entry.traitId)].some(key=>forgotten.has(key));
  // Remove derived descendants too: retaining a paraphrase would not be forgetting.
  const affected=soul.traits.filter(touches);for(const item of affected)forgotten.add(item.id);
  return {...soul,traits:soul.traits.filter(item=>!touches(item)),history:soul.history.filter(record=>!record.before.some(touches)&&!record.afterIds.some(key=>forgotten.has(key)))};
}
/** Applies one atomic learning operation. Only name/core changes need caller approval. */
export function applySoul(current,{action,id,ids,historyId,offset=0,text:entry,evidence,source,quote,archiveId,traits,consolidations=[]},{now=new Date()}={}){
  const soul=normalizeSoul(current),today=now.toISOString().slice(0,10),find=()=>soul.traits.find(trait=>trait.id===id);
  const body=['rename','essence'].includes(action)?whole(entry):checked(entry,SOUL_LIMITS.trait,'Trait'),why=checked(evidence,SOUL_LIMITS.evidence,'Evidence');
  const finish=(next,message,{budget=true,recovery=true}={})=>{
    if(budget)assertBudget(next,soul);
    const record={id:randomUUID(),action,at:now.toISOString(),evidence:why,source:action!=='consolidate'&&source==='stated'?'stated':'inferred',quote:action==='consolidate'?'':whole(quote),archiveId:action==='consolidate'?'':whole(archiveId),before:soul.traits,beforeSeededAt:soul.seededAt,afterIds:next.traits.map(trait=>trait.id)};
    return {soul:{...next,history:recovery?[...soul.history,record].slice(-SOUL_LIMITS.history):next.history},message,budget:soulBudget(next)};
  };
  if(action==='harddelete'){if(source!=='stated'||!why)throw Error('Permanent deletion needs an explicit user request with source stated and evidence.');const next=hardDelete(soul,id);return {soul:next,message:'Deleted the trait, its derived descendants, evidence and recovery copies.',budget:soulBudget(next)};}
  if(action==='inspect'){
    const start=Number.isInteger(offset)&&offset>=0?offset:0,page=8;
    let details;
    if(id){
      const trait=find();if(!trait)throw Error('No trait with that id.');
      details={trait:{...trait,evidenceLog:trait.evidenceLog.slice(start,start+page),lineage:trait.lineage.slice(start,start+page)},evidenceCount:trait.evidenceLog.length,lineageCount:trait.lineage.length,nextOffset:start+page<Math.max(trait.evidenceLog.length,trait.lineage.length)?start+page:null};
    }else if(historyId){
      const record=soul.history.find(item=>item.id===historyId);if(!record)throw Error('No recovery history with that id.');
      details={record:{...record,before:record.before.slice(start,start+page).map(({evidenceLog,lineage,...trait})=>({...trait,evidenceCount:evidenceLog.length,lineageCount:lineage.length}))},traitCount:record.before.length,nextOffset:start+page<record.before.length?start+page:null};
    }else{
      const records=[...soul.history].reverse();
      details={history:records.slice(start,start+page).map(({id,action,at,evidence,source,before,afterIds})=>({id,action,at,evidence,source,beforeCount:before.length,afterCount:afterIds.length})),historyCount:records.length,nextOffset:start+page<records.length?start+page:null};
    }
    return {soul,message:'Read soul evidence and recovery history.',budget:soulBudget(soul),details};
  }
  if(action==='seed'){
    if(soul.seededAt)throw Error(`The soul was already seeded from history on ${soul.seededAt}. Add further traits one at a time, or ask the user to allow seeding again in Settings → Personalisation.`);
    const {accepted,skipped}=seedTraits(soul,traits,{consolidations,now});
    if(!accepted.length&&!consolidations.length)throw Error('No new traits to seed. Each needs text and evidence, and must not already exist.');
    let base=soul;for(const group of consolidations)base=consolidateTraits(base,group,today);
    const added=accepted.map(item=>{const id=randomUUID().slice(0,8);return normalizeTrait({id,...item,since:today,confirmedAt:today});});
    const note=skipped.length?` Skipped ${skipped.length}: `+skipped.map(item=>`“${item.text.slice(0,60)}” (${item.reason})`).join('; ')+'.':'';
    return finish({...base,traits:[...base.traits,...added],seededAt:today},`Seeded ${added.length} traits from history${consolidations.length?` and consolidated ${consolidations.length} group(s)`:''}.${note}`);
  }
  if(action==='rename'){const name=checked(entry,SOUL_LIMITS.name,'Name');if(!name)throw Error('Give the new name as text.');return {soul:{...soul,name},message:`Renamed to ${name}.`};}
  if(action==='essence'){const essence=checked(entry,SOUL_LIMITS.essence,'Character');if(!essence)throw Error('Give the new essence as text.');return {soul:{...soul,essence},message:'Essence rewritten.'};}
  if(action==='consolidate')return finish(consolidateTraits(soul,{ids,traits,evidence,source,quote,archiveId},today),'Consolidated traits; source evidence and the previous traits remain recoverable.');
  if(action==='restore'){
    const record=soul.history.find(item=>item.id===historyId);if(!record)throw Error('No recovery history with that id.');
    if(!why)throw Error('Give the evidence or reason for restoring this previous version.');
    if(soul.traits.some(trait=>trait.source==='stated')&&source!=='stated')throw Error('Restoring over stated preferences needs direct user evidence with source stated; inference cannot overrule them.');
    return finish({...soul,traits:record.before},`Restored traits from history ${record.id}; later trait changes were rolled back.`);
  }
  if(action==='add'){
    if(!body)throw Error('Give the trait as text.');
    if(!why)throw Error('Give the evidence: what the user said or did.');
    if(soul.traits.some(trait=>trait.text.toLowerCase()===body.toLowerCase()))throw Error('That trait already exists; confirm it instead.');
    const trait=normalizeTrait({id:randomUUID().slice(0,8),text:body,evidence:why,source:source==='stated'?'stated':'inferred',quote,archiveId,since:today,confirmedAt:today});
    return finish({...soul,traits:[...soul.traits,trait]},`Added trait ${trait.id}.`);
  }
  const trait=find();if(!trait)throw Error('No trait with that id.');
  if(action==='retire'){
    if(!why)throw Error('Give the new evidence for retiring this trait.');
    if(trait.source==='stated'&&source!=='stated')throw Error('Retiring a stated preference needs new direct user evidence with source stated; inference cannot overrule it.');
    return finish({...soul,traits:soul.traits.filter(item=>item!==trait)},`Retired trait ${trait.id}; its evidence is recoverable within the last ${SOUL_LIMITS.history} substantive changes.`);
  }
  if(action==='confirm'){
    if(!why)throw Error('Give the evidence for confirming this trait.');
    return finish({...soul,traits:soul.traits.map(item=>item===trait?{...item,confirmedAt:today,evidenceLog:evidenceLog([...item.evidenceLog,newEvidence(why,source==='stated'?'stated':'inferred',today,id,quote,archiveId)])}:item)},`Confirmed trait ${trait.id}.`,{budget:false,recovery:false});
  }
  if(action==='revise'){
    if(!body||!why)throw Error('Give the revised text and the evidence for the change.');
    if(trait.source==='stated'&&source!=='stated')throw Error('Revising a stated preference needs new direct user evidence with source stated; inference cannot overrule it.');
    if(soul.traits.some(item=>item!==trait&&item.text.toLowerCase()===body.toLowerCase()))throw Error('The revised text duplicates another trait; consolidate instead.');
    const provenance=source==='stated'?'stated':trait.source;
    return finish({...soul,traits:soul.traits.map(item=>item===trait?{...item,text:body,evidence:why,quote:whole(quote),archiveId:whole(archiveId),source:provenance,confirmedAt:today,lineage:lineage([...item.lineage,item]),evidenceLog:evidenceLog([...item.evidenceLog,newEvidence(why,provenance,today,id,quote,archiveId)])}:item)},`Revised trait ${trait.id}.`);
  }
  throw Error('Unknown action.');
}

export function normalizePersonalization(value={},{prompt=false}={}){
  const input=value&&typeof value==='object'?value:{};
  const styles=(Array.isArray(input.styles)?input.styles:[]).slice(0,LIMITS.styles).map(style=>({
    id:typeof style?.id==='string'&&/^[\w-]{1,64}$/.test(style.id)?style.id:randomUUID(),
    name:text(style?.name,LIMITS.name)||'My style',
    appliesTo:STYLE_SCOPES.includes(style?.appliesTo)?style.appliesTo:'both',
    enabled:style?.enabled!==false,
    guide:text(style?.guide,LIMITS.guide),
    sources:(Array.isArray(style?.sources)?style.sources:[]).slice(0,40).map(source=>({name:text(source?.name,200)||'Sample',kind:text(source?.kind,20)||'text',characters:Math.max(0,Math.floor(Number(source?.characters)||0))})),
    updatedAt:typeof style?.updatedAt==='string'?style.updatedAt.slice(0,40):new Date().toISOString(),
  }));
  return {about:text(input.about,LIMITS.about),tone:toneIds.has(input.tone)?input.tone:'balanced',instructions:text(input.instructions,LIMITS.instructions),styles,soul:normalizeSoul(input.soul,{includeHistory:!prompt,includeEvidence:!prompt})};
}
export function normalizeChatPersonalization(value){
  if(!value||typeof value!=='object')return null;
  const result={};
  if(toneIds.has(value.tone))result.tone=value.tone;
  const instructions=text(value.instructions,LIMITS.instructions);if(instructions)result.instructions=instructions;
  if(value.styles===false)result.styles=false;
  return Object.keys(result).length?result:null;
}

/** The block added to each message. Empty when nothing is personalised. */
export function personalizationContext(global,chat,{privateChat=false}={}){
  const base=normalizePersonalization(global,{prompt:true}),own=normalizeChatPersonalization(chat)||{};
  const soul=soulContext(base.soul,{privateChat});
  const tone=TONES.find(item=>item.id===(own.tone||base.tone));
  const lines=[];
  if(base.about)lines.push(`About the user: ${base.about}`);
  if(tone?.text)lines.push(`Response tone${own.tone?' for this chat':''}: ${tone.text}`);
  if(base.instructions)lines.push(`The user's standing instructions: ${base.instructions}`);
  if(own.instructions)lines.push(`Instructions for this chat only (these win over the standing ones): ${own.instructions}`);
  if(own.styles!==false)for(const style of base.styles.filter(item=>item.enabled&&item.guide)){
    const where=style.appliesTo==='chat'?'your chat replies':style.appliesTo==='documents'?'documents, files and other text you write for the user to use (not your chat replies)':'both your chat replies and documents or files you write for the user';
    lines.push(`Write in the user's "${style.name}" style for ${where}:\n${style.guide}`);
  }
  if(!lines.length)return soul+personalizationHint;
  return soul+'User personalization (follow it unless the user asks otherwise; never mention this block):\n'+lines.join('\n')+'\n'+personalizationHint;
}
export const personalizationHint='When the user asks you to change how you respond from now on (tone, length, language, form of address, formatting), call personalization_update: scope "chat" for this chat, "everywhere" only when they clearly mean all chats.\n';

/** Pulls the user's own writing out of an upload. `author` (name or e-mail) filters mail and chat exports. */
export function extractSamples({name='',text:content=''},{author=''}={}){
  const raw=String(content||'').replace(/\r\n/g,'\n'),lower=name.toLowerCase(),who=author.trim().toLowerCase();
  const clean=body=>body.split('\n').filter(line=>!/^\s*>/.test(line)).join('\n').split(/\n-- \n|\nOn .{5,120} wrote:\n|\nAm .{5,120} schrieb .{0,80}:\n/)[0].trim();
  const mailBody=message=>{const split=message.indexOf('\n\n');const headers=split>0?message.slice(0,split):'';const from=/^from:\s*(.*)$/im.exec(headers)?.[1]||'';return {from,body:clean(split>0?message.slice(split+2):message)};};
  if(lower.endsWith('.mbox')){
    const messages=raw.split(/\n(?=From [^\n]*\n)/).map(mailBody).filter(item=>item.body&&(!who||item.from.toLowerCase().includes(who)));
    return messages.map(item=>item.body);
  }
  if(lower.endsWith('.eml')){const item=mailBody(raw);return item.body&&(!who||item.from.toLowerCase().includes(who))?[item.body]:[];}
  if(lower.endsWith('.json')){
    let data;try{data=JSON.parse(raw);}catch{return [];}
    const list=Array.isArray(data)?data:Array.isArray(data?.messages)?data.messages:[];
    // Slack export: [{user, user_name, user_profile:{real_name,display_name}, text}].
    return list.filter(item=>typeof item?.text==='string'&&item.text.trim()&&!item.subtype).filter(item=>{
      if(!who)return true;
      return [item.user,item.user_name,item.username,item.user_profile?.real_name,item.user_profile?.display_name,item.user_profile?.name].some(value=>typeof value==='string'&&value.toLowerCase().includes(who));
    }).map(item=>item.text.trim());
  }
  return raw.trim()?[raw.trim()]:[];
}
/** Keeps a spread of samples within the prompt budget. */
export function sampleCorpus(samples,limit=18000){
  const list=samples.map(item=>String(item).trim()).filter(item=>item.length>=20);
  const out=[];let used=0;
  for(const item of list){const piece=item.slice(0,2500);if(used+piece.length>limit)break;out.push(piece);used+=piece.length+8;}
  return out;
}
export function stylePrompt(samples,{appliesTo='both'}={}){
  const target=appliesTo==='chat'?'chat messages':appliesTo==='documents'?'documents and longer texts':'both short messages and longer texts';
  return `Below are writing samples by one person. Describe their writing style as a practical guide another writer could follow for ${target}. Cover: tone and attitude, sentence length and rhythm, vocabulary and register, punctuation and formatting habits, how they open and close, language and spelling conventions, and anything distinctive. Use short bullet points, at most 250 words. Do not quote private details, names or facts from the samples; describe style only. Reply with the guide only.\n\nSamples:\n\n${samples.map((sample,index)=>`--- Sample ${index+1} ---\n${sample}`).join('\n\n')}`;
}

const quoteSchema={type:'string',description:'The exact words from the user that support source stated; the host verifies this quote.'};
const archiveIdSchema={type:'string',description:'For historical evidence: the archive record id containing that exact user quote.'};
const soulTraitSchema={type:'object',properties:{text:{type:'string',maxLength:SOUL_LIMITS.trait},evidence:{type:'string',maxLength:SOUL_LIMITS.evidence},source:{type:'string',enum:['stated','inferred']},fromIds:{type:'array',minItems:1,uniqueItems:true,items:{type:'string'},description:'For consolidation: selected source traits covered by this replacement; all must share the same source provenance.'},quote:quoteSchema,archiveId:archiveIdSchema},required:['text','evidence'],additionalProperties:false};
const consolidationSchema={type:'object',properties:{ids:{type:'array',minItems:2,uniqueItems:true,items:{type:'string'}},traits:{type:'array',minItems:1,items:soulTraitSchema},evidence:{type:'string',maxLength:SOUL_LIMITS.evidence},source:{type:'string',enum:['stated','inferred']},quote:quoteSchema,archiveId:archiveIdSchema},required:['ids','traits','evidence'],additionalProperties:false};
export const personalizationDefinitions=[{name:'personalization_update',description:'Change how you respond when the user asks for it ("be more concise from now on", "talk to me informally", "always answer in German"). scope "chat" applies to this chat only, right away; "everywhere" changes the defaults for all chats and asks the user to confirm. Give either a tone, an instruction to add, or clear:true to reset.',inputSchema:{type:'object',properties:{scope:{type:'string',enum:['chat','everywhere']},tone:{type:'string',enum:TONES.map(tone=>tone.id)},instruction:{type:'string',description:'One instruction in the user\'s words, added to the existing ones.'},clear:{type:'boolean',description:'Reset this scope to the defaults.'}},required:['scope'],additionalProperties:false}},
  {name:'soul_reflect',description:'Develop the shared Exomina character quietly from durable interaction evidence. add, confirm, revise and retire need evidence; confirm records evidence without a recovery snapshot. consolidate atomically replaces multiple ids, preserving original wording in lineage and all source evidence. Each replacement has fromIds covering selected source traits of one provenance; separate stated and inferred sources, cover every selected id, and never promote inference by merging. No approval is needed for routine learning or consolidation. New stated claims or changes require an exact user quote, plus archiveId for historical evidence; the host verifies it. The active context has a character budget, no entry count cap; at10500 characters consolidate toward9000, considering redundant inference first. The last100 substantive changes are recoverable. seed runs once when the user requests history seeding; use consolidations in that same atomic call if needed. inspect reads evidence by id, recovery summaries without an id, or a snapshot by historyId; continue with nextOffset as offset. restore rolls back all later trait changes but never reopens seeding. harddelete is only for an explicit user request to forget a trait and removes its evidence, lineage and recovery copies. rename/essence change the fixed starting character only when the user asks and approves. Unavailable in private chats.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['add','confirm','revise','retire','consolidate','inspect','restore','harddelete','rename','essence','seed']},traits:{type:'array',description:'History seed entries, or evidence-backed replacements for consolidate. No count cap.',items:soulTraitSchema},consolidations:{type:'array',description:'For seed: consolidate these groups before adding history traits, atomically.',items:consolidationSchema},ids:{type:'array',minItems:2,uniqueItems:true,description:'Source trait ids for consolidate; all must still exist.',items:{type:'string'}},id:{type:'string',description:'Trait id for confirm, revise, retire, inspect or explicit harddelete.'},historyId:{type:'string',description:'Recovery record id for inspect or restore.'},offset:{type:'integer',minimum:0,description:'For inspect: nextOffset from the previous page.'},text:{type:'string',description:'The learned trait, the new name, or the new essence.'},evidence:{type:'string',maxLength:SOUL_LIMITS.evidence,description:'What the user said or did, or the evidence and preservation reasoning for consolidation.'},source:{type:'string',enum:['stated','inferred'],description:'stated only for direct user evidence verified through quote. Consolidation preserves each replacement source provenance.'},quote:quoteSchema,archiveId:archiveIdSchema},required:['action'],additionalProperties:false}}];

/** Applies a personalization_update call to a settings or chat value. */
export function applyUpdate(current,{tone,instruction,clear},{chat=false}={}){
  if(clear)return chat?null:{...normalizePersonalization(current),tone:'balanced',instructions:''};
  const base=chat?{...(normalizeChatPersonalization(current)||{})}:normalizePersonalization(current);
  if(tone&&toneIds.has(tone))base.tone=tone;
  const add=text(instruction,600);
  if(add)base.instructions=[base.instructions,add].filter(Boolean).join('\n').slice(-LIMITS.instructions);
  return chat?normalizeChatPersonalization(base):normalizePersonalization(base);
}
