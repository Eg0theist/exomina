import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {Workers,normalizeWorker,workerInvocation} from '../desktop/workers.mjs';
import {WorkspaceTools} from '../desktop/workspace-tools.mjs';
const image='example.invalid/reviewed@sha256:'+'a'.repeat(64);
async function fixture(t,{approve=async()=>true,spawnImpl,executableCandidates}={}){
  const dir=await mkdtemp(path.join(tmpdir(),'exomina-workers-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const project=path.join(dir,'project'),data=path.join(dir,'private'),installed=path.join(dir,'installed');await mkdir(project);await mkdir(data);await mkdir(installed);
  const executables={docker:path.join(installed,'docker.exe'),ssh:path.join(installed,'ssh.exe')};for(const file of Object.values(executables))await writeFile(file,'synthetic approved runtime','utf8');
  const tools=new WorkspaceTools({dataDir:data,getSettings:()=>({workspace:project}),approve});
  const workers=new Workers({dir:path.join(data,'workers'),workspaceTools:tools,approve,spawnImpl,executableCandidates:executableCandidates||((backend)=>[executables[backend]])});await workers.init();t.after(()=>workers.close());
  return {dir,project,data,tools,workers,executables};
}
function child(){const value=new EventEmitter();value.stdout=new PassThrough();value.stderr=new PassThrough();value.kill=()=>queueMicrotask(()=>value.emit('close',null,'SIGTERM'));return value;}
test('worker configurations refuse mutable images and unsafe SSH destinations',()=>{
  for(const patch of [{backend:'docker',image:'node:latest'},{backend:'docker',image,folder:'../private'},{backend:'ssh',host:'-oProxyCommand=evil',directory:'/srv'},{backend:'ssh',host:'user@host',directory:'relative'},{backend:'ssh',host:'user@host',directory:'/srv',port:90000}])assert.throws(()=>normalizeWorker({name:'test',...patch}));
  const worker=normalizeWorker({name:'remote',backend:'ssh',host:'user@example.test',directory:"/srv/it's ok"});const invocation=workerInvocation(worker,{command:'printf approved',executable:path.resolve('installed-ssh.exe')});
  assert.ok(invocation.args.includes('StrictHostKeyChecking=yes'));assert.ok(invocation.args.includes('ForwardAgent=no'));assert.ok(invocation.args.at(-1).includes("'\\''"));
});
test('Docker invocation pins image and constrains mounts, privileges, network and resources',()=>{
  const worker=normalizeWorker({name:'isolated',backend:'docker',image}),executable=path.resolve('installed-docker.exe');const invocation=workerInvocation(worker,{command:'printf approved',cwd:'C:/project',jobName:'exomina-fixture',executable});
  assert.equal(invocation.file,executable);for(const expected of ['none','--read-only','ALL','no-new-privileges','65534:65534','--memory','--cpus','--pids-limit','never'])assert.ok(invocation.args.includes(expected),expected);
  assert.equal(invocation.args.find(arg=>arg.startsWith('type=bind')),'type=bind,source=C:/project,target=/workspace,readonly');assert.equal(invocation.args.at(-4),image);
});
test('denied worker approval cannot start a process and configuration persists',async t=>{
  let starts=0;const {workers}=await fixture(t,{approve:async()=>false,spawnImpl:()=>{starts++;throw Error('must not start');}});
  await workers.save({id:'reviewed',name:'Build',backend:'docker',image});await assert.rejects(workers.call({action:'run',id:'reviewed',command:'printf approved'},'chat'),/declined/);assert.equal(starts,0);
  const reloaded=new Workers({dir:workers.dir,workspaceTools:workers.workspaceTools,approve:workers.approve});await reloaded.init();assert.equal(reloaded.list().workers[0].image,image);
});
test('worker mount cannot include private app data and rechecks after approval',async t=>{
  const {workers,tools,dir,project}=await fixture(t);await workers.save({id:'test',name:'Test',backend:'docker',image});
  tools.getSettings=()=>({workspace:dir});await assert.rejects(workers.call({action:'run',id:'test',command:'printf approved'},'chat'),/private data/);
  tools.getSettings=()=>({workspace:project});workers.approve=async()=>{await workers.save({id:'test',name:'Changed',backend:'docker',image});return true;};await assert.rejects(workers.call({action:'run',id:'test',command:'printf approved'},'chat'),/configuration changed/);
});
test('approved SSH worker streams bounded output with clean environment and no local fallback',async t=>{
  const calls=[];const {workers,executables}=await fixture(t,{spawnImpl:(file,args,options)=>{calls.push({file,args,options});const process=child();queueMicrotask(()=>{process.stdout.write('Grüße remote');process.emit('close',0,null);});return process;}});
  await workers.save({id:'remote',name:'Remote',backend:'ssh',host:'user@example.test',directory:'/srv/project'});
  const previous=process.env.EXOMINA_SYNTHETIC_TOKEN;process.env.EXOMINA_SYNTHETIC_TOKEN='private';try{const result=await workers.call({action:'run',id:'remote',command:'printf approved'},'chat');assert.equal(result.exitCode,0);assert.equal(result.output,'Grüße remote');assert.equal(calls[0].file,executables.ssh);assert.equal(calls[0].options.env.EXOMINA_SYNTHETIC_TOKEN,undefined);assert.equal(calls[0].options.shell,false);}finally{if(previous===undefined)delete process.env.EXOMINA_SYNTHETIC_TOKEN;else process.env.EXOMINA_SYNTHETIC_TOKEN=previous;}
  workers.spawnImpl=()=>{const process=child();queueMicrotask(()=>process.emit('error',Object.assign(Error('not installed'),{code:'ENOENT'})));return process;};await assert.rejects(workers.call({action:'run',id:'remote',command:'printf approved'},'chat'),/not installed/);assert.equal(workers.running.size,0);
});
test('cancelled Docker jobs remove only their generated container name',async t=>{
  const calls=[];let running;const {workers}=await fixture(t,{spawnImpl:(file,args)=>{calls.push({file,args});const value=child();if(args.includes('run'))running=value;return value;}});
  await workers.save({id:'docker',name:'Build',backend:'docker',image});const task=workers.call({action:'run',id:'docker',command:'sleep 20'},'chat');while(!running)await new Promise(resolve=>setImmediate(resolve));workers.cancel('chat');const result=await task;assert.equal(result.cancelled,true);const cleanup=calls.find(call=>call.args.includes('rm'));assert.match(cleanup.args.at(-1),/^exomina-[a-f0-9-]{36}$/);assert.equal(workers.running.size,0);
});

test('worker runtime resolution ignores project-local executables and revalidates the approved binding',async t=>{
  const calls=[];const f=await fixture(t,{spawnImpl:(file,args)=>{calls.push({file,args});const value=child();queueMicrotask(()=>value.emit('close',0,null));return value;}});
  await writeFile(path.join(f.project,'docker.exe'),'untrusted project runtime','utf8');
  await f.workers.save({id:'docker',name:'Build',backend:'docker',image});
  let shown;f.workers.approve=async request=>{shown=JSON.parse(request.detail);return true;};
  await f.workers.call({action:'run',id:'docker',command:'printf approved'},'chat');
  assert.equal(calls[0].file,f.executables.docker);assert.equal(shown.invocation.file,f.executables.docker);assert.ok(path.isAbsolute(calls[0].file));
  f.workers.approve=async()=>{await writeFile(f.executables.docker,'changed after approval','utf8');return true;};
  await assert.rejects(f.workers.call({action:'run',id:'docker',command:'printf approved'},'chat'),/executable changed/);assert.equal(calls.length,1);
  f.workers.executableCandidates=()=>[path.join(f.project,'docker.exe')];
  await assert.rejects(f.workers.call({action:'run',id:'docker',command:'printf approved'},'chat'),/outside the workspace/);assert.equal(calls.length,1);
  f.workers.executableCandidates=()=>[path.join(f.dir,'missing.exe')];
  await assert.rejects(f.workers.call({action:'run',id:'docker',command:'printf approved'},'chat'),/not installed/);assert.equal(calls.length,1);
});

test('parallel approvals cannot exceed per-chat or global worker admission',async t=>{
  const spawned=[],approvals=[];const f=await fixture(t,{approve:request=>new Promise(resolve=>approvals.push({request,resolve})),spawnImpl:()=>{const value=child();spawned.push(value);return value;}});
  await f.workers.save({id:'remote',name:'Remote',backend:'ssh',host:'user@example.test',directory:'/srv/project'});
  const same=[f.workers.call({action:'run',id:'remote',command:'printf one'},'same'),f.workers.call({action:'run',id:'remote',command:'printf two'},'same')];
  const settled=Promise.allSettled(same);
  while(approvals.length<2)await new Promise(resolve=>setImmediate(resolve));for(const approval of approvals)approval.resolve(true);
  while(spawned.length<1)await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(spawned.length,1);spawned[0].emit('close',0,null);
  const first=await settled;assert.equal(first.filter(result=>result.status==='fulfilled').length,1);assert.match(first.find(result=>result.status==='rejected').reason.message,/already has/);
  approvals.length=0;spawned.length=0;
  const jobs=Promise.allSettled(Array.from({length:4},(_,index)=>f.workers.call({action:'run',id:'remote',command:'printf approved'},'chat-'+index)));
  while(approvals.length<4)await new Promise(resolve=>setImmediate(resolve));for(const approval of approvals)approval.resolve(true);
  while(spawned.length<3)await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setTimeout(resolve,25));assert.equal(spawned.length,3);for(const value of spawned)value.emit('close',0,null);
  const result=await jobs;assert.equal(result.filter(item=>item.status==='fulfilled').length,3);assert.match(result.find(item=>item.status==='rejected').reason.message,/Three worker/);
});

test('independent output pipe failures reject and stop worker jobs without an unhandled error',async t=>{
  let running;const f=await fixture(t,{spawnImpl:()=>{running=child();return running;}});
  await f.workers.save({id:'remote',name:'Remote',backend:'ssh',host:'user@example.test',directory:'/srv/project'});
  const task=f.workers.call({action:'run',id:'remote',command:'printf approved'},'chat');
  const rejected=assert.rejects(task,/output failed: Synthetic pipe failure/);
  while(!running)await new Promise(resolve=>setImmediate(resolve));running.stdout.emit('error',Error('Synthetic pipe failure'));await rejected;
  assert.equal(f.workers.running.size,0);assert.doesNotThrow(()=>running.stderr.emit('error',Error('Late pipe failure')));
});

test('Docker cleanup refuses an executable changed after job startup',async t=>{
  const calls=[];let running;const f=await fixture(t,{spawnImpl:(file,args)=>{calls.push({file,args});running=child();return running;}});
  await f.workers.save({id:'docker',name:'Build',backend:'docker',image});const task=f.workers.call({action:'run',id:'docker',command:'sleep 20'},'chat');
  while(!running)await new Promise(resolve=>setImmediate(resolve));await writeFile(f.executables.docker,'unapproved replacement','utf8');f.workers.cancel('chat');
  const result=await task;assert.equal(result.cancelled,true);assert.match(result.cleanupError,/approved executable/);assert.equal(calls.length,1);
});
