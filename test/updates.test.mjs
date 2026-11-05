import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Updater,readStamp,STAMP,canPromoteInstalledSource} from '../desktop/updates.mjs';
import {readUpdateState,writeUpdateState} from '../desktop/update-state.mjs';
import {PermissionPolicy,hostAction} from '../desktop/permissions.mjs';

async function layout({installed,staged,shipped=true}={}){
  const home=await mkdtemp(path.join(tmpdir(),'exomina-update-'));
  const appDir=path.join(home,'App'),resourcesDir=path.join(appDir,'resources'),build=path.join(home,'Source','release','win-unpacked'),stateDir=path.join(home,'state');
  await mkdir(build,{recursive:true});await mkdir(path.join(resourcesDir,'app.asar.unpacked','desktop'),{recursive:true});await mkdir(path.join(resourcesDir,'app.asar.unpacked','scripts'),{recursive:true});
  if(shipped){await writeFile(path.join(resourcesDir,'app.asar.unpacked','desktop','update-runner.ps1'),'');await writeFile(path.join(resourcesDir,'app.asar.unpacked','scripts','install-windows.ps1'),'');}
  if(installed)await writeFile(path.join(appDir,STAMP),JSON.stringify(installed));
  if(staged){await writeFile(path.join(build,STAMP),JSON.stringify(staged));await writeFile(path.join(build,'Exomina.exe'),'');}
  const calls=[];
  const updater=new Updater({packaged:true,appDir,home,resourcesDir,stateDir,exePath:path.join(appDir,'Exomina.exe'),powershell:'powershell.exe',isProcessAlive:()=>true,readyTimeoutMs:500,spawnImpl:(command,args,options)=>{calls.push({command,args,options});const child=new EventEmitter();child.pid=1234;child.unref=()=>{};child.kill=()=>{};writeFile(path.join(stateDir,'update-ready.json'),JSON.stringify({attemptId:args[args.indexOf('-AttemptId')+1],pid:child.pid}));return child;}});
  return {home,stateDir,build,updater,calls,cleanup:()=>rm(home,{recursive:true,force:true})};
}
const A={id:'aaaaaaaa-1111',version:'0.4.0',builtAt:'2026-10-01T10:00:00.000Z'},B={id:'bbbbbbbb-2222',version:'0.4.0',builtAt:'2026-10-06T10:00:00.000Z'};

test('a differently stamped packaged build is an available update', async()=>{
  const t=await layout({installed:A,staged:B});
  try{const status=await t.updater.status();assert.equal(status.supported,true);assert.equal(status.available,true);assert.equal(status.staged.id,B.id);assert.equal(status.autoBlocked,false);assert.equal(status.inProgress,false);}
  finally{await t.cleanup();}
});

test('the same build, a missing stamp or a dev copy is not an update', async()=>{
  let t=await layout({installed:A,staged:A});try{assert.equal((await t.updater.status()).available,false);}finally{await t.cleanup();}
  t=await layout({installed:A});try{assert.equal((await t.updater.status()).available,false);}finally{await t.cleanup();}
  t=await layout({installed:A,staged:B,shipped:false});try{const s=await t.updater.status();assert.equal(s.supported,false);assert.match(s.reason,/install-windows\.ps1/);}finally{await t.cleanup();}
  const dev=new Updater({packaged:false});assert.equal((await dev.status()).supported,false);
});

test('rejects malformed stamps', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'exomina-stamp-'));
  try{await writeFile(path.join(dir,STAMP),JSON.stringify({id:'../../x'}));assert.equal(await readStamp(dir),null);}
  finally{await rm(dir,{recursive:true,force:true});}
});

test('local update notes survive stamp reading and updater selection with a size bound',async()=>{
  const t=await layout({installed:A,staged:{...B,version:'0.6.2',notes:'Improved conversational learning.\nAutomatic patch versions.'}});
  try{
    assert.equal((await t.updater.status()).staged.notes,'Improved conversational learning.\nAutomatic patch versions.');
    await writeFile(path.join(t.build,STAMP),JSON.stringify({...B,notes:'x'.repeat(10020)}));
    assert.equal((await readStamp(t.build)).notes.length,10000);
    await writeFile(path.join(t.build,STAMP),JSON.stringify({...B,notes:{untrusted:'not text'}}));
    assert.equal((await readStamp(t.build)).notes,undefined);
  }finally{await t.cleanup();}
});

test('launch awaits the hidden shipped runner, records it, and blocks a second runner', async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    await t.updater.launch({conversationId:'chat-1'});
    assert.equal(t.calls.length,1);const {args,options}=t.calls[0];
    assert.equal(options.detached,true);assert.equal(options.windowsHide,true);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE,'1');
    assert.equal(t.calls[0].command,path.join(t.build,'Exomina.exe'));
    assert.ok(args[0].endsWith('update-launcher.cjs'));
    assert.ok(!args.includes('Bypass'));
    assert.ok(args[args.indexOf('-File')+1].endsWith(path.join('app.asar.unpacked','desktop','update-runner.ps1')));
    // The elevated installer comes from the protected App folder, never from Source.
    assert.ok(args[args.indexOf('-Installer')+1].startsWith(path.join(t.home,'App')));
    assert.equal(args[args.indexOf('-Build')+1],t.build);assert.equal(args[args.indexOf('-BuildId')+1],B.id);
    const pending=JSON.parse(await readFile(path.join(t.stateDir,'pending-update.json'),'utf8'));assert.equal(pending.conversationId,'chat-1');
    assert.equal((await t.updater.status()).inProgress,true);
    const other=new Updater({...t.updater,resourcesDir:path.join(t.home,'App','resources'),spawnImpl:()=>{throw Error('second runner');}});
    await other.launch();
  }finally{await t.cleanup();}
});

test('an abandoned pending record does not block startup or trigger an automatic retry',async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    await mkdir(t.stateDir,{recursive:true});
    await writeFile(path.join(t.stateDir,'pending-update.json'),JSON.stringify({buildId:B.id,startedAt:new Date().toISOString()}));
    const s=await t.updater.status();assert.equal(s.inProgress,false);assert.equal(s.autoBlocked,true);assert.equal(s.lastResult.status,'failed');
    assert.equal((await t.updater.takeResult()).status,'failed');
  }finally{await t.cleanup();}
});

test('a runner that exits successfully without executing is a failed handoff',async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    t.updater.spawnImpl=()=>{const child=new EventEmitter();child.kill=()=>{};queueMicrotask(()=>child.emit('exit',0));return child;};
    await assert.rejects(t.updater.launch(),/exited before it was ready/);
    const s=await t.updater.status();assert.equal(s.inProgress,false);assert.equal(s.autoBlocked,true);assert.equal(t.updater.launched,false);
  }finally{await t.cleanup();}
});

test('spawn errors and missing acknowledgement keep the app open',async()=>{
  for(const mode of ['error','timeout']){
    const t=await layout({installed:A,staged:B});
    try{
      t.updater.readyTimeoutMs=60;
      t.updater.spawnImpl=()=>{const child=new EventEmitter();child.kill=()=>{};if(mode==='error')queueMicrotask(()=>child.emit('error',Object.assign(Error('missing'),{code:'ENOENT'})));return child;};
      await assert.rejects(t.updater.launch(),mode==='error'?/ENOENT/:/did not confirm startup/);
      assert.equal((await t.updater.status()).inProgress,false);assert.equal((await t.updater.status()).autoBlocked,true);
    }finally{await t.cleanup();}
  }
});

test('a launcher failure keeps its specific diagnostic instead of replacing it with an exit code',async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    t.updater.spawnImpl=(command,args)=>{
      const child=new EventEmitter();child.pid=1234;child.kill=()=>{};
      const attemptId=args[args.indexOf('-AttemptId')+1];
      writeFile(path.join(t.stateDir,'last-update.json'),JSON.stringify({attemptId,buildId:B.id,status:'failed',message:'Windows retained the launching application job.',finishedAt:new Date().toISOString()})).then(()=>child.emit('exit',1));
      return child;
    };
    await assert.rejects(t.updater.launch(),/Windows retained the launching application job/);
    assert.equal((await t.updater.status()).lastResult.message,'Windows retained the launching application job.');
  }finally{await t.cleanup();}
});

test('a dead acknowledged runner is recoverable immediately',async()=>{
  const t=await layout({installed:A,staged:B});
  try{await t.updater.launch();t.updater.isProcessAlive=()=>false;const s=await t.updater.status();assert.equal(s.inProgress,false);assert.equal(s.autoBlocked,true);}
  finally{await t.cleanup();}
});

test('delayed readiness survives concurrent status checks and coalesces launches',async()=>{
  const t=await layout({installed:A,staged:B});let acknowledge;
  try{
    t.updater.spawnImpl=(command,args,options)=>{
      t.calls.push({command,args,options});const child=new EventEmitter();child.pid=1234;child.unref=()=>{};child.kill=()=>{};
      acknowledge=()=>writeFile(path.join(t.stateDir,'update-ready.json'),JSON.stringify({attemptId:args[args.indexOf('-AttemptId')+1],pid:child.pid}));return child;
    };
    const first=t.updater.launch(),second=t.updater.launch();assert.equal(first,second);
    while(!acknowledge)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal((await t.updater.status()).inProgress,true);
    const other=new Updater({...t.updater,resourcesDir:path.join(t.home,'App','resources'),spawnImpl:()=>assert.fail('Duplicate updater started')});
    assert.equal((await other.status()).inProgress,true);await other.launch();
    assert.equal((await t.updater.status()).lastResult,null);
    await acknowledge();await first;assert.equal(t.calls.length,1);
    assert.equal((await t.updater.status()).inProgress,true);
  }finally{await t.cleanup();}
});

test('simultaneous handoffs from separate updater instances start only one supervisor',async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    const other=new Updater({...t.updater,resourcesDir:path.join(t.home,'App','resources')});
    await Promise.all([t.updater.launch(),other.launch()]);assert.equal(t.calls.length,1);
    assert.equal((await other.status()).inProgress,true);
  }finally{await t.cleanup();}
});

test('concurrent state readers and separate handoffs preserve one live supervisor',async()=>{
  for(let round=0;round<30;round++){
    const t=await layout({installed:A,staged:B});let stopped=false;
    const file=path.join(t.stateDir,'pending-update.json');
    const readers=Array.from({length:8},async()=>{while(!stopped)await readUpdateState(file);});
    try{
      const other=new Updater({...t.updater,resourcesDir:path.join(t.home,'App','resources')});
      await Promise.all([t.updater.launch(),other.launch()]);
      assert.equal(t.calls.length,1,`round ${round}`);
      assert.equal((await other.status()).inProgress,true);
      assert.equal((await other.status()).lastResult,null);
      const pending=await readUpdateState(file);
      assert.equal(pending.phase,'ready');assert.equal(pending.ready,true);
    }finally{stopped=true;await Promise.all(readers);await t.cleanup();}
  }
});

test('concurrent initial state claims have one winner and preserve its complete record',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'exomina-update-claim-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'pending-update.json');
  const results=await Promise.allSettled(Array.from({length:20},(_,id)=>writeUpdateState(file,{id},{claim:true})));
  const winner=results.findIndex(value=>value.status==='fulfilled');
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);
  assert.ok(results.filter(value=>value.status==='rejected').every(value=>value.reason.code==='EEXIST'));
  assert.deepEqual(await readUpdateState(file),{id:winner});
  assert.deepEqual(await readdir(directory),['pending-update.json']);
});

test('temporary cleanup failure cannot invalidate a successfully published update claim',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'exomina-update-claim-'));
  const file=path.join(directory,'pending-update.json');
  try{
    t.mock.method(fs,'rm',async()=>{throw Object.assign(Error('Scanner holds temporary'),{code:'EPERM'});});
    await writeUpdateState(file,{attemptId:'our-claim'},{claim:true});
    assert.deepEqual(await readUpdateState(file),{attemptId:'our-claim'});
    await assert.rejects(writeUpdateState(file,{attemptId:'another-claim'},{claim:true}),{code:'EEXIST'});
    assert.deepEqual(await readUpdateState(file),{attemptId:'our-claim'});
  }finally{t.mock.restoreAll();await rm(directory,{recursive:true,force:true});}
});

async function holdUpdateFile(file){
  const script=path.join(path.dirname(file),'hold-file.ps1');
  await writeFile(script,`param([string]$Target)
$ErrorActionPreference = 'Stop'
$handle = [IO.File]::Open($Target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [Console]::Out.WriteLine('locked')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally { $handle.Dispose() }
`,'utf8');
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawn(powershell,['-NoProfile','-NonInteractive','-File',script,'-Target',file],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let diagnostic='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{diagnostic+=chunk;});
  const closed=new Promise(resolve=>child.once('close',resolve));
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Native file lock did not become ready. '+diagnostic)),5000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);reject(Error(`Native lock exited (${code}): ${diagnostic}`));});
      child.stdout.setEncoding('utf8');let output='';
      child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('locked')){clearTimeout(timer);resolve();}});
    });
  }catch(error){child.kill();await closed;throw error;}
  let released=false;
  return async()=>{if(released)return;released=true;child.stdin.end('release\n');assert.equal(await closed,0,diagnostic);};
}

test('a brief native Windows read lock delays replacement without removing the original claim',{skip:process.platform!=='win32',timeout:15000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'exomina-update-lock-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'pending-update.json');
  await writeUpdateState(file,{phase:'starting'},{claim:true});
  const release=await holdUpdateFile(file);let completed=false;
  const result=writeUpdateState(file,{phase:'ready'}).then(()=>{completed=true;return null;},error=>{completed=true;return error;});
  try{
    await delay(75);assert.equal(completed,false);
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{phase:'starting'});
    // A competing claim must still fail while the replacement is waiting.
    await assert.rejects(writeFile(file,'{}',{flag:'wx'}),{code:'EEXIST'});
    await release();assert.equal(await result,null);
    assert.deepEqual(await readUpdateState(file),{phase:'ready'});
    assert.deepEqual((await readdir(directory)).sort(),['hold-file.ps1','pending-update.json']);
  }finally{await release();await result;}
});

test('a lasting native Windows lock fails within the retry bound and preserves state',{skip:process.platform!=='win32',timeout:15000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'exomina-update-lock-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'pending-update.json');
  await writeUpdateState(file,{phase:'starting'},{claim:true});
  const release=await holdUpdateFile(file);
  try{
    const started=Date.now();
    await assert.rejects(writeUpdateState(file,{phase:'ready'}),error=>['EPERM','EACCES','EBUSY'].includes(error.code));
    assert.ok(Date.now()-started<5000,'A lasting lock must not wait indefinitely.');
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{phase:'starting'});
    assert.deepEqual((await readdir(directory)).sort(),['hold-file.ps1','pending-update.json']);
  }finally{await release();}
  // A failed operation cannot poison the per-file queue.
  await writeUpdateState(file,{phase:'ready'});
  assert.deepEqual(await readUpdateState(file),{phase:'ready'});
});

test('an acknowledged live updater remains active after four minutes',async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    await t.updater.launch();const file=path.join(t.stateDir,'pending-update.json'),pending=JSON.parse(await readFile(file,'utf8'));
    pending.startedAt=new Date(Date.now()-30*60*1000).toISOString();await writeFile(file,JSON.stringify(pending));
    const status=await t.updater.status();assert.equal(status.inProgress,true);assert.equal(status.lastResult,null);assert.equal(status.autoBlocked,false);
    assert.equal(JSON.parse(await readFile(file,'utf8')).attemptId,pending.attemptId);
  }finally{await t.cleanup();}
});

test('a relayed supervisor can acknowledge after its bootstrap exits successfully',async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    t.updater.spawnImpl=(command,args,options)=>{
      t.calls.push({command,args,options});const child=new EventEmitter();child.pid=1234;child.unref=()=>{};child.kill=()=>{};
      queueMicrotask(()=>child.emit('exit',0));
      setTimeout(()=>writeFile(path.join(t.stateDir,'update-ready.json'),JSON.stringify({attemptId:args[args.indexOf('-AttemptId')+1],pid:child.pid,supervisorPid:5678,runnerPid:6789})),80);
      return child;
    };
    t.updater.isProcessAlive=pid=>pid===5678||pid===process.pid;
    await t.updater.launch();const pending=JSON.parse(await readFile(path.join(t.stateDir,'pending-update.json'),'utf8'));
    assert.equal(pending.pid,5678);assert.equal(pending.bootstrapPid,1234);assert.equal((await t.updater.status()).inProgress,true);
  }finally{await t.cleanup();}
});

test('a matching live elevated installer blocks retry after its runner disappears',async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    await t.updater.launch();const pending=JSON.parse(await readFile(path.join(t.stateDir,'pending-update.json'),'utf8'));
    const progress={attemptId:pending.attemptId,buildId:B.id,installerPid:9876,phase:'verifying',verifiedFiles:10,totalFiles:30,updatedAt:new Date().toISOString()};
    await writeFile(path.join(t.stateDir,'install-progress.json'),JSON.stringify(progress));
    await writeFile(path.join(t.stateDir,'last-update.json'),JSON.stringify({buildId:B.id,attemptId:pending.attemptId,status:'failed',message:'A previous updater notice.'}));
    t.updater.isProcessAlive=pid=>pid===9876;
    let status=await t.updater.status();assert.equal(status.inProgress,true);assert.equal(status.lastResult,null);assert.equal(status.autoBlocked,false);
    await rm(path.join(t.stateDir,'pending-update.json'));
    status=await t.updater.status();assert.equal(status.inProgress,true);assert.equal(status.lastResult,null);
    const other=new Updater({...t.updater,resourcesDir:path.join(t.home,'App','resources'),spawnImpl:()=>assert.fail('Installer retry started')});
    await other.launch();assert.equal(t.calls.length,1);
  }finally{await t.cleanup();}
});

test('a live watcher keeps an installer active when progress is absent, unreadable or lacks its PID',async()=>{
  for(const progressMode of ['absent','unreadable','no-pid']){
    const t=await layout({installed:A,staged:B});
    try{
      await t.updater.launch();const pending=JSON.parse(await readFile(path.join(t.stateDir,'pending-update.json'),'utf8'));
      const watcher={attemptId:pending.attemptId,buildId:B.id,installerPid:9876,phase:'installing',updatedAt:new Date().toISOString()};
      await writeFile(path.join(t.stateDir,'update-watcher.json'),JSON.stringify(watcher));
      if(progressMode==='unreadable')await writeFile(path.join(t.stateDir,'install-progress.json'),'{partial');
      if(progressMode==='no-pid')await writeFile(path.join(t.stateDir,'install-progress.json'),JSON.stringify({...watcher,installerPid:0,phase:'starting'}));
      t.updater.isProcessAlive=pid=>pid===9876;
      assert.equal((await t.updater.status()).inProgress,true,progressMode);
      await rm(path.join(t.stateDir,'pending-update.json'));
      const other=new Updater({...t.updater,resourcesDir:path.join(t.home,'App','resources'),spawnImpl:()=>assert.fail('Live watcher allowed another installer')});
      assert.equal((await other.status()).inProgress,true,progressMode);await other.launch();
    }finally{await t.cleanup();}
  }
});

test('mismatched and dead watcher records cannot keep a crashed handoff active',async()=>{
  for(const mismatch of ['attempt','build','dead','terminal']){
    const t=await layout({installed:A,staged:B});
    try{
      await t.updater.launch();const pending=JSON.parse(await readFile(path.join(t.stateDir,'pending-update.json'),'utf8'));
      const watcher={attemptId:pending.attemptId,buildId:B.id,installerPid:9876,phase:'installing',updatedAt:new Date().toISOString()};
      if(mismatch==='attempt')watcher.attemptId='11111111-2222-3333-4444-555555555555';
      if(mismatch==='build')watcher.buildId=A.id;
      if(mismatch==='terminal')watcher.phase='failed';
      await writeFile(path.join(t.stateDir,'update-watcher.json'),JSON.stringify(watcher));
      t.updater.isProcessAlive=pid=>mismatch!=='dead'&&pid===9876;
      const status=await t.updater.status();assert.equal(status.inProgress,false,mismatch);assert.equal(status.lastResult.attemptId,pending.attemptId);
    }finally{await t.cleanup();}
  }
});

test('mismatched and dead installer progress cannot keep a crashed handoff active',async()=>{
  for(const mismatch of ['attempt','build','dead','terminal','done']){
    const t=await layout({installed:A,staged:B});
    try{
      await t.updater.launch();const pending=JSON.parse(await readFile(path.join(t.stateDir,'pending-update.json'),'utf8'));
      const progress={attemptId:pending.attemptId,buildId:B.id,installerPid:9876,phase:'verifying',updatedAt:new Date().toISOString()};
      if(mismatch==='attempt')progress.attemptId='11111111-2222-3333-4444-555555555555';
      if(mismatch==='build')progress.buildId=A.id;
      if(mismatch==='terminal')progress.phase='installed';
      if(mismatch==='done')progress.phase='done';
      await writeFile(path.join(t.stateDir,'install-progress.json'),JSON.stringify(progress));
      t.updater.isProcessAlive=pid=>mismatch!=='dead'&&pid===9876;
      const status=await t.updater.status();assert.equal(status.inProgress,false,mismatch);assert.equal(status.lastResult.attemptId,pending.attemptId);assert.equal(status.autoBlocked,true);
    }finally{await t.cleanup();}
  }
});

test('a live watcher protects the interval after installer progress reaches done',async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    await t.updater.launch();const pending=JSON.parse(await readFile(path.join(t.stateDir,'pending-update.json'),'utf8'));
    const record={attemptId:pending.attemptId,buildId:B.id,installerPid:9876,updatedAt:new Date().toISOString()};
    await writeFile(path.join(t.stateDir,'install-progress.json'),JSON.stringify({...record,phase:'done'}));
    await writeFile(path.join(t.stateDir,'update-watcher.json'),JSON.stringify({...record,phase:'installing'}));
    t.updater.isProcessAlive=pid=>pid===9876;
    assert.equal((await t.updater.status()).inProgress,true);
    await rm(path.join(t.stateDir,'pending-update.json'));
    assert.equal((await t.updater.status()).inProgress,true);
  }finally{await t.cleanup();}
});

test('stale pending state preserves the concrete outcome for the same attempt',async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    await t.updater.launch();const pending=JSON.parse(await readFile(path.join(t.stateDir,'pending-update.json'),'utf8'));
    const result={buildId:B.id,attemptId:pending.attemptId,status:'failed',message:'Copy verification failed for resources/app.asar.',finishedAt:new Date().toISOString()};
    await writeFile(path.join(t.stateDir,'last-update.json'),JSON.stringify(result));t.updater.isProcessAlive=()=>false;
    const status=await t.updater.status();assert.deepEqual(status.lastResult,result);
    assert.deepEqual(JSON.parse(await readFile(path.join(t.stateDir,'last-update.json'),'utf8')),result);
  }finally{await t.cleanup();}
});

test('provisional startup is not a user-facing success and an orphaned verification fails honestly',async()=>{
  const t=await layout({installed:A,staged:B});try{
    await t.updater.launch();const pending=JSON.parse(await readFile(path.join(t.stateDir,'pending-update.json'),'utf8'));
    await writeFile(path.join(t.stateDir,'last-update.json'),JSON.stringify({buildId:B.id,attemptId:pending.attemptId,status:'verifying-startup'}));
    assert.equal(await t.updater.takeResult(),null);
    t.updater.isProcessAlive=()=>false;const status=await t.updater.status();assert.equal(status.lastResult.status,'failed');assert.equal(status.autoBlocked,true);
  }finally{await t.cleanup();}
});

async function startupHandoff(t){
  await mkdir(t.stateDir,{recursive:true});
  const record={attemptId:'12345678-1234-4234-8234-123456789012',buildId:B.id};
  const now=Date.now(),token='a'.repeat(32);
  const files={
    'pending-update.json':{...record,pid:1234,ready:true,startedAt:new Date(now).toISOString()},
    'update-ready.json':{attemptId:record.attemptId,pid:1234},
    'update-watcher.json':{...record,installerPid:5678,phase:'verifying-startup',updatedAt:new Date(now).toISOString()},
    'last-update.json':{...record,status:'verifying-startup'},
    'install-report.json':{...record,ok:true,programCleanup:{...record,pid:5678,monitored:true,token}},
    'program-cleanup-pending.json':{...record,schema:1,token,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+180000).toISOString()},
  };
  const save=()=>Promise.all(Object.entries(files).map(([name,value])=>writeFile(path.join(t.stateDir,name),JSON.stringify(value))));
  await save();return {files,save};
}

test('the installed candidate opens during its live health handoff while another installer stays blocked',async()=>{
  const t=await layout({installed:B,staged:B});
  try{
    await startupHandoff(t);
    const status=await t.updater.status();
    assert.equal(status.inProgress,true);assert.equal(status.verifyingStartup,true);
    assert.equal(status.lastResult,null,'The live helper must not produce an installed success notice.');
    await writeFile(path.join(t.build,STAMP),JSON.stringify({...B,id:'cccccccc-3333',version:'0.4.1'}));
    await t.updater.launch();assert.equal(t.calls.length,0);
    assert.ok(await readUpdateState(path.join(t.stateDir,'pending-update.json')));
  }finally{await t.cleanup();}
});

test('copying, old builds and invalid or stale handoffs never bypass the startup wait',async()=>{
  for(const scenario of ['old-build','copying','phase','attempt','build','control-attempt','unmonitored','token','expired','future','duration','dead-helper','recovery-path']){
    const t=await layout({installed:scenario==='old-build'?A:B,staged:B});
    try{
      const {files,save}=await startupHandoff(t),report=files['install-report.json'],challenge=files['program-cleanup-pending.json'];
      if(scenario==='copying'){files['last-update.json'].status='installing';files['update-watcher.json'].phase='installing';report.ok=false;}
      if(scenario==='phase'){files['last-update.json'].status='installing';files['update-watcher.json'].phase='installing';}
      if(scenario==='attempt')report.attemptId='87654321-1234-4234-8234-123456789012';
      if(scenario==='build')report.buildId=A.id;
      if(scenario==='control-attempt')report.programCleanup.attemptId='87654321-1234-4234-8234-123456789012';
      if(scenario==='unmonitored')report.programCleanup.monitored=false;
      if(scenario==='token')challenge.token='b'.repeat(32);
      if(scenario==='expired'){challenge.createdAt=new Date(Date.now()-200000).toISOString();challenge.expiresAt=new Date(Date.now()-1000).toISOString();}
      if(scenario==='future')challenge.createdAt=new Date(Date.now()+10000).toISOString();
      if(scenario==='duration')challenge.expiresAt=new Date(Date.now()+300000).toISOString();
      if(scenario==='dead-helper')t.updater.isProcessAlive=pid=>pid!==5678;
      if(scenario==='recovery-path')t.updater.appDir=path.join(t.home,'Recovery');
      await save();const status=await t.updater.status();
      assert.equal(status.inProgress,true,scenario);assert.equal(status.verifyingStartup,false,scenario);
    }finally{await t.cleanup();}
  }
});

test('Source promotion requires positive startup success for the installed build',()=>{
  const good={inProgress:false,installed:B,lastResult:{buildId:B.id,status:'installed'}};
  assert.equal(canPromoteInstalledSource(good),true);
  for(const status of ['verifying-startup','failed','rolled-back','recovery-opened','installed-unverified'])assert.equal(canPromoteInstalledSource({...good,lastResult:{buildId:B.id,status}}),false,status);
  assert.equal(canPromoteInstalledSource({...good,inProgress:true}),false);
  assert.equal(canPromoteInstalledSource({...good,inProgress:undefined}),false);
  assert.equal(canPromoteInstalledSource({...good,lastResult:null}),false);
  assert.equal(canPromoteInstalledSource({...good,lastResult:{buildId:A.id,status:'installed'}}),false);
  assert.equal(canPromoteInstalledSource(null),false);
});

test('Windows casing differences preserve both handoff recognition and health acknowledgement',{skip:process.platform!=='win32'},async()=>{
  const t=await layout({installed:B,staged:B});
  try{
    await startupHandoff(t);t.updater.home=t.home.toUpperCase();
    assert.equal((await t.updater.status()).verifyingStartup,true);
    assert.equal(await t.updater.confirmStartup({pid:1234,rendererPid:6789}),true);
    assert.equal((await readUpdateState(path.join(t.stateDir,'program-cleanup-health.json'))).buildId,B.id);
  }finally{await t.cleanup();}
});

test('a completed handoff whose runner disappeared allows an explicit retry',async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    await t.updater.launch();t.updater.isProcessAlive=()=>false;
    assert.equal((await t.updater.status()).inProgress,false);
    t.updater.isProcessAlive=()=>true;await t.updater.launch();assert.equal(t.calls.length,2);
    assert.equal((await t.updater.status()).inProgress,true);
  }finally{await t.cleanup();}
});

test('a declined or failed build is not retried automatically, and its result is shown once', async()=>{
  const t=await layout({installed:A,staged:B});
  try{
    await mkdir(t.stateDir,{recursive:true});await writeFile(path.join(t.stateDir,'last-update.json'),JSON.stringify({buildId:B.id,status:'declined',message:'No approval.'}));
    assert.equal((await t.updater.status()).autoBlocked,true);
    assert.equal((await t.updater.takeResult()).status,'declined');assert.equal(await t.updater.takeResult(),null);
    assert.equal((await t.updater.status()).autoBlocked,true);
    await writeFile(path.join(t.build,STAMP),JSON.stringify({...B,id:'cccccccc-3333'}));
    assert.equal((await t.updater.status()).autoBlocked,false);
  }finally{await t.cleanup();}
});

test('restarting to update always asks, even in Full access or with an allow rule', ()=>{
  const settings={permissionMode:'full',permissionRules:[{effect:'allow',tool:'app_*',match:''}]};
  const policy=new PermissionPolicy({getSettings:()=>settings});
  assert.equal(policy.evaluate(hostAction('app_restart_to_update')).decision,'ask');
  settings.permissionMode='read-only';
  assert.equal(policy.evaluate(hostAction('app_restart_to_update')).decision,'ask');
  assert.equal(policy.evaluate(hostAction('app_update_status')).decision,'allow');
  settings.permissionRules=[{effect:'deny',tool:'app_restart_to_update',match:''}];
  assert.equal(policy.evaluate(hostAction('app_restart_to_update')).decision,'deny');
});
