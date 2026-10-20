import test from 'node:test';
import assert from 'node:assert/strict';
import {RunActivity} from '../desktop/activity.mjs';
import {LiveFollowups} from '../desktop/live-followups.mjs';
import {finishRunFailure} from '../desktop/reply-outcomes.mjs';
import {recentConversation} from '../desktop/context.mjs';
import {handoffContext} from '../desktop/model-preferences.mjs';

test('a later continuation failure preserves the latest completed reply and completed work',async()=>{
  const message={id:'reply',role:'assistant',content:'Original task done.',followups:[{id:'one',text:'Apply the follow-up.',taskStatus:'pending'},{id:'two',text:'One more change.',taskStatus:'pending'}]};
  const activity=new RunActivity(message,{conversationId:'chat',emit:()=>{}});
  activity.tool({id:'side-effect',name:'publish',status:'done',output:'Published once.'});
  const run={message,activity},chat={messages:[{role:'user',content:'Finish the task.'},message]},saved=[];
  const followups=new LiveFollowups({getRun:()=>run,getChat:()=>chat,save:async()=>saved.push(structuredClone(message)),emit:()=>{}});
  let attempts=0;
  await assert.rejects(followups.beforeComplete('chat',{text:'Original task done.'},async()=>{
    activity.cut();
    if(++attempts===1){await followups.update('chat',{id:'one',status:'handled',summary:'Applied and verified.'});return {text:'Original task and first follow-up done.'};}
    activity.delta('Retrying continuation.');throw Error('Requested full; effective read-only.');
  }),/effective read-only/);
  await followups.failed('chat','Requested full; effective read-only.');
  finishRunFailure(run,'Requested full; effective read-only.');
  assert.equal(message.content,'Original task and first follow-up done.');assert.equal(message.error,undefined);
  assert.equal(message.continuationError,'Requested full; effective read-only.');
  assert.equal(message.followups[0].taskStatus,'handled');assert.equal(message.followups[1].taskStatus,'blocked');
  assert.match(message.followups[1].summary,/could not continue/);assert.ok(message.activity.some(step=>step.output==='Published once.'));
  const stored=JSON.parse(JSON.stringify(message));assert.equal(stored.content,message.content);assert.equal(stored.continuationError,message.continuationError);
  assert.match(recentConversation([stored]),/Original task and first follow-up done/);assert.match(recentConversation([stored]),/effective read-only/);
  assert.ok(saved.some(copy=>copy.followups[0].taskStatus==='handled'));
});

test('failure before any completed reply retains the original error behavior',()=>{
  const message={content:''},activity=new RunActivity(message,{conversationId:'chat',emit:()=>{}});
  finishRunFailure({message,activity},'Startup failed.');
  assert.equal(message.error,'Startup failed.');assert.equal(message.content,'Startup failed.');assert.equal(message.continuationError,undefined);
});

test('fresh permission recovery checkpoint includes the completed reply and successful side effects',()=>{
  const message={id:'reply',content:'Continuation in progress.',activity:[{kind:'tool',name:'publish',status:'done',output:'Already published.'}]};
  const context=handoffContext(message,{reason:'permissions',completedReply:'Original task verified.'});
  assert.match(context,/incompatible permissions/);assert.doesNotMatch(context,/exhausted its usage/);
  const checkpoint=JSON.parse(context.split('Handoff checkpoint:\n')[1]);
  assert.equal(checkpoint.completedReply,'Original task verified.');assert.equal(checkpoint.recentDetails[0].output,'Already published.');
});
