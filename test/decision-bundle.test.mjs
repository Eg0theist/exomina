import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../desktop/memory.mjs';
import {DecisionLayer} from '../desktop/decision-layer.mjs';
import {createNextPromptGate} from '../desktop/next-prompt-gate.mjs';
import {AgentTriggers} from '../desktop/agent-triggers.mjs';
import {Workbench} from '../desktop/workbench.mjs';
import {createAttentionNotifier} from '../desktop/attention-notify.mjs';
import {assessBusy, BUSY_PROBE} from '../desktop/decision-busy.mjs';
import {NLI_MODELS, NliRuntime, downloadNliModel, nliScores, nliProbabilities} from '../desktop/decision-nli.mjs';

test('Mark all as viewed covers notes beyond a 500-note listing and preserves content', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),'exomina-view-all-'));
  const memory = new MemoryStore(directory);
  try {
    for(let i=0;i<515;i++)await memory.note('Synthetic note '+i);
    const before=await memory.list('',1000);
    assert.equal((await memory.list()).length,500);
    assert.deepEqual(await memory.reviewAll(),{unreviewedCount:0});
    assert.equal((await memory.list('',1000,{newOnly:true})).length,0);
    assert.deepEqual((await memory.list('',1000)).map(x=>[x.id,x.text]),before.map(x=>[x.id,x.text]));
    await memory.note('Added after mark all');
    assert.equal((await memory.reviewStatus()).unreviewedCount,1);
  } finally { memory.close(); }
});

test('deleting a source erases its excerpts and invalidates its trained classifier durably', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'exomina-decision-cleanup-')),file=path.join(directory,'decisions.json');
  const layer=new DecisionLayer({file});
  for(let i=0;i<50;i++)await layer.record({gate:'test',kind:'noul',input:'deleted secret '+i,answer:i%2===0,source:'chat-a'});
  await layer.record({gate:'test',kind:'noul',input:'keep this',answer:true,source:'chat-b'});
  assert.ok(layer.model('test'));
  assert.equal(await layer.forgetSource('chat-a'),50);
  assert.equal(layer.model('test'),null);
  const saved=await readFile(file,'utf8');assert.ok(!saved.includes('deleted secret'));
  const reopened=new DecisionLayer({file});await reopened.load();assert.equal(reopened.gates.get('test').examples.length,1);
  await writeFile(file,JSON.stringify({version:1,gates:{old:{kind:'noul',labels:['false','true'],examples:[{text:'legacy excerpt',label:1}]}}}),'utf8');
  const migrated=new DecisionLayer({file});await migrated.load();assert.ok(!(await readFile(file,'utf8')).includes('legacy excerpt'));
  const gate=createNextPromptGate(migrated,{enabled:()=>false});
  const messages=[{role:'assistant',content:'x',nextPrompt:'Continue'}];
  assert.equal(await gate.record(messages,'Continue','chat-c'),null);assert.equal(messages[0].nextPromptRecorded,undefined);
});

const triggerFixture = ({enabled=true,budget=1,decisions=()=>null,runTask=async()=>({status:'complete',conversationId:'result'})}={}) => {
  const store={state:{settings:{agent:{enabled,dailyBudget:budget}},schedules:[{id:'task'}],agentTriggers:[],agentInbox:[]},save:async()=>{}};
  const watched=[];
  const agent=new AgentTriggers({store,decisions,runTask,clock:()=>new Date('2026-10-15T12:00:00Z'),watch:folder=>{watched.push(folder);return {close(){},on(){}};}});
  return {store,agent,watched};
};
const triggerInput = name => ({name,taskId:'task',folder:path.resolve('synthetic-project'),enabled:true});

test('agent is off by default; concurrent and failed starts cannot exceed or reset its budget', async () => {
  const off=triggerFixture({enabled:false});await off.agent.saveTrigger(triggerInput('off'));off.agent.start();assert.equal(off.watched.length,0);
  let runs=0;
  const {agent}=triggerFixture({runTask:async()=>{runs++;throw Error('Provider failed');}});
  const a=await agent.saveTrigger(triggerInput('a')),b=await agent.saveTrigger(triggerInput('b'));
  await Promise.all([agent.handle(a,['a.pdf']),agent.handle(b,['b.pdf'])]);
  assert.equal(runs,1);assert.equal(agent.runsToday(),1);
  for(let i=0;i<205;i++)await agent.addInbox({status:'skipped'});
  await agent.handle(a,['a2.pdf']);assert.equal(runs,1);assert.equal(agent.runsToday(),1);
  agent.stop();off.agent.stop();
});

test('disabling the agent during inference prevents a late provider request', async () => {
  let release,asked=0;
  const pending=new Promise(resolve=>release=resolve);
  const {agent,store}=triggerFixture({decisions:()=>({ask:()=>pending}),runTask:async()=>{asked++;return {status:'complete'};}});
  const trigger=await agent.saveTrigger(triggerInput('a'));
  const run=agent.handle(trigger,['a.pdf']);
  store.state.settings.agent.enabled=false;release({abstained:true});await run;
  assert.equal(asked,0);agent.stop();
});

test('a folder run uses task instructions and keeps delivery in the review chat', async () => {
  let prompt,delivered=0;
  const task={id:'t',prompt:'Summarize the selected files.',delivery:'discord',nextRun:'later'};
  const store={state:{schedules:[task]},save:async()=>{}};
  const bench=new Workbench({store,execute:async request=>{prompt=request.prompt;return {text:'Done',conversationId:'chat'};},deliver:async()=>{delivered++;}});
  const result=await bench.run('t',true,'a.pdf');
  assert.equal(result.status,'complete');assert.match(prompt,/Summarize the selected files/);assert.match(prompt,/untrusted file names/);assert.equal(delivered,0);
});

function timers() {
  const jobs=new Map();let id=0;
  return {jobs,setTimer:(fn,ms)=>{const key=++id;jobs.set(key,{fn,ms});return key;},clearTimer:key=>jobs.delete(key),async fire(){const [key,job]=jobs.entries().next().value;jobs.delete(key);await job.fn();return job.ms;}};
}
const question={type:'chat.question',conversationId:'chat',question:{id:'q',status:'waiting',questions:[{question:'Choose the scope.'}]}};
test('hidden-window questions notify with sound, defer in quiet states, remind and cancel after answering', async () => {
  const timer=timers(),notes=[],sounds=[];let quiet=true,focused=false;
  const notify=createAttentionNotifier({...timer,quiet:async()=>quiet,attended:()=>focused,enabled:()=>true,show:note=>notes.push(note),sound:note=>sounds.push(note)});
  notify(question);notify(question);assert.equal(timer.jobs.size,1);
  await timer.fire();assert.equal(notes.length,0);assert.equal(sounds.length,0);
  quiet=false;assert.equal(await timer.fire(),30000);assert.equal(notes.length,1);assert.equal(sounds.length,1);
  assert.equal(await timer.fire(),180000);assert.equal(notes[1].reminder,true);
  notify({...question,question:{...question.question,status:'answered'}});assert.equal(timer.jobs.size,0);
  focused=true;notify({...question,question:{...question.question,id:'q2'}});await timer.fire();assert.equal(notes.length,2);assert.equal(sounds.at(-1).focused,true);
  notify.close();assert.equal(timer.jobs.size,0);
});

test('resolved approvals and deleted chats cannot deliver a deferred notification', async () => {
  const timer=timers();let sent=0,release;
  const notifier=createAttentionNotifier({...timer,quiet:()=>new Promise(resolve=>release=resolve),attended:()=>false,enabled:()=>true,show:()=>sent++});
  notifier({type:'approval',id:'a',title:'Run a command'});const running=timer.fire();
  notifier({type:'approval.resolved',id:'a'});release(false);await running;assert.equal(sent,0);
  notifier(question);notifier.cancelChat('chat');assert.equal(timer.jobs.size,0);
});

test('quiet time suppresses audio; GPU render and video-encode engines are sampled', () => {
  assert.equal(assessBusy(JSON.stringify({notification:6})).quiet,true);
  assert.match(BUSY_PROBE,/Compute/);assert.match(BUSY_PROBE,/VideoEncode/);assert.doesNotMatch(BUSY_PROBE,/VideoDecode/);
  assert.equal(assessBusy(JSON.stringify({gpu:[{pid:99999,name:'blender',load:95}]})).busy,true);
});

test('Tier 2 verifies files, uses paired token types and serializes release behind inference', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'exomina-nli-'));
  const bytes=new Map([['config.json',Buffer.from(JSON.stringify({id2label:{0:'contradiction',1:'entailment'}}))],['tokenizer_config.json',Buffer.from('{}')],['tokenizer.json',Buffer.from('{}')],['onnx/model_quantized.onnx',Buffer.from('synthetic-model')]]);
  NLI_MODELS.fixture={id:'fixture',revision:'pinned',repo:'synthetic',files:[...bytes].map(([name,value])=>({name,size:value.length,sha256:createHash('sha256').update(value).digest('hex')}))};
  let released=false,feeds;
  const fakeSession={inputNames:['input_ids','attention_mask','token_type_ids'],run:async input=>{feeds=input;assert.equal(released,false);return {logits:{data:[-2,2]}};},release:async()=>{released=true;}};
  class Tensor {constructor(type,data,dims){Object.assign(this,{type,data,dims});}}
  class Tokenizer {encode(){return {ids:[1,2,3],token_type_ids:[0,1,1]};}}
  try {
    const fetchImpl=async url=>new Response(bytes.get([...bytes.keys()].find(key=>url.endsWith('/'+key))));
    await downloadNliModel({root,id:'fixture',fetchImpl});
    const runtime=new NliRuntime({root,loadRuntime:async()=>({ort:{Tensor,InferenceSession:{create:async()=>fakeSession}},Tokenizer})});
    const answer=runtime.score('premise',['hypothesis']);const release=runtime.release();
    assert.ok((await answer)[0].truth>.9);await release;assert.equal(released,true);
    assert.deepEqual([...feeds.token_type_ids.data],[0n,1n,1n]);
    assert.throws(()=>runtime.encode({tokenizer:new Tokenizer()},'premise','x'.repeat(1001)),/too long/);
    await writeFile(path.join(root,'fixture','onnx/model_quantized.onnx'),'corrupted-model','utf8');
    const tampered=new NliRuntime({root});await assert.rejects(tampered.ensure(),/changed/);
    await assert.rejects(downloadNliModel({root,id:'fixture',fetchImpl:async()=>new Response('x')}),/integrity check/);
  } finally {delete NLI_MODELS.fixture;}
  assert.ok(nliScores([2,0,-2],{0:'entailment',1:'neutral',2:'contradiction'}).truth>.8);
  const probabilities=await nliProbabilities({score:async()=>[{entail:2,truth:.95,falsehood:.05,neutral:0},{entail:-2,truth:.1,falsehood:.9,neutral:0}]},{kind:'choice',labels:['reports','games'],input:'report',hypothesis:'This is about {}.'});
  assert.ok(probabilities[0]>.9);
});

test('neutral or truncated evidence abstains instead of confidently skipping an event', async () => {
  const score=nliScores([1,-4,10],{0:'contradiction',1:'entailment',2:'neutral'});
  assert.ok(score.neutral>.99);
  const runtime={score:async()=>[score]};
  assert.equal(await nliProbabilities(runtime,{kind:'noul',input:'unknown',question:'An invoice needs action.'}),null);
  assert.equal(await nliProbabilities({score:async()=>[{entail:6,truth:.99,falsehood:.01,neutral:0,truncated:true}]},{kind:'noul',input:'long',question:'Needs action'}),null);
});

test('agent rechecks settings after the persisted claim; overflow events cannot be silently skipped', async () => {
  let finishSave,asked=0,checked=0;
  const {agent,store}=triggerFixture({decisions:()=>({ask:async()=>{checked++;return {answer:false,confidence:.99,tier:2};}}),runTask:async()=>{asked++;return {status:'complete'};}});
  const trigger=await agent.saveTrigger(triggerInput('a'));
  store.save=()=>new Promise(resolve=>finishSave=resolve);
  const pending=agent.handle(trigger,['a.pdf'],{omitted:true});
  await Promise.resolve();store.state.settings.agent.enabled=false;store.save=async()=>{};finishSave();await pending;
  assert.equal(checked,0);assert.equal(asked,0);assert.equal(agent.inbox()[0].status,'cancelled');agent.stop();
});

test('trigger cleanup works while decisions are disabled and does not commit after cleanup failure', async () => {
  const {agent}=triggerFixture({decisions:()=>null});
  let cleaned=0;
  agent.cleanup=()=>({forgetSource:async()=>{cleaned++;throw Error('Disk full');}});
  const trigger=await agent.saveTrigger(triggerInput('a'));
  await assert.rejects(agent.removeTrigger(trigger.id),/Disk full/);assert.equal(agent.triggers().length,1);
  agent.cleanup=()=>({forgetSource:async()=>{cleaned++;}});await agent.removeTrigger(trigger.id);
  assert.equal(agent.triggers().length,0);assert.equal(cleaned,2);agent.stop();
});

test('corrected feedback replaces its training label instead of adding contradictions', async () => {
  const layer=new DecisionLayer();
  const {agent}=triggerFixture({decisions:()=>layer});
  const trigger=await agent.saveTrigger(triggerInput('a'));
  const entry=await agent.handle(trigger,['a.pdf']);
  await Promise.all([agent.feedback(entry.id,false),agent.feedback(entry.id,true)]);
  const rows=layer.gates.get('agent.'+trigger.id).examples;assert.equal(rows.length,1);assert.equal(rows[0].label,1);assert.equal(entry.feedback,true);agent.stop();
});

test('a failed notification attempt is retried without consuming a reminder', async () => {
  const timer=timers();let failures=0;const notes=[];
  const notify=createAttentionNotifier({...timer,quiet:async()=>false,attended:()=>false,enabled:()=>true,show:note=>{if(failures++===0)throw Error('OS not ready');notes.push(note);}});
  notify(question);await timer.fire();assert.equal(notes.length,0);assert.equal(await timer.fire(),30000);assert.equal(notes[0].reminder,false);notify.close();
});

test('real folder notifications run a saved task locally without an AI service', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'exomina-folder-trigger-'));
  const store={state:{settings:{agent:{enabled:true,dailyBudget:1}},schedules:[{id:'task'}]},save:async()=>{}};
  let result;
  const agent=new AgentTriggers({store,runTask:async(id,extra)=>{result={id,extra};return {status:'complete'};},setTimer:(fn,ms)=>setTimeout(fn,Math.min(ms,20))});
  try {
    await agent.saveTrigger({...triggerInput('actual folder'),folder:directory,filter:'*.txt'});
    await writeFile(path.join(directory,'report.txt'),'Synthetic event, no private data.','utf8');
    for(let i=0;i<100&&!result;i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(result?.id,'task');assert.match(result.extra,/report.txt/);assert.equal(agent.runsToday(),1);
  }finally{agent.stop();}
});
