import test from 'node:test';
import assert from 'node:assert/strict';
import {Scratchpad,NOTES_TOOLS} from '../desktop/scratchpad.mjs';
import {hostAction} from '../desktop/permissions.mjs';

async function fixture(){
 const store={state:{},save:async()=>{}},pad=new Scratchpad({store});
 const n=await pad.create(),note=await pad.update({...n,title:'Ideas',text:'Done\nRejected\nStill needs hardware\n',allowAI:true});
 pad.data().organization={autoRefresh:false,applied:{id:'old',sources:[{id:note.id,revision:note.revision}],overview:'Done and rejected claims',groups:[{title:'Ideas',summary:'Done and rejected claims',items:[{id:'old-item',noteId:note.id,title:'Done',summary:'Done and rejected claims',quote:'Done',offset:0}]}]}};
 return {store,pad,note,input:{id:note.id,revision:note.revision,items:[{text:'Done\n',reason:'implemented',evidence:'Verified in synthetic example'},{text:'Rejected\n',reason:'discarded',evidence:'Owner authorized removal; redundant alternative'}]}};
}
test('resolution removes exact implemented/discarded passages, hides stale claims, and survives restart with undo',async()=>{
 const f=await fixture();let preview;
 const result=await f.pad.resolvePassages('chat',f.input,async request=>{preview=request;return true;});
 assert.equal(result.removed,2);assert.equal(f.pad.readNotes('chat',{id:f.note.id}).text,'Still needs hardware\n');
 assert.match(preview.detail,/discarded/);assert.equal(preview.action.tool,'notes_resolve');
 const read=f.pad.readOverview('chat');assert.equal(read.stale,true);assert.ok(!read.text.includes('Done and rejected claims'));assert.match(read.text,/Still needs hardware/);
 const restored=new Scratchpad({store:{state:structuredClone(f.store.state),save:async()=>{}}});
 assert.equal(restored.view().notes[0].lastCleanup.items[1].reason,'discarded');
 await restored.restoreCleanup({id:f.note.id,revision:result.revision,cleanupId:result.cleanupId});
 assert.equal(restored.readNotes('chat',{id:f.note.id}).text,f.note.text);
});
test('resolution refuses concurrent edits, revoked sharing, partial lines, and cancellation',async()=>{
 for(const change of ['edit','revoke','cancel']){
  const f=await fixture();await assert.rejects(f.pad.resolvePassages('chat',f.input,async()=>{
   if(change==='edit')await f.pad.update({...f.note,text:f.note.text+'New idea\n'});
   if(change==='revoke')await f.pad.update({...f.note,allowAI:false});
   return change!=='cancel';
  }));assert.ok(f.pad.view().notes[0].text.includes('Done'));
 }
 const f=await fixture();await assert.rejects(f.pad.resolvePassages('chat',{...f.input,items:[{text:'Don',reason:'discarded',evidence:'Reason'}]},async()=>true),/complete lines/);
 await assert.rejects(f.pad.resolvePassages('chat',{...f.input,items:[{...f.input.items[0],reason:'unverified'}]},async()=>true),/reason/);
});
test('failed resolution save rolls back text, cleanup and overview',async()=>{
 const f=await fixture(),before=structuredClone(f.pad.data());f.store.save=async()=>{throw Error('disk full');};
 await assert.rejects(f.pad.resolvePassages('chat',f.input,async()=>true),/disk full/);
 assert.deepEqual(f.pad.data().notes,before.notes);assert.deepEqual(f.pad.data().organization,before.organization);
});
test('resolved cleanup remains a scoped write and advertises explicit dispositions',()=>{
 assert.deepEqual(hostAction('notes_resolve',{id:'n'}),{kind:'write',tool:'notes_resolve',target:'n'});
 assert.deepEqual(NOTES_TOOLS.find(x=>x.name==='notes_resolve').inputSchema.properties.items.items.properties.reason.enum,['implemented','discarded']);
});
test('one note may retain more than eight independent overview ideas',async()=>{
 const store={state:{},save:async()=>{}},pad=new Scratchpad({store,choose:async request=>({text:JSON.stringify({overview:'Independent ideas',groups:[{title:'Ideas',summary:'Each distinct idea',items:Array.from({length:12},(_,i)=>({sourceId:request.parts[0].id,title:'Idea '+i,summary:'Independent '+i,quote:'Idea '+i+'\n'}))}]})})});
 const n=await pad.create();await pad.update({...n,allowAI:true,text:Array.from({length:12},(_,i)=>'Idea '+i+'\n').join('')});
 await pad.organizer.prepare({provider:'codex'});await pad.organizer.pending;
 assert.equal(pad.view().organization.proposal.groups[0].items.length,12);
});
test('new shared notes appear before AI refresh without relabelling old content as current',async()=>{
 const f=await fixture(),n=await f.pad.create();await f.pad.update({...n,title:'New',text:'A newly added idea',allowAI:true});
 const view=f.pad.view().organization;
 assert.equal(view.appliedStale,true);assert.ok(view.applied.groups.some(g=>g.items.some(i=>i.noteId===n.id&&i.quote==='A newly added idea')));
 assert.ok(f.pad.readOverview('chat').text.includes('A newly added idea'));
});
test('overview pagination binds new-note addition, edits and revoked sharing to its snapshot',async()=>{
 const f=await fixture(),original=structuredClone(f.pad.data().organization.applied),before=f.pad.readOverview('chat',{limit:20});
 const created=await f.pad.create(),added=await f.pad.update({...created,title:'New',text:'New source text',allowAI:true});
 const first=f.pad.readOverview('chat',{limit:20});assert.notEqual(first.snapshot,before.snapshot);assert.throws(()=>f.pad.readOverview('chat',{offset:20,snapshot:before.snapshot}),/changed/);
 const metadata=first.sources.find(source=>source.id===added.id);assert.equal(metadata.revision,null);assert.equal(metadata.currentRevision,added.revision);assert.equal(metadata.refreshRequired,true);
 const edited=await f.pad.update({...added,text:'Edited newly shared source'}),second=f.pad.readOverview('chat',{limit:20});assert.notEqual(second.snapshot,first.snapshot);assert.throws(()=>f.pad.readOverview('chat',{offset:20,snapshot:first.snapshot}),/changed/);
 await f.pad.update({...edited,allowAI:false});const third=f.pad.readOverview('chat');assert.notEqual(third.snapshot,second.snapshot);assert.throws(()=>f.pad.readOverview('chat',{offset:20,snapshot:second.snapshot}),/changed/);assert.ok(!third.sources.some(source=>source.id===added.id));assert.ok(!third.text.includes('Edited newly shared source'));assert.deepEqual(f.pad.data().organization.applied,original);
});
test('projected source ordering is stable when unrelated note ordering changes',async()=>{
 const f=await fixture();for(const title of ['Second','Third']){const n=await f.pad.create();await f.pad.update({...n,title,text:title+' new source',allowAI:true});}
 const first=f.pad.readOverview('chat');f.pad.data().notes.reverse();const second=f.pad.readOverview('chat');assert.equal(second.snapshot,first.snapshot);assert.equal(second.text,first.text);assert.deepEqual(second.sources,first.sources);
});
