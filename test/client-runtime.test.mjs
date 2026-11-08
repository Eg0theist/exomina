import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ClientScopes} from '../desktop/client-scopes.mjs';
import {ClientRuntime} from '../desktop/client-runtime.mjs';

async function fixture(t,options={}){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'exomina-client-runtime-'));
  const chats=[{id:'alpha',projectId:'project-alpha',outcomeMarks:[{id:'alpha-check'}]},{id:'alpha-next',projectId:'project-alpha',outcomeMarks:[{id:'alpha-check-next'}]},{id:'beta',projectId:'project-beta',outcomeMarks:[{id:'beta-check'}]},{id:'personal',outcomeMarks:[{id:'personal-check'}]}];
  const store={state:{conversations:chats},save:async()=>{}};
  const scopes=new ClientScopes({store,getPrincipal:()=> 'owner',getChat:id=>chats.find(chat=>chat.id===id),resourceExists:()=>true});
  const org=(await scopes.manage({action:'createOrganization',name:'Org'})).result;
  const clients=[];for(const name of ['alpha','beta']){const client=(await scopes.manage({action:'createClient',organizationId:org.id,name})).result;clients.push(client);await scopes.manage({action:'bindResource',organizationId:org.id,clientId:client.id,kind:'project',id:'project-'+name});}
  const runtime=new ClientRuntime({scopes,dataDir,getChats:()=>chats,...options});
  t.after(async()=>{await runtime.close();await rm(dataDir,{recursive:true,force:true});});
  return {dataDir,chats,store,scopes,runtime,org,clients};
}
test('real client SQLite databases isolate identical search terms, source links and summaries',async t=>{
  const f=await fixture(t),a=await f.runtime.memory('alpha'),b=await f.runtime.memory('beta');
  const alpha=await a.note('Confidential revenue is 17 for Alpha',{conversationId:'alpha'}),beta=await b.note('Confidential revenue is 93 for Beta',{conversationId:'beta'});
  const first=await a.call('memory_recall',{query:'Confidential revenue'}),second=await b.call('memory_recall',{query:'Confidential revenue'});
  const firstRows=JSON.parse(first.content[0].text).results,secondRows=JSON.parse(second.content[0].text).results;
  assert.deepEqual(firstRows.map(row=>({id:row.id,text:row.text,sourceChatIds:row.sourceChatIds})),[{id:alpha.id,text:'Confidential revenue is 17 for Alpha',sourceChatIds:['alpha']}]);
  assert.deepEqual(secondRows.map(row=>({id:row.id,text:row.text,sourceChatIds:row.sourceChatIds})),[{id:beta.id,text:'Confidential revenue is 93 for Beta',sourceChatIds:['beta']}]);
  assert.ok(firstRows.every(row=>row.id!==beta.id));assert.ok(secondRows.every(row=>row.id!==alpha.id));
  const wake=await a.run(['wake']);assert.ok(!wake.text.includes('Confidential revenue is 93 for Beta'));assert.ok(!wake.text.includes(beta.id));
  assert.equal((await readdir(path.join(f.dataDir,'client-data'))).length,2);
  assert.equal(await f.runtime.memory('alpha-next'),a);assert.notEqual(a,b);
});
test('transcript source filtering excludes client records from personal chats and each other',async t=>{
  const f=await fixture(t);assert.deepEqual(f.runtime.chats('alpha').map(row=>row.id),['alpha','alpha-next']);assert.deepEqual(f.runtime.chats('beta').map(row=>row.id),['beta']);assert.deepEqual(f.runtime.chats('personal').map(row=>row.id),['personal']);
});
test('client outcome callback never falls back to personal evidence after the opening chat is deleted',async t=>{
  const f=await fixture(t),a=await f.runtime.memory('alpha');assert.deepEqual(a.outcomeSource().map(row=>row.id),['alpha-check','alpha-check-next']);
  f.chats.splice(f.chats.findIndex(row=>row.id==='alpha'),1);
  assert.deepEqual(a.outcomeSource().map(row=>row.id),['alpha-check-next']);assert.equal(await f.runtime.memory('alpha-next'),a);
});
test('client outcome callback remains scoped if its first chat changes projects',async t=>{
  const f=await fixture(t),a=await f.runtime.memory('alpha');f.chats.find(row=>row.id==='alpha').projectId='project-beta';
  assert.deepEqual(a.outcomeSource().map(row=>row.id),['alpha-check-next']);
});
test('revoked client context cannot retrieve an initialized database or transcript source',async t=>{
  const f=await fixture(t);await f.runtime.memory('alpha');await f.scopes.manage({action:'retireClient',organizationId:f.org.id,clientId:f.clients[0].id});
  await assert.rejects(f.runtime.memory('alpha'),/unavailable/);assert.throws(()=>f.runtime.chats('alpha'),/unavailable/);assert.throws(()=>f.runtime.allowed('alpha','memory_recall'),/unavailable/);
});
test('authorization change while a memory adapter initializes prevents its result from reaching the request',async t=>{
  let entered,release;const waiting=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{memoryFactory:()=>({init:async()=>{entered();await new Promise(resolve=>{release=resolve;});},setOutcomeSource(){},close(){}})});
  const pending=f.runtime.memory('alpha');await waiting;await f.scopes.manage({action:'setMember',organizationId:f.org.id,principalId:'helper',role:'reader',clientIds:[f.clients[0].id]});release();await assert.rejects(pending,/authorization changed/);
});
test('scoped runs have host-only ephemeral native contracts and a reduced catalog',async t=>{
  const f=await fixture(t),defs=['memory_recall','conversation_read','archive_search','workspace_shell','external_send'].map(name=>({name}));
  const options=f.runtime.runOptions('alpha',defs);assert.equal(options.hostToolsOnly,true);assert.equal(options.noPersistence,true);assert.equal(options.ephemeral,true);assert.equal(options.noAuthRetry,true);
  assert.deepEqual(options.toolDefinitions.map(row=>row.name),['memory_recall','conversation_read']);assert.deepEqual(f.runtime.runOptions('personal',defs),{});
  assert.throws(()=>f.runtime.assertTool('alpha','workspace_shell'),/no client-isolated adapter/);
  assert.throws(()=>f.runtime.assertTool('alpha','memory_future_external_export'),/no client-isolated adapter/);
  assert.throws(()=>f.runtime.assertTool('alpha','conversation_future_global_query'),/no client-isolated adapter/);
});
test('client notes survive a fresh runtime using the same client identity and storage directory',async t=>{
  const f=await fixture(t),a=await f.runtime.memory('alpha');await a.note('Alpha retention marker');await f.runtime.close();
  const next=new ClientRuntime({scopes:f.scopes,dataDir:f.dataDir,getChats:()=>f.chats});try{assert.match((await (await next.memory('alpha')).run(['wake'])).text,/retention marker/);}finally{await next.close();}
});
test('read-only client roles do not discover or dispatch memory mutations',async t=>{
  const f=await fixture(t);await f.scopes.manage({action:'setMember',organizationId:f.org.id,principalId:'reader',role:'reader',clientIds:[f.clients[0].id]});f.scopes.getPrincipal=()=> 'reader';
  assert.equal(f.runtime.allowed('alpha','memory_recall'),true);for(const name of ['memory_note','memory_nap','memory_forget','conversation_set_title']){assert.equal(f.runtime.allowed('alpha',name),false);assert.throws(()=>f.runtime.assertTool('alpha',name),/no client-isolated adapter/);}
});
