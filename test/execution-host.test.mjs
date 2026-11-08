import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {startExecutionHost} from '../desktop/execution-host.mjs';
import {ExecutionClient} from '../desktop/execution-client.mjs';
import {TerminalPtySessions} from '../desktop/terminal-pty.mjs';
import {executionEndpoint} from '../desktop/execution-protocol.mjs';
const waitFor=async predicate=>{const deadline=Date.now()+5000;while(!await predicate()){if(Date.now()>deadline)throw Error('Execution QA timed out.');await new Promise(resolve=>setTimeout(resolve,20));}};

test('authenticated background host survives attachment replacement and preserves exact chat ownership/output',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'exomina-execution-')),token=randomBytes(32).toString('hex'),nonce=randomUUID(),endpoint=executionEndpoint(root);
  const fakes=[];const native={spawn(){let onData,onExit;const fake={pid:9000+fakes.length,onData:cb=>{onData=cb;},onExit:cb=>{onExit=cb;},write:text=>{fake.writes.push(text);onData(text);},resize(){},kill:()=>onExit({exitCode:0}),emit:text=>onData(text),writes:[]};fakes.push(fake);return fake;}};
  const host=await startExecutionHost({root,endpoint,token,nonce,load:async()=>native,killTree:async pty=>pty.kill(),idleMs:100_000});
  const descriptor={version:1,token,nonce,endpoint,pid:process.pid};await writeFile(path.join(root,'endpoint.json'),JSON.stringify(descriptor),'utf8');
  const first=new ExecutionClient({root}),second=new ExecutionClient({root}),intruder=new ExecutionClient({root});let terminals;
  try{
    await assert.rejects(intruder.connect({...descriptor,token:'0'.repeat(64)}),/auth|ended/);intruder.close();
    await first.init();const binding={id:'pty:'+randomUUID(),conversationId:'chat',owner:'agent',workspace:root,startDirectory:root,title:'Synthetic background session',cols:80,rows:24,createdAt:new Date().toISOString()};
    const pty=await first.native.spawn(null,null,{exomina:binding});await pty.setKeepAlive(true);await pty.write('before detach\r');first.close();
    assert.equal(host.sessions.get(binding.id).status,'running');await second.init();const records=await second.existing();assert.equal(records[0].pid,9000);assert.equal(records[0].keepAlive,true);
    await assert.rejects(second.request('input',{id:binding.id,conversationId:'other',owner:'agent',text:'wrong'}),/owned/);assert.deepEqual(fakes[0].writes,['before detach\r']);
    let approvals=0;terminals=new TerminalPtySessions({getContext:async()=>({workspace:root,permissionMode:'ask'}),approve:async()=>{approvals++;return true;},check:()=>{}});await terminals.adopt(records,value=>second.proxy(value));await waitFor(()=>terminals.sessions.get(binding.id).buffer.includes('before detach'));
    await terminals.input({conversationId:'chat',id:binding.id,text:'after attach\r'},{agent:true});assert.equal(approvals,1);await waitFor(()=>terminals.sessions.get(binding.id).buffer.includes('after attach'));assert.deepEqual(fakes[0].writes,['before detach\r','after attach\r']);await terminals.resize({conversationId:'chat',id:binding.id,cols:100,rows:30});assert.equal(approvals,1);
    let blocked=false;terminals.check=()=>{if(blocked)throw Error('Revoked');};blocked=true;await assert.rejects(terminals.input({conversationId:'chat',id:binding.id,text:'never'}),/Revoked/);await terminals.revalidate();await waitFor(()=>!host.sessions.get(binding.id).pty);await waitFor(()=>terminals.sessions.get(binding.id).status==='stopped');
    assert.equal(fakes[0].writes.includes('never'),false);assert.ok((await readFile(path.join(root,'session-index.json'),'utf8')).includes('Synthetic background session'));assert.doesNotMatch(await readFile(path.join(root,'session-index.json'),'utf8'),/before detach/);
  }finally{terminals?.close();first.close();second.close();intruder.close();await host.close();await rm(root,{recursive:true,force:true});}
});

test('sessions without keep-alive stop when their desktop explicitly quits',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'exomina-execution-')),token=randomBytes(32).toString('hex'),nonce=randomUUID(),endpoint=executionEndpoint(root);
  let exit;const host=await startExecutionHost({root,endpoint,token,nonce,load:async()=>({spawn:()=>({pid:9001,onData(){},onExit:cb=>exit=cb,kill:()=>exit({exitCode:0})})}),killTree:async pty=>pty.kill(),idleMs:100_000});const client=new ExecutionClient({root});await writeFile(path.join(root,'endpoint.json'),JSON.stringify({version:1,token,nonce,endpoint,pid:process.pid}),'utf8');
  try{await client.init();await client.native.spawn(null,null,{exomina:{id:'pty:'+randomUUID(),conversationId:'chat',owner:'agent',workspace:root,startDirectory:root,cols:80,rows:24}});await client.detach();await waitFor(()=>[...host.sessions.values()][0].status==='stopped');}finally{client.close();await host.close();await rm(root,{recursive:true,force:true});}
});

test('an owner disappearing during native load cannot leave a late orphan, and maximum control input is admitted',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'exomina-execution-')),token=randomBytes(32).toString('hex'),nonce=randomUUID(),endpoint=executionEndpoint(root);let release,entered=false,spawns=0,onExit,written='';
  const native={spawn:()=>{spawns++;return {pid:9002,onData(){},onExit:cb=>onExit=cb,write:text=>{written=text;},kill:()=>onExit({exitCode:0})};}};
  const host=await startExecutionHost({root,endpoint,token,nonce,load:()=>new Promise(resolve=>{entered=true;release=()=>resolve(native);}),killTree:async pty=>pty.kill(),idleMs:100_000});const client=new ExecutionClient({root}),other=new ExecutionClient({root});await writeFile(path.join(root,'endpoint.json'),JSON.stringify({version:1,token,nonce,endpoint,pid:process.pid}),'utf8');
  try{await client.init();const binding={id:'pty:'+randomUUID(),conversationId:'chat',owner:'agent',workspace:root,startDirectory:root,cols:80,rows:24};const opening=client.native.spawn(null,null,{exomina:binding});opening.catch(()=>{});await waitFor(()=>entered);client.close();await new Promise(resolve=>setTimeout(resolve,30));release();await assert.rejects(opening,/ended|disconnected/);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(spawns,0);
    host.sessions.clear();await other.init();entered=false;const next=other.native.spawn(null,null,{exomina:{...binding,id:'pty:'+randomUUID()}});await waitFor(()=>entered);release();const pty=await next;await pty.write('\u0001'.repeat(65536));assert.equal(written.length,65536);assert.ok(other.socket&&!other.socket.destroyed);await pty.kill();
  }finally{client.close();other.close();await host.close();await rm(root,{recursive:true,force:true});}
});

test('cold reopening restores truthful unavailable metadata without launching or killing a recorded PID',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'exomina-execution-')),client=new ExecutionClient({root});let terminals;
  try{const id='pty:'+randomUUID();await writeFile(path.join(root,'session-index.json'),JSON.stringify([{id,conversationId:'chat',owner:'agent',workspace:root,startDirectory:root,title:'Previous shell',status:'running',pid:process.pid,baseCursor:0,nextCursor:50,keepAlive:true}]),'utf8');const records=await client.existing();assert.equal(records[0].status,'unavailable');assert.match(records[0].error,/cannot be confirmed/);assert.equal(client.socket,null);
    terminals=new TerminalPtySessions({getContext:async()=>({workspace:root}),approve:async()=>{throw Error('No cold input grant should be requested.');},load:async()=>{throw Error('No process should be spawned.');}});await terminals.adopt(records,()=>{throw Error('No live proxy should be attached.');});assert.equal((await terminals.list('chat'))[0].status,'unavailable');assert.equal(terminals.busy,false);assert.equal((await terminals.read({conversationId:'chat',id})).text,'');assert.ok(process.pid>0);
  }finally{terminals?.close();client.close();await rm(root,{recursive:true,force:true});}
});
