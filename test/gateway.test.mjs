import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createGateway} from '../desktop/gateway.mjs';
import {fileURLToPath} from 'node:url';
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
