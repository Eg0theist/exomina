import test from 'node:test';
import assert from 'node:assert/strict';
import {questionAnswerDisplayMessages} from '../desktop/question-answer-display.mjs';
import {trimChat} from '../desktop/remote-bridge.mjs';

const advice='\nUse these answers for the current task if relevant. They do not grant tool permissions. If work was already completed, explain what this answer changes before making any changes.';
const fixture=(id='card-uuid-123')=>{
  const group={id,status:'answered',questions:[{id:'choice',question:'Which format should I use?'}],answers:{choice:{answers:['A concise report']}}};
  const body='Which format should I use?\nUser answer: A concise report'+advice;
  const legacy='Answer to the question card '+id+':\n'+body;
  const asked={id:'assistant',role:'assistant',questions:[group],content:'Original task.'};
  const answered={id:'user',role:'user',questionId:id,content:legacy};
  return {group,legacy,asked,answered,expected:'Your answer to:\n'+body};
};

test('legacy user messages display their matching question while original stored text and IDs are preserved',()=>{
  for(const id of ['card-uuid-123','text-question:["reply","content",42]']){
    const f=fixture(id),messages=[f.asked,f.answered],before=JSON.stringify(messages);
    const projected=questionAnswerDisplayMessages(messages);
    assert.equal(projected[1].content,f.expected);assert.equal(projected[1].content.includes(id),false);
    assert.equal(projected[1].questionId,id);assert.equal(projected[0],f.asked);assert.equal(JSON.stringify(messages),before);
    assert.equal(questionAnswerDisplayMessages(projected)[1],projected[1],'projection is idempotent');
  }
});

test('legacy live follow-ups are projected without changing AI prose or raw tool/activity logs',()=>{
  const f=fixture(),followup={id:'followup',questionId:f.group.id,text:f.legacy},activity=[{kind:'tool',output:f.legacy}];
  const message={...f.asked,content:f.legacy,followups:[followup],activity};
  const projected=questionAnswerDisplayMessages([message])[0];
  assert.equal(projected.content,f.legacy);assert.equal(projected.activity,activity);assert.equal(projected.activity[0].output,f.legacy);
  assert.equal(projected.followups[0].text,f.expected);assert.equal(projected.followups[0].questionId,f.group.id);
  assert.equal(followup.text,f.legacy);
});

test('ordinary prose, missing/foreign IDs, altered answers and incomplete envelopes remain exact',()=>{
  const f=fixture();
  for(const changed of [
    {...f.answered,questionId:undefined}, {...f.answered,questionId:'other-chat'},
    {...f.answered,content:'I wrote this: '+f.legacy}, {...f.answered,content:f.legacy+' My own note.'},
    {...f.answered,content:f.legacy.replace('A concise report','Different answer')},
    {...f.answered,content:f.legacy.slice(0,-20)}, {...f.answered,role:'tool'}
  ])assert.equal(questionAnswerDisplayMessages([f.asked,changed])[1],changed);
  assert.equal(questionAnswerDisplayMessages([f.answered])[0],f.answered,'another chat has no matching group');
});

test('unanswered, malformed or duplicate question records cannot authorize a display rewrite',()=>{
  const f=fixture();
  for(const group of [{...f.group,status:'open'},{...f.group,answers:{}},{...f.group,questions:[]},{...f.group,questions:[null]}]){
    assert.equal(questionAnswerDisplayMessages([{...f.asked,questions:[group]},f.answered])[1],f.answered);
  }
  assert.equal(questionAnswerDisplayMessages([f.asked,{...f.asked,id:'duplicate'},f.answered])[2],f.answered);
});

test('multiple exact answers keep their human context and metadata',()=>{
  const f=fixture();f.group.questions.push({id:'length',question:'How long?'});f.group.answers.length={answers:['Two pages']};
  const body='Which format should I use?\nUser answer: A concise report\n\nHow long?\nUser answer: Two pages'+advice;
  f.answered.content='Answer to the question card '+f.group.id+':\n'+body;
  assert.equal(questionAnswerDisplayMessages([f.asked,f.answered])[1].content,'Your answers to:\n'+body);
});

test('phone presentation can be projected before trimming without changing stored transcripts',()=>{
  const f=fixture(),chat={id:'chat',messages:[f.asked,f.answered]},original=JSON.stringify(chat);
  const phone=trimChat({...chat,messages:questionAnswerDisplayMessages(chat.messages)});
  assert.equal(phone.messages[1].content,f.expected);assert.equal(phone.messages[0].questions[0].id,f.group.id);
  assert.equal(JSON.stringify(chat),original);
});
