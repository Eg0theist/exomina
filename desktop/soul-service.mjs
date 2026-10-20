import {applySoul,normalizePersonalization,soulBudget} from './personalization.mjs';

/** Routine learning is quiet. Only a requested name/core rewrite has an approval step. */
export async function reflectSoul(args,{isPrivate,getPersonalization,setPersonalization,save,approve,changed,verifyStated}){
  if(isPrivate())throw Error('The soul is not changed from private chats.');
  let current=normalizePersonalization(getPersonalization());
  if(!current.soul.enabled)throw Error('The soul is switched off in Settings → Personalisation.');
  const preview=applySoul(current.soul,args);
  if(args.action==='inspect')return {content:[{type:'text',text:JSON.stringify({message:preview.message,budget:preview.budget,details:preview.details})}]};
  if(args.action==='harddelete'&&args.source!=='stated')throw Error('Permanent deletion needs an explicit user request with source stated and its quote.');
  if(verifyStated){
    if(args.action==='seed'){
      for(const item of args.traits||[])if(item.source==='stated')await verifyStated(item);
    }else if(args.source==='stated'&&['add','confirm','revise','retire','harddelete','restore'].includes(args.action))await verifyStated(args);
  }
  if(['rename','essence'].includes(args.action)){
    const decision=await approve({title:args.action==='rename'?`Rename your AI to “${preview.soul.name}”?`:'Rewrite your AI’s core character?',action:{kind:'memory',tool:'soul_reflect',target:args.action},detail:args.action==='rename'?preview.soul.name:preview.soul.essence});
    if(!decision.approved)return {content:[{type:'text',text:decision.message?'The user declined: '+decision.message:'The user declined. Nothing changed.'}]};
  }
  // An approval can outlive changes made in Settings or another chat.
  if(isPrivate())throw Error('The soul is not changed from private chats.');
  current=normalizePersonalization(getPersonalization());
  if(!current.soul.enabled)throw Error('The soul is switched off in Settings → Personalisation.');
  const result=applySoul(current.soul,args);
  setPersonalization({...current,soul:result.soul});
  await save();changed?.();
  const budget=soulBudget(result.soul);
  return {content:[{type:'text',text:result.message+' Takes effect from the next message. No need to announce routine learning.'}],budget};
}

/** UI operations apply to current host state, never a stale renderer snapshot. */
export function changeSoulFromSettings(current,args){
  const next=normalizePersonalization(current);
  if(args.action==='patch'){
    const patch=args.patch||{};
    for(const key of Object.keys(patch))if(!['enabled','name','essence','seededAt'].includes(key))throw Error('Invalid soul setting.');
    if('enabled'in patch){if(typeof patch.enabled!=='boolean')throw Error('Invalid soul switch.');next.soul.enabled=patch.enabled;}
    if('name'in patch)next.soul=applySoul(next.soul,{action:'rename',text:patch.name}).soul;
    if('essence'in patch)next.soul=applySoul(next.soul,{action:'essence',text:patch.essence}).soul;
    if('seededAt'in patch){if(patch.seededAt!==null)throw Error('Only resetting history seeding is allowed here.');next.soul.seededAt=null;}
  }else{
    if(!['harddelete','retire','restore','revise'].includes(args.action))throw Error('Invalid soul edit.');
    next.soul=applySoul(next.soul,{...args,source:'stated',evidence:args.action==='restore'?'The user rolled back to this version in Settings.':args.action==='harddelete'?'The user permanently deleted this observation in Settings.':'The user edited this observation in Settings.'}).soul;
  }
  return next;
}

/** A source label alone is insufficient: match a quoted span in user-authored text. */
export function assertStatedQuote(entry,userTexts){
  const quote=typeof entry.quote==='string'?entry.quote.trim():'';
  if(quote.length<12||!userTexts.some(value=>typeof value==='string'&&value.includes(quote)))throw Error('A stated preference needs quote (at least 12 characters) matching an actual user message. Use inferred for an interpretation.');
}
