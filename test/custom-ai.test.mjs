import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {ApiConnections,connectionEndpoint} from '../desktop/api-connections.mjs';
import {ApiAgent} from '../desktop/api-agent.mjs';
import {getProvider} from '../desktop/provider-catalog.mjs';
import {fallbackTargets} from '../desktop/model-preferences.mjs';
import {Store} from '../desktop/store.mjs';

const encryption={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from('encrypted:'+text),decryptString:bytes=>bytes.toString().slice(10)};
const custom=getProvider('custom-api');
async function fixture(t,fetchImpl){
  const directory=await mkdtemp(path.join(os.tmpdir(),'exomina-custom-ai-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const connections=new ApiConnections({dataDir:directory,encryption,fetchImpl});await connections.init();
  return {connections,directory};
}
const reply=text=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});

test('own-server endpoint accepts loopback and HTTPS, normalizes roots and rejects unsafe addresses',()=>{
  assert.equal(connectionEndpoint(custom,'http://localhost:1234/'),'http://localhost:1234/v1');
  assert.equal(connectionEndpoint(custom,'https://EXAMPLE.com/api/v1/'),'https://example.com/api/v1');
  assert.equal(connectionEndpoint(custom,'http://[::1]:11434/v1'),'http://[::1]:11434/v1');
  for(const address of ['http://remote.example/v1','http://192.168.1.2:1234/v1','https://user:password@remote.example/v1','https://remote.example/v1?key=secret','https://remote.example/v1#secret','file:///tmp/model','https://remote.example/v1/chat/completions','https://remote.example/v1/models'])assert.throws(()=>connectionEndpoint(custom,address));
  assert.throws(()=>connectionEndpoint(getProvider('openai-api'),'https://other.example/v1'),/documented endpoints/);
});

test('local setup is keyless, persists capabilities, and survives ordinary chat saves',async t=>{
  const {connections,directory}=await fixture(t);
  const result=await connections.configure({provider:'custom-api',baseUrl:'http://127.0.0.1:1234',model:'local/model:latest'});
  assert.equal(result.configured,true);assert.equal(result.hasKey,false);assert.equal(result.local,true);
  assert.equal(result.supportsTools,false);assert.equal(result.supportsImages,false);assert.equal(result.maxOutputTokens,2048);
  const reopened=new ApiConnections({dataDir:directory,encryption});await reopened.init();
  assert.equal((await reopened.getConnection('custom-api')).model,'local/model:latest');
  const store=new Store(directory,{workspace:path.join(directory,'workspace')});await store.init();
  store.state.settings.provider='custom-api';const chat=store.create('custom-api');await store.save();
  assert.equal(store.conversation(chat.id).provider,'custom-api');assert.equal(store.state.settings.provider,'custom-api');
  await assert.rejects(connections.configure({provider:'custom-api',model:'m',maxOutputTokens:0}),/reply length/);
  await assert.rejects(connections.configure({provider:'custom-api',model:'m',supportsTools:'yes'}),/capabilities/);
  await connections.disconnect('custom-api');assert.equal(connections.status().find(item=>item.id==='custom-api').configured,false);
});

test('hosted setup requires billing consent but permits services without authentication',async t=>{
  const {connections}=await fixture(t);
  const input={provider:'custom-api',baseUrl:'https://hosted.example/v1',model:'hosted-model'};
  await assert.rejects(connections.configure(input),/billing/);
  await connections.configure({...input,allowPaidApi:true,supportsTools:true,supportsImages:true,maxOutputTokens:1024});
  const connection=await connections.getConnection('custom-api');
  assert.equal(connection.apiKey,'');assert.equal(connection.optionalKey,true);assert.equal(connection.supportsTools,true);
  let dispatched;
  const agent=new ApiAgent({getConnection:()=>connection,fetchImpl:async(url,options)=>{dispatched={url,options};return reply('Hosted reply');}});
  assert.equal((await agent.run({provider:'custom-api',conversationId:'hosted',prompt:'Hello'})).text,'Hosted reply');
  assert.equal(dispatched.url,'https://hosted.example/v1/chat/completions');assert.equal(dispatched.options.headers.Authorization,undefined);
  assert.equal(JSON.parse(dispatched.options.body).max_tokens,1024);
});

test('keys stay encrypted and cannot move to a different destination without explicit action',async t=>{
  const {connections,directory}=await fixture(t);
  await connections.configure({provider:'custom-api',baseUrl:'https://one.example/v1',model:'m',apiKey:'fixture-private-key',allowPaidApi:true});
  const status=connections.status().find(item=>item.id==='custom-api');assert.equal(status.hasKey,true);assert.ok(!JSON.stringify(status).includes('fixture-private-key'));
  assert.ok(!(await readFile(path.join(directory,'api-connections.json'),'utf8')).includes('"fixture-private-key"'));
  // The fake encryption is reversible in tests; production uses OS safeStorage.
  assert.equal((await connections.getConnection('custom-api')).apiKey,'fixture-private-key');
  await assert.rejects(connections.configure({provider:'custom-api',baseUrl:'https://two.example/v1',model:'m',allowPaidApi:true}),/Re-enter/);
  await assert.rejects(connections.models({provider:'custom-api',baseUrl:'https://two.example/v1'}),/new destination/);
  assert.equal((await connections.getConnection('custom-api')).baseUrl,'https://one.example/v1');
  await connections.configure({provider:'custom-api',baseUrl:'https://two.example/v1',model:'m',removeKey:true,allowPaidApi:true});
  assert.equal((await connections.getConnection('custom-api')).apiKey,'');
  assert.equal(connections.status().find(item=>item.id==='custom-api').hasKey,false);
  connections.encryption.isEncryptionAvailable=()=>false;
  await assert.rejects(connections.configure({provider:'custom-api',model:'m',apiKey:'not-saved',allowPaidApi:true}),/encryption/);
});

test('model discovery is metadata-only, bounded and never follows a redirect',async t=>{
  const calls=[];
  const {connections}=await fixture(t,async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({data:[null,{id:'model-a'}, {id:'model-a'}, {id:'bad id'}, {id:'auto'}, {id:'model-b',display_name:'Model B'}]}));});
  const result=await connections.models({provider:'custom-api',baseUrl:'http://localhost:1234',apiKey:'fixture-discovery-key'});
  assert.deepEqual(result.models,[{id:'model-a',label:'model-a'},{id:'model-b',label:'Model B'}]);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'http://localhost:1234/v1/models');
  assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.body,undefined);
  assert.equal(calls[0].options.headers.Authorization,'Bearer fixture-discovery-key');
  assert.ok(!JSON.stringify(result).includes('fixture-discovery-key'));
  connections.fetchImpl=async()=>new Response('no',{status:404});
  await assert.rejects(connections.models({provider:'custom-api',baseUrl:'http://localhost:1234/v1'}),/enter a model ID manually/);
});

test('a real local server receives streaming chat and a tool result through the existing dispatcher',async t=>{
  const requests=[],toolCalls=[],events=[];
  const server=http.createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;
    requests.push({url:request.url,authorization:request.headers.authorization,body:raw?JSON.parse(raw):undefined});
    if(request.url==='/v1/models'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:[{id:'local-chat'}]}));return;}
    response.setHeader('Content-Type','text/event-stream');
    const delta=requests.length===2?{tool_calls:[{index:0,id:'read-1',type:'function',function:{name:'workspace_read',arguments:JSON.stringify({path:'example.txt'})}}]}:{content:'Read verified'};
    response.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {connections}=await fixture(t);
  const baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
  const models=await connections.models({provider:'custom-api',baseUrl});assert.equal(models.models[0].id,'local-chat');
  await connections.configure({provider:'custom-api',baseUrl,model:'local-chat',supportsTools:true});
  const agent=new ApiAgent({getConnection:()=>connections.getConnection('custom-api'),emit:event=>events.push(event),getTools:()=>[{name:'workspace_read',description:'Read a permitted file',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}],callTool:async(...args)=>{toolCalls.push(args);return {content:[{type:'text',text:'Synthetic contents'},{type:'image',mimeType:'image/png',data:'AQID'}]};}});
  const result=await agent.run({provider:'custom-api',conversationId:'local',prompt:'Read example.txt'});
  assert.equal(result.text,'Read verified');assert.equal(requests.length,3);assert.equal(requests[1].url,'/v1/chat/completions');
  assert.equal(requests[1].authorization,undefined);assert.equal(toolCalls.length,1);assert.deepEqual(toolCalls[0],['workspace_read',{path:'example.txt'},'local']);
  assert.equal(requests[2].body.messages[2].role,'tool');assert.match(requests[2].body.messages[2].content,/Synthetic contents/);
  assert.match(requests[2].body.messages[2].content,/Image output was not sent/);assert.ok(!JSON.stringify(requests[2].body).includes('base64'));
  assert.deepEqual(events.filter(event=>event.type==='chat.tool').map(event=>event.status),['running','done']);
});

test('text-only custom connections send no tools, reject images and refuse unsolicited calls',async()=>{
  let fetches=0,calls=0,lastBody;
  const connection={protocol:'openai',baseUrl:'http://localhost:1234/v1',model:'small',supportsTools:false,supportsImages:false};
  const agent=new ApiAgent({getConnection:()=>connection,getTools:()=>{throw Error('Tools must not be read');},callTool:()=>{calls++;},fetchImpl:async(_url,options)=>{fetches++;lastBody=JSON.parse(options.body);return reply('Text reply');}});
  assert.equal((await agent.run({provider:'custom-api',conversationId:'text',prompt:'Hello',toolDefinitions:[{name:'bad'}]})).text,'Text reply');
  assert.equal(lastBody.tools,undefined);
  await assert.rejects(agent.run({provider:'custom-api',conversationId:'image',prompt:'Look',images:[{mimeType:'image/png',dataBase64:'AQID'}]}),/Image input is off/);assert.equal(fetches,1);
  agent.fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'bad-call',function:{name:'workspace_write',arguments:'{}'}}]},finish_reason:'tool_calls'}]}));
  await assert.rejects(agent.run({provider:'custom-api',conversationId:'bad',prompt:'Hello'}),/unknown tool/);assert.equal(calls,0);
});

test('custom connections never become an automatic fallback, including saved ordered targets',()=>{
  for(const preferences of [{},{fallback:{mode:'ordered',targets:[{provider:'custom-api',model:'local'}]}}]){
    assert.deepEqual(fallbackTargets({preferences,connections:[{id:'custom-api',connected:true}],models:{'custom-api':[{id:'local'}]},current:{provider:'codex',model:'auto'}}),[]);
  }
});
