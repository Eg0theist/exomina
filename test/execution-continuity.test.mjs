import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,cp,realpath} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {startExecutionHost} from '../desktop/execution-host.mjs';
import {ExecutionClient} from '../desktop/execution-client.mjs';
import {TerminalPtySessions,terminalCwd,terminalShellArguments} from '../desktop/terminal-pty.mjs';
import {executionEndpoint} from '../desktop/execution-protocol.mjs';
import {stageExecutionRuntime,pruneExecutionRuntimes} from '../desktop/execution-runtime.mjs';
const waitFor=async(predicate,ms=5000)=>{const deadline=Date.now()+ms;while(!await predicate()){if(Date.now()>deadline)throw Error('Continuity QA timed out.');await new Promise(resolve=>setTimeout(resolve,20));}};
const RUNTIME='0123456789abcdef01234567';
function fakeNative(){const fakes=[];return {fakes,spawn(_shell,_args,options){let onData=()=>{},onExit=()=>{};const fake={pid:7000+fakes.length,options,onData:cb=>{onData=cb;},onExit:cb=>{onExit=cb;},write(){},resize(){},kill:()=>onExit({exitCode:0}),emit:text=>onData(text)};fakes.push(fake);return fake;}};}
async function hostFixture(options={}){
  const root=await mkdtemp(path.join(tmpdir(),'exomina-continuity-')),token=randomBytes(32).toString('hex'),nonce=randomUUID(),endpoint=executionEndpoint(root),native=fakeNative();
  const host=await startExecutionHost({root,endpoint,token,nonce,load:async()=>native,killTree:async pty=>pty.kill(),idleMs:100_000,transcriptMs:30,...options});
  await writeFile(path.join(root,'endpoint.json'),JSON.stringify({version:1,token,nonce,endpoint,pid:process.pid,runtime:RUNTIME}),'utf8');
  return {root,host,native,cleanup:async()=>{await host.close();await rm(root,{recursive:true,force:true});}};
}
const binding=root=>({id:'pty:'+randomUUID(),conversationId:'chat',owner:'user',workspace:root,startDirectory:root,title:'Shell',cols:80,rows:24,createdAt:new Date().toISOString()});

test('an update hold keeps sessions through the restart, and reattaching ends the hold',async()=>{
  const {root,host,cleanup}=await hostFixture();const before=new ExecutionClient({root}),after=new ExecutionClient({root}),later=new ExecutionClient({root});
  try{
    await before.init();assert.equal(before.survivesUpdates,true);const shell=binding(root);await before.native.spawn(null,null,{exomina:shell});
    assert.deepEqual(await before.holdForUpdate(60_000),{held:1,ms:60_000});before.close();
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(host.sessions.get(shell.id).status,'running','held session survives the old desktop closing');
    await after.init();assert.deepEqual(after.identity.released,[shell.id]);await after.detach();
    await waitFor(()=>host.sessions.get(shell.id).status==='stopped');
    await later.init();assert.deepEqual(later.identity.released,[],'the hold was a single restart, not a lasting keep-alive');
  }finally{before.close();after.close();later.close();await cleanup();}
});

test('unexpected disconnect preserves ordinary shells until authenticated recovery, then input needs fresh approval',async()=>{
  const {root,host,cleanup}=await hostFixture({crashGraceMs:400}),before=new ExecutionClient({root}),after=new ExecutionClient({root});let terminals;
  try{
    await before.init();const shell=binding(root);await before.native.spawn(null,null,{exomina:shell});before.close();
    await waitFor(()=>host.sessions.get(shell.id).crashHold===true);assert.equal(host.sessions.get(shell.id).status,'running');
    const intruder=new ExecutionClient({root});try{await assert.rejects(intruder.connect({...await after.descriptor(),token:'0'.repeat(64)}),/auth|ended/);}finally{intruder.close();}
    assert.equal(host.sessions.get(shell.id).crashHold,true,'failed authentication cannot clear the recovery hold');
    await after.init();assert.deepEqual(after.identity.recovered,[shell.id]);assert.equal(host.sessions.get(shell.id).crashHold,false);
    await new Promise(resolve=>setTimeout(resolve,450));assert.equal(host.sessions.get(shell.id).status,'running','the old grace timer cannot stop a recovered terminal');
    let approvals=0;terminals=new TerminalPtySessions({getContext:async()=>({workspace:root,permissionMode:'ask'}),approve:async()=>{approvals++;return false;},check:()=>{}});
    await terminals.adopt(await after.existing(),record=>after.proxy(record));
    await assert.rejects(terminals.input({conversationId:'chat',id:shell.id,text:'denied'}),/declined/);assert.equal(approvals,1);
    await after.detach();await waitFor(()=>host.sessions.get(shell.id).status==='stopped');
  }finally{terminals?.close();before.close();after.close();await cleanup();}
});

test('crash grace expires, respects keep-alive, and is never serialized as lasting permission',async()=>{
  const {root,host,cleanup}=await hostFixture({crashGraceMs:100}),client=new ExecutionClient({root});
  try{
    await client.init();const plain=binding(root),kept=binding(root);await client.native.spawn(null,null,{exomina:plain});const keptPty=await client.native.spawn(null,null,{exomina:kept});await keptPty.setKeepAlive(true);client.close();
    await waitFor(()=>host.sessions.get(plain.id).status==='stopped');assert.equal(host.sessions.get(kept.id).status,'running');
    // Runtime status changes before the queued durable index write completes.
    // Observe the expected persisted state rather than racing file creation.
    await waitFor(async()=>{try{return JSON.parse(await readFile(path.join(root,'session-index.json'),'utf8')).some(row=>row.id===plain.id&&row.status==='stopped');}catch(error){if(error.code==='ENOENT')return false;throw error;}});
    const metadata=await readFile(path.join(root,'session-index.json'),'utf8');assert.doesNotMatch(metadata,/crashHold|updateHold/);
  }finally{client.close();await cleanup();}
});

test('clean detach preserves explicit keep-alive and update holds without adding crash grace',async t=>{
  const {root,host,cleanup}=await hostFixture({crashGraceMs:20}),client=new ExecutionClient({root});
  const until=async predicate=>{const end=Date.now()+5000;while(!await predicate()){if(Date.now()>end)throw Error('Clean detach did not settle.');await new Promise(resolve=>setImmediate(resolve));}};
  try{
    await client.init();const plain=binding(root),kept=binding(root);await client.native.spawn(null,null,{exomina:plain});const keptPty=await client.native.spawn(null,null,{exomina:kept});await keptPty.setKeepAlive(true);
    // Advance only the deadline under test. A loaded CI worker must not turn a
    // 50ms assertion into a wall-clock race with a 120ms update hold.
    t.mock.timers.enable({apis:['setTimeout']});
    await client.holdForUpdate(60_000);await client.detach();
    await until(()=>new Promise((resolve,reject)=>host.server.getConnections((error,count)=>error?reject(error):resolve(count===0))));
    assert.equal(host.sessions.get(plain.id).updateHold,true);assert.equal(host.sessions.get(plain.id).status,'running');assert.equal(host.sessions.get(plain.id).crashHold,undefined);
    t.mock.timers.tick(59_999);assert.equal(host.sessions.get(plain.id).status,'running');
    t.mock.timers.tick(1);await until(()=>host.sessions.get(plain.id).status==='stopped');assert.equal(host.sessions.get(kept.id).status,'running');
  }finally{t.mock.timers.reset();client.close();await cleanup();}
});

test('a hold expires when no desktop reattaches; a session kept by choice survives the expiry',async t=>{
  const {root,host,cleanup}=await hostFixture();const client=new ExecutionClient({root});
  const disconnected=new Promise(resolve=>host.server.once('connection',socket=>socket.once('close',resolve)));
  try{
    await client.init();const plain=binding(root),kept=binding(root);await client.native.spawn(null,null,{exomina:plain});const keptPty=await client.native.spawn(null,null,{exomina:kept});await keptPty.setKeepAlive(true);
    // Hold the deadline still until the host observes the disconnect. A short
    // real timer could expire first under suite load, legitimately starting
    // crash grace instead of exercising update-hold expiry.
    t.mock.timers.enable({apis:['setTimeout']});
    await client.holdForUpdate(60_000);client.close();await disconnected;
    assert.equal(host.sessions.get(plain.id).status,'running');
    t.mock.timers.tick(60_000);
    const deadline=Date.now()+5000;while(host.sessions.get(plain.id).status!=='stopped'){if(Date.now()>deadline)throw Error('Hold expiry did not settle.');await new Promise(resolve=>setImmediate(resolve));}
    assert.equal(host.sessions.get(kept.id).status,'running');
  }finally{t.mock.timers.reset();client.close();await cleanup();}
});

test('a host without the runtime copy cannot hold; updates keep the old close-first rule',async()=>{
  const {root,cleanup}=await hostFixture();const descriptor=JSON.parse(await readFile(path.join(root,'endpoint.json'),'utf8'));delete descriptor.runtime;await writeFile(path.join(root,'endpoint.json'),JSON.stringify(descriptor));
  const client=new ExecutionClient({root});
  try{await client.init();assert.equal(client.survivesUpdates,false);await assert.rejects(client.holdForUpdate(),/cannot keep terminals/);}finally{client.close();await cleanup();}
});

test('after a crash, output and the last folder survive, and Reopen here starts a new shell there',async()=>{
  const {root,host,native,cleanup}=await hostFixture(),client=new ExecutionClient({root}),crashed=await mkdtemp(path.join(tmpdir(),'exomina-crashed-')),folder=await realpath(await mkdtemp(path.join(tmpdir(),'exomina-last-folder-')));let terminals;
  try{
    await client.init();const shell=binding(root);await client.native.spawn(null,null,{exomina:shell});
    native.fakes[0].emit('PS> npm run build\r\nbuild ok\r\n\x1b]9;9;"'+folder+'"\x07PS '+folder+'> ');
    await waitFor(async()=>{try{return JSON.parse(await readFile(path.join(root,'transcripts',shell.id.slice(4)+'.json'),'utf8')).cwd===folder;}catch{return false;}});
    // Power loss: the files stay as they were while the session was running.
    await cp(path.join(root,'session-index.json'),path.join(crashed,'session-index.json'));await cp(path.join(root,'transcripts'),path.join(crashed,'transcripts'),{recursive:true});
    const records=await new ExecutionClient({root:crashed}).existing();
    assert.equal(records[0].status,'unavailable');assert.equal(records[0].cwd,folder);assert.match(records[0].text,/build ok/);
    const spawned=fakeNative();
    terminals=new TerminalPtySessions({getContext:async()=>({workspace:root,permissionMode:'ask'}),approve:async()=>true,check:()=>{},load:async()=>spawned});
    await terminals.adopt(records,()=>{throw Error('No live proxy for a crashed host.');});
    const view=await terminals.read({conversationId:'chat',id:shell.id});assert.match(view.text,/build ok/);assert.equal(view.cwd,folder);
    // A double click sends two reopen requests before either finishes: only one shell starts.
    const clicks=await Promise.allSettled([terminals.open({conversationId:'chat',restore:shell.id}),terminals.open({conversationId:'chat',restore:shell.id})]);
    assert.equal(clicks.filter(item=>item.status==='fulfilled').length,1);assert.match(clicks.find(item=>item.status==='rejected').reason.message,/already reopened/);
    const reopened=clicks.find(item=>item.status==='fulfilled').value;await terminals.sessions.get(reopened.id).ready;assert.equal(reopened.restoredFrom,shell.id);
    await assert.rejects(terminals.open({conversationId:'chat',restore:shell.id}),/already reopened/);
    assert.equal(terminals.sessions.get(reopened.id).status,'running');assert.equal(spawned.fakes[0].options.cwd,folder);assert.equal(reopened.title,'Shell');
    await assert.rejects(terminals.open({conversationId:'chat',restore:reopened.id}),/still running/);
    await assert.rejects(terminals.open({conversationId:'chat',restore:shell.id},{owner:'agent'}),/user action/);
    await rm(folder,{recursive:true});await assert.rejects(terminals.open({conversationId:'chat',restore:shell.id}),/no longer exists/);
    // A host restarted on the crashed files also serves the saved output.
    const second=await startExecutionHost({root:crashed,endpoint:executionEndpoint(crashed),token:randomBytes(32).toString('hex'),nonce:randomUUID(),load:async()=>fakeNative(),idleMs:100_000});
    try{const saved=second.sessions.get(shell.id);assert.equal(saved.status,'unavailable');assert.match(saved.buffer,/build ok/);assert.equal(saved.cwd,folder);}finally{await second.close();}
  }finally{terminals?.close();client.close();await cleanup();await rm(crashed,{recursive:true,force:true});await rm(folder,{recursive:true,force:true});}
});

test('only running host sessions skip the update blocker; starting ones still block',async()=>{
  const terminals=new TerminalPtySessions({getContext:async()=>({workspace:tmpdir()}),approve:()=>new Promise(()=>{})});
  try{
    terminals.sessions.set('pty:a',{id:'pty:a',status:'running',pty:{remote:true}});
    terminals.sessions.set('pty:b',{id:'pty:b',status:'authorizing'});
    terminals.sessions.set('pty:c',{id:'pty:c',status:'running',pty:{remote:false}});
    assert.deepEqual(terminals.blockingIds(),['pty:a','pty:b','pty:c']);
    assert.deepEqual(terminals.blockingIds({survive:true}),['pty:b','pty:c']);
    let disposed=0,killed=0;terminals.sessions.clear();terminals.killTree=async()=>{killed++;};
    terminals.sessions.set('pty:d',{id:'pty:d',status:'running',controller:new AbortController(),disposables:[],pty:{remote:true,dispose:()=>disposed++}});
    terminals.holdForUpdate(true);terminals.close({detach:true});assert.equal(disposed,1);assert.equal(killed,0,'an update restart detaches instead of stopping');
  }finally{terminals.close();}
});

test('the prompt reports its folder and the parser reads the last report',()=>{
  assert.match(terminalShellArguments({}).at(-1),/function global:prompt/);
  assert.equal(terminalCwd('a\x1b]9;9;"C:\\one"\x07b\x1b]9;9;"D:\\two words"\x1b\\c'),'D:\\two words');
  assert.equal(terminalCwd('no report'),null);
});

test('runtime staging copies verified files once, replaces a changed copy and prunes unused ones',async()=>{
  const base=await mkdtemp(path.join(tmpdir(),'exomina-runtime-')),source=path.join(base,'source'),root=path.join(base,'host');
  try{
    await mkdir(path.join(source,'pkg'),{recursive:true});await writeFile(path.join(source,'node.exe'),'binary');await writeFile(path.join(source,'daemon.mjs'),'daemon');await writeFile(path.join(source,'pkg','index.js'),'pkg');
    const entries=[{source:path.join(source,'node.exe'),target:'node.exe'},{source:path.join(source,'daemon.mjs'),target:path.join('desktop','execution-daemon.mjs')},{source:path.join(source,'pkg','index.js'),target:path.join('node_modules','pkg','index.js')}];
    const first=await stageExecutionRuntime({root,entries});assert.match(first.runtime,/^[a-f0-9]{24}$/);assert.equal(await readFile(first.daemon,'utf8'),'daemon');
    await writeFile(first.command,'tampered');const again=await stageExecutionRuntime({root,entries});assert.equal(again.runtime,first.runtime);assert.equal(await readFile(again.command,'utf8'),'binary');
    await writeFile(path.join(source,'daemon.mjs'),'daemon v2');const next=await stageExecutionRuntime({root,entries,keep:[first.runtime]});assert.notEqual(next.runtime,first.runtime);
    assert.deepEqual((await readdir(path.join(root,'runtime'))).sort(),[first.runtime,next.runtime].sort(),'a copy the attached host uses is kept');
    await pruneExecutionRuntimes(path.join(root,'runtime'),[next.runtime]);assert.deepEqual(await readdir(path.join(root,'runtime')),[next.runtime]);
  }finally{await rm(base,{recursive:true,force:true});}
});
