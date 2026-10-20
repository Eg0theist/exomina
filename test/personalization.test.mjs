import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePersonalization,normalizeSoul,soulBudget,SOUL_LIMITS,personalizationDefinitions,personalizationContext,applyUpdate,applySoul,seedTraits,extractSamples,sampleCorpus,stylePrompt} from '../desktop/personalization.mjs';
import {claudeUsage,codexUsage,usageWarnings,UsageTracker} from '../desktop/usage.mjs';

test('personalisation becomes one context block; chat settings win over defaults', ()=>{
  const settings={about:'Writer in Example City.',tone:'concise',instructions:'Avoid lists.',styles:[{id:'s1',name:'Essay',appliesTo:'documents',guide:'- Long, lyrical sentences.'},{id:'s2',name:'Off',enabled:false,guide:'x'}]};
  const block=personalizationContext(settings,{tone:'warm',instructions:'Answer in German.'});
  assert.match(block,/About the user: Writer in Example City\./);
  assert.match(block,/Response tone for this chat: Be warm/);assert.doesNotMatch(block,/Be brief/);
  assert.match(block,/Avoid lists\./);assert.match(block,/this chat only.*Answer in German\./);
  assert.match(block,/"Essay" style for documents, files/);assert.doesNotMatch(block,/"Off"/);
  assert.doesNotMatch(personalizationContext(settings,{styles:false}),/Essay/);
  assert.match(personalizationContext({},null),/personalization_update/);
});

test('"from now on" updates add to instructions, and clear resets', ()=>{
  const chat=applyUpdate(null,{instruction:'Be more casual.'},{chat:true});
  assert.deepEqual(chat,{instructions:'Be more casual.'});
  assert.equal(applyUpdate(chat,{instruction:'Use du.'},{chat:true}).instructions,'Be more casual.\nUse du.');
  assert.equal(applyUpdate(chat,{clear:true},{chat:true}),null);
  const global=applyUpdate({tone:'formal',instructions:'A'},{tone:'direct'});
  assert.equal(global.tone,'direct');assert.equal(global.instructions,'A');
  assert.equal(normalizePersonalization({tone:'shouty'}).tone,'balanced');
});

test('the soul is shared by every chat, learns per user and stays out of private chats', ()=>{
  const fresh=personalizationContext({},null);
  assert.match(fresh,/you are Vesper\./);assert.match(fresh,/soul_reflect/);
  let {soul}=applySoul(undefined,{action:'add',text:'Wants pushback with reasons, not agreement.',evidence:'Asked to avoid sycophancy.',source:'stated'},{now:new Date('2026-10-17T12:00:00Z')});
  const [trait]=soul.traits;
  assert.equal(trait.source,'stated');assert.equal(trait.confirmedAt,'2026-10-17');
  const block=personalizationContext({soul},null);
  assert.match(block,new RegExp(`\\[${trait.id}, stated, confirmed 2026-10-17\\] Wants pushback`));
  const hidden=personalizationContext({soul},null,{privateChat:true});
  assert.match(hidden,/you are Vesper\./);assert.doesNotMatch(hidden,/Wants pushback|soul_reflect/);
  assert.equal(personalizationContext({soul:{...soul,enabled:false}},null).includes('Vesper'),false);
  assert.throws(()=>applySoul(soul,{action:'add',text:'Likes brevity.'}),/evidence/);
  assert.throws(()=>applySoul(soul,{action:'add',text:'wants pushback with reasons, not agreement.',evidence:'x'}),/already exists/);
  soul=applySoul(soul,{action:'revise',id:trait.id,text:'Wants pushback with reasons.',evidence:'Corrected it.',source:'stated'},{now:new Date('2026-10-20T00:00:00Z')}).soul;
  assert.equal(soul.traits[0].text,'Wants pushback with reasons.');assert.equal(soul.traits[0].source,'stated');assert.equal(soul.traits[0].confirmedAt,'2026-10-20');
  assert.equal(applySoul(soul,{action:'retire',id:trait.id,evidence:'The user asked to remove it.',source:'stated'}).soul.traits.length,0);
  assert.throws(()=>applySoul(soul,{action:'retire',id:'missing'}),/No trait/);
  const full={traits:Array.from({length:24},(_,index)=>({id:`t${index}`,text:`Trait ${index}`,since:'2026-10-01'}))};
  assert.equal(applySoul(full,{action:'add',text:'One more.',evidence:'x'}).soul.traits.length,25);
  assert.equal(applySoul(soul,{action:'rename',text:'Wren'}).soul.name,'Wren');
  assert.equal(normalizePersonalization({soul:{name:'',essence:''}}).soul.name,'Vesper');
});

test('seeding from history has no trait-count cap and reports duplicates and missing evidence', ()=>{
  const start={traits:[{id:'old',text:'Wants pushback with reasons.',since:'2026-10-17'}]};
  const batch=[{text:'wants pushback with reasons.',evidence:'x'},{text:'Exact build status.',evidence:'Asked repeatedly.',source:'stated'},{text:'No evidence.'},
    ...Array.from({length:25},(_,index)=>({text:`History trait ${index}`,evidence:'Archive.'}))];
  assert.deepEqual(seedTraits(start,batch).accepted.length,26);
  const {soul,message}=applySoul(start,{action:'seed',traits:batch},{now:new Date('2026-10-17T18:00:00Z')});
  assert.equal(soul.traits.length,27);assert.equal(soul.seededAt,'2026-10-17');
  assert.equal(soul.traits[1].source,'stated');assert.equal(soul.traits[2].source,'inferred');
  assert.match(message,/Seeded 26 traits.*already there.*no evidence/);assert.doesNotMatch(message,/trait limit/);
  assert.throws(()=>applySoul(soul,{action:'seed',traits:[{text:'Again.',evidence:'x'}]}),/already seeded.*2026-10-17/);
  assert.equal(normalizePersonalization({soul}).soul.seededAt,'2026-10-17');
  assert.equal(applySoul({...soul,seededAt:null,traits:[]},{action:'seed',traits:[{text:'Again.',evidence:'x'}]}).soul.traits.length,1);
  assert.throws(()=>applySoul(undefined,{action:'seed',traits:[]}),/No new traits/);
});

test('the length budget counts prompt labels and preserves legacy content without truncation', ()=>{
  const legacy={traits:Array.from({length:40},(_,index)=>({id:`t${index}`,text:`${index}: ${'x'.repeat(350)}`,evidence:'e'.repeat(500),source:'stated',since:'2026-01-01'}))};
  const normalized=normalizeSoul(legacy),budget=soulBudget(normalized);
  assert.equal(normalized.traits.length,40);assert.equal(normalized.traits[0].text,legacy.traits[0].text);assert.equal(normalized.traits[0].evidence.length,500);
  assert.equal(budget.budget,SOUL_LIMITS.activeChars);assert.equal(budget.target,SOUL_LIMITS.targetChars);assert.equal(budget.overBudget,true);
  assert.ok(budget.used>normalized.traits.reduce((total,trait)=>total+trait.text.length,0),'labels consume the active context budget too');
  const before=JSON.stringify(legacy);
  assert.throws(()=>applySoul(legacy,{action:'add',text:'Extra.',evidence:'New request.'}),/nothing was saved/i);
  assert.equal(JSON.stringify(legacy),before);
  assert.throws(()=>applySoul({}, {action:'add',text:'x'.repeat(SOUL_LIMITS.trait+1),evidence:'x'}),/not saved or truncated/);
  const definition=personalizationDefinitions.find(item=>item.name==='soul_reflect');
  assert.equal(definition.inputSchema.properties.traits.maxItems,undefined);
  assert.match(personalizationContext({soul:normalized},null),/routine evolution needs no user prompt or approval/);
  assert.doesNotMatch(personalizationContext({soul:normalized},null),/6.*hour|24 traits/);
});

test('consolidation is atomic, retains stated provenance and all source evidence, and is recoverable', ()=>{
  const current={traits:[
    {id:'a',text:'Use prose for philosophy.',evidence:'Asked for prose.',source:'stated',since:'2026-01-02'},
    {id:'b',text:'Use a lyrical philosophical register.',evidence:'Requested lyrical passages.',source:'stated',since:'2026-02-03'},
    {id:'c',text:'Keep technical status plain.',evidence:'Asked for exact build status.',source:'stated',since:'2026-03-04'},
  ]};
  const request={action:'consolidate',ids:['a','b'],source:'stated',quote:'Unsupported newly invented merge quote.',evidence:'Both concern the same philosophical response style; retain prose and lyrical register.',traits:[{text:'For philosophy, use flowing, lyrical prose.',evidence:'Preserves both source preferences.',source:'stated'}]};
  const original=JSON.stringify(current),{soul,budget}=applySoul(current,request,{now:new Date('2026-10-17T20:00:00Z')});
  assert.equal(JSON.stringify(current),original);assert.equal(soul.traits.length,2);assert.equal(budget.traitCount,2);
  const combined=soul.traits[0];assert.equal(combined.source,'stated');assert.equal(combined.since,'2026-01-02');
  assert.ok(combined.originIds.includes('a'));assert.ok(combined.originIds.includes('b'));
  assert.ok(combined.evidenceLog.some(item=>item.evidence==='Asked for prose.'&&item.source==='stated'));
  assert.ok(combined.evidenceLog.some(item=>item.evidence==='Requested lyrical passages.'&&item.source==='stated'));
  assert.equal(combined.quote,'');assert.equal(combined.evidenceLog.some(item=>item.traitId===combined.id&&item.source==='stated'),false,'a model merge explanation is not new direct user evidence');
  assert.deepEqual(soul.history[0].before.map(trait=>trait.id),['a','b','c']);assert.deepEqual(soul.history[0].afterIds,soul.traits.map(trait=>trait.id));
  assert.equal(normalizeSoul(soul).history[0].before[0].evidence,'Asked for prose.');
  const restored=applySoul(soul,{action:'restore',historyId:soul.history[0].id,evidence:'The user selected the original wording.',source:'stated'}).soul;
  assert.deepEqual(restored.traits.map(trait=>trait.text),current.traits.map(trait=>trait.text));assert.equal(restored.history.length,2);
  assert.throws(()=>applySoul(current,{...request,ids:['a','missing']}),/stale/);
  assert.throws(()=>applySoul(current,{...request,ids:['a','a']}),/distinct/);
  assert.throws(()=>applySoul(current,{...request,traits:[{text:'Weaker inferred wording.',evidence:'Guess.',source:'inferred'}]}),/preserve each source provenance/);
  assert.throws(()=>applySoul(soul,request),/stale/);
  assert.equal(JSON.stringify(current),original);
});

test('directly stated preferences cannot be revised or retired by inference', ()=>{
  const current=applySoul({}, {action:'add',text:'Never use em dashes.',evidence:'The user explicitly requested this.',source:'stated'}).soul;
  const id=current.traits[0].id,original=JSON.stringify(current);
  assert.throws(()=>applySoul(current,{action:'revise',id,text:'Usually avoid em dashes.',evidence:'Seems flexible.',source:'inferred'}),/new direct user evidence/);
  assert.throws(()=>applySoul(current,{action:'retire',id,evidence:'Seems less important.',source:'inferred'}),/new direct user evidence/);
  assert.throws(()=>applySoul(current,{action:'retire',id,source:'stated'}),/new evidence/);
  assert.equal(JSON.stringify(current),original);
  const revised=applySoul(current,{action:'revise',id,text:'Em dashes are welcome in quoted material.',evidence:'The user explicitly changed their instruction.',source:'stated'}).soul;
  assert.equal(revised.traits[0].source,'stated');assert.equal(revised.traits[0].evidenceLog.length,2);
  assert.equal(revised.history[1].before[0].text,'Never use em dashes.');
});

test('seed can consolidate and add atomically, and stale or oversized batches save nothing', ()=>{
  const current={traits:Array.from({length:10},(_,index)=>({id:`t${index}`,text:`${index} ${'x'.repeat(1050)}`,evidence:`Source ${index}`,source:'stated',since:'2026-01-01'}))};
  const traits=Array.from({length:3},(_,index)=>({text:`New ${index} ${'y'.repeat(700)}`,evidence:'Fresh archive evidence.'}));
  const consolidation={ids:current.traits.map(trait=>trait.id),evidence:'The ten source entries repeat one preference, retained in the replacement.',traits:[{text:'One concise preference preserving all ten source constraints.',evidence:'Source entries are equivalent.'}]};
  const original=JSON.stringify(current);
  assert.throws(()=>applySoul(current,{action:'seed',traits}),/Consolidate/);
  const {soul}=applySoul(current,{action:'seed',traits,consolidations:[consolidation]});
  assert.equal(soul.traits.length,4);assert.equal(soulBudget(soul).overBudget,false);
  for(let index=0;index<10;index++)assert.ok(soul.traits[0].evidenceLog.some(item=>item.evidence===`Source ${index}`));
  assert.equal(soul.history[0].before.length,10);
  assert.throws(()=>applySoul(current,{action:'seed',traits,consolidations:[consolidation,{...consolidation,ids:['t0','missing']}]}),/stale/);
  assert.equal(JSON.stringify(current),original);
});

test('recovery keeps the latest 100 changes without dropping legacy history on load; inspect is read only and paginated', ()=>{
  const legacyHistory=Array.from({length:105},(_,index)=>({id:`h${index}`,action:'add',at:'2026-10-17T00:00:00Z',before:[],afterIds:[]}));
  const legacy={history:legacyHistory};assert.equal(normalizeSoul(legacy).history.length,105);
  const added=applySoul(legacy,{action:'add',text:'Keep reports exact.',evidence:'Explicit request.',source:'stated'}).soul;
  assert.equal(added.history.length,100);assert.equal(added.history[0].id,'h6');
  const original=JSON.stringify(added),inspection=applySoul(added,{action:'inspect'});
  assert.equal(inspection.details.history.length,8);assert.equal(inspection.details.historyCount,100);assert.equal(inspection.details.nextOffset,8);
  const second=applySoul(added,{action:'inspect',offset:inspection.details.nextOffset});
  assert.notEqual(second.details.history[0].id,inspection.details.history[0].id);
  const evidence=applySoul(added,{action:'inspect',id:added.traits[0].id}).details;
  assert.equal(evidence.trait.evidenceLog[0].evidence,'Explicit request.');assert.equal(evidence.nextOffset,null);
  assert.equal(JSON.stringify(added),original);
});

test('mixed-source consolidation partitions provenance, evidence and original wording by fromIds', ()=>{
  const current={traits:[
    {id:'s1',text:'Keep philosophy lyrical.',evidence:'Explicit lyricism request.',source:'stated'},
    {id:'s2',text:'Prefer prose for philosophy.',evidence:'Explicit prose request.',source:'stated'},
    {id:'i1',text:'Use plain technical reports.',evidence:'Inferred from status interactions.',source:'inferred'},
    {id:'i2',text:'Make status scannable.',evidence:'Inferred from technical responses.',source:'inferred'},
  ]};
  const request={action:'consolidate',ids:['s1','s2','i1','i2'],evidence:'Combine overlaps within each provenance.',traits:[
    {fromIds:['s1','s2'],text:'For philosophy, use lyrical prose.',evidence:'Retains both explicit conditions.'},
    {fromIds:['i1','i2'],text:'For technical status, use plain, scannable reports.',evidence:'Combines the two inferred observations.'},
  ]};
  const result=applySoul(current,request).soul;
  assert.deepEqual(result.traits.map(item=>item.source),['stated','inferred']);
  assert.deepEqual(result.traits[0].lineage.map(item=>item.id),['s1','s2']);
  assert.deepEqual(result.traits[1].lineage.map(item=>item.id),['i1','i2']);
  assert.equal(result.traits[0].evidenceLog.some(item=>item.traitId==='i1'),false);
  assert.equal(result.traits[1].evidenceLog.some(item=>item.traitId==='s1'),false);
  assert.throws(()=>applySoul(current,{...request,traits:[{text:'Everything combined.',evidence:'Guess.'}]}),/fromIds/);
  assert.throws(()=>applySoul(current,{...request,traits:[{fromIds:['s1','i1'],text:'Mixed.',evidence:'Guess.'}]}),/separate replacement/);
  assert.throws(()=>applySoul(current,{...request,traits:request.traits.slice(0,1)}),/Every selected source/);
  assert.throws(()=>applySoul(current,{...request,traits:[request.traits[0],{...request.traits[1],source:'stated'}]}),/provenance/);
});

test('legacy over-budget souls allow gradual reduction and net-shrinking seeds but reject growth', ()=>{
  const current={traits:Array.from({length:30},(_,index)=>({id:`old-${index}`,text:`${index}: ${'x'.repeat(450)}`,evidence:'Old observation.',source:'inferred',since:'2026-01-01'}))};
  assert.equal(soulBudget(current).overBudget,true);
  const retired=applySoul(current,{action:'retire',id:'old-0',evidence:'New interactions contradicted it.'}).soul;
  assert.equal(retired.traits.length,29);assert.equal(soulBudget(retired).overBudget,true);
  const consolidation={ids:['old-0','old-1'],evidence:'Both repeat the same observation.',traits:[{text:'One short observation.',evidence:'Retains their shared meaning.'}]};
  const consolidated=applySoul(current,{action:'consolidate',...consolidation}).soul;
  assert.ok(soulBudget(consolidated).used<soulBudget(current).used);assert.equal(soulBudget(consolidated).overBudget,true);
  const seeded=applySoul(current,{action:'seed',consolidations:[consolidation],traits:[{text:'A new concise observation.',evidence:'Fresh historical evidence.'}]}).soul;
  assert.ok(soulBudget(seeded).used<soulBudget(current).used);assert.equal(soulBudget(seeded).overBudget,true);
  assert.throws(()=>applySoul(current,{action:'add',text:'A growing observation.',evidence:'Fresh interaction.'}),/nothing was saved/);
});

test('legacy normalization has deterministic dates and unique stable fallback ids', ()=>{
  const current={traits:[{text:'Same anonymous observation.'},{text:'Same anonymous observation.'},{id:'duplicate',text:'First.'},{id:'duplicate',text:'Second.'}],history:[{action:'revise',before:[{text:'Original.'}]}]};
  const first=normalizeSoul(current),second=normalizeSoul(current);
  assert.deepEqual(first,second);assert.equal(new Set(first.traits.map(item=>item.id)).size,4);
  assert.equal(first.traits[0].since,'unknown');assert.equal(first.traits[0].confirmedAt,'unknown');
  assert.equal(first.traits[0].id,normalizeSoul(first).traits[0].id);
  assert.deepEqual(soulBudget(current),soulBudget(current));
});

test('confirmation requires evidence, preserves inferred provenance, deduplicates repeat evidence and makes no snapshots', ()=>{
  let soul=applySoul({}, {action:'add',text:'Use flowing prose.',evidence:'Direct original instruction.',source:'stated',quote:'Please use flowing prose in philosophical conversation.'}).soul;
  const id=soul.traits[0].id,historyCount=soul.history.length;
  assert.throws(()=>applySoul(soul,{action:'confirm',id}),/evidence for confirming/);
  soul=applySoul(soul,{action:'confirm',id,evidence:'Response was received well.'},{now:new Date('2026-10-18T00:00:00Z')}).soul;
  soul=applySoul(soul,{action:'confirm',id,evidence:'Response was received well.'},{now:new Date('2026-10-19T00:00:00Z')}).soul;
  assert.equal(soul.history.length,historyCount);assert.equal(soul.traits[0].source,'stated');
  const inferred=soul.traits[0].evidenceLog.filter(item=>item.evidence==='Response was received well.');
  assert.equal(inferred.length,1);assert.equal(inferred[0].source,'inferred');assert.equal(inferred[0].date,'2026-10-19');
  assert.equal(soul.traits[0].confirmedAt,'2026-10-19');
});

test('active context and budget never traverse recovery history or evidence logs', ()=>{
  const soul={traits:[{id:'active',text:'Keep reports plain.',source:'inferred',since:'2026-01-01'}]};
  Object.defineProperty(soul,'history',{get(){throw Error('history traversed');}});
  Object.defineProperty(soul.traits[0],'evidenceLog',{get(){throw Error('evidence traversed');}});
  assert.ok(soulBudget(soul).used>0);
  assert.match(personalizationContext({soul},null),/Keep reports plain/);
});

test('original stated wording and its evidence survive recovery retention', ()=>{
  const original=applySoul({}, {action:'add',text:'Never use em dashes.',evidence:'Direct original preference.',source:'stated',quote:'Never use em dashes when replying to me.'}).soul;
  const id=original.traits[0].id;
  const revised=applySoul(original,{action:'revise',id,text:'Use em dashes only inside direct quotations.',evidence:'User changed the scope.',source:'stated',quote:'Em dashes are allowed only inside direct quotations.'}).soul;
  const expanded={...revised,history:[...revised.history,...Array.from({length:100},(_,index)=>({id:`later-${index}`,action:'add',at:'2026-10-20T00:00:00Z',before:[],afterIds:[]}))]};
  const after=applySoul(expanded,{action:'add',text:'Keep build status exact.',evidence:'User asked for exact status.'}).soul;
  assert.equal(after.history.length,100);assert.equal(after.history.some(record=>record.action==='revise'),false);
  assert.ok(after.traits[0].lineage.some(item=>item.text==='Never use em dashes.'&&item.source==='stated'&&item.quote==='Never use em dashes when replying to me.'));
  assert.ok(after.traits[0].evidenceLog.some(item=>item.evidence==='Direct original preference.'));
});

test('restore never reopens history seeding, and explicit harddelete removes retained and derived copies', ()=>{
  let soul=applySoul({}, {action:'seed',traits:[{text:'Unique private preference Alpha.',evidence:'Alpha source.',source:'stated'},{text:'Unique private preference Beta.',evidence:'Beta source.',source:'stated'}]}).soul;
  const ids=soul.traits.map(item=>item.id),seededAt=soul.seededAt;
  soul=applySoul(soul,{action:'add',text:'Keep this unrelated preference.',evidence:'Unrelated source.'}).soul;
  soul=applySoul(soul,{action:'consolidate',ids,evidence:'Both concern the same private preference.',traits:[{text:'Unique merged private preference.',evidence:'Retain Alpha and Beta.'}]}).soul;
  const combined=soul.traits[0];
  const restored=applySoul(soul,{action:'restore',historyId:soul.history[0].id,evidence:'The user requested a full rollback.',source:'stated'}).soul;
  assert.equal(restored.seededAt,seededAt);assert.equal(restored.traits.length,0);
  assert.throws(()=>applySoul(restored,{action:'seed',traits:[{text:'Again.',evidence:'x'}]}),/already seeded/);
  assert.throws(()=>applySoul(soul,{action:'harddelete',id:combined.id}),/explicit user request/);
  const forgotten=applySoul(soul,{action:'harddelete',id:combined.id,source:'stated',evidence:'The user explicitly requested permanent deletion.'}).soul,serialized=JSON.stringify(forgotten);
  assert.deepEqual(forgotten.traits.map(item=>item.text),['Keep this unrelated preference.']);
  assert.doesNotMatch(serialized,/Alpha|Beta|Unique merged private|private preference/);
  for(const id of [...ids,combined.id])assert.equal(serialized.includes(id),false);
});

test('consolidation hysteresis leaves growth room above the target before triggering again', ()=>{
  const traits=Array.from({length:11},(_,index)=>({id:`hysteresis-${index}`,text:`${index}: ${'x'.repeat(950)}`,source:'inferred',since:'2026-01-01'}));
  const below={traits:traits.slice(0,10)},above={traits};
  assert.ok(soulBudget(below).used>SOUL_LIMITS.targetChars);assert.equal(soulBudget(below).needsConsolidation,false);
  assert.equal(soulBudget(above).needsConsolidation,true);assert.equal(soulBudget(above).trigger,10500);
  assert.match(personalizationContext({soul:above},null),/redundant inferred traits first/);
});

test('samples come only from the user\'s own mail and Slack messages', ()=>{
  const mbox='From a@x Mon\nFrom: Alex Example <alex@example.com>\nSubject: Hi\n\nThanks for the draft, I tightened the second act.\n> quoted old text\n-- \nAlex\nFrom b@x Tue\nFrom: Someone Else <s@example.com>\n\nNot mine at all, please ignore this one.\n';
  assert.deepEqual(extractSamples({name:'mail.mbox',text:mbox},{author:'alex@example.com'}),['Thanks for the draft, I tightened the second act.']);
  const slack=JSON.stringify([{user:'U1',user_profile:{real_name:'Alex Example'},text:'Ship it, but fix the headline first.'},{user:'U2',user_profile:{real_name:'Other'},text:'nope'},{subtype:'channel_join',text:'joined'}]);
  assert.deepEqual(extractSamples({name:'general.json',text:slack},{author:'alex'}),['Ship it, but fix the headline first.']);
  assert.equal(sampleCorpus(['short','x'.repeat(30)]).length,1);
  assert.match(stylePrompt(['A sample text here.'],{appliesTo:'documents'}),/documents and longer texts/);
});

test('usage from Claude and Codex lands in one shape, and warns from 90%', ()=>{
  const resets=Math.floor(Date.now()/1000)+3600;
  const claude=claudeUsage({status:'allowed_warning',unifiedWindows:{five_hour:{utilization:0.92,resetsAt:resets},seven_day:{utilization:0.4,resetsAt:resets+86400}}});
  assert.deepEqual(claude.windows.map(item=>[item.id,item.label,item.usedPercent]),[['five_hour','5-hour session',92],['seven_day','Weekly',40]]);
  assert.equal(usageWarnings(claude).length,1);
  const merged=claudeUsage({status:'allowed',rateLimitType:'seven_day',utilization:0.5,resetsAt:resets},claude);
  assert.equal(merged.windows.find(item=>item.id==='five_hour').usedPercent,92);assert.equal(merged.windows.find(item=>item.id==='seven_day').usedPercent,50);
  const codex=codexUsage({rateLimits:{primary:{usedPercent:35,windowDurationMins:300,resetsAt:resets},secondary:{usedPercent:96,windowDurationMins:10080,resetsAt:resets},planType:'plus'}});
  assert.deepEqual(codex.windows.map(item=>[item.label,item.usedPercent]),[['5-hour session',35],['Weekly',96]]);assert.equal(codex.plan,'plus');
  const events=[];const tracker=new UsageTracker({emit:event=>events.push(event)});
  tracker.update('codex',{rateLimits:{primary:{usedPercent:99,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)-5}}});
  assert.equal(tracker.snapshot().codex.windows.length,0,'expired numbers are unavailable until the provider reports fresh usage');
  assert.equal(events[0].type,'usage');assert.equal(tracker.update('gemini',{}),null);
});
test('usage percentages keep provider units and missing values stay unknown', () => {
  assert.equal(codexUsage({ primary: { usedPercent: 1 } }).windows[0].usedPercent, 1);
  assert.equal(codexUsage({ primary: { usedPercent: null } }), null);
  assert.equal(claudeUsage({ status: 'allowed', rateLimitType: 'five_hour' }).windows.length, 0);
  assert.equal(claudeUsage({ unifiedWindows: { five_hour: { utilization: 1.1 } } }).windows[0].usedPercent, 100);
  const previous = claudeUsage({ rateLimitType: 'five_hour', utilization: 0.5 });
  assert.equal(claudeUsage({ status: 'rejected', rateLimitType: 'five_hour' }, previous).windows[0].usedPercent, 100);
});
