import test from 'node:test';
import assert from 'node:assert/strict';
import {findTextQuestions,resolveTextQuestion,textQuestionGroup} from '../desktop/text-questions.mjs';
import {UserQuestions} from '../desktop/user-questions.mjs';
import {questionFlowMessage} from '../src/question-flow.js';
import {REMOTE_METHODS} from '../desktop/remote-bridge.mjs';

const prompt='How do you normally put the PC to sleep when this happens?';
const options=['Windows Start menu → Power → Sleep','A keyboard button, shortcut, or utility','It happens automatically after inactivity'];
const text='Your PC supports traditional S3 sleep.\n'+prompt+'\n'+options.map(value=>'- '+value).join('\n');
function fixture(){
  const message={id:'reply',role:'assistant',content:'Independent work continued.',activity:[{id:'note',kind:'note',text}]},chat={id:'chat',messages:[message]},events=[],deliveries=[];
  let saved=0;
  const questions=new UserQuestions({getRun:()=>undefined,getChat:id=>id==='chat'?chat:{id,messages:[]},save:async()=>{saved++;},emit:event=>events.push(event),deliver:async(...args)=>{deliveries.push(args);return {conversationId:args[0],followup:'tracked'};}});
  const source=textQuestionGroup(message,'note',findTextQuestions(text)[0]).source;
  return {message,chat,questions,source,events,deliveries,saved:()=>saved};
}

test('the exact screenshot question has three choices with stable source offsets',()=>{
  const [question]=findTextQuestions(text);assert.equal(question.question,prompt);assert.deepEqual(question.options,options);assert.equal(text.slice(question.start,question.end),text.slice(text.indexOf(prompt)));
  assert.deepEqual(findTextQuestions('Which style do you prefer?\n\n1. Warm\n2. Formal')[0].options,['Warm','Formal']);
  assert.equal(findTextQuestions('Wie möchtest du antworten?\n- Deutsch\n- English').length,1);
});

test('prose recovery excludes code, quotes, task lists, nested lists, consent and ordinary prose',()=>{
  for(const value of ['```text\n'+text+'\n```','~~~\n'+text+'\n~~~',text.split('\n').map(line=>'> '+line).join('\n'),text.split('\n').map(line=>'    '+line).join('\n'),'Why does this happen?\n- [ ] Check Windows\n- [ ] Restart','Which mode?\n- One\n  - Nested\n- Two','Which mode?\n'+Array.from({length:7},(_,i)=>'- '+i).join('\n'),'Which mode?\n- One\n- One','Would you approve permission?\n- Allow\n- Deny','Some suggestions:\n- One\n- Two','Which mode?\n- One\n- Two\n- '+('a'.repeat(501))]) assert.deepEqual(findTextQuestions(value),[],value);
});

test('UI recovery is read-only and never duplicates a real question card or exact manual answer',()=>{
  const f=fixture(),q=findTextQuestions(text)[0],group=textQuestionGroup(f.message,'note',q);
  assert.equal(f.saved(),0);assert.equal(f.message.questions,undefined);assert.equal(f.deliveries.length,0);
  f.message.questions=[{id:'real',status:'open',questions:group.questions}];assert.equal(textQuestionGroup(f.message,'note',q),null);
  delete f.message.questions;f.message.followups=[{question:options[0]}];assert.equal(textQuestionGroup(f.message,'note',q),null);
});

test('explicit answer is persisted and delivered once to the originating chat',async()=>{
  const f=fixture(),result=await f.questions.answerText('chat',{source:f.source,answers:{answer:options[0]}});
  assert.equal(result.status,'answered');assert.equal(result.deliveryState,'delivered');assert.equal(f.events.at(-1).messageId,f.message.id);
  assert.equal(f.deliveries.length,1);assert.equal(f.deliveries[0][0],'chat');assert.match(f.deliveries[0][1],/How do you normally.*User answer: Windows Start menu/s);
  assert.deepEqual(f.message.questions[0].answers,{answer:{answers:[options[0]]}});
  assert.equal(questionFlowMessage(f.message).activity.filter(step=>step.kind==='question').length,0,'saved fallback stays inline, not duplicated in the timeline');
  await f.questions.answerText('chat',{source:f.source,answers:{answer:options[0]}});assert.equal(f.deliveries.length,1);
  await assert.rejects(f.questions.answerText('chat',{source:f.source,answers:{answer:options[1]}}),/already sent/);
});

test('cross-chat, user, tool-output, stale and forged sources cannot send answers',async()=>{
  const f=fixture();
  await assert.rejects(f.questions.answerText('other',{source:f.source,answers:{answer:options[0]}}),/assistant reply/);
  for(const source of [{...f.source,stepId:'unknown'},{...f.source,start:1},{...f.source,signature:'forged'},{...f.source,kind:'tool'}]) await assert.rejects(f.questions.answerText('chat',{source,answers:{answer:options[0]}}));
  f.message.role='user';assert.throws(()=>resolveTextQuestion(f.message,f.source),/assistant reply/);f.message.role='assistant';
  f.message.activity[0].kind='tool';assert.throws(()=>resolveTextQuestion(f.message,f.source),/changed/);f.message.activity[0].kind='note';
  for(const answers of [{},{answer:''},{answer:' '.repeat(20)},{answer:options[0],forged:'x'}]) await assert.rejects(f.questions.answerText('chat',{source:f.source,answers}));
  assert.equal(f.message.questions,undefined);assert.equal(f.deliveries.length,0);
});

test('custom answers and failed deliveries retain their exact saved answer for explicit retry',async()=>{
  const f=fixture();let fail=true;f.questions.deliver=async(...args)=>{f.deliveries.push(args);if(fail)throw Error('Synthetic delivery failure');return {followup:'tracked'};};
  const result=await f.questions.answerText('chat',{source:f.source,answers:{answer:'A custom explanation'}});assert.equal(result.deliveryState,'failed');
  fail=false;await f.questions.answerText('chat',{source:f.source,answers:{answer:'A custom explanation'}});assert.equal(f.message.questions[0].deliveryState,'delivered');
  assert.equal(f.deliveries.length,2);assert.match(f.deliveries[1][1],/User answer: A custom explanation/);
});

test('the final assistant answer uses the same validated path and saved source',async()=>{
  const f=fixture();f.message.content=text;f.source=textQuestionGroup(f.message,'content',findTextQuestions(text)[0]).source;
  await f.questions.answerText('chat',{source:f.source,answers:{answer:options[2]}});assert.equal(f.message.questions[0].source.stepId,'content');
});

test('recovered desktop and phone answers show question context without exposing generated source IDs',async()=>{
  for(const remote of [false,true]){
    const f=fixture(),input={conversationId:'chat',source:f.source,answers:{answer:'A custom explanation'},permissionMode:'full'};
    const payload=remote?REMOTE_METHODS['chat.question.answerText'](input):input;
    await f.questions.answerText(payload.conversationId,payload);
    const group=f.message.questions[0],delivered=f.deliveries[0];
    assert.equal(group.id.startsWith('text-question:'),true);assert.deepEqual(group.source,f.source);
    assert.match(delivered[1],/^Your answer to:\nHow do you normally/);assert.match(delivered[1],/User answer: A custom explanation/);
    assert.equal(delivered[1].includes(group.id),false);assert.equal(delivered[1].includes('text-question:'),false);
    assert.deepEqual(delivered[2],{questionId:group.id});if(remote)assert.equal(payload.permissionMode,undefined);
  }
});

test('a saved answer remains reachable when its old progress text is pruned',async()=>{
  const f=fixture();await f.questions.answerText('chat',{source:f.source,answers:{answer:options[0]}});f.message.activity=[];
  assert.equal(questionFlowMessage(f.message).activity.filter(step=>step.kind==='question').length,1);
});
