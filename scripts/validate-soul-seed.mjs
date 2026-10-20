// Verify the prepared evidence against authorized workspace exports, not app stores.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {applySoul,soulBudget} from '../desktop/personalization.mjs';
import {assertStatedQuote} from '../desktop/soul-service.mjs';
const work=path.resolve('../Workspace/soul-evolution-20261017'),dir=path.join(work,'archive');
const request=JSON.parse(await readFile(path.join(work,'seed-ready.json'),'utf8')),files=await readdir(dir),verified=[];
for(const item of request.traits){
 if(item.source!=='stated')continue;
 const parts=files.filter(name=>name===item.archiveId+'.txt'||name.startsWith(item.archiveId+'.part-')).sort((a,b)=>Number(a.match(/part-(\d+)/)?.[1]||0)-Number(b.match(/part-(\d+)/)?.[1]||0));assert.ok(parts.length,item.archiveId);
 const text=(await Promise.all(parts.map(file=>readFile(path.join(dir,file),'utf8')))).join('');
 const userTexts=[...text.matchAll(/\[user ·[^\n]*\]\n([\s\S]*?)(?=\n\[(?:user|assistant|system|tool) ·|$)/g)].map(match=>match[1]);
 assertStatedQuote(item,userTexts);verified.push({archiveId:item.archiveId,quote:item.quote});
}
const existing={traits:[
 {id:'7671b0df',source:'stated',text:'Disagree with reasons when warranted, without sycophancy or reflexive agreement. Do not manufacture objections or push back merely for its own sake.'},
 {id:'2b4fcbd1',source:'stated',text:'Never use em-dashes, and avoid "That\'s not X, that\'s Y" constructions.'},
 {id:'4bec0ce7',source:'stated',text:'For conversation and creative or philosophical topics, use erudite, flowing, lyrical prose with complex sentences and depth. Prefer prose over lists unless asked. Keep meaning clear; erudition must never excuse obfuscation.'},
 {id:'886126c9',source:'inferred',text:'For technical status reports on Exomina work, keep it plain and scannable: what changed, what was verified, what was not.'},
 {id:'8a9ece5a',source:'stated',text:'Allow occasional irony or sarcasm within an overall empathetic tone.'},
 {id:'6af57554',source:'stated',text:'Give extensive, genuinely engaged answers when the topic invites depth, rather than thin summaries.'},
]};
const result=applySoul(existing,request),budget=soulBudget(result.soul);assert.ok(!budget.overBudget);assert.ok(result.soul.traits.length>24);assert.ok(budget.used<budget.target);
const report={passed:true,note:'Dry run against the six known existing traits, not a live settings read or mutation.',verifiedStatedQuotes:verified,traitsToAdd:request.traits.length,resultingTraits:result.soul.traits.length,budget,liveSeedApplied:false};
await writeFile(path.join(work,'seed-validation.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({...report,verifiedStatedQuotes:verified.length}));
