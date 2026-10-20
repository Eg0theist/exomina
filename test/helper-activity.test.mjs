import test from 'node:test';
import assert from 'node:assert/strict';
import {HELPER_DISPLAY_LIMITS,normalizeHelperActivity,mergeHelperActivity} from '../desktop/helper-activity.mjs';
import {RunActivity} from '../desktop/activity.mjs';

test('helper display keeps requested, configured and execution identity distinct',()=>{
  const helper=normalizeHelperActivity({id:'helper-1',kind:'native',sourceProvider:'codex',sourceModel:'parent-actual',sourceRequestedModel:'parent-requested',sourceModelSource:'reported',effectiveProvider:'codex',requestedModel:'auto',configuredModel:'configured-native',configuredEffort:'high',effectiveModel:'execution-native',modelSource:'execution',status:'running',unexpectedSecret:'ignored'});
  assert.equal(helper.sourceRequestedModel,'parent-requested');assert.equal(helper.configuredModel,'configured-native');assert.equal(helper.effectiveModel,'execution-native');assert.equal(helper.configuredEffort,'high');assert.equal(helper.unexpectedSecret,undefined);
  const unknown=normalizeHelperActivity({id:'helper-2',configuredModel:'configured-only',status:'waiting'});assert.equal(unknown.effectiveModel,undefined);assert.equal(unknown.name,undefined);
});

test('partial helper lifecycle upserts retain task, provider and name without changing order',()=>{
  const first={id:'one',kind:'native',sourceProvider:'claude',provider:'claude',name:'Reviewer',task:'Read the files.',status:'running'};
  let rows=mergeHelperActivity([],first).helpers;rows=mergeHelperActivity(rows,{id:'two',task:'Another helper.',status:'running'}).helpers;
  rows=mergeHelperActivity(rows,{id:'one',status:'complete',summary:'Reported task completion.',finishedAt:1791710400000}).helpers;
  assert.deepEqual(rows.map(row=>row.id),['one','two']);assert.equal(rows[0].task,first.task);assert.equal(rows[0].provider,'claude');assert.equal(rows[0].name,'Reviewer');assert.equal(rows[0].summary,'Reported task completion.');assert.equal(rows[0].finishedAt,new Date(1791710400000).toISOString());
});

test('runtime reroute explicitly clears old executed model and effort while omitted fields persist',()=>{
  let rows=mergeHelperActivity([],{id:'consult',requestedProvider:'codex',requestedModel:'gpt-requested',effectiveProvider:'codex',effectiveModel:'gpt-executed',effectiveEffort:'high',status:'running',task:'Review.'}).helpers;
  rows=mergeHelperActivity(rows,{id:'consult',summary:'Still working.'}).helpers;assert.equal(rows[0].effectiveModel,'gpt-executed');
  rows=mergeHelperActivity(rows,{id:'consult',effectiveProvider:'claude',effectiveModel:null,effectiveEffort:null}).helpers;
  assert.equal(rows[0].effectiveProvider,'claude');assert.equal(rows[0].effectiveModel,null);assert.equal(rows[0].effectiveEffort,null);assert.equal(rows[0].requestedModel,'gpt-requested');assert.equal(rows[0].task,'Review.');
});

test('native helper dates, explicit status and shortened tasks remain truthful',()=>{
  const helper=normalizeHelperActivity({id:'native',nativeTaskId:'task',parentThreadId:'parent',parentHelperId:'other',background:true,startedAt:1791710400000,finishedAt:NaN,task:'Bounded task.',taskTruncated:true,status:'cancelled',summary:'No completion was observed.'});
  assert.equal(helper.startedAt,'2026-10-11T09:20:00.000Z');assert.equal(helper.finishedAt,undefined);assert.equal(helper.nativeTaskId,'task');assert.equal(helper.background,true);assert.equal(helper.taskTruncated,true);assert.equal(helper.status,'cancelled');
  assert.equal(normalizeHelperActivity({id:'invalid',status:'guess'}).status,undefined);
});

test('saved helper count and aggregate task/contribution text are bounded',()=>{
  let rows=[],omitted=0;
  for(let index=0;index<85;index++){const result=mergeHelperActivity(rows,{id:'h'+index,status:index===0?'running':'complete',task:'t'.repeat(40000),text:'x'.repeat(60000)});rows=result.helpers;omitted+=result.omitted;}
  assert.equal(rows.length,HELPER_DISPLAY_LIMITS.count);assert.equal(omitted,5);assert.equal(rows[0].id,'h0');assert.ok(rows.reduce((sum,row)=>sum+(row.task?.length||0)+(row.text?.length||0),0)<=HELPER_DISPLAY_LIMITS.savedText);assert.ok(rows.at(-1).task.length<=HELPER_DISPLAY_LIMITS.task);assert.ok(rows.at(-1).text.length<=HELPER_DISPLAY_LIMITS.text);assert.ok(rows.some(row=>row.taskTruncated&&row.task===''));assert.ok(rows.some(row=>row.textTruncated&&row.text===''));
});

test('RunActivity helper receipts pin message ownership and preserve the answer stream',()=>{
  const message={id:'reply-1',role:'assistant',content:'Parent answer.',activity:[]},events=[],activity=new RunActivity(message,{conversationId:'chat-1',emit:event=>events.push(structuredClone(event))});
  activity.helper({id:'consult',kind:'consult',sourceProvider:'codex',provider:'claude',task:'Review.',status:'running'});activity.helper({id:'consult',status:'complete',effectiveProvider:'claude',effectiveModel:'claude-reported',text:'Review result.'});
  assert.equal(message.helpers.length,1);assert.equal(message.content,'Parent answer.');assert.equal(message.helpers[0].task,'Review.');assert.equal(message.helpers[0].effectiveModel,'claude-reported');assert.deepEqual(events.map(event=>[event.type,event.conversationId,event.messageId]),[['chat.helper','chat-1','reply-1'],['chat.helper','chat-1','reply-1']]);
});
