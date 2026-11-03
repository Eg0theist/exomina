import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createGateway} from '../desktop/gateway.mjs';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {assertNativeScope} from '../desktop/native-tool-scope.mjs';

test('shared bridge capabilities bind both conversation and exact run; revoked or old tokens never revive',async()=>{
 const runs=new Map([['a',{}],['b',{}]]),calls=[];
 const gateway=await createGateway({getRun:id=>runs.get(id),isActive:id=>runs.has(id),definitions:()=>[],callTool:async(name,args,id)=>{calls.push({name,args,id});return {content:[]};}});
 try{
  assert.equal(gateway.token,undefined);assert.throws(()=>gateway.forConversation('missing'),/no active run/);
  const a=gateway.forConversation('a'),b=gateway.forConversation('b');assert.notEqual(a.token,b.token);
  const post=(lease,id)=>fetch(gateway.url,{method:'POST',headers:{Authorization:'Bearer '+lease.token},body:JSON.stringify({method:'tools/call',conversationId:id,params:{name:'synthetic',arguments:{}}})});
  assert.equal((await post(a,'b')).status,400);assert.equal(calls.length,0);
  assert.equal((await post(a,'a')).status,200);assert.equal(calls[0].id,'a');
  runs.set('a',{});assert.equal((await post(a,'a')).status,403);
  const next=gateway.forConversation('a');assert.equal((await post(next,'a')).status,200);next.revoke();assert.equal((await post(next,'a')).status,403);
  runs.delete('b');assert.equal((await post(b,'b')).status,403);assert.equal(calls.length,2);
 }finally{gateway.close();}
});

test('bridge preserves split UTF-8 and rechecks the run after reading a request',async()=>{
 const runs=new Map([['a',{}]]),seen=[],gateway=await createGateway({getRun:id=>runs.get(id),isActive:id=>runs.has(id),definitions:()=>[],callTool:async(_name,args)=>{seen.push(args.value);return {content:[]};}});
 try{
  const lease=gateway.forConversation('a');
  const body=Buffer.from(JSON.stringify({method:'tools/call',conversationId:'a',params:{name:'synthetic',arguments:{value:'Grüße 世界'}}}));
  const split=body.indexOf(Buffer.from('ü'))+1;
  const send=change=>new Promise((resolve,reject)=>{const request=http.request(gateway.url,{method:'POST',headers:{Authorization:'Bearer '+lease.token}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});request.on('error',reject);request.write(body.subarray(0,split));setTimeout(()=>{change?.();request.end(body.subarray(split));},20);});
  assert.equal(await send(),200);assert.deepEqual(seen,['Grüße 世界']);
  assert.equal(await send(()=>runs.set('a',{})),400);assert.equal(seen.length,1);
 }finally{gateway.close();}
});

test('an approval started by an old bridge run cannot authorize work in the next run',async()=>{
 let run={},release,entered;const ready=new Promise(resolve=>entered=resolve),approval=new Promise(resolve=>release=resolve);let performed=0;
 const gateway=await createGateway({getRun:()=>run,isActive:()=>true,definitions:()=>[],callTool:async(_name,_args,_id,scope)=>{assertNativeScope(scope);entered();await approval;assertNativeScope(scope);performed++;return {content:[]};}});
 try{const lease=gateway.forConversation('a'),request=fetch(gateway.url,{method:'POST',headers:{Authorization:'Bearer '+lease.token},body:JSON.stringify({method:'tools/call',conversationId:'a',params:{name:'synthetic'}})});await ready;run={};release();assert.equal((await request).status,400);assert.equal(performed,0);}finally{release();gateway.close();}
});
test('gateway denies unauthenticated, cross-origin and inactive requests before tool execution',async()=>{
 let calls=0;const gateway=await createGateway({definitions:()=>[],callTool:()=>{calls++},isActive:id=>id==='active'});
 try{
  const post=headers=>fetch(gateway.url,{method:'POST',headers,body:JSON.stringify({method:'tools/call',conversationId:'inactive',params:{name:'test'}})});
  assert.equal((await post({})).status,403);assert.equal((await post({Authorization:'Bearer '+gateway.token,Origin:'https://bad.test'})).status,403);
  assert.equal((await post({Authorization:'Bearer '+gateway.token})).status,400);assert.equal(calls,0);
 }finally{gateway.close()}
});
test('real MCP stdio bridge initializes, lists and calls an app tool without a model',async()=>{
 const gateway=await createGateway({definitions:()=>[{name:'synthetic',inputSchema:{type:'object'}}],callTool:async(_n,a)=>({content:[{type:'text',text:a.value}]}),isActive:id=>id==='test'});
 const child=spawn(process.execPath,[fileURLToPath(new URL('../desktop/mcp-stdio.mjs',import.meta.url))],{env:{...process.env,EXOMINA_TOOL_GATEWAY:gateway.url,EXOMINA_TOOL_TOKEN:gateway.token,EXOMINA_TOOL_CONVERSATION:'test'},stdio:['pipe','pipe','pipe'],windowsHide:true});
 try{
  const results=[];let pending='',id=0;const request=(method,params={})=>new Promise((resolve,reject)=>{
   const rid=++id;const timer=setTimeout(()=>reject(Error('MCP timeout')),5000);results[rid]=r=>{clearTimeout(timer);resolve(r)};child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:rid,method,params})+'\n');
  });
  child.stdout.on('data',b=>{pending+=b;let i;while((i=pending.indexOf('\n'))>=0){const r=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);results[r.id]?.(r)}});
  assert.equal((await request('initialize')).result.serverInfo.name,'exomina');
  assert.equal((await request('tools/list')).result.tools[0].name,'synthetic');
  assert.equal((await request('tools/call',{name:'synthetic',arguments:{value:'passed'}})).result.content[0].text,'passed');
 }finally{child.kill();gateway.close()}
});
