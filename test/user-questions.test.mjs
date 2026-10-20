import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {UserQuestions,QUESTION_TOOLS,questionInstructions,pendingQuestionContext} from '../desktop/user-questions.mjs';
import {recentConversation} from '../desktop/context.mjs';
import {LEAN_TOOLS} from '../desktop/routing.mjs';
import {REMOTE_METHODS} from '../desktop/remote-bridge.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  let now=Date.parse('2026-10-09T10:00:00Z'),active=true,saved=0;
  const chat={id:'chat',messages:[{id:'reply',role:'assistant',content:''}]},other={id:'other',messages:[]};
  const run={message:chat.messages[0]},events=[],deliveries=[],timers=new Map();let n=0;
  const questions=new UserQuestions({getRun:id=>active&&id===chat.id?run:undefined,getChat:id=>id===chat.id?chat:other,save:async()=>{saved++;},emit:event=>events.push(event),deliver:async(...args)=>{deliveries.push(args);return {followup:'tracked'};},now:()=>now,setTimer:(callback,ms)=>{const id=++n;timers.set(id,{callback,at:now+ms});return id;},clearTimer:id=>timers.delete(id)});
  return {questions,run,chat,events,deliveries,timers,saved:()=>saved,deactivate:()=>active=false,expire:async()=>{now+=60000;for(const {callback} of [...timers.values()])callback();await tick();}};
}
const input={questions:[{id:'choice',question:'Which colour should I use?',options:[{label:'Blue',description:'Calm.'},'Green']}]};

test('advertised question schemas accept native blocking and title-only async forms',async()=>{
  const asyncInput={questions:[{title:'Which colour should I use?',options:['Blue','Green']},{title:'Anything else?'}]};
  for(const tool of QUESTION_TOOLS.filter(tool=>tool.name.startsWith('request_user_input')||tool.name.startsWith('ask_user_question'))){
    const validate=new Ajv({strict:false}).compile(tool.inputSchema);
    assert.equal(validate(input),true,JSON.stringify(validate.errors));
    assert.equal(validate(asyncInput),true,JSON.stringify(validate.errors));
    assert.equal(validate({questions:[{options:['Blue']}]}),false);
    assert.equal(validate({questions:[{title:''}]}),false);
  }
  const f=fixture(),result=await f.questions.ask('chat',asyncInput,{wait:false});
  assert.equal(result.status,'waiting');assert.equal(result.id,f.run.message.questions[0].id);
  assert.deepEqual(f.run.message.questions[0].questions,[
    {id:'question-1',header:'',question:'Which colour should I use?',options:[{label:'Blue'},{label:'Green'}]},
    {id:'question-2',header:'',question:'Anything else?',options:[]},
  ]);
  assert.equal(f.events.at(-1).question.id,result.id,'async acceptance references its persistent question group');
  await f.questions.answer('chat',{id:result.id,answers:{'question-1':'Green','question-2':'Keep it simple'}});
  assert.equal(f.deliveries.length,1);assert.equal(f.run.message.questions[0].deliveryState,'delivered');
});

test('a question opens a real response window, options are not automatic answers',async()=>{
  const f=fixture();let returned=false;const pending=f.questions.ask('chat',input).then(result=>{returned=true;return result;});await tick();
  assert.equal(returned,false);const group=f.run.message.questions[0];assert.equal(group.waitSeconds,60);assert.equal(group.status,'waiting');assert.equal(group.answers,undefined);assert.equal(group.questions[0].options[0].description,'Calm.');assert.equal(f.events.at(-1).type,'chat.question');
  await f.questions.answer('chat',{id:group.id,answers:{choice:'Green'}});const result=await pending;
  assert.deepEqual(result.answers,{choice:{answers:['Green']}});assert.equal(result.pending,false);assert.equal(result.deliveryState,'returned');assert.equal(result.deliveryError,undefined);assert.equal(f.deliveries.length,0);assert.equal(group.deliveryState,'returned');assert.equal(f.timers.size,0);
});
test('expiry returns explicit unanswered input and retains a clickable late-answer card',async()=>{
  const f=fixture(),pending=f.questions.ask('chat',{...input,require_answer:false});await tick();const group=f.run.message.questions[0];await f.expire();
  const result=await pending;assert.equal(result.status,'unanswered');assert.deepEqual(result.answers,{});assert.match(result.notice,/not an answer or approval/);assert.equal(group.status,'open');
  f.deactivate();await f.questions.answer('chat',{id:group.id,answers:{choice:'Custom violet'}});
  assert.equal(group.status,'answered');assert.equal(f.deliveries[0][0],'chat');assert.match(f.deliveries[0][1],/^Your answer to:\nWhich colour.*User answer: Custom violet/s);assert.equal(f.deliveries[0][1].includes(group.id),false);assert.deepEqual(f.deliveries[0][2],{questionId:group.id});assert.equal(group.deliveryState,'delivered');
  await f.questions.answer('chat',{id:group.id,answers:{choice:'Custom violet'}});assert.equal(f.deliveries.length,1,'an identical resubmission cannot repeat actions');
});

test('generated answer messages use each human question while desktop and remote matching retain exact IDs',async()=>{
  for(const remote of [false,true]){
    const f=fixture(),{id}=await f.questions.ask('chat',{questions:[
      {id:'internal-format-choice',question:'Which format should I use?'},
      {id:'internal-detail-choice',question:'How much detail should I include?'}
    ]},{wait:false});
    const input={conversationId:'chat',id,answers:{'internal-format-choice':'A concise report','internal-detail-choice':'Two examples'},permissionMode:'full'};
    const payload=remote?REMOTE_METHODS['chat.question.answer'](input):input;
    assert.equal(payload.id,id);if(remote)assert.equal(payload.permissionMode,undefined);
    await f.questions.answer(payload.conversationId,payload);
    const [parent,text,metadata]=f.deliveries[0];
    assert.equal(parent,'chat');assert.match(text,/^Your answers to:\nWhich format should I use\?\nUser answer: A concise report\n\nHow much detail should I include\?\nUser answer: Two examples/);
    for(const internal of [id,'internal-format-choice','internal-detail-choice'])assert.equal(text.includes(internal),false);
    assert.deepEqual(metadata,{questionId:id});assert.equal(f.run.message.questions[0].id,id);
    assert.match(text,/They do not grant tool permissions/);
  }
});
test('asynchronous questions allow independent work but preserve the window at task completion',async()=>{
  const f=fixture(),result=await f.questions.ask('chat',input,{wait:false});assert.equal(result.status,'waiting');let finished=false;
  const window=f.questions.waitForWindow('chat').then(()=>finished=true);await tick();assert.equal(finished,false);await f.expire();await window;
  const completed=await f.questions.finish('chat',{text:'Independent work is complete.'});assert.match(completed.text,/Questions still awaiting your answer.*Which colour/s);assert.ok(f.run.message.questions[0].remindedAt);
});

test('blocking questions keep the native tool waiting past expiry until a real answer arrives',async()=>{
  const f=fixture();let resumed=false;const pending=f.questions.ask('chat',input).then(result=>{resumed=true;return result;});await tick();
  const group=f.run.message.questions[0];await f.expire();await tick();
  assert.equal(group.status,'open');assert.equal(group.requireAnswer,true);assert.equal(group.waitingForAnswer,true);assert.equal(resumed,false);
  await assert.rejects(f.questions.continue('chat',group.id),/needs your answer/);assert.equal(resumed,false);
  await f.questions.answer('chat',{id:group.id,answers:{choice:'Green'}});const result=await pending;
  assert.deepEqual(result.answers,{choice:{answers:['Green']}});assert.equal(result.deliveryState,'returned');assert.equal(f.deliveries.length,0);assert.equal(group.waitingForAnswer,false);
});

test('required asynchronous decisions permit independent work and hold completion until delivery',async()=>{
  const f=fixture(),{id}=await f.questions.ask('chat',{...input,require_answer:true},{wait:false});let finished=false;
  const completion=f.questions.waitForWindow('chat').then(()=>finished=true);await f.expire();assert.equal(finished,false);
  await f.questions.answer('chat',{id,answers:{choice:'Blue'}});await completion;
  assert.equal(finished,true);assert.equal(f.deliveries.length,1);assert.equal((await f.questions.finish('chat',{text:'Done.'})).text,'Done.');
});

test('a stopped required task releases its waiter and leaves a late-answer card after restart',async()=>{
  const f=fixture(),pending=f.questions.ask('chat',input);await tick();const group=f.run.message.questions[0];await f.expire();await f.questions.cancel('chat');
  assert.equal((await pending).status,'cancelled');assert.equal(group.status,'open');assert.equal(group.waitingForAnswer,false);
  await f.questions.restore([f.chat]);await f.questions.answer('chat',{id:group.id,answers:{choice:'Green'}});assert.equal(f.deliveries.length,1);
});
test('an answer arriving as asynchronous work completes is admitted before the window closes',async()=>{
  const f=fixture();let release;f.questions.deliver=async(...args)=>{f.deliveries.push(args);await new Promise(resolve=>release=resolve);return {followup:'tracked'};};
  const {id}=await f.questions.ask('chat',input,{wait:false});const answer=f.questions.answer('chat',{id,answers:{choice:'Blue'}});let finished=false;
  const window=f.questions.waitForWindow('chat').then(()=>finished=true);await tick();assert.equal(finished,false);assert.equal(f.deliveries.length,1);release();await answer;await window;
  assert.equal((await f.questions.finish('chat',{text:'Done.'})).text,'Done.');
});
test('continue while deciding releases the timer without selecting an option',async()=>{
  const f=fixture(),pending=f.questions.ask('chat',{...input,require_answer:false});await tick();const {id}=f.run.message.questions[0];await f.questions.continue('chat',id);assert.deepEqual((await pending).answers,{});assert.equal(f.timers.size,0);assert.equal(f.run.message.questions[0].windowOutcome,'continued');
  await f.questions.answer('chat',{id,answers:{choice:'Green'}});assert.equal(f.deliveries.length,1);
});

test('an answer during response-window saving is delivered only as a late follow-up',async()=>{
  const f=fixture(),pending=f.questions.ask('chat',{...input,require_answer:false});await tick();const {id}=f.run.message.questions[0];
  let releaseSave,first=true;f.questions.save=async()=>{if(first){first=false;await new Promise(resolve=>releaseSave=resolve);}};
  const continued=f.questions.continue('chat',id);await tick();
  await f.questions.answer('chat',{id,answers:{choice:'Green'}});releaseSave();await continued;
  const result=await pending;assert.equal(result.status,'unanswered');assert.deepEqual(result.answers,{});assert.equal(f.deliveries.length,1);assert.equal(f.run.message.questions[0].deliveryState,'delivered');
});
test('irrelevant questions are resolved with a reason and no completion reminder',async()=>{
  const f=fixture();const {id}=await f.questions.ask('chat',input,{wait:false});await f.questions.retire('chat',{id,reason:'The existing theme determines this colour.'});
  assert.equal((await f.questions.finish('chat',{text:'Done.'})).text,'Done.');assert.equal(f.timers.size,0);
  await assert.rejects(f.questions.answer('chat',{id,answers:{choice:'Blue'}}),/no longer affects/);
});
test('questions cannot be answered from another chat or by empty and unknown input',async()=>{
  const f=fixture(),{id}=await f.questions.ask('chat',input,{wait:false});
  await assert.rejects(f.questions.answer('other',{id,answers:{choice:'Blue'}}),/does not belong/);
  for(const answers of [{choice:''},{wrong:'Blue'},{choice:'Blue',extra:'yes'},[]])await assert.rejects(f.questions.answer('chat',{id,answers}));
  await assert.rejects(f.questions.ask('chat',{questions:[{id:'__proto__',question:'No'}]}));await f.questions.cancel('chat');
});
test('delivery failure keeps the answer and supports a bounded explicit retry',async()=>{
  const f=fixture(),{id}=await f.questions.ask('chat',input,{wait:false});await f.questions.continue('chat',id);f.questions.deliver=async()=>{throw Error('Provider disconnected');};
  const failed=await f.questions.answer('chat',{id,answers:{choice:'Green'}});const group=f.run.message.questions[0];assert.equal(group.deliveryState,'failed');assert.deepEqual(group.answers,{choice:{answers:['Green']}});assert.equal(failed.deliveryState,'failed');assert.equal(failed.deliveryError,'Provider disconnected');assert.equal(failed.status,'answered');
  f.questions.deliver=async(...args)=>{f.deliveries.push(args);return {followup:'retried'};};const retried=await f.questions.answer('chat',{id,answers:{choice:'Green'}});assert.equal(group.deliveryState,'delivered');assert.equal(f.deliveries.length,1);assert.equal(retried.deliveryState,'delivered');assert.equal(retried.deliveryError,undefined);assert.match(f.deliveries[0][1],/^Your answer to:\nWhich colour/);assert.equal(f.deliveries[0][1].includes(id),false);assert.deepEqual(f.deliveries[0][2],{questionId:id});
});
test('copied branch questions cannot release the original chat response window',async()=>{
  const f=fixture(),pending=f.questions.ask('chat',input);await tick();const original=f.run.message.questions[0],branch={id:'branch',messages:[{id:'copy',questions:[structuredClone(original)]}]};
  const get=f.questions.getChat;f.questions.getChat=id=>id==='branch'?branch:get(id);
  await f.questions.answer('branch',{id:original.id,answers:{choice:'Green'}});assert.equal(original.status,'waiting');assert.equal(f.questions.windows.size,1);assert.equal(f.deliveries[0][0],'branch');
  await f.questions.cancel('chat');await pending;
});
test('stopping or restarting retains unanswered cards while releasing blocked tools',async()=>{
  const f=fixture(),pending=f.questions.ask('chat',input);await tick();await f.questions.cancel('chat');assert.equal((await pending).status,'cancelled');assert.equal(f.run.message.questions[0].status,'open');
  f.run.message.questions[0].status='waiting';await f.questions.restore([f.chat]);assert.equal(f.run.message.questions[0].status,'open');assert.match(recentConversation(f.chat.messages),/Which colour should I use/);
});

test('later task completion and context retain earlier unanswered cards until retired',async()=>{
  const f=fixture(),{id}=await f.questions.ask('chat',input,{wait:false});await f.questions.continue('chat',id);
  const original=f.run.message;f.run.message={id:'later-reply',role:'assistant',content:'Later work.'};f.chat.messages.push(...Array.from({length:25},()=>({role:'user',content:'More work.'})),f.run.message);
  assert.match(pendingQuestionContext(f.chat.messages),/Which colour should I use/);
  assert.match((await f.questions.finish('chat',{text:'Later work is complete.'})).text,/Questions still awaiting your answer.*Which colour/s);
  assert.equal(f.events.at(-1).messageId,original.id,'the reminder updates the original card');
  await f.questions.retire('chat',{id,reason:'The new task no longer uses a colour.'});
  assert.equal(pendingQuestionContext(f.chat.messages),'');assert.equal((await f.questions.finish('chat',{text:'Done.'})).text,'Done.');
});

test('the unresolved-card limit includes previous tasks and frees space when retired',async()=>{
  const f=fixture();let first;
  for(let n=0;n<6;n++){
    const {id}=await f.questions.ask('chat',input,{wait:false});first??=id;await f.questions.continue('chat',id);
    f.run.message={id:'reply-'+n,role:'assistant',content:''};f.chat.messages.push(f.run.message);
  }
  await assert.rejects(f.questions.ask('chat',input,{wait:false}),/Resolve an earlier question/);
  await f.questions.retire('chat',{id:first,reason:'This choice is no longer relevant.'});
  await f.questions.ask('chat',input,{wait:false});await f.questions.cancel('chat');
});

test('restart exposes an unconfirmed saved answer for explicit retry',async()=>{
  const f=fixture(),{id}=await f.questions.ask('chat',input,{wait:false});await f.questions.continue('chat',id);
  const group=f.run.message.questions[0];Object.assign(group,{status:'answered',answers:{choice:{answers:['Green']}},deliveryState:'sending'});
  await f.questions.restore([f.chat]);assert.equal(group.deliveryState,'failed');assert.match(group.deliveryError,/app closed/);assert.equal(f.deliveries.length,0);
  await f.questions.answer('chat',{id,answers:{choice:'Green'}});assert.equal(group.deliveryState,'delivered');assert.equal(f.deliveries.length,1);assert.deepEqual(f.deliveries[0][2],{questionId:id});
});

test('restart confirms accepted answer messages and follow-ups without sending twice',async()=>{
  for(const kind of ['message','followup']){
    const f=fixture(),{id}=await f.questions.ask('chat',input,{wait:false});await f.questions.continue('chat',id);
    const group=f.run.message.questions[0];Object.assign(group,{status:'answered',answers:{choice:{answers:['Green']}},deliveryState:'sending'});
    if(kind==='message')f.chat.messages.push({id:'accepted-answer',role:'user',content:'Answer received.',questionId:id});
    else f.run.message.followups=[{id:'accepted-followup',text:'Answer received.',questionId:id}];
    await f.questions.restore([f.chat]);assert.equal(group.deliveryState,'delivered');assert.equal(group.receipt.conversationId,'chat');assert.equal(group.receipt.followup,kind==='followup'?'accepted-followup':undefined);
    await f.questions.answer('chat',{id,answers:{choice:'Green'}});assert.equal(f.deliveries.length,0);
  }
});
test('question tools are available in lean chat without granting permissions',()=>{
  for(const tool of QUESTION_TOOLS)assert.equal(LEAN_TOOLS.test(tool.name),true);
  assert.match(questionInstructions,/separate approval controls/);assert.match(questionInstructions,/Never treat/);assert.match(questionInstructions,/ask_user_question/);assert.match(questionInstructions,/Do not substitute a question and bullet list/);
});
