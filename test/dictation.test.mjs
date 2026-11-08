import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDictation,dictationVocabularies,appendDictationText,recoverDictationText} from '../desktop/dictation.mjs';
import {normalizeVoice,patchVoice} from '../desktop/voice-settings.mjs';
import {VoiceSession} from '../src/voice-session.js';

const settings={dictationMode:'minimal',dictationVocabularies:[{projectId:'alpha',terms:['Exomina','Hamburg','Überfluss']},{projectId:'beta',terms:['EXOMINA']}]};

test('raw is default and cleanup preserves lexical tokens, numbers and German/English negations',()=>{
  const raw='exomina   does not send 1,250.50 EUR, nie ohne 3 approvals';
  assert.equal(prepareDictation(raw,{},'alpha').text,raw);
  const prepared=prepareDictation(raw,settings,'alpha');
  assert.equal(prepared.text,'Exomina does not send 1,250.50 EUR, nie ohne 3 approvals');
  assert.equal(prepared.original,raw);assert.equal(prepared.changed,true);
  assert.equal(prepared.text.toLocaleLowerCase('en-US').replace(/\s+/g,' '),raw.toLocaleLowerCase('en-US').replace(/\s+/g,' '));
  assert.equal(prepareDictation('mehr überfluss',settings,'alpha').text,'mehr Überfluss');
});

test('project vocabulary never leaks between projects and makes no fuzzy substitutions',()=>{
  assert.equal(prepareDictation('exomina hamburg',settings,'alpha').text,'Exomina Hamburg');
  assert.equal(prepareDictation('exomina hamburg',settings,'beta').text,'EXOMINA hamburg');
  assert.equal(prepareDictation('exomina hamburg',settings,'').text,'exomina hamburg');
  assert.equal(prepareDictation('ex nomina',settings,'alpha').text,'ex nomina');
  assert.equal(prepareDictation('exomina', {...settings,dictationMode:'raw'},'alpha').text,'exomina');
});

test('command syntax, quoted strings and paths skip cleanup entirely',()=>{
  for(const text of ['exomina   --dry-run 3','copy C:\\some  folder','curl https://example.test','keep "a  b" exactly',"printf 'a  b'",'`exomina   run`','release /opt/exomina']){
    const result=prepareDictation(text,settings,'alpha');assert.equal(result.text,text);assert.equal(result.protectedSyntax,true);assert.equal(result.changed,false);
  }
  const long='exomina  '.repeat(2000);assert.equal(prepareDictation(long,settings,'alpha').text,long.trim());
});

test('vocabulary patches preserve other projects and reject executable/negation entries',()=>{
  const first=normalizeVoice(settings),result=patchVoice(first,{dictationVocabulary:{projectId:'alpha',terms:['EXomina']}});
  assert.deepEqual(result.dictationVocabularies.find(item=>item.projectId==='beta'),{projectId:'beta',terms:['EXOMINA']});
  assert.equal(patchVoice(result,{dictationVocabulary:{projectId:'alpha',terms:[]}}).dictationVocabularies.length,1);
  for(const terms of [['not'],['NICHT'],['C:\\path'],['123'],[null],['a'.repeat(65)],Array.from({length:41},()=> 'Exomina')])assert.throws(()=>patchVoice(first,{dictationVocabulary:{projectId:'alpha',terms}}),/Preferred spelling/);
  assert.throws(()=>patchVoice(first,{dictationVocabulary:{projectId:'../escape',terms:[]}}),/Invalid project/);
  assert.deepEqual(dictationVocabularies([{projectId:'alpha',terms:['Exomina','exomina','not','3','run --shell']}]),[{projectId:'alpha',terms:['Exomina']}]);
});

function fixture(){
  let currentText='Typed beginning';const states=[],sent=[],calls=[],current={conversationId:'chat',projectId:'alpha',settings};
  const session=new VoiceSession({invoke:async(method,payload)=>{calls.push({method,payload});return {sessionId:'live',language:'de-DE'};},current:()=>current,update:state=>states.push(state),draft:text=>{const before=currentText;currentText=appendDictationText(before,text);return {before,after:currentText};},recoverDraft:(receipt,original)=>{currentText=recoverDictationText(currentText,receipt,original);},send:text=>sent.push(text)});
  return {session,current,states,sent,calls,get text(){return currentText;},edit:value=>{currentText=value;},transcript:text=>session.receive({type:'voice.event',sessionId:'live',event:{type:'transcript',text}})};
}

test('dictation exposes original and restores only its unchanged draft without sending',async()=>{
  const f=fixture();await f.session.start('dictation');f.transcript('exomina   bleibt ohne 5 changes');
  assert.deepEqual(f.calls.find(call=>call.method==='voice.listen').payload,{language:''});
  assert.equal(f.text,'Typed beginning Exomina bleibt ohne 5 changes');assert.equal(f.states.at(-1).dictation.original,'exomina   bleibt ohne 5 changes');
  await f.session.stop();f.session.recoverOriginal();assert.equal(f.text,'Typed beginning exomina   bleibt ohne 5 changes');
  assert.equal(f.states.at(-1).dictation.restored,true);assert.deepEqual(f.sent,[]);
});

test('manual edits or sending prevents original restoration and navigation drops recognition',async()=>{
  const f=fixture();await f.session.start('dictation');f.transcript('exomina   works');await f.session.stop();
  f.edit('My later edit');f.session.recoverOriginal();assert.equal(f.text,'My later edit');assert.match(f.states.at(-1).dictation.error,/draft changed/);
  f.edit('');f.session.recoverOriginal();assert.equal(f.text,'');
  f.session.scopeChanged('other-chat','chat');assert.equal(f.states.at(-1).dictation,null);
});

test('stale speech cannot replace the original or append after a stop',async()=>{
  const f=fixture();await f.session.start('dictation');f.transcript('exomina   works');await f.session.stop();
  f.transcript('secret after stop');assert.equal(f.text,'Typed beginning Exomina works');
  f.session.dismissDictation();assert.equal(f.states.at(-1).dictation,null);assert.deepEqual(f.sent,[]);
});

test('changing project stops dictation and drops its original before another project is used',async()=>{
  const f=fixture();await f.session.start('dictation');f.transcript('exomina   works');
  f.current.projectId='beta';f.session.scopeChanged('chat','chat','beta');
  assert.equal(f.session.mode,'');assert.equal(f.states.at(-1).dictation,null);f.transcript('wrong scope');assert.equal(f.text,'Typed beginning Exomina works');
});
