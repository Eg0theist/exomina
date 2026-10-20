import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneNotebookView,phoneNotebookNote} from '../desktop/remote-notebook.mjs';
import {Scratchpad} from '../desktop/scratchpad.mjs';
import {REMOTE_METHODS} from '../desktop/remote-bridge.mjs';

test('phone notebook lists metadata without sending every note body or background-work configuration',()=>{
  const notes=Array.from({length:50},(_,index)=>({id:String(index),title:'Notebook '+index,text:'SENSITIVE_NOTE_BODY'.repeat(5000),revision:3,updatedAt:'2026-10-18',allowAI:true,lastCleanup:{beforeText:'REMOVED_BODY'}}));
  const result=phoneNotebookView({notes,jobs:[{goal:'PRIVATE_WORK_GOAL'}],settings:{permissionMode:'full'},organization:{applied:null,proposal:{overview:'UNAPPLIED_PROPOSAL'}}});
  assert.equal(result.notes.length,50);assert.ok(JSON.stringify(result).length<12000);
  assert.doesNotMatch(JSON.stringify(result),/SENSITIVE_NOTE_BODY|REMOVED_BODY|PRIVATE_WORK_GOAL|full|UNAPPLIED_PROPOSAL/);
  assert.deepEqual(phoneNotebookNote({notes},'0'),{id:'0',title:'Notebook 0',text:notes[0].text,revision:3,updatedAt:'2026-10-18'});
  assert.throws(()=>phoneNotebookNote({notes},'missing'),/removed/);
});

test('phone overview follows live notebook source consent and stale revisions',async()=>{
  const store={state:{},save:async()=>{}},pad=new Scratchpad({store});
  const note=await pad.create();await pad.update({...note,title:'Ideas',text:'Verify a useful workflow.',allowAI:true});
  const current=pad.view().notes[0];
  pad.data().organization={applied:{id:'plan',overview:'SHARED_OVERVIEW_MARKER',sources:[{id:note.id,revision:current.revision}],groups:[]}};
  assert.equal(phoneNotebookView(pad.view()).organization.applied.overview,'SHARED_OVERVIEW_MARKER');
  await pad.update({...current,text:'A changed source.',allowAI:true});
  assert.equal(phoneNotebookView(pad.view()).organization.appliedStale,true);
  await pad.update({...pad.view().notes[0],allowAI:false});
  assert.doesNotMatch(JSON.stringify(phoneNotebookView(pad.view()).organization),/SHARED_OVERVIEW_MARKER/);
});

test('paired note reads and edits cannot change sharing, grants or notebook-work settings',()=>{
  assert.deepEqual(REMOTE_METHODS['notes.phone.view']({includePrivate:true,settings:true}),{});
  assert.deepEqual(REMOTE_METHODS['notes.get']({id:'note',allowAI:true}),{id:'note'});
  assert.deepEqual(REMOTE_METHODS['notes.save']({id:'note',title:'Title',text:'Text',revision:4,allowAI:true,permissionMode:'full',enabled:true}),{id:'note',title:'Title',text:'Text',revision:4});
  for(const method of ['notes.organization.apply','notes.organization.prepare','notes.settings','notes.job.queue','notes.remove'])assert.equal(Object.hasOwn(REMOTE_METHODS,method),false);
});
