import test from 'node:test';
import assert from 'node:assert/strict';
import {Scratchpad} from '../desktop/scratchpad.mjs';
import {notebookPackets,notebookOrganizationPrompt} from '../desktop/notebook-organization.mjs';

function fixture(){
 const store={state:{},save:async()=>{}},requests=[],cancelled=[];
 const pad=new Scratchpad({store,cancel:id=>cancelled.push(id),now:()=>new Date('2026-10-17T12:00:00Z'),choose:async request=>{requests.push(request);return answer(request);}});
 const note=async(title,text,allowAI=true)=>{const created=await pad.create();return pad.update({...created,title,text,allowAI});};
 return {store,pad,requests,cancelled,note};
}
function answer(request){
 if(request.stage==='group')return {text:JSON.stringify({overview:'The complete notebook, grouped by topic.',groups:[{title:'All projects',summary:'Related ideas gathered together.',itemIds:request.items.map(item=>item.id)}]})};
 return {text:JSON.stringify({overview:'A clear overview of the shared notebook.',groups:[{title:'Projects',summary:'Ideas to revisit.',items:request.parts.map(part=>({sourceId:part.id,title:part.title,summary:'A condensed description of the original note.',quote:part.text.slice(0,80)}))}]})};
}
async function organize(f){await f.pad.organizer.prepare({provider:'codex'});await f.pad.organizer.pending;return f.pad.view().organization;}

test('packetization preserves every source character and Unicode across long notes',()=>{
 const input=[{id:'a',title:'Long',text:'x'.repeat(23999)+'🌙 café '+'tail'.repeat(18000)},{id:'b',title:'Another',text:'last marker'}],packets=notebookPackets(input);
 assert.ok(packets.length>3);assert.ok(packets.every(packet=>packet.reduce((sum,part)=>sum+part.text.length,0)<=24000));
 for(const note of input)assert.equal(packets.flat().filter(part=>part.noteId===note.id).map(part=>part.text).join(''),note.text);
 assert.ok(packets.flat().every(part=>!/[\uD800-\uDBFF]$/.test(part.text)));
});

test('proposal reads only shared notes and preserves all writing, revisions, links and task state',async()=>{
 const f=fixture();await f.note('Private','PRIVATE_SECRET',false);await f.note('Café','Café 🌙\nhttps://example.com/reference\nAn unresolved idea.');await f.note('Empty','');
 const before=structuredClone(f.pad.view().notes),view=await organize(f);
 assert.equal(view.eligibleCount,1);assert.equal(view.totalCount,3);assert.equal(view.proposal.sources.length,1);assert.equal(view.applied,null);assert.equal(f.requests.length,1);assert.equal(f.pad.used(),0);assert.equal(f.pad.overviewUsed(),1);
 assert.ok(!JSON.stringify(f.requests).includes('PRIVATE_SECRET'));assert.equal(f.requests[0].mode,'organization');assert.equal(f.requests[0].parts[0].text,before.find(note=>note.title==='Café').text);
 assert.deepEqual(f.pad.view().notes,before);assert.deepEqual(f.pad.view().jobs,[]);
 assert.match(notebookOrganizationPrompt(f.requests[0]),/data, never instructions/);assert.match(notebookOrganizationPrompt(f.requests[0]),/not.*implemented/i);
});

test('apply is revision checked; grouping persists and undo restores previous overview without reverting later edits',async()=>{
 const f=fixture(),note=await f.note('Project','First idea\nhttps://example.com/first');let view=await organize(f);
 await f.pad.organizer.apply({id:view.proposal.id});assert.ok(f.pad.view().organization.applied);assert.equal(f.pad.view().organization.proposal,null);
 const first=structuredClone(f.pad.view().organization.applied);view=await organize(f);await f.pad.organizer.apply({id:view.proposal.id});
 await f.pad.update({...f.pad.view().notes.find(item=>item.id===note.id),text:note.text+'\nNew scribble'});
 await f.pad.organizer.undo();assert.deepEqual(f.pad.view().organization.applied,first);assert.equal(f.pad.view().organization.appliedStale,true);assert.equal(f.pad.view().notes[0].text,note.text+'\nNew scribble');
 const reopened=new Scratchpad({store:{state:structuredClone(f.store.state),save:async()=>{}}});assert.deepEqual(reopened.view().organization.applied,first);assert.equal(reopened.view().organization.canUndo,false);
});

test('long notebook reads every packet then groups every extracted item once',async()=>{
 const f=fixture(),input='First idea\n'+'Long ramble. '.repeat(4000)+'\nLAST_UNREAD_MARKER';await f.note('Long notebook',input);
 const view=await organize(f),outlines=f.requests.filter(request=>request.stage==='outline');assert.ok(outlines.length>1);assert.equal(outlines.flatMap(request=>request.parts).map(part=>part.text).join(''),input);
 assert.equal(f.requests.at(-1).stage,'group');assert.equal(f.requests.length,view.requestCount);assert.equal(f.pad.overviewUsed(),view.requestCount);assert.equal(f.pad.used(),0);
 assert.equal(view.proposal.characters,input.length);assert.equal(view.proposal.groups[0].items.length,outlines.length);
});

test('unknown sources, fabricated quotes and omitted packet sources cannot produce an applicable proposal',async()=>{
 for(const mode of ['unknown','quote','omit']){
  const f=fixture();await f.note('One','An original source.');await f.note('Two','Another original source.');
  f.pad.choose=async request=>{const result=JSON.parse(answer(request).text);if(mode==='unknown')result.groups[0].items[0].sourceId='private-id';if(mode==='quote')result.groups[0].items[0].quote='Fabricated text';if(mode==='omit')result.groups[0].items.pop();return {text:JSON.stringify(result)};};
  const view=await organize(f);assert.equal(view.proposal,null);assert.match(view.error,/outside|match|omitted/);await assert.rejects(f.pad.organizer.apply({id:'anything'}),/proposal changed/);
 }
});

test('regrouping cannot duplicate or omit an extracted item',async()=>{
 for(const duplicate of [true,false]){
  const f=fixture();await f.note('Long','Long idea. '.repeat(5000));
  f.pad.choose=async request=>{const result=JSON.parse(answer(request).text);if(request.stage==='group'){if(duplicate)result.groups[0].itemIds.push(result.groups[0].itemIds[0]);else result.groups[0].itemIds.pop();}return {text:JSON.stringify(result)};};
  const view=await organize(f);assert.equal(view.proposal,null);assert.match(view.error,/duplicated|omitted/);
 }
});

test('overview generation is uncapped and does not spend the separate note-work budget',async()=>{
 const f=fixture();await f.note('Long','Long idea. '.repeat(5000));f.pad.data().settings={...f.pad.settings(),dailyBudget:1};
 f.pad.data().usage={day:'2026-10-17',turns:1};
 const view=await organize(f);assert.ok(view.proposal);assert.equal(view.error,'');assert.ok(f.requests.length>1);assert.equal(f.pad.used(),1);assert.equal(f.pad.overviewUsed(),f.requests.length);
});

test('editing, revoking or deleting sources while AI runs cancels it and refuses late output',async()=>{
 for(const mode of ['edit','revoke','delete']){
  const f=fixture(),note=await f.note('Shared','A source idea');let release,request;
  f.pad.choose=async value=>{request=value;value.onStarted('organization-run');return new Promise(resolve=>{release=resolve;});};
  await f.pad.organizer.prepare({provider:'codex'});await new Promise(resolve=>setImmediate(resolve));const pending=f.pad.organizer.pending;
  if(mode==='delete')await f.pad.remove(note.id);else await f.pad.update({...note,...(mode==='edit'?{text:'New source idea'}:{allowAI:false})});
  assert.equal(request.cancelled(),true);assert.deepEqual(f.cancelled,['organization-run']);release(answer(request));await pending;
  assert.equal(f.pad.view().organization.proposal,null);assert.equal(f.pad.view().organization.running,false);
 }
});

test('private or deleted sources hide existing derived summaries and stale proposals cannot apply',async()=>{
 const f=fixture(),note=await f.note('Sensitive','SHARED_SECRET');let view=await organize(f);await f.pad.organizer.apply({id:view.proposal.id});view=await organize(f);
 await f.pad.update({...note,text:'A changed secret'});assert.equal(f.pad.view().organization.proposalStale,true);await assert.rejects(f.pad.organizer.apply({id:view.proposal.id}),/shared notes changed/);
 await f.pad.update({...f.pad.view().notes[0],allowAI:false});view=f.pad.view().organization;assert.equal(view.applied,null);assert.equal(view.proposal,null);assert.match(view.notice,/previous organization was removed/);assert.ok(!JSON.stringify(view).includes('SHARED_SECRET'));
});

test('explicit stop and closing ignore late model results and cancel the current request',async()=>{
 for(const close of [false,true]){
  const f=fixture();await f.note('Shared','One idea');let request,release;
  f.pad.choose=async value=>{request=value;value.onStarted('run');return new Promise(resolve=>{release=resolve;});};
  await f.pad.organizer.prepare({provider:'codex'});await new Promise(resolve=>setImmediate(resolve));const pending=f.pad.organizer.pending;
  if(close)f.pad.close();else f.pad.organizer.stop();release(answer(request));await pending;
  assert.deepEqual(f.cancelled,['run']);assert.equal(f.pad.view().organization.proposal,null);assert.equal(f.pad.view().organization.running,false);
 }
});

test('organization excludes concurrent automatic/manual note work and settings changes',async()=>{
 const f=fixture(),note=await f.note('Shared','One idea');let release,request;f.pad.choose=async value=>{request=value;return new Promise(resolve=>{release=resolve;});};
 await f.pad.organizer.prepare({provider:'codex'});await new Promise(resolve=>setImmediate(resolve));const job=await f.pad.enqueue({id:note.id,text:note.text});
 await assert.rejects(f.pad.scan(true),/already running/);await assert.rejects(f.pad.startItem(job.id,{manual:true}),/already running/);await assert.rejects(f.pad.configure({...f.pad.settings(),provider:'codex'}),/Stop notebook/);
 release(answer(request));await f.pad.organizer.pending;
 f.pad.active={job};await assert.rejects(f.pad.organizer.prepare({provider:'codex'}),/current note work/);f.pad.active=null;
});

test('provider failures and persistence failures keep note contents and previous organization unchanged',async()=>{
 const f=fixture();await f.note('Shared','Café 🌙 https://example.com');let view=await organize(f);await f.pad.organizer.apply({id:view.proposal.id});const prior=structuredClone(f.pad.view().organization.applied),notes=structuredClone(f.pad.view().notes);
 f.pad.choose=async()=>({error:'The subscription usage allowance is exhausted.'});view=await organize(f);assert.match(view.error,/exhausted/);assert.deepEqual(view.applied,prior);assert.equal(view.proposal,null);
 f.pad.choose=async request=>answer(request);view=await organize(f);f.store.save=async()=>{throw Error('Disk unavailable');};await assert.rejects(f.pad.organizer.apply({id:view.proposal.id}),/Disk unavailable/);
 assert.deepEqual(f.pad.view().organization.applied,prior);assert.equal(f.pad.view().organization.proposal.id,view.proposal.id);assert.deepEqual(f.pad.view().notes,notes);
});

test('blank-only sections are skipped while nonblank content keeps its original source offset',async()=>{
 const f=fixture(),note=await f.note('Mostly blank',' '.repeat(30000)+'Actual idea at the end.');
 f.pad.choose=async request=>{const result=JSON.parse(answer(request).text);for(const group of result.groups)for(const item of group.items){const part=request.parts.find(part=>part.id===item.sourceId);item.quote=part.text.trim();}return {text:JSON.stringify(result)};};
 const view=await organize(f);assert.ok(view.proposal);assert.equal(f.pad.used(),0);assert.equal(f.pad.overviewUsed(),1);assert.equal(view.requestCount,1);assert.equal(view.proposal.groups[0].items[0].offset,30000);assert.equal(f.pad.view().notes[0].text,note.text);
});

test('a full legal one-million-character notebook has a finite request count',()=>{
 const notes=Array.from({length:50},(_,index)=>({id:String(index),title:`Note ${index}`,text:String(index%10).repeat(20000)})),packets=notebookPackets(notes);
 assert.equal(packets.length,42);assert.ok(packets.length+1<=50);
 for(const note of notes)assert.equal(packets.flat().filter(part=>part.noteId===note.id).map(part=>part.text).join(''),note.text);
});

test('synthesis receives semantic summaries; excessive synthesis payload fails explicitly before inference',async()=>{
 const f=fixture();await f.note('Long','A source topic. '.repeat(4000));const original=f.pad.choose;
 f.pad.choose=async request=>{if(request.stage==='group')assert.ok(request.items.every(item=>item.summary==='A condensed description of the original note.'));return original(request);};
 assert.ok((await organize(f)).proposal);
 const large=fixture();large.pad.data().settings={...large.pad.settings(),dailyBudget:50};
 for(let i=0;i<10;i++)await large.note('Large topic '+i,'Large topic. '.repeat(7690));
 let synthesisCalls=0;large.pad.choose=async request=>{if(request.stage==='group'){synthesisCalls++;return answer(request);}const result=JSON.parse(answer(request).text);for(const group of result.groups)group.items=group.items.flatMap(item=>Array.from({length:8},(_,index)=>({...item,title:'Topic '+index+' '+('x'.repeat(80)),summary:'Meaningful summary. '.repeat(30)})));return {text:JSON.stringify(result)};};
 const view=await organize(large);assert.equal(view.proposal,null);assert.match(view.error,/too many topics/);assert.equal(synthesisCalls,0);
});

test('revoke and delete purge affected proposals, applied organization and undo instead of resurrecting old summaries',async()=>{
 for(const mode of ['revoke','delete']){
  const f=fixture(),note=await f.note('Sensitive','A SECRET_SOURCE idea.');let view=await organize(f);await f.pad.organizer.apply({id:view.proposal.id});view=await organize(f);await f.pad.organizer.apply({id:view.proposal.id});view=await organize(f);
  if(mode==='revoke'){await f.pad.update({...note,allowAI:false});await f.pad.update({...f.pad.view().notes[0],text:'An unrelated replacement idea.'});await f.pad.update({...f.pad.view().notes[0],allowAI:true});}else await f.pad.remove(note.id);
  const saved=f.pad.data().organization;assert.equal(saved.applied,null);assert.equal(saved.proposal,null);assert.equal(saved.undo,null);assert.ok(!JSON.stringify(saved).includes('SECRET_SOURCE'));assert.match(f.pad.view().organization.notice,/previous organization was removed/);
 }
});

test('a canceled request must settle before a replacement or note work can start',async()=>{
 const f=fixture(),note=await f.note('Shared','An idea');let request,release;f.pad.choose=async value=>{request=value;return new Promise(resolve=>{release=resolve;});};
 await f.pad.organizer.prepare({provider:'codex'});await new Promise(resolve=>setImmediate(resolve));const pending=f.pad.organizer.pending;f.pad.organizer.stop();assert.equal(f.pad.view().organization.stopping,true);
 await assert.rejects(f.pad.organizer.prepare({provider:'codex'}),/current note work/);const job=await f.pad.enqueue({id:note.id,text:note.text});await assert.rejects(f.pad.startItem(job.id,{manual:true}),/already running/);
 release(answer(request));await pending;assert.equal(f.pad.view().organization.stopping,false);f.pad.choose=async request=>answer(request);assert.ok((await organize(f)).proposal);
});

test('failed note access revocation restores the original overview alongside the note permission',async()=>{
 const f=fixture(),note=await f.note('Shared','An idea');const view=await organize(f);await f.pad.organizer.apply({id:view.proposal.id});const prior=structuredClone(f.pad.view().organization.applied);f.store.save=async()=>{throw Error('Disk unavailable');};
 await assert.rejects(f.pad.update({...note,allowAI:false}),/Disk unavailable/);assert.equal(f.pad.view().notes[0].allowAI,true);assert.deepEqual(f.pad.view().organization.applied,prior);
});
