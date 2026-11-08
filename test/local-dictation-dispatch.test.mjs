import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {normalizeVoice} from '../desktop/voice-settings.mjs';

const source=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8');
function dispatch(){
  const calls=[],state={visible:true,minimized:false,voiceLocked:false};
  const context={normalizeVoice,voiceLocked:false,store:{state:{settings:{voice:{dictationEngine:'whisper'}}}},
    window:{isVisible:()=>state.visible,isMinimized:()=>state.minimized},
    clientScoped:id=>id==='client-chat',clientScopes:{binding:(_kind,id)=>id==='client-project'},
    voice:{stop:()=>calls.push('stop-device'),start:()=>calls.push('start-device')},
    realtimeVoice:{stop:async()=>{}},
    localDictation:{start:async value=>calls.push({start:value}),stop:()=>{},transcribe:async value=>{calls.push({transcribe:value});return 'recognized';}}};
  const from=source.indexOf("    case 'voice.local.transcribe':"),to=source.indexOf("    case 'voice.speak':",from);
  assert.ok(from>0&&to>from);
  vm.createContext(context);vm.runInContext('async function invoke(method,payload={}){switch(method){'+source.slice(from,to)+'}}',context);
  return {context,calls,state};
}

test('actual local transcription dispatch refuses hidden, locked, unselected and client scopes before audio processing',async()=>{
  for(const change of [f=>{f.state.visible=false;},f=>{f.state.minimized=true;},f=>{f.context.voiceLocked=true;},f=>{f.context.store.state.settings.voice={};}]){
    const f=dispatch();change(f);await assert.rejects(f.context.invoke('voice.local.transcribe',{sessionId:'fixture'}));assert.equal(f.calls.length,0);
  }
  for(const scope of [{conversationId:'client-chat'},{projectId:'client-project'}]){
    const f=dispatch();await assert.rejects(f.context.invoke('voice.local.transcribe',{sessionId:'fixture',...scope}),/client-isolated adapter/);assert.equal(f.calls.length,0);
  }
  const f=dispatch(),payload={sessionId:'fixture',conversationId:'personal-chat',projectId:'personal-project',audio:'synthetic'};
  assert.equal(await f.context.invoke('voice.local.transcribe',payload),'recognized');assert.deepEqual(f.calls,[{transcribe:payload}]);
});

test('actual local dictation start rechecks lock and visibility after asynchronous voice shutdown',async()=>{
  for(const locked of [true,false]){
    const f=dispatch();f.context.realtimeVoice.stop=async()=>{if(locked)f.context.voiceLocked=true;else f.state.visible=false;};
    await assert.rejects(f.context.invoke('voice.listen',{engine:'whisper'}),/Open Exomina/);assert.equal(f.calls.length,0);
  }
  const f=dispatch();await f.context.invoke('voice.listen',{engine:'whisper',language:'de-DE',conversationId:'personal-chat',projectId:'personal-project'});
  assert.equal(f.calls[0],'stop-device');assert.equal(f.calls[1].start.conversationId,'personal-chat');assert.equal(f.calls[1].start.projectId,'personal-project');
});

test('actual client-boundary coordinator refuses changes while a local recording or decode is pending',async()=>{
  const from=source.indexOf("  if(method==='clients.createProject')"),to=source.indexOf('\n  switch(method){',from);
  assert.ok(from>0&&to>from);
  const context={active:new Map(),voice:{active:null},localDictation:{busy:true},realtimeVoice:{active:null}};
  vm.createContext(context);vm.runInContext('async function invoke(method,payload={}){'+source.slice(from,to)+'}',context);
  for(const method of ['clients.createProject','clients.manage'])await assert.rejects(context.invoke(method,{}),/Finish active replies and voice/);
});
