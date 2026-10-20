import test from 'node:test';
import assert from 'node:assert/strict';
import {answerClaudeUserQuestions} from '../desktop/claude-user-questions.mjs';
import {UserQuestions} from '../desktop/user-questions.mjs';

const choice=(question,multiSelect=false)=>({question,header:'Choice',options:[{label:'First',description:'First route.',preview:'Preview retained for Claude.'},{label:'Second',description:'Second route.'}],multiSelect});
test('native Claude questions return the exact question-keyed input and multiple answers',async()=>{
  const input={questions:[choice('  Which routes?  ',true),choice('Which size?')],metadata:{source:'native'}};
  const original=structuredClone(input),requests=[];
  const result=await answerClaudeUserQuestions({input,ask:async request=>{requests.push(request);return {status:'answered',answers:{'claude-question-1':{answers:['First, Second']},'claude-question-2':{answers:['Custom size']}}};}});
  assert.equal(result.behavior,'allow');assert.deepEqual(result.updatedInput.questions,input.questions);assert.deepEqual(result.updatedInput.metadata,input.metadata);
  assert.deepEqual({...result.updatedInput.answers},{'  Which routes?  ':'First, Second','Which size?':'Custom size'});
  assert.equal(requests[0].questions[0].multiSelect,true);assert.equal(requests[0].questions[0].options[0].description,'First route.');assert.deepEqual(input,original);
});
test('four native questions become bounded cards with unique stable ids',async()=>{
  const requests=[];const result=await answerClaudeUserQuestions({input:{questions:Array.from({length:4},(_,index)=>choice('Question '+index+'?'))},ask:async request=>{
    requests.push(request);return {status:'answered',answers:Object.fromEntries(request.questions.map(question=>[question.id,{answers:['Second']}]))};
  }});
  assert.deepEqual(requests.map(request=>request.questions.length),[3,1]);assert.equal(requests[1].questions[0].id,'claude-question-4');assert.equal(Object.keys(result.updatedInput.answers).length,4);
});
test('unanswered, cancelled and irrelevant native questions cannot become allowed answers',async()=>{
  for(const status of ['unanswered','cancelled','irrelevant']){
    let calls=0;const result=await answerClaudeUserQuestions({input:{questions:Array.from({length:4},(_,index)=>choice('Question '+index+'?'))},ask:async()=>{calls++;return {status,answers:{}};}});
    assert.equal(result.behavior,'deny');assert.equal(result.updatedInput,undefined);assert.match(result.message,/not answered/);assert.equal(calls,1);
  }
});
test('native callback uses the real persistent response window without permissions',async()=>{
  const chat={id:'native',messages:[{id:'reply',role:'assistant'}]},run={message:chat.messages[0]},events=[],timers=[];
  const host=new UserQuestions({getRun:()=>run,getChat:()=>chat,save:async()=>{},emit:event=>events.push(event),deliver:async()=>{throw Error('Blocking answers must return directly');},setTimer:callback=>{timers.push(callback);return callback;},clearTimer:()=>{}});
  const pending=answerClaudeUserQuestions({input:{questions:[choice('Which native features?',true)]},ask:input=>host.ask('native',input)});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(events.at(-1).type,'chat.question');const group=chat.messages[0].questions[0];assert.equal(group.questions[0].multiSelect,true);
  await host.answer('native',{id:group.id,answers:{'claude-question-1':'First, Second'}});
  const result=await pending;assert.equal(result.behavior,'allow');assert.equal(result.updatedInput.answers['Which native features?'],'First, Second');assert.equal(group.deliveryState,'returned');host.close();
});
test('malformed native questions fail before asking or granting access',async()=>{
  for(const input of [{questions:[]},{questions:Array(5).fill(choice('Too many?'))},{questions:[choice('Duplicate?'),choice('Duplicate?')]},{questions:[{...choice('Unsupported?'),kind:'number'}]},{questions:[{...choice('Invalid?'),multiSelect:'yes'}]}]){
    await assert.rejects(answerClaudeUserQuestions({input,ask:async()=>{throw Error('Must not ask');}}),error=>!error.message.includes('Must not ask'));
  }
});
