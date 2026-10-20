import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {Store} from '../desktop/store.mjs';
import {ChatMemoryTree} from '../desktop/chat-memory-tree.mjs';
import {ChatMemoryService} from '../desktop/chat-memory-service.mjs';
import {ConversationTools} from '../desktop/conversation-tools.mjs';
import {CloudClient} from '../desktop/cloud-client.mjs';
import {createDataExport} from '../desktop/data-export.mjs';
import {ApiAgent} from '../desktop/api-agent.mjs';
import {assertTemporaryRequest,temporaryRunOptions,temporarySupported} from '../desktop/privacy.mjs';

async function directory(t,cleanup=true){const parent=path.resolve('.verification/privacy-tests');await mkdir(parent,{recursive:true});const dir=await mkdtemp(path.join(parent,'synthetic-'));if(cleanup)t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const unpack=result=>JSON.parse(result.content[0].text);
test('temporary text never enters durable state or backup, even while ordinary chats change',async t=>{
  const dir=await directory(t);
  const live=new Store(dir);await live.init();
  const saved=live.create('codex'),temporary=live.create('claude',{isPrivate:true});
  saved.messages.push({role:'user',content:'SAVED_MARKER'});temporary.messages.push({role:'user',content:'PRIVATE_CONTENT_MARKER'});
  await live.save();saved.title='Changed title';temporary.messages.push({role:'assistant',content:'PRIVATE_REPLY_MARKER'});await live.save();
  assert.ok(live.state.conversations.includes(temporary));
  for(const file of await readdir(dir))if(file.startsWith('state'))assert.doesNotMatch(await readFile(path.join(dir,file),'utf8'),/PRIVATE_CONTENT_MARKER|PRIVATE_REPLY_MARKER|Temporary chat/);
  const reopened=new Store(dir);await reopened.init();assert.equal(reopened.state.conversations.length,1);assert.equal(reopened.state.conversations[0].id,saved.id);
});
test('temporary messages, native events, tool output and helpers never reach memory or search',async t=>{
  const dir=await directory(t,false),tree=new ChatMemoryTree(dir);await tree.init();t.after(async()=>{await tree.close();await rm(dir,{recursive:true,force:true});});
  const touched=[],service=new ChatMemoryService({tree,settings:()=>({chatMemoryEnabled:true}),isPrivate:id=>id==='private',search:{touch:id=>touched.push(id)}});
  const chat={id:'private',private:true,messages:[{id:'m',role:'user',content:'PRIVATE_MARKER'}]};
  await service.sync(chat);service.providerEvent({type:'chat.delta',conversationId:chat.id,text:'SECRET_DELTA'},'run');service.emitted({type:'chat.helper',conversationId:chat.id,helper:{id:'h',status:'complete',text:'SECRET_HELPER'}});
  await service.hostCall(chat.id,'call','workspace_read',{path:'secret'});await service.hostResult(chat.id,'call','workspace_read','SECRET_TOOL');await service.finish(chat);await service.queue;
  assert.equal((await tree.stats(chat.id)).total,0);assert.equal(service.buffers.size,0);assert.deepEqual(touched,[]);assert.equal((await service.prepare(chat)).usable,false);
});
test('saved-chat searches cannot see temporary text, and temporary chats cannot recall saved chats',async()=>{
  const chats=[{id:'saved',messages:[{role:'user',content:'SAVED_SECRET'}]},{id:'private',private:true,messages:[{role:'user',content:'PRIVATE_SECRET'}]}];
  const tools=new ConversationTools({getConversations:()=>chats,getMemoryEnabled:()=>true});
  assert.deepEqual(unpack(await tools.call('conversation_search',{query:'PRIVATE_SECRET'},'saved')).results,[]);
  assert.deepEqual(unpack(await tools.call('conversation_search',{query:'SAVED_SECRET'},'private')).results,[]);
  await assert.rejects(tools.call('conversation_read',{conversationId:'private'},'saved'),/not found/);
  await assert.rejects(tools.call('conversation_read',{conversationId:'saved'},'private'),/current chat/);
});
test('temporary chats do not affect sync records or exports, including direct export requests',async()=>{
  const chat={id:'saved',provider:'codex',title:'Saved',messages:[]},temporary={id:'private',private:true,provider:'claude',title:'Private',messages:[{role:'user',content:'PRIVATE_SECRET'}]};
  const store={state:{conversations:[chat]},conversation:id=>store.state.conversations.find(c=>c.id===id)};
  const memory={list:async()=>[]},archive={syncIndex:()=>[],exportDocuments:()=>[]};
  const cloud=new CloudClient({dataDir:'.verification',store,memory,archive,autoSync:false});const fingerprint=cloud.fingerprint();store.state.conversations.push(temporary);
  assert.equal(cloud.fingerprint(),fingerprint);assert.doesNotMatch((await createDataExport({store,memory,archive})).content,/PRIVATE_SECRET|private/);
  await assert.rejects(createDataExport({store,memory,archive},{scope:'chat',conversationId:'private'}),/cannot be exported/);
});
test('temporary mode fails closed on unsupported clients, files, projects and background requests',()=>{
  for(const provider of ['codex','claude','openai-api','anthropic-api','gemini','xai']){assert.equal(temporarySupported(provider),true);assertTemporaryRequest({private:true,provider,text:'Hello'});}
  for(const provider of ['grok','antigravity','muse-code','unknown'])assert.throws(()=>assertTemporaryRequest({provider},{private:true}),/unavailable/);
  for(const extra of [{attachments:['upload']},{projectId:'project'},{background:true},{channel:{type:'telegram'}}])assert.throws(()=>assertTemporaryRequest({private:true,provider:'codex',...extra}),/text only/);
  assert.deepEqual(temporaryRunOptions(),{noPersistence:true,noTools:true,toolDefinitions:[],lean:true,allowEscalation:false});
});
test('temporary OpenAI API requests use official store:false and expose no tools',async()=>{
  const requests=[],agent=new ApiAgent({getConnection:()=>({protocol:'openai',baseUrl:'https://api.openai.com/v1',apiKey:'synthetic-test-key',model:'test-model'}),fetchImpl:async(url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{message:{content:'Hello'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});}});
  await agent.run({provider:'openai-api',conversationId:'temporary',prompt:'PRIVATE_MARKER',...temporaryRunOptions()});
  assert.equal(requests[0].store,false);assert.equal(requests[0].tools,undefined);assert.equal(agent.active.size,0);
});
