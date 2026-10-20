import test from 'node:test';
import assert from 'node:assert/strict';
import {NATIVE_ACTIVITY_LIMITS,normalizeCodexActivity,nativeActivityText} from '../desktop/provider-activity.mjs';
import {RunActivity} from '../desktop/activity.mjs';

const scope={threadId:'thread-1',turnId:'turn-1'};
const tokens=(input=28000)=>({inputTokens:input,cachedInputTokens:24000,cacheWriteInputTokens:0,outputTokens:900,reasoningOutputTokens:600,totalTokens:input+900});
const normalize=(method,payload={})=>normalizeCodexActivity(method,{...scope,...payload});
function run(){const events=[],message={role:'assistant',content:''};return {events,message,activity:new RunActivity(message,{conversationId:'chat',emit:event=>events.push(structuredClone(event))})};}

test('bundled native plan schema keeps the actual statuses, and bounds fields',()=>{
  const plan=normalize('turn/plan/updated',{explanation:'Read before changing.',plan:[{step:'Inspect',status:'completed',internalSecret:'ignored'},{step:'Patch',status:'inProgress'},{step:'Verify',status:'pending'}],unneeded:'ignored'});
  assert.deepEqual(plan,{kind:'plan',...scope,explanation:'Read before changing.',steps:[{text:'Inspect',status:'completed'},{text:'Patch',status:'inProgress'},{text:'Verify',status:'pending'}],truncated:false});
  const bounded=normalize('turn/plan/updated',{explanation:'x'.repeat(8000),plan:Array.from({length:100},()=>({step:'y'.repeat(2000),status:'pending'}))});
  assert.equal(bounded.steps.length,NATIVE_ACTIVITY_LIMITS.planSteps);assert.equal(bounded.steps[0].text.length,NATIVE_ACTIVITY_LIMITS.planText);assert.equal(bounded.explanation.length,NATIVE_ACTIVITY_LIMITS.explanation);assert.equal(bounded.truncated,true);
});

test('native usage separates latest request, cumulative total and an explicitly reported window',()=>{
  const last=tokens(),total=tokens(890000),usage=normalize('thread/tokenUsage/updated',{tokenUsage:{last,total,modelContextWindow:128000,secret:'ignored'}});
  assert.deepEqual(usage,{kind:'usage',...scope,last,total,modelContextWindow:128000});
  assert.equal(normalize('thread/tokenUsage/updated',{tokenUsage:{last,total}}).modelContextWindow,null);
  assert.equal(normalize('thread/tokenUsage/updated',{tokenUsage:{last,total,modelContextWindow:0}}).modelContextWindow,null);
  assert.equal(normalize('thread/tokenUsage/updated',{tokenUsage:{last:{...last,inputTokens:-1},total}}),null);
  assert.equal(normalize('thread/tokenUsage/updated',{tokenUsage:{last:{...last,totalTokens:Number.MAX_SAFE_INTEGER+1},total}}),null);
  assert.equal(normalize('thread/tokenUsage/updated',{tokenUsage:{last,total:null}}),null);
});

test('native diff is bounded, redacts common credential formats and strips control sequences',()=>{
  const source='diff --git a/config.txt b/config.txt\n+api_key="sk-synthetic-secret-abcdefghijkl"\n+Bearer token-synthetic-private\n+password: private\n+https://user:private@example.com?token=synthetic\n\x1b[31m+visible\x00\n';
  const diff=normalize('turn/diff/updated',{diff:source});
  assert.ok(diff.text.includes('diff --git'));assert.ok(diff.text.includes('+visible'));assert.ok(!/synthetic|private|\x1b|\x00/.test(diff.text));assert.equal(diff.truncated,false);
  const long=normalize('turn/diff/updated',{diff:'x'.repeat(1000000)});assert.equal(long.text.length,NATIVE_ACTIVITY_LIMITS.diff);assert.equal(long.truncated,true);
  assert.equal(nativeActivityText('-----BEGIN PRIVATE KEY-----\nsynthetic-secret\n',4000),'[private key redacted]');
});

test('native reroute uses actual bundled fields rather than inventing the selected model',()=>{
  assert.deepEqual(normalize('model/rerouted',{fromModel:'gpt-6',toModel:'gpt-6-cyber',reason:'highRiskCyberActivity',extra:'ignored'}),{kind:'reroute',...scope,fromModel:'gpt-6',toModel:'gpt-6-cyber',reason:'highRiskCyberActivity'});
  assert.equal(normalize('model/rerouted',{model:'something'}),null);
  assert.equal(normalize('turn/plan/updated',{plan:{}}),null);assert.equal(normalizeCodexActivity('turn/diff/updated',{turnId:'turn',diff:'x'}),null);assert.equal(normalize('unknown',{diff:'x'}),null);
});

test('repeated turn telemetry replaces snapshots, preserves streamed answer and open reasoning',()=>{
  const {events,message,activity}=run();activity.delta('The answer is streaming.','answer');activity.thinking({id:'reasoning',start:true});
  activity.delta('Another block.','answer2');activity.thinking({id:'reasoning2',start:true});const beforeContent=message.content;
  const plan=normalize('turn/plan/updated',{plan:[{step:'Verify',status:'inProgress'}]});activity.native(plan);activity.native({...plan,steps:[{text:'Verify',status:'completed'}]});
  activity.native(normalize('turn/diff/updated',{diff:'+first'}));activity.native(normalize('turn/diff/updated',{diff:'+second'}));
  activity.native(normalize('thread/tokenUsage/updated',{tokenUsage:{last:tokens(),total:tokens(890000),modelContextWindow:128000}}));
  assert.equal(message.content,beforeContent);assert.equal(activity.find('reasoning2').status,'running');assert.equal(message.activity.filter(step=>step.native?.kind==='plan').length,1);assert.equal(message.activity.filter(step=>step.native?.kind==='diff').length,1);assert.equal(message.activity.find(step=>step.native?.kind==='diff').native.text,'+second');assert.ok(events.every(event=>event.type==='chat.activity'||event.type==='chat.segment'));
});

test('ending a turn never turns an unfinished native plan into completed tasks',()=>{
  const {message,activity}=run();activity.native(normalize('turn/plan/updated',{plan:[{step:'Verify',status:'inProgress'},{step:'Review',status:'pending'}]}));activity.finish('Task stopped.',{failed:true});
  assert.deepEqual(message.activity[0].native.steps.map(step=>step.status),['inProgress','pending']);assert.equal(message.content,'Task stopped.');
});

test('many native turn continuations keep recent snapshots and visibly omit old bulky details',()=>{
  const {message,activity}=run();for(let turn=0;turn<20;turn++)activity.native(normalizeCodexActivity('turn/diff/updated',{...scope,turnId:'turn-'+turn,diff:'+x'.repeat(24000)}));
  const size=message.activity.reduce((sum,step)=>sum+JSON.stringify(step.native).length,0);assert.ok(size<=200000);assert.ok(message.activity.some(step=>step.native.omitted));assert.equal(message.activity.at(-1).native.text.length,48000);assert.equal(message.activity.at(-1).native.omitted,undefined);
});
