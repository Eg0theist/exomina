import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeHelperStep,helperStepRows,helperStepTitle,isHelperStep} from '../desktop/helper-step.mjs';
import {RunActivity} from '../desktop/activity.mjs';
import {describeTool} from '../desktop/describe.mjs';

test('native helper display metadata preserves schema identity and requested model with bounded redacted text',()=>{
  const step=nativeHelperStep({type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['one','one','bad\nID',...Array.from({length:50},(_,i)=>`thread-${i}`)],prompt:'Review api_key=private-value '+ 'x'.repeat(3000),model:'requested-alias',reasoningEffort:'high',agentsStates:{one:{status:'running',token:'private'}},extra:'never retained'});
  assert.equal(step.threadIds.length,32);assert.equal(step.task.length,2000);assert.match(step.task,/api_key=\[credential redacted\]/);assert.equal(step.requestedModel,'requested-alias');assert.deepEqual(step.statuses,{one:'running'});assert.equal(step.extra,undefined);assert.equal(step.effectiveModel,undefined);
  assert.deepEqual(nativeHelperStep({type:'subAgentActivity',agentPath:'/root/review',agentThreadId:'child',kind:'interacted'}),{provider:'codex',type:'subAgentActivity',threadIds:['child'],action:'interacted',name:'/root/review'});
  assert.equal(nativeHelperStep({type:'dynamicToolCall',tool:'subAgentActivity'}),null);
});

test('activity step joins only its exact native identity and never borrows another helper model/task',()=>{
  const helpers=[{id:'a',nativeThreadId:'one',task:'First task',effectiveModel:'actual-one'},{id:'b',nativeThreadId:'two',task:'Second task',effectiveModel:'actual-two'}];
  const step={id:'activity',name:'subAgentActivity',status:'done',helper:nativeHelperStep({type:'subAgentActivity',agentThreadId:'two',kind:'completed',agentPath:'/root/two'})};
  assert.equal(helperStepRows(step,helpers,'codex')[0],helpers[1]);
  step.helper.threadIds=['missing'];const missing=helperStepRows(step,helpers,'codex')[0];assert.equal(missing.effectiveModel,undefined);assert.equal(missing.task,undefined);assert.equal(missing.provider,'codex');assert.equal(missing.status,'complete');
  const legacy=helperStepRows({id:'legacy',name:'subAgentActivity',status:'done'},helpers,'codex')[0];assert.equal(legacy.status,undefined);assert.equal(legacy.effectiveModel,undefined);assert.equal(Boolean(legacy.task),false);
  assert.equal(helperStepRows({id:'legacy',name:'subAgentActivity'},helpers,'claude')[0].provider,'codex');
  assert.equal(helperStepTitle(step),'Helper completed');assert.equal(describeTool('subAgentActivity').kind,'agent');assert.equal(isHelperStep({name:'model_available'}),false);
});
test('long saved helper activity drops old metadata explicitly while retaining recent exact identity',()=>{
  const message={id:'bounded',content:''},activity=new RunActivity(message,{conversationId:'chat',emit:()=>{}});
  const helper=nativeHelperStep({type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:Array.from({length:32},(_,i)=>`thread-${i}-`+'x'.repeat(280)),prompt:'Task '.repeat(500)});
  for(let i=0;i<60;i++)activity.tool({id:`step-${i}`,name:'collabAgentToolCall',helper,status:'done'});
  activity.finish('Completed.');assert.ok(JSON.stringify(message.activity).length<=400000);assert.equal(message.activity[0].helper.omitted,true);assert.deepEqual(message.activity.at(-1).helper.threadIds,helper.threadIds);
});

test('Claude original tool-use IDs survive continuation prefixes without joining an unrelated card',()=>{
  const helper={id:'native-helper:claude:turn:call',nativeToolUseId:'call',task:'Known Claude task.',requestedModel:'sonnet'},other={id:'another',nativeToolUseId:'other'};
  const step={id:'continuation:call',name:'Agent',nativeToolUseId:'call',input:JSON.stringify({prompt:'Supplied task.',model:'requested'})};
  assert.equal(helperStepRows(step,[other,helper],'claude')[0],helper);
  const unknown=helperStepRows(step,[other],'claude')[0];assert.equal(unknown.task,'Supplied task.');assert.equal(unknown.requestedModel,'requested');assert.equal(unknown.effectiveModel,undefined);
});

test('RunActivity upserts native helper display metadata and retains it independently of clipped raw output',()=>{
  const message={id:'reply',content:''},events=[],activity=new RunActivity(message,{conversationId:'chat',emit:event=>events.push(event)});
  activity.tool({id:'activity',name:'subAgentActivity',helper:nativeHelperStep({type:'subAgentActivity',agentThreadId:'child',kind:'started',agentPath:'/root/review'}),status:'running'});
  activity.tool({id:'activity',name:'subAgentActivity',helper:nativeHelperStep({type:'subAgentActivity',agentThreadId:'child',kind:'completed',agentPath:'/root/review'}),status:'done',output:'x'.repeat(9000)});
  assert.equal(message.activity.length,1);assert.equal(message.activity[0].helper.action,'completed');assert.equal(message.activity[0].output.length,4001);assert.equal(events.at(-1).step.helper.threadIds[0],'child');
});
