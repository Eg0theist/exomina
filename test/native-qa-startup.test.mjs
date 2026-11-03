import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {watchStartup} from '../scripts/native-qa-startup.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';

const fakeChild=()=>Object.assign(new EventEmitter(),{stderr:new EventEmitter()});
const pending=()=>new Promise(()=>{});
test('Electron module-load errors fail promptly before app handlers exist',async()=>{
 const child=fakeChild(),startup=watchStartup(child),waiting=startup.race(pending());
 child.stderr.emit('data',Buffer.from('App threw an error dur'));
 child.stderr.emit('data',Buffer.from('ing load\nError [ERR_MODULE_NOT_FOUND]: missing dependency\n'));
 await assert.rejects(waiting,{startupPhase:'electron.load',errorClass:'MainProcessLoadError'});
});
test('a failed process launch is reported without an unhandled error event',async()=>{
 const child=fakeChild(),startup=watchStartup(child),waiting=startup.race(pending());
 child.emit('error',Object.assign(Error('not found'),{code:'ENOENT'}));
 await assert.rejects(waiting,{startupPhase:'process.spawn',errorClass:'ENOENT'});
});
test('a real Electron load failure is caught while the app remains alive',{skip:process.platform!=='win32',timeout:15000},async()=>{
 const fixture=await mkdtemp(path.join(os.tmpdir(),'exomina-electron-load-'));
 assert.equal(path.dirname(fixture),path.resolve(os.tmpdir()));
 let child;
 try{
  const app=path.join(fixture,'app'),profile=path.join(fixture,'profile');
  await mkdir(app);await mkdir(profile);
  await writeFile(path.join(app,'package.json'),'{"name":"exomina-load-test","version":"1.0.0","type":"module","main":"main.mjs"}','utf8');
  await writeFile(path.join(app,'main.mjs'),"import './missing-module-for-load-test.mjs';\n",'utf8');
  const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
  child=spawn(createRequire(import.meta.url)('electron'),['--no-error-dialogs','--user-data-dir='+profile,app],{env:environment,windowsHide:true,stdio:['ignore','ignore','pipe']});
  const startup=watchStartup(child),started=Date.now();
  await assert.rejects(startup.race(new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Electron load failure was not detected')),6000);timer.unref();})),{startupPhase:'electron.load'});
  assert.ok(Date.now()-started<5000);assert.equal(child.exitCode,null);
 }finally{
  if(child&&child.exitCode===null)await new Promise(resolve=>{const killer=spawn(path.join(process.env.SystemRoot,'System32','taskkill.exe'),['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});killer.once('close',resolve);});
  await rm(fixture,{recursive:true,force:true});
 }
});

test('a reported startup failure stops the wait with its phase', async()=>{
 const child=fakeChild(),startup=watchStartup(child);
 const waiting=startup.race(pending());
 // The line can arrive split across chunks.
 child.stderr.emit('data',Buffer.from('[exomina-startup] phase=api.ready\n[exomina-startup] fail'));
 child.stderr.emit('data',Buffer.from('ure phase=api.ready errorClass=TypeError\n'));
 await assert.rejects(waiting,error=>error.startupPhase==='api.ready'&&error.errorClass==='TypeError'&&/phase api\.ready \(TypeError\)/.test(error.message));
 assert.throws(()=>startup.check(),/startup failure/);
});

test('an early exit stops the wait with its code', async()=>{
 const child=fakeChild(),startup=watchStartup(child);
 const waiting=startup.race(pending());
 child.emit('close',1,null);
 await assert.rejects(waiting,error=>error.exitCode===1&&/exited during startup \(code 1\)/.test(error.message));
});

test('ordinary phases do not fail and the awaited step wins', async()=>{
 const child=fakeChild(),startup=watchStartup(child);
 child.stderr.emit('data',Buffer.from('[exomina-startup] phase=startup.ready\nDevTools listening on ws://127.0.0.1:1/devtools/browser/x\n'));
 assert.equal(await startup.race(Promise.resolve('window')),'window');
 startup.check();assert.equal(startup.failure,null);
});

test('the first failure is kept when the process later exits', async()=>{
 const child=fakeChild(),startup=watchStartup(child);
 child.stderr.emit('data',Buffer.from('[exomina-startup] failure phase=stores.begin errorClass=Error\n'));
 child.emit('close',1,null);
 assert.equal(startup.failure.startupPhase,'stores.begin');
});

test('a real child that reports failure and keeps running is detected promptly', async()=>{
 // Models the app: failure line on stderr, then the process waits on its dialog.
 const child=spawn(process.execPath,['-e',"process.stderr.write('[exomina-startup] failure phase=api.ready errorClass=Error\\n');setInterval(()=>{},1000);"],{stdio:['ignore','ignore','pipe']});
 try{
  const startup=watchStartup(child),started=Date.now();
  await assert.rejects(startup.race(pending()),{startupPhase:'api.ready'});
  assert.ok(Date.now()-started<5000);
  assert.equal(child.exitCode,null,'Detection must not wait for the process to exit.');
 }finally{child.kill();}
});
