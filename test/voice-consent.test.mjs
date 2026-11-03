import test from 'node:test';
import assert from 'node:assert/strict';
import {AiVoiceConsent,AI_VOICE_DISCLOSURE,persistAiVoiceAcknowledgment,voiceContextGuard} from '../desktop/voice-consent.mjs';
import {AI_VOICE_ACKNOWLEDGMENT,normalizeVoice,patchVoice} from '../desktop/voice-settings.mjs';
import {beginSettingsTransaction} from '../desktop/runtime-settings-transaction.mjs';
import {chooseDeviceSpeech} from '../src/companion-voice.js';

test('AI voice acknowledgment explicitly covers microphone and enabled chat memory/project context and persists once',async()=>{
 let settings={},prompts=0,writes=0;const gate=new AiVoiceConsent({read:()=>settings,confirm:async disclosure=>{prompts++;assert.equal(disclosure.defaultId,0);assert.match(disclosure.message,/microphone audio and chat context/);assert.match(disclosure.detail,/memories when enabled/);assert.match(disclosure.detail,/project instructions/);return true;},save:async version=>{writes++;settings=patchVoice(settings,{aiVoiceAcknowledged:version});}});
 assert.equal(await gate.ensure(),true);assert.equal(settings.aiVoiceAcknowledged,AI_VOICE_ACKNOWLEDGMENT);assert.equal(await gate.ensure(),true);assert.equal(prompts,1);assert.equal(writes,1);
 assert.equal(patchVoice(settings,{companionMode:'device'}).aiVoiceAcknowledged,1);assert.equal(normalizeVoice({aiVoiceAcknowledged:true}).aiVoiceAcknowledged,undefined);assert.equal(normalizeVoice({aiVoiceAcknowledged:2}).aiVoiceAcknowledged,undefined);
});
test('declining, Stop or eligibility loss during AI voice disclosure does not persist or arm voice',async()=>{
 for(const action of ['decline','stop','scope']){
  let release,valid=true,writes=0,prepared=0;const wait=new Promise(resolve=>release=resolve),gate=new AiVoiceConsent({read:()=>({}),confirm:()=>wait,save:async()=>{writes++;}});
  const starting=(async()=>{if(await gate.ensure({isCurrent:()=>valid}))prepared++;})();
  assert.equal(prepared,0);assert.equal(await gate.ensure(),false);
  if(action==='stop')gate.cancel();if(action==='scope')valid=false;release(action!=='decline');await starting;
  assert.equal(writes,0);assert.equal(prepared,0);
 }
});
test('AI voice persistence failure or Stop during save cannot arm capture',async()=>{
 for(const failure of [true,false]){
  let release,prepared=0;const wait=new Promise(resolve=>release=resolve),gate=new AiVoiceConsent({read:()=>({}),confirm:async()=>true,save:async()=>{if(failure)throw Error('Synthetic save failure');await wait;}});
  const starting=(async()=>{if(await gate.ensure())prepared++;})();
  if(failure)await assert.rejects(starting,/save failure/);else{await new Promise(resolve=>setImmediate(resolve));gate.cancel();release();await starting;}
  assert.equal(prepared,0);
 }
 assert.ok(AI_VOICE_DISCLOSURE.detail.includes('microphone stays off'));
});
test('pending acknowledgment cannot authorize a second start and failed persistence preserves concurrent voice choices',async()=>{
 const settings={voice:{realtimeVoice:'vale'}},saved=[];let rejectSave,calls=0;
 const save=new Promise((_,reject)=>rejectSave=reject);
 const gate=new AiVoiceConsent({read:()=>settings.voice,confirm:async()=>true,save:version=>persistAiVoiceAcknowledgment({settings,version,persist:async()=>{calls++;if(calls===1)await save;saved.push(structuredClone(settings));}})});
 const first=gate.ensure();await new Promise(resolve=>setImmediate(resolve));assert.equal(settings.voice.aiVoiceAcknowledged,1);assert.equal(await gate.ensure(),false);
 const other=beginSettingsTransaction(settings,{voicePatch:{companionMode:'device'}});settings.voice=patchVoice(settings.voice,{companionMode:'device'});other.commit();
 rejectSave(Error('Synthetic disk failure'));await assert.rejects(first,/disk failure/);
 assert.equal(settings.voice.aiVoiceAcknowledged,undefined);assert.equal(settings.voice.companionMode,'device');assert.equal(settings.voice.realtimeVoice,'vale');assert.equal(saved[0].voice.aiVoiceAcknowledged,undefined);
});
test('voice context cannot cross a memory-sharing, project, private-chat, deletion or Stop change during asynchronous reads',async()=>{
 for(const change of ['memory','project','private','deleted','stopped']){
  let scope={memoryEnabled:true,projectInstructions:'fixture'},valid=true,sent=0,release;const pending=new Promise(resolve=>release=resolve);
  const check=voiceContextGuard({eligible:()=>{if(!valid)throw Error('Ineligible voice context');},policy:()=>scope});
  const preparation=(async()=>{await pending;check();sent++;})();
  if(change==='memory')scope.memoryEnabled=false;else if(change==='project')scope.projectInstructions='changed';else valid=false;
  release();await assert.rejects(preparation,/changed|Ineligible/);assert.equal(sent,0);
 }
});
test('explicit device recovery checks capability and persists the choice before capture',async()=>{
 const calls=[],current=()=>({page:'chat',conversationId:'chat',provider:'claude',running:false});let settings={realtimeVoice:'vale'};
 await chooseDeviceSpeech({current,invoke:async(method,payload)=>{calls.push(method);if(method==='voice.status')return {available:true,voices:[{id:'fixture'}]};settings=patchVoice(settings,payload.voicePatch);},start:async mode=>{assert.equal(settings.companionMode,'device');assert.equal(mode,'conversation');calls.push('capture');}});
 assert.deepEqual(calls,['voice.status','settings.save','capture']);assert.equal(settings.realtimeVoice,'vale');
});
test('device recovery never silently starts after missing capability, failed persistence or a changed chat',async()=>{
 for(const problem of ['unavailable','save','scope','stopped']){
  const scope={page:'chat',conversationId:'chat',provider:'claude',running:false};let captured=0,allowed=true;
  await assert.rejects(chooseDeviceSpeech({current:()=>({...scope}),allowed:()=>allowed,invoke:async method=>{if(method==='voice.status'){if(problem==='scope')scope.conversationId='different';if(problem==='stopped')allowed=false;return {available:problem!=='unavailable',voices:[{}]};}if(problem==='save')throw Error('Synthetic save failed');},start:()=>captured++}));assert.equal(captured,0);
 }
});
