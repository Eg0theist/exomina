import test from 'node:test';
import assert from 'node:assert/strict';
import {Scratchpad,NOTES_TOOLS} from '../desktop/scratchpad.mjs';
import {hostAction} from '../desktop/permissions.mjs';
import {LEAN_TOOLS} from '../desktop/routing.mjs';
import {FOLLOWUP_READ_TOOLS} from '../desktop/followup-tools.mjs';

async function fixture(){
 const store={state:{},save:async()=>{}},pad=new Scratchpad({store,now:()=>new Date('2026-10-18T00:00:00Z')});
 const note=async(title,text,allowAI=true)=>{const created=await pad.create();return pad.update({...created,title,text,allowAI});};
 const first=await note('Product','Finished feature.\nPending café 🌙 idea.\nhttps://example.com/source'),second=await note('Research','A research idea.'),secret=await note('Private','PRIVATE_NOTE_SECRET',false);
 const item=(id,note,title,quote)=>({id,noteId:note.id,noteTitle:note.title,title,summary:title+' summary.',quote,offset:note.text.indexOf(quote)});
 const plan={id:'applied-v1',createdAt:'2026-10-17T12:00:00Z',overview:'Finished feature and pending work.',sources:[first,second].map(({id,revision})=>({id,revision})),groups:[
  {title:'Product',summary:'Finished feature and a pending idea.',items:[item('item-1',first,'Finished feature','Finished feature.'),item('item-2',first,'Pending idea','Pending café 🌙 idea.')]},
  {title:'Research',summary:'Research to do.',items:[item('item-3',second,'Research idea','A research idea.')]}
 ]};
 pad.data().organization={applied:plan,proposal:null};
 const input=()=>({snapshot:pad.readOverview('chat').snapshot,items:[{id:'item-1',reason:'implemented',evidence:'The installed feature was checked against its original request.'}],overview:'Pending product and research work.',groupSummaries:[{index:0,summary:'A pending idea.'}]});
 return {pad,store,first,second,secret,plan,input};
}

test('overview reads the applied saved content directly without private notes, mutation or model use',async()=>{
 const f=await fixture(),before=structuredClone(f.store.state),read=f.pad.readOverview('chat',{limit:16000});
 assert.equal(read.status,'available');assert.equal(read.selection,'applied');assert.equal(read.stale,false);assert.equal(read.untrusted,true);assert.equal(read.sources.length,2);
 assert.match(read.text,/item-1: Finished feature/);assert.match(read.text,/Pending café 🌙 idea/);assert.match(read.notice,/not a verified implementation status/);assert.ok(!JSON.stringify(read).includes('PRIVATE_NOTE_SECRET'));assert.deepEqual(f.store.state,before);assert.equal(f.pad.used(),0);
 f.pad.data().organization.proposal={...structuredClone(f.plan),id:'proposal-v2',overview:'Unapplied proposal'};
 assert.match(f.pad.readOverview('chat').text,/Finished feature/);assert.match(f.pad.readOverview('chat',{selection:'proposal'}).text,/Unapplied proposal/);
});

test('overview pagination reconstructs all Unicode text and refuses mixed or unsnapshotted pages',async()=>{
 const f=await fixture(),whole=f.pad.readOverview('chat',{limit:16000});let value='',offset=0,snapshot;
 do{const page=f.pad.readOverview('chat',{offset,limit:17,...(snapshot?{snapshot}:{})});value+=page.text;snapshot=page.snapshot;offset=page.nextOffset;}while(offset!==null);
 assert.equal(value,whole.text);assert.throws(()=>f.pad.readOverview('chat',{offset:1}),/previous page/);
 await f.pad.update({...f.first,text:f.first.text+'\nNew note content'});
 assert.equal(f.pad.readOverview('chat').stale,true);assert.throws(()=>f.pad.readOverview('chat',{offset:17,snapshot}),/changed/);
 for(const input of [{limit:0},{limit:16001},{offset:-1},{offset:1.5},{selection:'undo'}])assert.throws(()=>f.pad.readOverview('chat',input));
});

test('every page checks sharing and malformed or missing source references never expose an overview',async()=>{
 for(const mode of ['private','deleted','invalid-item']){
  const f=await fixture(),before=f.pad.readOverview('chat');
  if(mode==='private')await f.pad.update({...f.first,allowAI:false});
  if(mode==='deleted')await f.pad.remove(f.first.id);
  if(mode==='invalid-item')f.pad.data().organization.applied.groups[0].items[0].noteId=f.secret.id;
  assert.throws(()=>f.pad.readOverview('chat',{offset:1,snapshot:before.snapshot}),/changed/);
  const read=f.pad.readOverview('chat');assert.notEqual(read.status,'available');assert.equal(read.text,'');assert.ok(!JSON.stringify(read).includes('Finished feature'));assert.ok(!JSON.stringify(read).includes(f.secret.id));
 }
});

test('scoped note tasks cannot widen a selected passage to the full notebook',async()=>{
 const f=await fixture();f.pad.active={job:{conversationId:'work-chat',noteId:f.first.id,title:'Product',goal:'Finished feature.'}};
 assert.equal(f.pad.readNotes('work-chat',{id:f.first.id}).text,'Finished feature.');assert.throws(()=>f.pad.readOverview('work-chat'),/outside that scope/);
 assert.equal(f.pad.readOverview('different-chat').status,'available');
});

test('targeted cleanup updates source notes and overview together, preserves other ideas and persists Undo',async()=>{
 const f=await fixture(),notes=structuredClone(f.pad.data().notes);let approval;
 const result=await f.pad.cleanupOverview('chat',f.input(),async request=>{approval=request;return true;});
 assert.equal(result.removed,1);assert.equal(result.remainingItems,2);assert.equal(result.originalNotesChanged,true);assert.ok(!result.text.includes('Finished feature'));assert.match(result.text,/item-2: Pending idea/);assert.match(result.text,/item-3: Research idea/);
 assert.equal(approval.action.kind,'write');assert.equal(approval.action.tool,'notes_overview_cleanup');assert.match(approval.detail,/installed feature/);assert.match(approval.detail,/Finished feature\./);assert.deepEqual(approval.sourceNoteIds,[f.first.id]);assert.equal(f.pad.data().notes.find(n=>n.id===f.first.id).text,'\nPending café 🌙 idea.\nhttps://example.com/source');assert.deepEqual(f.pad.data().notes.filter(n=>n.id!==f.first.id),notes.filter(n=>n.id!==f.first.id));assert.deepEqual(f.pad.data().organization.applied.groups[1],f.plan.groups[1]);assert.equal(f.pad.used(),0);
 const retained=f.pad.data().organization.applied.groups[0].items[0];assert.equal(retained.offset,1);assert.equal(f.pad.readOverview('chat').stale,false);assert.equal(f.pad.data().notes.find(n=>n.id===f.first.id).text.slice(retained.offset,retained.offset+retained.quote.length),retained.quote);
 const reopened=new Scratchpad({store:{state:structuredClone(f.store.state),save:async()=>{}}}),read=reopened.readOverview('chat');assert.equal(read.undoKind,'cleanup');
 const undone=await reopened.cleanupOverview('chat',{action:'undo',snapshot:read.snapshot},async()=>true);assert.match(undone.text,/item-1: Finished feature/);assert.deepEqual(reopened.data().organization.applied,{...f.plan,sources:f.plan.sources.map(source=>({...source,revision:reopened.data().notes.find(n=>n.id===source.id).revision}))});assert.deepEqual(reopened.data().notes.map(n=>[n.id,n.text]),notes.map(n=>[n.id,n.text]));assert.equal(reopened.readOverview('chat').canUndo,false);assert.equal(undone.stale,false);
});

test('discarded items and an empty remaining overview retain a working UI Undo',async()=>{
 const f=await fixture(),input=f.input();input.items=['item-1','item-2','item-3'].map(id=>({id,reason:'discarded',evidence:'The owner explicitly discarded this idea.'}));input.overview='No active ideas remain.';input.groupSummaries=[];
 const result=await f.pad.cleanupOverview('chat',input,async()=>true);assert.equal(result.remainingItems,0);assert.equal(f.pad.data().organization.applied.groups.length,0);assert.equal(result.stale,false);
 assert.equal(f.pad.data().notes.find(n=>n.id===f.second.id).text,'');assert.equal(result.canUndo,true);
 await f.pad.organizer.undo();assert.deepEqual(f.pad.data().organization.applied.groups,f.plan.groups);assert.equal(f.pad.data().notes.find(n=>n.id===f.second.id).text,f.second.text);assert.equal(f.pad.readOverview('chat').stale,false);
});

test('invalid cleanup cannot drop unknown or duplicate IDs, omit evidence, or rewrite unrelated groups',async()=>{
 const changes=[input=>input.items.push({...input.items[0]}),input=>input.items[0].id='unknown',input=>input.items[0].evidence='',input=>input.items[0].reason='maybe',input=>input.overview='',input=>input.groupSummaries=[],input=>input.groupSummaries.push({index:1,summary:'Unrelated rewrite'}),input=>input.groupSummaries.push({index:99,summary:'Unknown group'})];
 for(const change of changes){const f=await fixture(),before=structuredClone(f.store.state),input=f.input();change(input);let asked=false;await assert.rejects(f.pad.cleanupOverview('chat',input,async()=>{asked=true;return true;}));assert.equal(asked,false);assert.deepEqual(f.store.state,before);}
});

test('denial and changes while approval waits do not apply stale cleanup',async()=>{
 for(const mode of ['deny','edit','revoke','proposal']){
  const f=await fixture(),input=f.input(),original=f.pad.data().organization.applied;
  await assert.rejects(f.pad.cleanupOverview('chat',input,async()=>{
   if(mode==='edit')await f.pad.update({...f.first,text:f.first.text+'\nChanged'});
   if(mode==='revoke')await f.pad.update({...f.first,allowAI:false});
   if(mode==='proposal')f.pad.data().organization.proposal={...structuredClone(f.plan),id:'new-proposal'};
   return mode!=='deny';
  }),/declined|changed|unavailable|proposal/);
  if(mode!=='revoke')assert.equal(f.pad.data().organization.applied,original);
 }
});

test('stale overviews and running work refuse cleanup before approval; persistence failure restores previous state',async()=>{
 const f=await fixture();await f.pad.update({...f.first,text:f.first.text+'\nChanged'});await assert.rejects(f.pad.cleanupOverview('chat',f.input(),async()=>assert.fail('No approval for stale content')),/Refresh organization/);
 const g=await fixture();g.pad.organizer.run={};await assert.rejects(g.pad.cleanupOverview('chat',g.input(),async()=>true),/current notebook work/);g.pad.organizer.run=null;
 const before=structuredClone(g.store.state);g.store.save=async()=>{throw Error('Disk write failed');};await assert.rejects(g.pad.cleanupOverview('chat',g.input(),async()=>true),/Disk write failed/);assert.deepEqual(g.store.state,before);
});

test('overview read is available in chat and side answers; cleanup remains a write outside side answers',()=>{
 assert.ok(NOTES_TOOLS.some(tool=>tool.name==='notes_overview'));assert.ok(NOTES_TOOLS.some(tool=>tool.name==='notes_overview_cleanup'));
 assert.equal(hostAction('notes_overview').kind,'read');assert.equal(hostAction('notes_overview_cleanup').kind,'write');assert.ok(LEAN_TOOLS.test('notes_overview'));assert.ok(!LEAN_TOOLS.test('notes_overview_cleanup'));
 assert.ok(FOLLOWUP_READ_TOOLS.has('notes_overview'));assert.ok(!FOLLOWUP_READ_TOOLS.has('notes_overview_cleanup'));
});

test('partial excerpts require explicit complete anchored passages and cannot erase a retained idea',async()=>{
 for(const mode of ['partial','mixed','unanchored','overlap']){
  const f=await fixture(),input=f.input(),item=f.pad.data().organization.applied.groups[0].items[0];item.quote='feature';item.offset=f.first.text.indexOf('feature');input.snapshot=f.pad.readOverview('chat').snapshot;
  if(mode==='mixed')input.items[0].passages=['Finished feature.\nPending café 🌙 idea.'];
  if(mode==='unanchored')input.items[0].passages=['https://example.com/source'];
  if(mode==='overlap')input.items[0].passages=['Finished feature.','Finished feature.\n'];
  const before=structuredClone(f.store.state);await assert.rejects(f.pad.cleanupOverview('chat',input,async()=>assert.fail('Unsafe removal must fail before approval')),/complete lines|retained idea|original excerpt|overlap|complete contiguous/);assert.deepEqual(f.store.state,before);
 }
 const f=await fixture(),item=f.pad.data().organization.applied.groups[0].items[0];item.quote='feature';item.offset=f.first.text.indexOf('feature');const input=f.input();input.items[0].passages=['Finished feature.'];await f.pad.cleanupOverview('chat',input,async()=>true);assert.ok(!f.pad.data().notes.find(n=>n.id===f.first.id).text.includes('Finished feature'));
});

test('multi-note cleanup rolls back as a unit on save failure and keeps empty-note undo across restart',async()=>{
 const f=await fixture(),input=f.input();input.items.push({id:'item-3',reason:'discarded',evidence:'Owner explicitly discarded the research idea.'});
 const before=structuredClone(f.store.state);f.store.save=async()=>{throw Error('Disk unavailable');};await assert.rejects(f.pad.cleanupOverview('chat',input,async()=>true),/Disk unavailable/);assert.deepEqual(f.store.state,before);
 f.store.save=async()=>{};await f.pad.cleanupOverview('chat',input,async()=>true);assert.equal(f.pad.data().notes.find(n=>n.id===f.second.id).text,'');
 const reopened=new Scratchpad({store:{state:structuredClone(f.store.state),save:async()=>{}}});assert.equal(reopened.view().organization.canUndo,true);await reopened.organizer.undo();assert.equal(reopened.data().notes.find(n=>n.id===f.first.id).text,f.first.text);assert.equal(reopened.data().notes.find(n=>n.id===f.second.id).text,f.second.text);assert.equal(reopened.readOverview('chat').stale,false);
});

test('newer source edits prevent both tool and UI Undo from overwriting them',async()=>{
 const f=await fixture();await f.pad.cleanupOverview('chat',f.input(),async()=>true);const note=f.pad.data().notes.find(n=>n.id===f.first.id);await f.pad.update({...note,text:note.text+'\nA newer idea.'});const before=structuredClone(f.store.state);
 assert.equal(f.pad.view().organization.canUndo,false);await assert.rejects(f.pad.organizer.undo(),/changed after cleanup/);await assert.rejects(f.pad.cleanupOverview('chat',{action:'undo',snapshot:f.pad.readOverview('chat').snapshot},async()=>true),/Refresh organization/);assert.deepEqual(f.store.state,before);
});

test('revoking an emptied source removes cleanup backup text from the saved overview',async()=>{
 const f=await fixture(),input=f.input();input.items=[{id:'item-3',reason:'discarded',evidence:'Owner explicitly discarded it.'}];input.groupSummaries=[];await f.pad.cleanupOverview('chat',input,async()=>true);const note=f.pad.data().notes.find(n=>n.id===f.second.id);assert.equal(note.text,'');assert.match(JSON.stringify(f.pad.data().organization.undo),/A research idea/);
 await f.pad.update({...note,allowAI:false});assert.equal(f.pad.data().organization.undo,null);assert.ok(!JSON.stringify(f.pad.data().organization).includes('A research idea'));
});

test('cleanup never triggers model inference and refresh sees only remaining source text',async()=>{
 const f=await fixture();f.pad.organizer.start();await f.pad.cleanupOverview('chat',f.input(),async()=>true);assert.equal(f.pad.organizer.refreshPending,false);assert.equal(f.pad.used(),0);
 const note=f.pad.data().notes.find(n=>n.id===f.first.id);await f.pad.update({...note,text:note.text+'\nAnother idea.'});const inputs=f.pad.organizer.refreshInputs();assert.ok(inputs.changed.some(n=>n.id===note.id));assert.ok(!inputs.changed.some(n=>n.text.includes('Finished feature.')));f.pad.organizer.close();
});

test('legacy overview-only cleanup undo preserves note text',async()=>{
 const f=await fixture(),before=structuredClone(f.pad.data().notes);f.pad.data().organization.undo={id:'old',kind:'cleanup',applied:structuredClone(f.plan)};await f.pad.cleanupOverview('chat',{action:'undo',snapshot:f.pad.readOverview('chat').snapshot},async()=>true);assert.deepEqual(f.pad.data().notes,before);
});

test('note mutations cannot interleave with a pending cleanup save',async()=>{
 const f=await fixture();let release;f.store.save=()=>new Promise(resolve=>{release=resolve;});const pending=f.pad.cleanupOverview('chat',f.input(),async()=>true);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.pad.cleanupCommitting,true);
 await assert.rejects(f.pad.update({...f.first,text:'New draft'}),/cleanup is saving/);await assert.rejects(f.pad.create(),/cleanup is saving/);await assert.rejects(f.pad.remove(f.first.id),/cleanup is saving/);release();await pending;assert.equal(f.pad.cleanupCommitting,false);
});

test('cleanup waits for earlier note saves instead of racing their rollback',async()=>{
 const f=await fixture();let release;f.store.save=()=>new Promise(resolve=>{release=resolve;});const pending=f.pad.update({...f.first,title:'Updated title'});assert.equal(f.pad.savesInFlight,1);
 await assert.rejects(f.pad.cleanupOverview('chat',f.input(),async()=>assert.fail('Must not ask while a save is pending')),/finish saving/);await assert.rejects(f.pad.organizer.undo(),/finish saving/);release();await pending;
});

test('repeated source quotes must be removed at their saved position',async()=>{
 const f=await fixture(),note=f.pad.data().notes.find(n=>n.id===f.first.id);note.text='Finished feature.\nKeep feature pending.\nPending café 🌙 idea.\nhttps://example.com/source';const [done,pending]=f.plan.groups[0].items;done.quote='feature';done.offset=9;pending.offset=note.text.indexOf(pending.quote);const input=f.input();input.items[0].passages=['Keep feature pending.'];await assert.rejects(f.pad.cleanupOverview('chat',input,async()=>assert.fail('Wrong occurrence')),/saved position/);assert.match(note.text,/Keep feature pending/);
});

test('malformed removed anchors and incomplete new Undo records fail closed',async()=>{
 for(const change of [item=>item.quote='',item=>delete item.quote,item=>item.offset=-1,item=>item.offset=5000]){
  const f=await fixture();change(f.plan.groups[0].items[0]);const input=f.input();input.items[0].passages=['Finished feature.'];await assert.rejects(f.pad.cleanupOverview('chat',input,async()=>assert.fail('Malformed source')),/invalid/);
 }
 for(const change of [undo=>delete undo.notes,undo=>undo.notes=null,undo=>delete undo.notes[0].beforeText]){
  const f=await fixture();await f.pad.cleanupOverview('chat',f.input(),async()=>true);change(f.pad.data().organization.undo);assert.equal(f.pad.view().organization.canUndo,false);const before=structuredClone(f.store.state);await assert.rejects(f.pad.organizer.undo(),/changed after cleanup/);assert.deepEqual(f.store.state,before);
 }
});

test('approval binds the exact source passages and summaries, even if input changes while waiting',async()=>{
 const f=await fixture(),input=f.input(),before=structuredClone(f.store.state);await assert.rejects(f.pad.cleanupOverview('chat',input,async()=>{input.overview='Altered after the approval preview.';return true;}),/changed while approval/);assert.deepEqual(f.store.state,before);
});
