import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,rm,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LocalDictation,extractDictationRuntime,installLocalDictation} from '../desktop/dictation-local.mjs';
import {normalizeVoice,patchVoice} from '../desktop/voice-settings.mjs';
import {VoiceSession} from '../src/voice-session.js';
import {DictationRecorder} from '../src/dictation-recorder.js';

function fixture({verify=async()=>{}}={}){
  const calls=[],events=[],children=[];
  const service=new LocalDictation({root:path.join(os.tmpdir(),'synthetic-local-dictation'),platform:'win32',arch:'x64',verifyImpl:verify,emit:value=>events.push(value),spawnImpl(executable,args,options){
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;return true;};calls.push({executable,args,options});children.push(child);return child;
  }});return {service,calls,events,children};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('optional recognizer preserves Windows default and renderer chooses local only for dictation',async()=>{
  assert.equal(normalizeVoice({}).dictationEngine,undefined);assert.equal(patchVoice({}, {dictationEngine:'whisper'}).dictationEngine,'whisper');assert.equal(patchVoice({dictationEngine:'whisper'}, {dictationEngine:'windows'}).dictationEngine,undefined);
  const calls=[],session=new VoiceSession({current:()=>({conversationId:'c',projectId:'p',settings:{dictationEngine:'whisper',language:'de-DE'}}),update(){},draft(){},invoke:async(method,payload)=>{calls.push({method,payload});return {sessionId:'s'};}});
  await session.start('dictation');assert.deepEqual(calls.at(-1).payload,{language:'de-DE',engine:'whisper',conversationId:'c',projectId:'p'});await session.stop();
  await session.start('conversation');assert.deepEqual(calls.at(-1).payload,{language:'de-DE'});await session.stop();
});

test('local startup validates before opening microphone and Stop cancels pending validation',async()=>{
  let release,entered;const verifying=new Promise(resolve=>entered=resolve),f=fixture({verify:()=>new Promise(resolve=>{release=resolve;entered();})}),pending=f.service.start();await verifying;assert.equal(f.service.starting,true);assert.equal(f.calls.length,0);
  await assert.rejects(f.service.install(),/Stop local dictation/);f.service.stop();release();await assert.rejects(pending,/stopped/);assert.equal(f.calls.length,0);assert.equal(f.service.busy,false);
});

const recorded=()=>{const recorder=new DictationRecorder();recorder.append(new Float32Array(16000).fill(0.05),16000);return recorder.finish();};
test('finite local capture opens no native microphone, transcribes once and binds exact scope',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'local-dictation-finite-')),f=fixture();f.service.root=root;
  try{const run=await f.service.start({language:'de-DE',conversationId:'c'});assert.equal(f.calls.length,0);assert.equal(run.capture,true);assert.equal(f.service.mediaAllowed(),true);
    await assert.rejects(f.service.transcribe({sessionId:run.sessionId,wav:recorded(),conversationId:'other'}),/session changed/);
    const pending=f.service.transcribe({sessionId:run.sessionId,wav:recorded(),conversationId:'c'});while(!f.children.length)await tick();const child=f.children[0];
    assert.equal(f.service.mediaAllowed(),false);assert.equal(f.calls[0].options.shell,false);assert.equal(f.calls[0].options.windowsHide,true);assert.equal(f.calls[0].args.includes('--no-gpu'),true);assert.equal(f.calls[0].executable.endsWith('whisper-cli.exe'),true);
    child.stdout.write('Do not ');child.stdout.write('send this.');child.emit('close',0);assert.deepEqual(await pending,{text:'Do not send this.'});assert.equal(f.events.some(value=>value.event.type==='transcript'),false);
    assert.deepEqual(await readdir(root),[]);f.service.stop();assert.equal(f.service.busy,false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('stale Stop cannot stop newer armed capture and cancelled transcription returns no text',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'local-dictation-cancel-')),f=fixture();f.service.root=root;
  try{const a=await f.service.start(),b=await f.service.start();assert.deepEqual(f.service.stop(a.sessionId),{stopped:false});assert.equal(f.service.active.sessionId,b.sessionId);
    const pending=f.service.transcribe({sessionId:b.sessionId,wav:recorded()});const rejected=assert.rejects(pending,/stopped/);while(!f.children.length)await tick();f.service.stop(b.sessionId);assert.equal(f.children[0].killed,true);f.children[0].emit('close',0);await rejected;assert.equal(f.service.busy,false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('unsupported languages and platforms never launch microphone or download',async()=>{
  const f=fixture();await assert.rejects(f.service.start({language:'$(bad)'}),/English or German/);assert.equal(f.calls.length,0);
  const other=new LocalDictation({root:'unused',platform:'linux',arch:'x64',spawnImpl(){throw Error('must not launch');}});await assert.rejects(other.start(),/Windows x64/);assert.equal((await other.status()).supported,false);
});

test('download integrity failure writes no installed marker and removes partial',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'exomina-dictation-integrity-'));
  try{await assert.rejects(installLocalDictation(root,{platform:'win32',arch:'x64',fetchImpl:async()=>new Response('broken archive')}),/integrity/);assert.deepEqual(await readdir(root),[]);await assert.rejects(readFile(path.join(root,'installed.json'),'utf8'));}finally{await rm(root,{recursive:true,force:true});}
  assert.throws(()=>extractDictationRuntime(Buffer.from('not a ZIP')),/Invalid/);
});

test('close disarms capture and refuses future launches',async()=>{
  const f=fixture();await f.service.start();assert.equal(f.service.mediaAllowed(),true);f.service.close();assert.equal(f.service.mediaAllowed(),false);assert.equal(f.calls.length,0);await assert.rejects(f.service.start(),/closed/);
});

test('recorder downsampling and finish retain one finite clip and cancellation releases input',async()=>{
  let stopped=0,release;const late=new DictationRecorder({mediaDevices:{getUserMedia:()=>new Promise(resolve=>release=resolve)},AudioContextImpl:function(){}}),pending=late.start();late.cancel();release({getTracks:()=>[{stop(){stopped++;}}]});await assert.rejects(pending,/cancelled/);assert.equal(stopped,1);
  const recorder=new DictationRecorder();recorder.append(new Float32Array(48000).fill(0.5),48000);const wav=Buffer.from(recorder.finish(),'base64');assert.equal(wav.length,32044);assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.readUInt32LE(40),32000);assert.throws(()=>recorder.finish(),/cancelled/);
});

test('finite dictation appends after explicit finish once and never sends a message',async()=>{
  const calls=[],drafts=[],states=[];let released=0;
  const session=new VoiceSession({current:()=>({conversationId:'c',settings:{dictationEngine:'whisper'}}),update:value=>states.push(value),draft:text=>drafts.push(text),send:()=>assert.fail('must not send'),capture:()=>({start:async()=>{},finish:()=>recorded(),cancel:()=>released++}),invoke:async(method,payload)=>{calls.push({method,payload});if(method==='voice.listen')return {sessionId:'s',capture:true};if(method==='voice.local.transcribe')return {text:'One complete utterance.'};return {};}});
  await session.start('dictation');assert.deepEqual(drafts,[]);await session.finishDictation();await session.finishDictation();assert.deepEqual(drafts,['One complete utterance.']);assert.equal(calls.filter(row=>row.method==='voice.local.transcribe').length,1);assert.equal(session.mode,'');assert.ok(states.some(row=>row.phase==='transcribing'));
});

test('startup removes only recognized orphan recordings and preserves unrelated files',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'local-dictation-orphan-'));
  try{
    await mkdir(path.join(root,'capture-ABC123'));await writeFile(path.join(root,'capture-ABC123/input.wav'),'synthetic raw bytes','utf8');
    await mkdir(path.join(root,'capture-DEF456'));await writeFile(path.join(root,'capture-DEF456/unrelated.txt'),'keep','utf8');await writeFile(path.join(root,'owner.txt'),'keep','utf8');
    await new LocalDictation({root,platform:'win32',arch:'x64'}).status();
    assert.deepEqual((await readdir(root)).sort(),['capture-DEF456','owner.txt']);assert.equal(await readFile(path.join(root,'capture-DEF456/unrelated.txt'),'utf8'),'keep');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('completed finite transcription cannot enter a changed chat or project before navigation effect runs',async()=>{
  for(const change of ['conversationId','projectId']){
    const current={conversationId:'c',projectId:'p',settings:{dictationEngine:'whisper'}},drafts=[],calls=[];let release;
    const session=new VoiceSession({current:()=>current,update(){},draft:text=>drafts.push(text),capture:()=>({start:async()=>{},finish:()=>recorded(),cancel(){}}),invoke:async(method,payload)=>{calls.push({method,payload});if(method==='voice.listen')return {sessionId:'s',capture:true};if(method==='voice.local.transcribe')return new Promise(resolve=>release=resolve);return {};}});
    await session.start('dictation');const pending=session.finishDictation();current[change]='changed';release({text:'Must stay in the original scope.'});await pending;
    assert.deepEqual(drafts,[]);assert.equal(session.mode,'');assert.equal(calls.at(-1).method,'voice.stop');
  }
});

test('unsupported low-rate audio fails closed and releases microphone rather than mislabelling duration',async()=>{
  let stopped=0,closed=0;
  const recorder=new DictationRecorder({mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>stopped++}]})},AudioContextImpl:class{constructor(){this.sampleRate=8000;}close(){closed++;return Promise.resolve();}}});
  await assert.rejects(recorder.start(),/16 kHz/);assert.equal(stopped,1);assert.equal(closed,1);assert.equal(recorder.closed,true);
  assert.throws(()=>new DictationRecorder().append(new Float32Array(8000),8000),/sample rate/);
});
