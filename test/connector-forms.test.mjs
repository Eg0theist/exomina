import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectorForms,normalizeConnectorForm,validateConnectorContent} from '../desktop/connector-forms.mjs';

const params=(properties,required=[])=>({serverName:'Synthetic connector',mode:'form',threadId:'root',turnId:'turn',message:'Choose the requested settings.',requestedSchema:{type:'object',properties,required}});
function fixture(){
  const events=[],run={message:{content:''}},runs=new Map([['chat',run]]),timers=[];
  const forms=new ConnectorForms({getRun:id=>runs.get(id),getChat:()=>({}),emit:event=>events.push(event),setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer:()=>{}});
  return {forms,events,run,runs,timers};
}

test('native primitive constraints, titled choices and list choices round trip',()=>{
  const form=normalizeConnectorForm(params({name:{type:'string',minLength:2,maxLength:12},count:{type:'integer',minimum:0,maximum:3},enabled:{type:'boolean'},choice:{type:'string',oneOf:[{const:'a',title:'First'},{const:'b',title:'Second'}]},tags:{type:'array',items:{anyOf:[{const:'x',title:'X'},{const:'y',title:'Y'}]},minItems:1,maxItems:2}},['name','count','enabled','choice','tags']));
  const answer={name:'Example',count:0,enabled:false,choice:'b',tags:['x','y']};assert.deepEqual(validateConnectorContent(form,answer),answer);
  assert.equal(form.fields[3].options[1].label,'Second');
});
test('legacy and untitled native enums are supported',()=>{
  const form=normalizeConnectorForm(params({choice:{type:'string',enum:['a','b'],enumNames:['A','B']},tags:{type:'array',items:{type:'string',enum:['x','y']}}}));
  assert.deepEqual(validateConnectorContent(form,{choice:'a',tags:['x']}),{choice:'a',tags:['x']});
});
test('OpenAI form aliases accept the same bounded flat schema',()=>{
  for(const mode of ['openai/form','openaiForm'])assert.equal(normalizeConnectorForm({...params({n:{type:'number'}}),mode}).fields[0].type,'number');
});
test('required boolean false and zero are preserved; defaults never select an answer',()=>{
  const form=normalizeConnectorForm(params({ok:{type:'boolean',default:true},n:{type:'number',default:4}},['ok','n']));
  assert.deepEqual(validateConnectorContent(form,{ok:false,n:0}),{ok:false,n:0});assert.throws(()=>validateConnectorContent(form,{}),/required/);assert.ok(form.fields.every(field=>!('default' in field)));
});
test('constraint violations and injected fields cannot return an accepted result',()=>{
  const form=normalizeConnectorForm(params({s:{type:'string',minLength:2,maxLength:4},n:{type:'integer',minimum:1,maximum:4},tags:{type:'array',items:{type:'string',enum:['a','b']},minItems:1,maxItems:2}},['s']));
  for(const value of [{s:'x'},{s:'abcde'},{s:'ok',n:2.2},{s:'ok',n:0},{s:'ok',n:Infinity},{s:'ok',tags:['a','a']},{s:'ok',tags:['z']},{s:'ok',extra:'ignored?'}])assert.throws(()=>validateConnectorContent(form,value));
  assert.throws(()=>validateConnectorContent(form,JSON.parse('{"s":"ok","__proto__":"bad"}')));
});
test('formats validate actual dates, timezone-qualified timestamps and web addresses',()=>{
  const form=normalizeConnectorForm(params({email:{type:'string',format:'email'},url:{type:'string',format:'uri'},date:{type:'string',format:'date'},time:{type:'string',format:'date-time'}}));
  assert.deepEqual(validateConnectorContent(form,{email:'qa@example.test',url:'https://example.test/path',date:'2026-10-11',time:'2026-10-11T12:30:00+02:00'}),{email:'qa@example.test',url:'https://example.test/path',date:'2026-10-11',time:'2026-10-11T12:30:00+02:00'});
  for(const value of [{email:'wrong'},{url:'javascript:alert(1)'},{url:'https://name:password@example.test'},{date:'2026-02-30'},{time:'2026-10-11T12:30:00'},{time:'2026-02-30T12:30:00Z'},{time:'2026-10-11T24:00:00Z'}])assert.throws(()=>validateConnectorContent(form,value));
});
test('unsupported nested schemas and unknown constraints fail explicitly',()=>{
  for(const field of [{type:'object',properties:{}},{type:'string',pattern:'.*'},{type:'number',multipleOf:2},{type:'string',format:'password'},{type:'array',items:{type:'string'}}])assert.throws(()=>normalizeConnectorForm(params({field})));
  assert.throws(()=>normalizeConnectorForm({...params({}),requestedSchema:{type:'object',properties:{},additionalProperties:true}}));
});
test('credentials and prototype property names are not ordinary connector fields',()=>{
  for(const name of ['api_key','access_token','Password','constructor'])assert.throws(()=>normalizeConnectorForm(params({[name]:{type:'string'}})));
});
test('oversized and contradictory schema bounds fail without displaying a form',()=>{
  assert.throws(()=>normalizeConnectorForm(params(Object.fromEntries(Array.from({length:21},(_,i)=>['field'+i,{type:'string'}])))));
  assert.throws(()=>normalizeConnectorForm(params({x:{type:'string',minLength:5,maxLength:2}})));
  assert.throws(()=>normalizeConnectorForm(params({x:{type:'number',minimum:3,maximum:2}})));
  assert.throws(()=>normalizeConnectorForm(params({x:{type:'string',enum:['a','a']}})));
  assert.throws(()=>normalizeConnectorForm(params({x:{type:'array',items:{type:'string',enum:['a']},minItems:2,maxItems:3}})));
});
test('schema string lengths count Unicode code points',()=>{
  const form=normalizeConnectorForm(params({x:{type:'string',minLength:1,maxLength:1}}));assert.deepEqual(validateConnectorContent(form,{x:'😀'}),{x:'😀'});assert.throws(()=>validateConnectorContent(form,{x:'😀😀'}));
});
test('form submission returns exact data only to the waiting request',async()=>{
  const {forms,events,run}=fixture(),promise=forms.request('chat',params({field:{type:'string'}},['field'])),request=forms.view()[0];
  assert.equal(events[0].type,'connector.form');assert.equal(forms.respond({id:request.id,action:'accept',content:{field:'SYNTHETIC_PRIVATE_ANSWER'}}).action,'accept');
  assert.deepEqual(await promise,{action:'accept',content:{field:'SYNTHETIC_PRIVATE_ANSWER'}});assert.deepEqual(forms.view(),[]);
  assert.ok(!JSON.stringify(events).includes('SYNTHETIC_PRIVATE_ANSWER'));assert.ok(!JSON.stringify(run).includes('SYNTHETIC_PRIVATE_ANSWER'));
  assert.throws(()=>forms.respond({id:request.id,action:'accept',content:{field:'again'}}),/no longer/);
});
test('invalid submission keeps its pending form available for correction',async()=>{
  const {forms}=fixture(),promise=forms.request('chat',params({n:{type:'integer'}},['n'])),id=forms.view()[0].id;
  assert.throws(()=>forms.respond({id,action:'accept',content:{n:'3'}}));assert.equal(forms.view().length,1);
  forms.respond({id,action:'decline'});assert.deepEqual(await promise,{action:'decline'});
});
test('replaced runs and ended native ownership cancel rather than accepting a late answer',async()=>{
  for(const native of [false,true]){
    const {forms,runs}=fixture();let live=true;const promise=forms.request('chat',params({x:{type:'string'}}),{isActive:()=>live}),id=forms.view()[0].id;
    if(native)live=false;else runs.set('chat',{message:{}});
    assert.throws(()=>forms.respond({id,action:'accept',content:{x:'late'}}),/ended/);assert.deepEqual(await promise,{action:'cancel'});
  }
});
test('stop and shutdown cancel every waiting form without answers',async()=>{
  for(const method of ['cancel','close']){
    const {forms,timers}=fixture(),promise=forms.request('chat',params({x:{type:'string'}}));
    if(method==='cancel')forms.cancel('chat');else forms.close();
    assert.deepEqual(await promise,{action:'cancel'});assert.deepEqual(forms.view(),[]);
  }
});
test('an unanswered form remains pending after its reminder and still requires an explicit response',async()=>{
  const {forms,timers,events}=fixture(),promise=forms.request('chat',params({ok:{type:'boolean'}},['ok'])),id=forms.view()[0].id;
  timers[0]();assert.equal(forms.view()[0].id,id);assert.equal(events.at(-1).type,'chat.notice');
  forms.respond({id,action:'accept',content:{ok:false}});assert.deepEqual(await promise,{action:'accept',content:{ok:false}});
});
test('scheduled and remote channel tasks cannot wait for local connector input',async()=>{
  for(const chat of [{background:true},{channel:{type:'telegram'}}]){const {forms}=fixture();forms.getChat=()=>chat;assert.deepEqual(await forms.request('chat',params({})),{action:'cancel'});assert.deepEqual(forms.view(),[]);}
});
test('ending a native child cancels only that thread’s form',async()=>{
  const {forms}=fixture(),a=forms.request('chat',{...params({}),threadId:'a'}),b=forms.request('chat',{...params({}),threadId:'b'});
  forms.cancelThread('a');assert.deepEqual(await a,{action:'cancel'});assert.equal(forms.view().length,1);forms.close();assert.deepEqual(await b,{action:'cancel'});
});
test('unsupported URL and device proof modes decline with a visible explanation',async()=>{
  for(const mode of ['url','openai/userVerification']){const {forms,events}=fixture();assert.deepEqual(await forms.request('chat',{...params({}),mode}),{action:'decline'});assert.match(events[0].text,/not supported/);assert.deepEqual(forms.view(),[]);}
});
