import test from 'node:test';
import assert from 'node:assert/strict';
import {Scratchpad,noteWorkPrompt} from '../desktop/scratchpad.mjs';

function fixture(){const store={state:{},save:async()=>{}},calls=[];let time=new Date('2026-10-15T12:00:00Z');const pad=new Scratchpad({store,scope:()=> 'C:/synthetic/project',idle:()=>true,now:()=>time,execute:async request=>{calls.push(request);await request.onStarted('work-chat');await pad.progress('work-chat',{status:'complete',summary:'Done',evidence:['Synthetic outcome verified']});return {text:'Done',selection:{provider:'codex',model:'test',effort:'high'}};},choose:async()=>({text:'{"noteId":null,"idea":""}'})});return {pad,store,calls,setTime:value=>{time=new Date(value);},settings:patch=>pad.configure({...pad.settings(),provider:'codex',onlyWhenIdle:false,...patch}),note:async(text='Create a synthetic report',allowAI=false)=>{const note=await pad.create();return pad.update({...note,title:'Idea',text,allowAI});}};}

test('scratch notes are private, revision checked, bounded and portable across host restarts',async()=>{
 const f=fixture(),note=await f.note('Private café 🌙 draft');assert.deepEqual(f.pad.readNotes('chat'),[]);assert.throws(()=>f.pad.readNotes('chat',{id:note.id}),/private/);
 await assert.rejects(f.pad.update({...note,revision:1,text:'overwrite'}),/changed elsewhere/);assert.equal(f.pad.view().notes[0].text,'Private café 🌙 draft');
 const approved=await f.pad.update({...note,allowAI:true});assert.equal(f.pad.readNotes('chat',{id:note.id,offset:0,limit:7}).nextOffset,7);
 await assert.rejects(f.pad.update({...approved,text:'x'.repeat(100001)}),/100,000/);
 const restored=new Scratchpad({store:{state:JSON.parse(JSON.stringify(f.store.state)),save:async()=>{}}});assert.equal(restored.view().notes[0].text,'Private café 🌙 draft');assert.equal(restored.view().jobs.length,0);
});

test('host continues unfinished work across replies and preserves model selection and checkpoint',async()=>{
 const f=fixture();await f.settings();const note=await f.note(),job=await f.pad.enqueue({id:note.id,text:note.text});let runs=0;
 f.pad.execute=async request=>{await request.onStarted('work-chat');runs++;if(runs===1){await f.pad.progress('work-chat',{status:'continue',summary:'Created the report. Needs a read-back.',nextStep:'Read it once.'});return {text:'Continue',selection:{provider:'claude',model:'sonnet',effort:'high'}};}assert.equal(request.selection.provider,'claude');assert.match(request.job.checkpoint,/Created/);await f.pad.progress('work-chat',{status:'complete',summary:'Read-back passed',evidence:['Report content read back exactly']});return {text:'Done'};};
 await f.pad.startItem(job.id,{manual:true});await f.pad.pending;assert.equal(runs,2);assert.equal(job.status,'complete');assert.equal(f.pad.used(),2);assert.equal(job.evidence[0],'Report content read back exactly');
});

test('missing completion evidence cannot finish a task; unreported replies stop at the per-item cap',async()=>{
 const f=fixture();await f.settings({maxSteps:2});const note=await f.note(),job=await f.pad.enqueue({id:note.id,text:note.text});
 f.pad.execute=async request=>{await request.onStarted('work-chat');await assert.rejects(f.pad.progress('work-chat',{status:'complete',summary:'Trust me'}),/evidence/);return {text:'Should I continue?'};};
 await f.pad.startItem(job.id,{manual:true});await f.pad.pending;assert.equal(job.status,'paused');assert.equal(job.steps,2);assert.equal(f.pad.used(),2);assert.notEqual(job.status,'complete');
});

test('all models unavailable preserves queued work without charging usage; capacity recovery resumes it',async()=>{
 const f=fixture();await f.settings({enabled:true});const note=await f.note(),job=await f.pad.enqueue({id:note.id,text:note.text});f.pad.available=()=>false;
 await f.pad.startItem(job.id,{manual:true});assert.equal(job.status,'waiting-usage');assert.equal(f.pad.used(),0);assert.equal(f.calls.length,0);
 f.pad.available=()=>true;f.setTime('2026-10-15T12:06:00Z');await f.pad.tick();await f.pad.pending;assert.equal(job.status,'complete');assert.equal(f.calls.length,1);
});

test('daily budget suspends continuation without losing progress; a new day can resume it',async()=>{
 const f=fixture();await f.settings({enabled:true,dailyBudget:1,maxSteps:3});const note=await f.note(),job=await f.pad.enqueue({id:note.id,text:note.text});let steps=0;
 f.pad.execute=async request=>{await request.onStarted('work-chat');steps++;await f.pad.progress('work-chat',steps===1?{status:'continue',summary:'First step done',nextStep:'Verify outcome'}:{status:'complete',summary:'Verified',evidence:['Read-back passed']});return {text:'Step'};};
 await f.pad.startItem(job.id,{manual:true});await f.pad.pending;assert.equal(job.status,'waiting-budget');assert.match(job.checkpoint,/First step/);
 f.setTime('2026-10-16T12:00:00Z');await f.pad.tick();await f.pad.pending;assert.equal(job.status,'complete');assert.equal(f.pad.used(),1);
});

test('planning sees only approved notes and must quote a real passage; finished ideas are not queued twice',async()=>{
 const f=fixture();await f.settings();await f.note('PRIVATE NOTE');const note=await f.note('Make a short outline. Then review it.',true);
 f.pad.choose=async request=>{assert.equal(request.notes.length,1);assert.equal(request.notes[0].id,note.id);return {text:JSON.stringify({noteId:note.id,idea:'Make a short outline.'})};};
 await f.pad.scan(true);const job=f.pad.view().jobs[0];assert.equal(job.goal,'Make a short outline.');await f.pad.startItem(job.id,{manual:true});await f.pad.pending;
 await f.pad.scan(true);assert.equal(f.pad.view().jobs.length,1);
 f.pad.choose=async()=>({text:JSON.stringify({noteId:note.id,idea:'Unrequested destructive work'})});await f.pad.scan(true);assert.match(f.pad.view().lastScan.error,/exact passage/);assert.equal(f.pad.view().jobs.length,1);
});

test('pausing, deleting source notes and restarts cannot falsely complete or replay active work',async()=>{
 const f=fixture();await f.settings();const note=await f.note(),job=await f.pad.enqueue({id:note.id,text:note.text});let release;const cancelled=[];f.pad.cancel=id=>cancelled.push(id);
 f.pad.execute=async request=>{await request.onStarted('work-chat');return new Promise(resolve=>{release=resolve;});};
 await f.pad.startItem(job.id,{manual:true});await new Promise(resolve=>setImmediate(resolve));await f.pad.pauseActive();release({text:'Done'});await f.pad.pending;
 assert.equal(job.status,'paused');assert.deepEqual(cancelled,['work-chat']);
 job.status='running';f.pad.start();f.pad.close();assert.equal(job.status,'paused');await f.pad.remove(note.id);assert.equal(f.pad.view().jobs.length,0);assert.equal(f.pad.view().notes.length,0);
});

test('automatic note work is off by default and respects idle time, scope and explicit blockers',async()=>{
 const f=fixture(),note=await f.note(),job=await f.pad.enqueue({id:note.id,text:note.text});await f.pad.tick();assert.equal(f.calls.length,0);
 await f.settings({enabled:true,onlyWhenIdle:true});f.pad.idle=()=>false;await f.pad.tick();assert.equal(f.calls.length,0);f.pad.idle=()=>true;
 f.pad.execute=async request=>{await request.onStarted('work-chat');return {text:'This needs an approval',blockedReason:'An explicit permission rule blocks writing.'};};
 await f.pad.tick();await f.pad.pending;assert.equal(job.status,'blocked');assert.match(job.reason,/permission/);
 f.pad.scope=()=> 'C:/another-project';await f.pad.startItem(job.id,{manual:true});assert.equal(job.status,'blocked');assert.match(job.reason,/folder changed/);
 const prompt=noteWorkPrompt(job,f.pad.settings());assert.match(prompt,/notes_work_update/);assert.match(prompt,/Do not write scratchpad content into shared memory/);
});

test('planning history excludes private and revoked notes and retains approved completed passages after queue removal',async()=>{
 const f=fixture();await f.settings();const privateNote=await f.note('PRIVATE QUEUED PASSAGE'),approved=await f.note('Allowed first idea. Allowed second idea.',true);
 const hidden=await f.pad.enqueue({id:privateNote.id,text:privateNote.text}),done=await f.pad.enqueue({id:approved.id,text:'Allowed first idea.'});
 await f.pad.startItem(done.id,{manual:true});await f.pad.pending;await f.pad.removeJob(done.id);
 let attempts=0;f.pad.choose=async request=>{attempts++;assert.equal(JSON.stringify(request.previous).includes('PRIVATE'),false);assert.ok(request.previous.some(item=>item.idea==='Allowed first idea.'));return {text:JSON.stringify({noteId:approved.id,idea:attempts===1?'Allowed first idea.':'Allowed second idea.'})};};
 await f.pad.scan(true);assert.equal(attempts,2);assert.equal(f.pad.view().jobs.length,2);assert.ok(f.pad.view().jobs.some(job=>job.goal==='Allowed second idea.'));assert.equal(f.pad.view().jobs[0].id,hidden.id);
 await f.pad.update({...approved,allowAI:false});assert.deepEqual(f.pad.planningHistory(),[]);
});

test('revoked and stale-folder queue entries do not starve later eligible work',async()=>{
 const f=fixture();await f.settings({enabled:true});const revoked=await f.note('Revoked idea',true),ready=await f.note('Ready idea');
 const first=await f.pad.enqueue({id:revoked.id,text:revoked.text,manual:false}),second=await f.pad.enqueue({id:ready.id,text:ready.text});
 await f.pad.update({...revoked,allowAI:false});assert.equal(first.status,'blocked');await f.pad.tick();await f.pad.pending;assert.equal(second.status,'complete');
 const stale=await f.pad.enqueue({id:ready.id,text:ready.text});f.pad.scope=()=> 'C:/new-workspace';const current=await f.pad.enqueue({id:ready.id,text:ready.text});await f.pad.tick();assert.equal(stale.status,'blocked');await f.pad.tick();await f.pad.pending;assert.equal(current.status,'complete');
});

test('transient planning failure retries after backoff and changed instructions invalidate a drained scan',async()=>{
 const f=fixture();await f.settings({enabled:true});await f.note('An allowed idea',true);let calls=0;f.pad.choose=async()=>{calls++;if(calls===1)throw Error('Temporary network failure');return {text:'{"noteId":null,"idea":""}'};};
 await f.pad.tick();assert.equal(calls,1);await f.pad.tick();assert.equal(calls,1);f.setTime('2026-10-15T12:16:00Z');await f.pad.tick();assert.equal(calls,2);await f.pad.tick();assert.equal(calls,2);
 await f.settings({enabled:true,instructions:'Work on the newly allowed class of ideas.'});await f.pad.tick();assert.equal(calls,3);
});

test('revoking an approved note cancels planning and no result or fallback may adopt the revoked task',async()=>{
 const f=fixture();await f.settings();const note=await f.note('An allowed idea',true);let request,release;const cancellations=[];f.pad.cancel=id=>cancellations.push(id);
 f.pad.choose=async value=>{request=value;value.onStarted('planner');return new Promise(resolve=>{release=resolve;});};
 const scan=f.pad.scan(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(request.cancelled(),false);await f.pad.update({...note,allowAI:false});assert.equal(request.cancelled(),true);assert.deepEqual(cancellations,['planner']);
 release({text:JSON.stringify({noteId:note.id,idea:note.text})});await scan;assert.equal(f.pad.view().jobs.length,0);assert.equal(f.pad.view().scanning,false);
});

test('revoking note access cancels an active automatic item and refuses late progress',async()=>{
 const f=fixture();await f.settings({enabled:true});const note=await f.note('An approved task',true),job=await f.pad.enqueue({id:note.id,text:note.text,manual:false});let release;const cancelled=[];f.pad.cancel=id=>cancelled.push(id);
 f.pad.execute=async request=>{await request.onStarted('automatic-chat');return new Promise(resolve=>{release=resolve;});};
 await f.pad.startItem(job.id);await new Promise(resolve=>setImmediate(resolve));await f.pad.update({...note,allowAI:false});assert.equal(job.status,'paused');assert.deepEqual(cancelled,['automatic-chat']);
 await assert.rejects(f.pad.progress('automatic-chat',{status:'complete',summary:'Late report',evidence:['Claimed result']}),/not the current/);release({text:'Late result'});await f.pad.pending;assert.equal(job.status,'paused');assert.deepEqual(f.pad.view().jobs[0].evidence,[]);
});

test('completed-item cleanup preserves unfinished text, records evidence and undoes exactly after a restart',async()=>{
 const f=fixture(),original='Finished café 🌙\n\nStill needs a real phone test.\n\nAnother verified item\n';
 const note=await f.note(original,true),read=f.pad.readNotes('chat',{id:note.id});assert.equal(read.revision,note.revision);
 const result=await f.pad.removeCompleted('chat',{id:note.id,revision:read.revision,items:[{text:'Another verified item\n',evidence:'The result was read back.'},{text:'Finished café 🌙\n\n',evidence:'Behaviour verified in the real host.'}]},async request=>{assert.equal(request.action.kind,'write');assert.equal(request.action.target,note.id);assert.match(request.detail,/Finished café 🌙/);return true;});
 assert.equal(result.removed,2);assert.equal(f.pad.view().notes[0].text,'Still needs a real phone test.\n\n');assert.equal(f.pad.view().notes[0].title,note.title);assert.equal(f.pad.view().notes[0].allowAI,true);
 assert.equal(JSON.stringify(f.pad.readNotes('chat',{id:note.id})).includes('Finished café'),false);
 const restored=new Scratchpad({store:{state:JSON.parse(JSON.stringify(f.store.state)),save:async()=>{}}}),saved=restored.view().notes[0];
 assert.equal(saved.lastCleanup.items[0].evidence,'Behaviour verified in the real host.');
 const undone=await restored.restoreCleanup({id:note.id,revision:saved.revision,cleanupId:result.cleanupId});assert.equal(undone.text,original);assert.equal(undone.lastCleanup,null);
});

test('cleanup refuses private, stale, ambiguous, overlapping, partial-line and unverified passages before asking',async()=>{
 const f=fixture(),privateNote=await f.note('Private completed task'),note=await f.note('Same\nSame\nFirst line\nSecond line\nUnfinished',true);let approvals=0;
 const remove=patch=>f.pad.removeCompleted('chat',{id:note.id,revision:note.revision,items:[{text:'First line',evidence:'Verified'}],...patch},async()=>{approvals++;return true;});
 await assert.rejects(remove({id:privateNote.id,revision:privateNote.revision}),/private/);
 await assert.rejects(remove({revision:1}),/changed/);
 await assert.rejects(remove({items:[{text:'Same',evidence:'Verified'}]}),/exactly once/);
 await assert.rejects(remove({items:[{text:'First line',evidence:''}]}),/evidence/);
 await assert.rejects(remove({items:[{text:'First',evidence:'Verified'}]}),/complete lines/);
 await assert.rejects(remove({items:[{text:'First line\nSecond line',evidence:'Verified'},{text:'Second line',evidence:'Verified'}]}),/overlap/);
 assert.equal(approvals,0);assert.equal(f.pad.view().notes.find(item=>item.id===note.id).text,note.text);
});

test('denial, concurrent editing and revoked access leave the latest note intact',async()=>{
 const f=fixture(),note=await f.note('Finished\nKeep this',true),input={id:note.id,revision:note.revision,items:[{text:'Finished',evidence:'Verified'}]};
 await assert.rejects(f.pad.removeCompleted('chat',input,async()=>false),/declined/);assert.equal(f.pad.view().notes[0].revision,note.revision);
 await assert.rejects(f.pad.removeCompleted('chat',input,async()=>{await f.pad.update({...note,text:note.text+'\nA new idea'});return true;}),/changed/);assert.match(f.pad.view().notes[0].text,/A new idea/);
 const latest={...f.pad.view().notes[0]};await assert.rejects(f.pad.removeCompleted('chat',{...input,revision:latest.revision},async()=>{await f.pad.update({...latest,allowAI:false});return true;}),/no longer available/);assert.equal(f.pad.view().notes[0].lastCleanup,undefined);
});

test('a manually queued private passage cannot clean up unrelated text or broaden access while waiting',async()=>{
 const f=fixture(),note=await f.note('Selected task\nPRIVATE_UNRELATED_TASK'),job={noteId:note.id,title:note.title,goal:'Selected task',conversationId:'work'};f.pad.active={job};
 assert.equal(f.pad.readNotes('work',{id:note.id}).text,'Selected task');
 await assert.rejects(f.pad.removeCompleted('work',{id:note.id,revision:note.revision,items:[{text:'PRIVATE_UNRELATED_TASK',evidence:'Claimed'}]},async()=>true),/scope/);
 await assert.rejects(f.pad.removeCompleted('work',{id:note.id,revision:note.revision,items:[{text:'Selected task',evidence:'Verified'}]},async()=>{f.pad.active=null;return true;}),/no longer available/);
 assert.equal(f.pad.view().notes[0].text,note.text);
});

test('failed cleanup persistence rolls back and undo cannot overwrite newer edits',async()=>{
 const f=fixture(),note=await f.note('Finished\nNext idea',true),input={id:note.id,revision:note.revision,items:[{text:'Finished',evidence:'Verified'}]};
 f.store.save=async()=>{throw Error('Disk unavailable');};await assert.rejects(f.pad.removeCompleted('chat',input,async()=>true),/Disk unavailable/);assert.deepEqual(f.pad.view().notes[0],note);
 f.store.save=async()=>{};const result=await f.pad.removeCompleted('chat',input,async()=>true),cleaned=f.pad.view().notes[0];await f.pad.update({...cleaned,text:cleaned.text+'\nNew work'});const changed=f.pad.view().notes[0];
 await assert.rejects(f.pad.restoreCleanup({id:note.id,revision:changed.revision,cleanupId:result.cleanupId}),/newer edits/);assert.match(changed.text,/New work/);assert.equal(changed.lastCleanup.items[0].text,'Finished');
});

test('essential clarification waits durably and only an explicit answer resumes the same task',async()=>{
 const f=fixture();await f.settings({enabled:true});const note=await f.note('Organize the project files.',true),job=await f.pad.enqueue({id:note.id,text:note.text});job.checkpoint='Inventory completed; no files moved.';
 let runs=0;f.pad.execute=async request=>{runs++;await request.onStarted('original-work-chat');await f.pad.progress('original-work-chat',{status:'blocked',summary:'The intended grouping is ambiguous.',question:'Group files by client or by year?'});return {text:'The question is saved.'};};
 await f.pad.startItem(job.id,{manual:true});await f.pad.pending;
 assert.equal(job.status,'needs-answer');assert.equal(job.steps,1);assert.match(job.checkpoint,/Inventory completed/);assert.equal(f.pad.view().notes[0].text,note.text);
 const questionId=job.clarification.id;await f.pad.tick();assert.equal(runs,1);await assert.rejects(f.pad.startItem(job.id,{manual:true}),/Answer the question/);
 const store={state:JSON.parse(JSON.stringify(f.store.state)),save:async()=>{}},restored=new Scratchpad({store,scope:()=>job.scope,now:()=>new Date('2026-10-15T12:00:00Z'),execute:async request=>{
  runs++;assert.equal(request.job.id,job.id);assert.equal(request.job.conversationId,'original-work-chat');assert.equal(request.job.goal,note.text);assert.equal(request.job.clarifications[0].answer,'By client');assert.match(noteWorkPrompt(request.job,request.settings),/never permission grants/);
  await request.onStarted('original-work-chat');await restored.progress('original-work-chat',{status:'complete',summary:'Client groups verified.',evidence:['Each file belongs to its chosen client.']});return {text:'Done'};
 }});
 restored.start();try{await restored.answerClarification({id:job.id,clarificationId:questionId,answer:'By client'});await restored.pending;}finally{restored.close();}
 const finished=restored.view().jobs[0];assert.equal(finished.status,'complete');assert.equal(finished.steps,2);assert.equal(finished.clarifications[0].question,'Group files by client or by year?');assert.equal(restored.view().notes[0].text,note.text);
 await assert.rejects(restored.answerClarification({id:job.id,clarificationId:questionId,answer:'By year'}),/saving|already answered/);assert.equal(runs,2);
});

test('permission blockers take precedence over a model clarification or completion claim',async()=>{
 const f=fixture();await f.settings();const note=await f.note(),job=await f.pad.enqueue({id:note.id,text:note.text});
 f.pad.execute=async request=>{await request.onStarted('work-chat');
  await assert.rejects(f.pad.progress('work-chat',{status:'continue',summary:'Unclear',nextStep:'Think',question:'Which result?'}),/requires blocked/);
  await assert.rejects(f.pad.progress('work-chat',{status:'blocked',summary:'Permission missing',question:'May I write?'},{blockedReason:'Explicit write deny.'}),/cannot approve/);
  await f.pad.progress('work-chat',{status:'blocked',summary:'Claimed ambiguity',question:'Which result?'});return {text:'Question',blockedReason:'An explicit permission rule blocks writing.'};
 };
 await f.pad.startItem(job.id,{manual:true});await f.pad.pending;assert.equal(job.status,'blocked');assert.equal(job.clarification,undefined);assert.match(job.reason,/permission rule/);
 await assert.rejects(f.pad.answerClarification({id:job.id,clarificationId:'invented',answer:'Yes'}),/already answered/);
 f.pad.execute=async request=>{await request.onStarted('work-chat');await f.pad.progress('work-chat',{status:'complete',summary:'Claimed completion',evidence:['Claimed read-back']});return {text:'Done',blockedReason:'A native approval is required.'};};
 await f.pad.startItem(job.id,{manual:true});await f.pad.pending;assert.equal(job.status,'blocked');assert.equal(f.pad.data().handled.length,0);
});

test('clarification survives an interrupted or failed provider step without automatic repetition',async()=>{
 const f=fixture();await f.settings({enabled:true});const note=await f.note(),job=await f.pad.enqueue({id:note.id,text:note.text});let release;
 f.pad.execute=async request=>{await request.onStarted('work-chat');await f.pad.progress('work-chat',{status:'blocked',summary:'A choice is missing.',question:'Which document should be used?'});return new Promise(resolve=>{release=resolve;});};
 await f.pad.startItem(job.id,{manual:true});await new Promise(resolve=>setImmediate(resolve));const state=JSON.parse(JSON.stringify(f.store.state));
 f.pad.close();release({text:'Late answer'});await f.pad.pending;assert.equal(job.status,'needs-answer');
 let resumed=0;const restored=new Scratchpad({store:{state,save:async()=>{}},execute:async()=>{resumed++;},available:()=>true});restored.start();try{assert.equal(restored.view().jobs[0].status,'needs-answer');await restored.tick();assert.equal(resumed,0);}finally{restored.close();}
 const g=fixture();await g.settings();const other=await g.note(),failed=await g.pad.enqueue({id:other.id,text:other.text});
 g.pad.execute=async request=>{await request.onStarted('work-chat');await g.pad.progress('work-chat',{status:'blocked',summary:'Missing choice',question:'Which date?'});throw Error('Provider disconnected after saving question');};
 await g.pad.startItem(failed.id,{manual:true});await g.pad.pending;assert.equal(failed.status,'needs-answer');assert.equal(failed.clarification.question,'Which date?');
});

test('answering does not replenish daily or per-task budgets and still respects usage availability',async()=>{
 for(const gate of ['daily','steps','usage']){
  const f=fixture();await f.settings({enabled:true,dailyBudget:gate==='daily'?1:8,maxSteps:gate==='steps'?1:3});const note=await f.note(),job=await f.pad.enqueue({id:note.id,text:note.text});let calls=0;
  f.pad.execute=async request=>{calls++;await request.onStarted('work-chat');await f.pad.progress('work-chat',{status:'blocked',summary:'A detail is missing.',question:'Which format?'});return {text:'Question'};};
  await f.pad.startItem(job.id,{manual:true});await f.pad.pending;const used=f.pad.used();if(gate==='usage')f.pad.available=()=>false;
  await f.pad.answerClarification({id:job.id,clarificationId:job.clarification.id,answer:'CSV'});await f.pad.pending;
  assert.equal(job.status,gate==='daily'?'waiting-budget':gate==='steps'?'paused':'waiting-usage');assert.equal(job.steps,1);assert.equal(f.pad.used(),used);assert.equal(calls,1);assert.equal(job.clarifications[0].answer,'CSV');
  if(gate==='steps')assert.match(job.reason,/answer is saved.*Allow 1 more step.*daily limit/);
  if(gate==='daily'){
   f.setTime('2026-10-16T12:00:00Z');f.pad.execute=async request=>{await request.onStarted('work-chat');await f.pad.progress('work-chat',{status:'complete',summary:'CSV verified',evidence:['CSV opened and checked']});return {text:'Done'};};await f.pad.tick();await f.pad.pending;assert.equal(job.status,'complete');assert.equal(job.steps,2);
  }
 }
});

test('clarification answers reject stale submissions, revoked access and changed folders, and roll back failed saves',async()=>{
 const f=fixture();await f.settings();const note=await f.note('An automatic idea.',true),job=await f.pad.enqueue({id:note.id,text:note.text,manual:false});
 f.pad.execute=async request=>{await request.onStarted('work-chat');await f.pad.progress('work-chat',{status:'blocked',summary:'Missing detail',question:'Which audience?'});return {text:'Question'};};
 await f.pad.startItem(job.id,{manual:true});await f.pad.pending;const input={id:job.id,clarificationId:job.clarification.id,answer:'Existing users'};
 await assert.rejects(f.pad.answerClarification({...input,clarificationId:'stale'}),/already answered/);await assert.rejects(f.pad.answerClarification({...input,answer:' '.repeat(3)}),/your answer/);await assert.rejects(f.pad.answerClarification({...input,answer:'x'.repeat(4001)}),/your answer/);
 const before=structuredClone(job);f.store.save=async()=>{throw Error('Disk full');};await assert.rejects(f.pad.answerClarification(input),/Disk full/);assert.deepEqual(job,before);f.store.save=async()=>{};
 f.pad.scope=()=> 'C:/changed';await assert.rejects(f.pad.answerClarification(input),/folder changed/);f.pad.scope=()=>job.scope;
 await f.pad.update({...note,allowAI:false});await assert.rejects(f.pad.answerClarification(input),/no longer approved/);assert.equal(job.status,'needs-answer');assert.equal(job.clarifications,undefined);
});

test('answer persistence excludes scheduler races and a concurrent pause prevents resume',async()=>{
 const f=fixture();await f.settings({enabled:true});const note=await f.note(),job=await f.pad.enqueue({id:note.id,text:note.text});let calls=0;
 f.pad.execute=async request=>{calls++;await request.onStarted('work-chat');await f.pad.progress('work-chat',{status:'blocked',summary:'Missing detail',question:'Which file?'});return {text:'Question'};};
 await f.pad.startItem(job.id,{manual:true});await f.pad.pending;const input={id:job.id,clarificationId:job.clarification.id,answer:'report.txt'};let release;
 f.store.save=()=>new Promise(resolve=>{release=resolve;});const answering=f.pad.answerClarification(input);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.pad.view().activeId,job.id);await f.pad.tick();assert.equal(calls,1);await assert.rejects(f.pad.startItem(job.id,{manual:true}),/already running/);await assert.rejects(f.pad.answerClarification(input),/saving/);
 f.store.save=async()=>{};await f.pad.configure({...f.pad.settings(),enabled:false});release();await answering;
 assert.equal(job.status,'paused');assert.equal(job.clarifications[0].answer,'report.txt');assert.equal(calls,1);assert.equal(f.pad.view().activeId,null);
});

test('an answer can save during other work or planning without interrupting or automatically resuming',async()=>{
 for(const other of ['job','scan']){
  const f=fixture();await f.settings({enabled:false});const note=await f.note('Prepare the original report.'),job=await f.pad.enqueue({id:note.id,text:note.text});job.nextStep='OBSOLETE_NEXT_STEP';let calls=0,release;
  f.pad.execute=async request=>{calls++;await request.onStarted('original-work-chat');await f.pad.progress('original-work-chat',{status:'blocked',summary:'Audience missing.',question:'Who will read it?'});return {text:'Question'};};
  await f.pad.startItem(job.id,{manual:true});await f.pad.pending;const questionId=job.clarification.id;
  if(other==='job'){
   const second=await f.note('Another independent task.'),running=await f.pad.enqueue({id:second.id,text:second.text});
   f.pad.execute=async request=>{calls++;await request.onStarted('other-work-chat');return new Promise(resolve=>{release=resolve;});};await f.pad.startItem(running.id,{manual:true});await new Promise(resolve=>setImmediate(resolve));
  }else f.pad.scanning=true;
  const activeId=f.pad.active?.job.id;await f.pad.answerClarification({id:job.id,clarificationId:questionId,answer:'Existing users'});
  assert.equal(job.status,'paused');assert.match(job.reason,/answer is saved.*current note work finishes/);assert.equal(job.clarifications[0].answer,'Existing users');assert.equal(job.nextStep.includes('OBSOLETE'),false);assert.match(job.nextStep,/Apply the saved answer.*Inspect inputs that changed/);
  assert.equal(f.pad.active?.job.id,activeId);assert.equal(f.pad.view().notes.find(item=>item.id===note.id).text,note.text);
  if(other==='job'){release({text:'Other task stopped.',blockedReason:'Synthetic unrelated blocker'});await f.pad.pending;}else f.pad.scanning=false;
  await f.pad.tick();assert.equal(job.status,'paused');assert.equal(calls,other==='job'?2:1);
  f.pad.execute=async request=>{assert.equal(request.job.id,job.id);assert.match(noteWorkPrompt(request.job,request.settings),/Existing users/);await request.onStarted('original-work-chat');await f.pad.progress('original-work-chat',{status:'complete',summary:'Requested audience verified.',evidence:['Audience inspected']});return {text:'Done'};};
  await f.pad.startItem(job.id,{manual:true});await f.pad.pending;assert.equal(job.status,'complete');
 }
});
