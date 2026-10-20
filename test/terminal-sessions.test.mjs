import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalSessions} from '../desktop/terminal-sessions.mjs';
import {agentCommandRows} from '../desktop/agent-commands.mjs';

const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function settled(terminal){for(let step=0;step<30&&terminal.busy;step++)await turn();assert.equal(terminal.busy,false);}
function fixture(execute=async()=>result({exitCode:0,output:'Done.'})){const events=[],cancelled=[],terminal=new TerminalSessions({getContext:cid=>{if(cid==='unknown')throw Error('Unknown chat.');return {workspace:'C:\\Synthetic\\'+(cid||'default')};},execute,cancel:id=>cancelled.push(id),emit:event=>events.push(event)});return {terminal,events,cancelled};}

test('direct terminal streams bounded output and keeps its transcripts out of emitted events',async()=>{
  const {terminal,events}=fixture(async(args,context)=>{assert.equal(args.command,'Synthetic');assert.equal(context.conversationId,'chat');assert.match(context.processKey,/^terminal:/);context.onEvent({type:'start',cwd:'C:\\Resolved'});context.onEvent({type:'output',text:'First line.\n'});await turn();return result({exitCode:0,output:'First line.\n'+'x'.repeat(300000)});});
  const started=await terminal.start({conversationId:'chat',command:'Synthetic'});assert.equal(started.status,'authorizing');assert.equal(terminal.hasRunning('chat'),true);
  await settled(terminal);const view=await terminal.list('chat');assert.equal(view.interactive,false);assert.equal(view.entries[0].workspace,'C:\\Resolved');assert.equal(view.entries[0].status,'complete');assert.equal(view.entries[0].output.length,256*1024);assert.equal(view.entries[0].outputTruncated,true);
  assert.deepEqual(Object.keys(events[0]).sort(),['conversationId','type']);assert.doesNotMatch(JSON.stringify(events),/First line|Synthetic|Resolved/);terminal.close();
});

test('explicit direct process keys isolate cancellation by chat and by command',async()=>{
  const waits=new Map(),{terminal,cancelled}=fixture(async(_args,context)=>{context.onEvent({type:'start'});return new Promise(resolve=>{waits.set(context.processKey,()=>resolve(result({exitCode:0,output:'done'})));context.signal.addEventListener('abort',()=>resolve(result({exitCode:null,output:'Stopped',cancelled:true})),{once:true});});});
  const first=await terminal.start({conversationId:'one',command:'first'}),second=await terminal.start({conversationId:'two',command:'second'});await turn();
  await assert.rejects(terminal.stop({conversationId:'two',id:first.id}),/selected terminal/);
  await terminal.stop({conversationId:'one',id:first.id});await turn();assert.deepEqual(cancelled,[first.id]);assert.equal(terminal.hasRunning('two'),true);assert.equal((await terminal.list('one')).entries[0].status,'stopped');
  waits.get(second.id)();await settled(terminal);assert.equal((await terminal.list('two')).entries[0].status,'complete');assert.equal((await terminal.list(null)).entries.length,0);terminal.close();
});

test('stopping a conversation and closing the host abort only owned direct work',async()=>{
  const {terminal,cancelled}=fixture(async(_args,context)=>new Promise((_resolve,reject)=>context.signal.addEventListener('abort',()=>reject(Object.assign(Error('Stopped'),{code:'TERMINAL_CANCELLED'})),{once:true})));
  const first=await terminal.start({conversationId:'one',command:'first'}),second=await terminal.start({conversationId:'two',command:'second'});await turn();terminal.stopConversation('one');await turn();assert.equal(terminal.hasRunning('one'),false);assert.equal(terminal.hasRunning('two'),true);terminal.close();await settled(terminal);assert.deepEqual(cancelled.sort(),[first.id,second.id].sort());await assert.rejects(terminal.start({command:'third'}),/closing/);
});

test('closing during deferred context lookup prevents late command registration or execution',async()=>{
  let resolveContext,calls=0;const events=[];
  const terminal=new TerminalSessions({getContext:()=>new Promise(resolve=>{resolveContext=resolve;}),execute:async()=>{calls++;return result({exitCode:0,output:'must not run'});},cancel:()=>{},emit:event=>events.push(event)});
  const pending=terminal.start({conversationId:'chat',command:'synthetic'});
  terminal.close();resolveContext({workspace:'C:\\Synthetic'});
  await assert.rejects(pending,/closing/);await turn();
  assert.equal(calls,0);assert.equal(terminal.busy,false);assert.equal(terminal.entries.length,0);assert.deepEqual(events,[]);
});

test('invalid contexts, excessive concurrency and invalid commands never execute',async()=>{
  let calls=0;const {terminal}=fixture(async(_args,context)=>{calls++;return new Promise((_resolve,reject)=>context.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));});
  await assert.rejects(terminal.start({conversationId:'unknown',command:'x'}),/Unknown/);await assert.rejects(terminal.start({command:''}),/Enter/);await assert.rejects(terminal.start({command:'x',timeoutSeconds:121}),/timeout/);assert.equal(calls,0);
  for(let index=0;index<3;index++)await terminal.start({command:'x'});await assert.rejects(terminal.start({command:'fourth'}),/three/);await turn();assert.equal(calls,3);terminal.close();await settled(terminal);
});

test('denial, timeout, unknown exit and output limit are distinguished from success',async()=>{
  for(const [answer,status]of [[{exitCode:1,output:'failure'},'error'],[{exitCode:null,output:'receipt'},'unconfirmed'],[{exitCode:0,output:'partial',timedOut:true},'timed-out'],[{exitCode:0,output:'partial',truncated:true},'output-limited']]){
    const {terminal}=fixture(async()=>result(answer));await terminal.start({command:'x'});await settled(terminal);assert.equal((await terminal.list()).entries[0].status,status);terminal.close();
  }
  const {terminal}=fixture(async()=>{throw Object.assign(Error('Permission blocked.'),{code:'TERMINAL_DENIED'});});await terminal.start({command:'x'});await settled(terminal);assert.equal((await terminal.list()).entries[0].status,'denied');terminal.close();
});

test('completed direct history is bounded without exposing another chat transcript',async()=>{
  const {terminal}=fixture();
  for(let index=0;index<23;index++){await terminal.start({conversationId:index===0?'other':'chat',command:'command '+index});await settled(terminal);}
  const view=await terminal.list('chat');assert.equal(view.entries.length,20);assert.equal(view.entries[0].command,'command 3');assert.equal(view.entries.at(-1).command,'command 22');assert.equal((await terminal.list('other')).entries.length,0);terminal.close();
});

test('agent command view reads reported activity only and never invents live terminal attachment',()=>{
  const messages=[{id:'old',role:'assistant',provider:'claude',finishedAt:'saved',activity:[{id:'a',kind:'tool',category:'execute',name:'Bash',input:'{"command":"check old"}',status:'done',output:'old output'}]},
    {id:'new',role:'assistant',provider:'codex',activity:[{id:'b',kind:'tool',category:'tool',name:'Reviewer: commandExecution',input:'{"command":["check","new"]}',status:'running',output:'partial'}, {id:'c',kind:'tool',category:'read',name:'Read',status:'done'}]}];
  const rows=agentCommandRows(messages,{running:true});assert.equal(rows.length,2);assert.equal(rows[0].status,'recorded');assert.equal(rows[1].command,'check new');assert.equal(rows[1].canStopTask,true);assert.equal(agentCommandRows(messages)[1].status,'unconfirmed');assert.equal(agentCommandRows(messages)[1].canStopTask,false);
});
