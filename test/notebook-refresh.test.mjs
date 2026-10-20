import test from 'node:test';
import assert from 'node:assert/strict';
import {Scratchpad} from '../desktop/scratchpad.mjs';
import {notebookOrganizationPrompt} from '../desktop/notebook-organization.mjs';

async function until(read){for(let i=0;i<200;i++){const value=read();if(value)return value;await new Promise(r=>setTimeout(r,5));}throw Error('Expected notebook refresh state did not arrive');}
function answer(request){
 if(request.stage==='group'){
  const product=request.items.filter(i=>!i.summary.includes('Travel')),travel=request.items.filter(i=>i.summary.includes('Travel'));
  return {text:JSON.stringify({overview:'Current product and travel ideas.',groups:[...(product.length?[{title:'Product',summary:'Product ideas.',itemIds:product.map(i=>i.id)}]:[]),...(travel.length?[{title:'Travel',summary:'Travel ideas.',itemIds:travel.map(i=>i.id)}]:[])]})};
 }
 return {text:JSON.stringify({overview:'Shared ideas.',groups:[{title:'Product',summary:'Ideas.',items:request.parts.map(p=>({sourceId:p.id,title:p.title,summary:p.text,quote:p.text.slice(0,100)}))}]})};
}
async function fixture(t){
 const store={state:{},save:async()=>{}},calls=[],cancelled=[];let available=true;
 const pad=new Scratchpad({store,choose:async r=>{calls.push(r);return answer(r);},available:()=>available,cancel:id=>cancelled.push(id),organizationProvider:()=>'codex'});
 pad.data().settings={...pad.settings(),dailyBudget:50};
 const note=async(title,text,allowAI=true)=>{const created=await pad.create();return pad.update({...created,title,text,allowAI});};
 const original=await note('Product','Keep the layout clear.');await pad.organizer.prepare({provider:'codex',instructions:'Use existing topics where appropriate.'});await pad.organizer.pending;await pad.organizer.apply({id:pad.view().organization.proposal.id});
 calls.length=0;pad.organizer.refreshDelay=5;pad.organizer.start();t.after(()=>pad.close());
 return {pad,store,calls,cancelled,note,original,tick:()=>{clearTimeout(pad.organizer.refreshTimer);pad.organizer.refreshTimer=null;return pad.organizer.tick();},setAvailable:value=>available=value};
}

test('new shared notes refresh automatically, reuse existing items and add a suitable new category',async t=>{
 const f=await fixture(t),prior=structuredClone(f.pad.view().organization.applied),first=await f.note('Buttons','Use clear button labels.'),second=await f.note('Holiday','Travel to the coast.');
 const notes=structuredClone(f.pad.view().notes);assert.equal(f.pad.view().organization.refreshPending,true);
 await until(()=>f.pad.view().organization.applied?.sources.length===3&&!f.pad.organizer.busy);
 const view=f.pad.view().organization,outlines=f.calls.filter(r=>r.stage==='outline');assert.equal(outlines.length,1);assert.deepEqual(new Set(outlines[0].parts.map(p=>p.noteId)),new Set([first.id,second.id]));
 assert.deepEqual(view.applied.groups.map(g=>g.title),['Product','Travel']);assert.deepEqual(view.applied.groups[0].items.find(i=>i.noteId===f.original.id),prior.groups[0].items[0]);assert.equal(view.appliedStale,false);assert.equal(view.proposal,null);assert.equal(view.canUndo,true);assert.equal(view.refreshPending,false);assert.deepEqual(f.pad.view().notes,notes);
 assert.deepEqual(f.calls.at(-1).existingTopics,['Product']);assert.match(notebookOrganizationPrompt(f.calls.at(-1)),/Keep suitable existing topic names/);
});

test('editing a note replaces only that note’s items and uses current source excerpts',async t=>{
 const f=await fixture(t);await f.note('Other','Another idea.');await until(()=>f.pad.view().organization.applied?.sources.length===2&&!f.pad.organizer.busy);f.calls.length=0;
 const current=f.pad.view().notes.find(n=>n.id===f.original.id);await f.pad.update({...current,text:'The revised layout idea.'});await until(()=>!f.pad.view().organization.appliedStale&&!f.pad.organizer.busy);
 assert.equal(f.calls[0].parts.length,1);assert.equal(f.calls[0].parts[0].text,'The revised layout idea.');const item=f.pad.view().organization.applied.groups.flatMap(g=>g.items).find(i=>i.noteId===current.id);assert.equal(item.quote,'The revised layout idea.');
});

test('private notes and their edits never schedule or enter overview inference',async t=>{
 const f=await fixture(t),secret=await f.note('Private','PRIVATE_SOURCE',false);await f.pad.update({...secret,text:'PRIVATE_CHANGED'});await f.tick();
 assert.equal(f.calls.length,0);assert.equal(f.pad.view().organization.refreshPending,false);assert.equal(f.pad.view().organization.appliedStale,false);
 await f.note('Shared','Public notebook idea.');await until(()=>!f.pad.view().organization.appliedStale&&!f.pad.organizer.busy);assert.ok(!JSON.stringify(f.calls).includes('PRIVATE_'));
});

test('subscription exhaustion waits without inference; an exhausted work budget does not block overview',async t=>{
 const f=await fixture(t);f.pad.organizer.refreshDelay=60000;f.setAvailable(false);await f.note('New','A new idea.');await f.tick();assert.equal(f.calls.length,0);assert.equal(f.pad.view().organization.refreshPending,true);assert.match(f.pad.view().organization.refreshMessage,/available subscription/);
 f.setAvailable(true);f.pad.data().usage={day:new Date().toISOString().slice(0,10),turns:50};await f.tick();await f.pad.organizer.pending;assert.equal(f.pad.view().organization.appliedStale,false);assert.equal(f.calls.length,2);assert.equal(f.pad.used(),50);
});

test('unchanged saves and repeated idle ticks never schedule inference, including after restart',async t=>{
 const f=await fixture(t),current=f.pad.view().notes[0],saved=await f.pad.update({...current});assert.equal(saved.revision,current.revision);
 for(let i=0;i<100;i++)await f.tick();assert.equal(f.calls.length,0);assert.equal(f.pad.view().organization.refreshPending,false);
 const calls=[],reopened=new Scratchpad({store:{state:structuredClone(f.store.state),save:async()=>{}},choose:async r=>{calls.push(r);return answer(r);}});reopened.organizer.refreshDelay=5;reopened.organizer.start();t.after(()=>reopened.close());
 for(let i=0;i<100;i++)await reopened.organizer.tick();assert.equal(calls.length,0);assert.equal(reopened.view().organization.refreshPending,false);
});

test('refreshing unchanged notes uses no inference and preserves the existing Undo',async t=>{
 const f=await fixture(t),before=structuredClone(f.pad.data().organization),used=f.pad.overviewUsed();
 await f.pad.organizer.refresh();assert.equal(f.calls.length,0);assert.equal(f.pad.overviewUsed(),used);assert.deepEqual(f.pad.data().organization,before);
});

test('changes while refresh is running cancel stale output and coalesce the latest saved contents',async t=>{
 const f=await fixture(t);let held,release;const choose=f.pad.choose;f.pad.choose=async r=>{held=r;r.onStarted('held-refresh');return new Promise(resolve=>release=resolve);};
 const note=await f.note('New','First draft.');await until(()=>release);const prior=f.pad.view().organization.applied.id,old=f.pad.organizer.pending;await f.pad.update({...note,text:'Latest saved version.'});assert.ok(f.cancelled.includes('held-refresh'));assert.equal(f.pad.view().organization.applied.id,prior);
 f.pad.choose=choose;release(answer(held));await old;await until(()=>!f.pad.view().organization.appliedStale&&!f.pad.organizer.busy);
 assert.ok(f.pad.view().organization.applied.groups.flatMap(g=>g.items).some(i=>i.quote==='Latest saved version.'));assert.ok(!JSON.stringify(f.pad.view().organization.applied).includes('First draft.'));
});

test('revocation removes derived text and the next refresh reads only still-shared sources',async t=>{
 const f=await fixture(t);await f.note('Other','A still shared idea.');await until(()=>!f.pad.view().organization.appliedStale&&!f.pad.organizer.busy);f.calls.length=0;
 await f.pad.update({...f.pad.view().notes.find(n=>n.id===f.original.id),allowAI:false});assert.equal(f.pad.view().organization.applied,null);await until(()=>f.pad.view().organization.applied?.sources.length===1&&!f.pad.organizer.busy);
 assert.ok(!JSON.stringify(f.calls).includes('Keep the layout clear'));assert.ok(!JSON.stringify(f.pad.view().organization.applied).includes('Keep the layout clear'));
});

test('automatic refresh can be disabled, manual refresh still works and Undo preserves source edits',async t=>{
 const f=await fixture(t);await f.pad.organizer.configure({autoRefresh:false});const n=await f.note('New','New source.');await f.tick();assert.equal(f.calls.length,0);assert.equal(f.pad.view().organization.appliedStale,true);
 const previous=f.pad.view().organization.applied.id;await f.pad.organizer.refresh();await f.pad.organizer.pending;assert.equal(f.pad.view().organization.appliedStale,false);await f.pad.organizer.undo();assert.equal(f.pad.view().organization.applied.id,previous);assert.ok(f.pad.view().notes.some(i=>i.id===n.id));assert.equal(f.pad.view().organization.autoRefresh,false);
});

test('explicit stop and inference failure do not restart the same request in a loop',async t=>{
 const f=await fixture(t);f.pad.organizer.refreshDelay=60000;let held,release;f.pad.choose=async r=>{held=r;return new Promise(resolve=>release=resolve);};await f.note('New','New idea.');await f.tick();await until(()=>release);const pending=f.pad.organizer.pending;f.pad.organizer.stop();release(answer(held));await pending;await f.tick();assert.equal(f.pad.view().organization.refreshPending,false);assert.equal(f.pad.view().organization.refreshStatus,'paused');
 f.pad.choose=async()=>({error:'Model unavailable'});await f.pad.organizer.refresh();await f.pad.organizer.pending;assert.equal(f.pad.view().organization.refreshStatus,'error');assert.equal(await f.tick(),false);
});

test('startup catches stale saved overviews, honors pending proposals and waits for note work',async t=>{
 const f=await fixture(t);f.pad.organizer.close();await f.note('Added while closed','Later idea.');f.pad.closed=false;f.pad.organizer.refreshDelay=60000;f.pad.organizer.start();assert.equal(f.pad.view().organization.refreshPending,true);
 f.pad.active={job:{id:'running'}};await f.tick();assert.equal(f.calls.length,0);assert.match(f.pad.view().organization.refreshMessage,/current notebook work/);f.pad.active=null;
 f.pad.data().organization.proposal={...f.pad.data().organization.applied,id:'review'};await f.tick();assert.equal(f.calls.length,0);assert.match(f.pad.view().organization.refreshMessage,/existing proposal/);await f.pad.organizer.discard({id:'review'});await f.tick();await f.pad.organizer.pending;assert.equal(f.pad.view().organization.appliedStale,false);
});

test('adding a note preserves an intentional cleanup in unchanged source notes',async t=>{
 const f=await fixture(t);const plan=f.pad.data().organization.applied;f.pad.data().organization.applied={...plan,overview:'No pending product items.',groups:[]};await f.note('New','Travel idea.');await until(()=>!f.pad.view().organization.appliedStale&&!f.pad.organizer.busy);
 assert.ok(!f.pad.view().organization.applied.groups.flatMap(g=>g.items).some(i=>i.noteId===f.original.id));assert.ok(!JSON.stringify(f.calls).includes('Keep the layout clear'));
});

test('startup with an old revoked-source plan never sends its topic labels to inference',async t=>{
 const f=await fixture(t);f.pad.organizer.close();const second=await f.note('Other','Still shared.');f.pad.data().notes.find(n=>n.id===f.original.id).allowAI=false;f.pad.data().organization.applied.groups[0].title='PRIVATE_OLD_TOPIC';f.pad.closed=false;f.pad.organizer.refreshDelay=60000;f.pad.organizer.start();await f.tick();await f.pad.organizer.pending;
 assert.ok(!JSON.stringify(f.calls).includes('PRIVATE_OLD_TOPIC'));assert.ok(!JSON.stringify(f.calls).includes('Keep the layout clear'));assert.equal(f.pad.view().organization.applied.sources[0].id,second.id);
});

test('the periodic tick cannot bypass the editing debounce',async t=>{
 const f=await fixture(t);f.pad.organizer.refreshDelay=60000;await f.note('New','A recent save.');assert.equal(await f.pad.organizer.tick(),false);assert.equal(f.calls.length,0);assert.equal(f.pad.view().organization.refreshPending,true);
 await f.tick();await f.pad.organizer.pending;assert.equal(f.calls.length,2);
});

test('Undo of the first applied overview does not recreate it after an edit or restart',async t=>{
 const f=await fixture(t);await f.pad.organizer.undo();assert.equal(f.pad.data().organization.applied,null);assert.equal(f.pad.data().organization.refreshConfigured,false);await f.note('New','New idea after undo.');await f.tick();assert.equal(f.calls.length,0);
 const reopened=new Scratchpad({store:{state:structuredClone(f.store.state),save:async()=>{}},choose:async r=>{f.calls.push(r);return answer(r);}});reopened.organizer.refreshDelay=5;reopened.organizer.start();t.after(()=>reopened.close());await new Promise(r=>setTimeout(r,20));assert.equal(f.calls.length,0);assert.equal(reopened.data().organization.applied,null);
});

test('explicit Stop and failed inference pauses survive restart for unchanged sources',async t=>{
 for(const reason of ['stop','failure']){
  const f=await fixture(t);f.pad.organizer.refreshDelay=60000;await f.note('New','A pending idea.');
  if(reason==='stop'){let release;f.pad.choose=async r=>new Promise(resolve=>release=()=>resolve(answer(r)));await f.tick();await until(()=>release);const pending=f.pad.organizer.pending;f.pad.organizer.stop();release();await pending;await f.pad.organizer.pauseSave;}
  else{f.pad.choose=async()=>({error:'Malformed provider result'});await f.tick();await f.pad.organizer.pending;}
  const calls=[],reopened=new Scratchpad({store:{state:structuredClone(f.store.state),save:async()=>{}},choose:async r=>{calls.push(r);return answer(r);}});reopened.organizer.refreshDelay=5;reopened.organizer.start();t.after(()=>reopened.close());await new Promise(r=>setTimeout(r,20));assert.equal(calls.length,0);assert.equal(reopened.view().organization.refreshStatus,'paused');assert.equal(reopened.view().organization.refreshPending,false);
  const note=reopened.view().notes[0];await reopened.update({...note,text:note.text+' A newer revision.'});await until(()=>!reopened.view().organization.appliedStale&&!reopened.organizer.busy);assert.ok(calls.length>0);
 }
});

test('a refresh never reads a source while its save is still pending',async t=>{
 const f=await fixture(t);f.pad.organizer.refreshDelay=60000;await f.note('New','Saved idea.');let release;const original=f.store.save;f.store.save=()=>new Promise(resolve=>release=resolve);
 const note=f.pad.view().notes[0],saving=f.pad.update({...note,text:'Unsaved while disk is busy.'});await until(()=>release);await f.tick();assert.equal(f.calls.length,0);assert.match(f.pad.view().organization.refreshMessage,/finish saving/);
 f.store.save=original;release();await saving;await f.tick();await f.pad.organizer.pending;assert.ok(f.calls[0].parts.some(p=>p.text==='Unsaved while disk is busy.'));
});

test('Stop during the commit point reports a finishing save and keeps a valid Undo',async t=>{
 const f=await fixture(t);f.pad.organizer.refreshDelay=60000;await f.note('New','A new source.');let release;const original=f.store.save;f.store.save=async()=>{if(f.pad.data().organization.applied.sources.length===2)await new Promise(resolve=>release=resolve);};
 await f.tick();await until(()=>release&&f.pad.organizer.run?.committing);const view=f.pad.organizer.stop();assert.equal(view.running,true);assert.equal(view.committing,true);assert.equal(view.error,'');assert.match(view.progress,/Finishing/);f.store.save=original;release();await f.pad.organizer.pending;assert.equal(f.pad.view().organization.refreshStatus,'idle');assert.equal(f.pad.view().organization.canUndo,true);assert.equal(f.pad.view().organization.appliedStale,false);
});
