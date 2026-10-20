import test from 'node:test';
import assert from 'node:assert/strict';
import {Scratchpad,NOTES_TOOLS} from '../desktop/scratchpad.mjs';

async function fixture(){
 const store={state:{},save:async()=>{}},pad=new Scratchpad({store,now:()=>new Date('2026-10-19T14:00:00Z')});
 const created=await pad.create(),note=await pad.update({...created,title:'Ideas',text:'Mobile work\nKeep this link: https://example.com/source\n\nSmart home\n',allowAI:true});
 const input=()=>({id:note.id,revision:pad.data().notes[0].revision,annotations:[{quote:'Mobile work',status:'partial',text:'Chat exists; a physical phone approval test remains.'},{quote:'Smart home',status:'needs-clarification',text:'Choose a platform and the first action.'}]});
 return {pad,store,note,input};
}

test('native annotations preserve every original character and link, with reversible dated status comments',async()=>{
 const f=await fixture(),before=structuredClone(f.note);let request;
 const result=await f.pad.annotate('chat',f.input(),async r=>{request=r;return true;});
 const note=f.pad.data().notes[0];assert.equal(result.added,2);assert.equal(result.revision,before.revision+1);assert.match(note.text,/AI review 2026-10-19 \| PARTIAL/);assert.match(note.text,/NEEDS CLARIFICATION/);assert.match(request.detail,/Mobile work/);
 assert.equal(note.text.replace(/\n\n> \[AI review [^\n]+\]\n(?:> [^\n]*\n)+/g,''),before.text);assert.equal(note.allowAI,true);
 const restored=await f.pad.restoreAnnotations({id:note.id,revision:note.revision,annotationId:result.annotationId});assert.equal(restored.text,before.text);assert.equal(restored.lastAnnotations,null);
 assert.ok(NOTES_TOOLS.find(tool=>tool.name==='notes_annotate'));
});

test('private, stale, ambiguous, overlapping, partial-line and out-of-task anchors refuse before approval',async()=>{
 for(const mode of ['private','stale','unknown','ambiguous','overlap','partial','scope']){
  const f=await fixture(),input=f.input();
  if(mode==='private')f.pad.data().notes[0].allowAI=false;
  if(mode==='stale')input.revision--;
  if(mode==='unknown')input.annotations[0].quote='Missing';
  if(mode==='ambiguous')f.pad.data().notes[0].text+='Mobile work\n';
  if(mode==='overlap')input.annotations[1].quote=f.note.text.slice(0,f.note.text.indexOf('\n\n'));
  if(mode==='partial')input.annotations[0].quote='Mobile';
  if(mode==='scope')f.pad.active={job:{conversationId:'chat',noteId:f.note.id,goal:'Smart home',title:'Scoped'}};
  const before=structuredClone(f.store.state);let asked=false;await assert.rejects(f.pad.annotate('chat',input,async()=>{asked=true;return true;}));assert.equal(asked,false,mode);assert.deepEqual(f.store.state,before,mode);
 }
});

test('declining, editing or revoking sharing during approval cannot overwrite the note',async()=>{
 for(const mode of ['deny','edit','revoke']){
  const f=await fixture();let after;
  await assert.rejects(f.pad.annotate('chat',f.input(),async()=>{if(mode!=='deny')await f.pad.update({...f.pad.data().notes[0],...(mode==='edit'?{text:f.note.text+'User addition.'}:{allowAI:false})});after=structuredClone(f.store.state);return mode!=='deny';}));
  assert.deepEqual(f.store.state,after,mode);assert.equal(f.pad.data().notes[0].lastAnnotations,undefined);
 }
});

test('tool Undo restores only its exact batch, respects sharing and rejects newer source edits',async()=>{
 const f=await fixture(),result=await f.pad.annotate('chat',f.input(),async()=>true),undo={action:'undo',id:f.note.id,revision:result.revision,annotationId:result.annotationId};
 const reopened=new Scratchpad({store:{state:structuredClone(f.store.state),save:async()=>{}}});await reopened.annotate('chat',undo,async()=>true);assert.equal(reopened.data().notes[0].text,f.note.text);
 await f.pad.update({...f.pad.data().notes[0],text:f.pad.data().notes[0].text+'Newer edit.'});const before=structuredClone(f.store.state);await assert.rejects(f.pad.annotate('chat',{...undo,revision:f.pad.data().notes[0].revision},async()=>true),/changed/);assert.deepEqual(f.store.state,before);
 assert.equal(f.pad.data().notes[0].lastAnnotations.beforeText,undefined);
});

test('CRLF notes retain their line endings and fenced code cannot be split by a comment',async()=>{
 const f=await fixture();await f.pad.update({...f.pad.data().notes[0],text:'First idea\r\n\r\n```js\r\nconst x=1;\r\n```\r\n'});
 let input={id:f.note.id,revision:f.pad.data().notes[0].revision,annotations:[{quote:'const x=1;',status:'reviewed',text:'A comment.'}]};await assert.rejects(f.pad.annotate('chat',input,async()=>true),/fenced block/);
 input.annotations[0].quote='First idea';await f.pad.annotate('chat',input,async()=>true);assert.ok(!/(?<!\r)\n/.test(f.pad.data().notes[0].text));
});

test('a failed annotation save restores the original note and does not publish a false result',async()=>{
 const f=await fixture(),before=structuredClone(f.store.state);f.store.save=async()=>{throw Error('Disk refused');};await assert.rejects(f.pad.annotate('chat',f.input(),async()=>true),/Disk refused/);assert.deepEqual(f.store.state,before);
});
