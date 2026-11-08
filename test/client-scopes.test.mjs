import test from 'node:test';
import assert from 'node:assert/strict';
import {ClientScopes,validateClientScopes} from '../desktop/client-scopes.mjs';
import {ScopedToolDiscovery} from '../desktop/scoped-tool-discovery.mjs';

async function fixture(){
  let principal='owner';const chats=[{id:'a',projectId:'pa'},{id:'b',projectId:'pb'},{id:'personal'}];
  const store={state:{conversations:chats},save:async()=>{}};
  const scopes=new ClientScopes({store,getPrincipal:()=>principal,getChat:id=>chats.find(chat=>chat.id===id),resourceExists:()=>true,scopedTools:['memory_recall','conversation_read']});
  const org=(await scopes.manage({action:'createOrganization',name:'Agency'})).result;
  const a=(await scopes.manage({action:'createClient',organizationId:org.id,name:'Client Alpha'})).result;
  const b=(await scopes.manage({action:'createClient',organizationId:org.id,name:'Client Beta'})).result;
  const bind=(kind,id,clientId,sources)=>scopes.manage({action:'bindResource',organizationId:org.id,clientId,kind,id,...(sources?{sources}:{})});
  await bind('project','pa',a.id);await bind('project','pb',b.id);
  return {store,scopes,chats,org,a,b,bind,as:value=>{principal=value;}};
}

test('project-bound conversations get explicit client identities; personal chats stay separate',async()=>{
  const f=await fixture();assert.equal(f.scopes.context('a').clientId,f.a.id);assert.equal(f.scopes.context('personal'),null);
  assert.equal(f.scopes.allowsResource('a',{kind:'chat',id:'a'}),true);
  assert.equal(f.scopes.allowsResource('a',{kind:'chat',id:'b'}),false);
  assert.equal(f.scopes.allowsResource('personal',{kind:'chat',id:'a'}),false);
  assert.equal(f.scopes.allowsResource('a',{kind:'chat',id:'personal'}),false);
});
test('filtering removes cross-client metadata before ranking or counts',async()=>{
  const f=await fixture();assert.deepEqual(f.scopes.filterResources('a',[{id:'b',secret:'Beta'},{id:'a',text:'Alpha'},{id:'personal'}],row=>({kind:'chat',id:row.id})),[{id:'a',text:'Alpha'}]);
});
test('owner client listings use client IDs and membership-filtered choices survive reload',async()=>{
  const f=await fixture();assert.deepEqual(f.scopes.status().clients.map(client=>client.id),[f.a.id,f.b.id]);
  await f.scopes.manage({action:'setMember',organizationId:f.org.id,principalId:'reader',role:'reader',clientIds:[f.a.id]});f.as('reader');assert.deepEqual(f.scopes.status().clients.map(client=>client.id),[f.a.id]);
  const reopened=new ClientScopes({store:{state:JSON.parse(JSON.stringify(f.store.state)),save:async()=>{}},getPrincipal:()=> 'owner'});assert.deepEqual(reopened.status().clients.map(client=>client.id),[f.a.id,f.b.id]);
  f.as('owner');await f.scopes.manage({action:'retireClient',organizationId:f.org.id,clientId:f.b.id});assert.deepEqual(f.scopes.status().clients.map(client=>client.id),[f.a.id]);
});
test('membership limits clients and read-only roles do not execute or write',async()=>{
  const f=await fixture();await f.scopes.manage({action:'setMember',organizationId:f.org.id,principalId:'analyst',role:'reader',clientIds:[f.a.id]});f.as('analyst');
  assert.equal(f.scopes.allowsResource('a',{kind:'chat',id:'a'}),true);assert.equal(f.scopes.allowsResource('a',{kind:'chat',id:'a'},'write'),false);assert.equal(f.scopes.allowsResource('a',{kind:'chat',id:'a'},'execute'),false);
  assert.throws(()=>f.scopes.context('b'),/unavailable/);await assert.rejects(f.scopes.manage({action:'createClient',organizationId:f.org.id,name:'Intruder'}),/unavailable/);
});
test('revocation invalidates async jobs, cached keys and discovery references even with identical tools',async()=>{
  const f=await fixture();const before=f.scopes.cacheKey('a','same query'),job=f.scopes.captureJob('a');
  const discovery=new ScopedToolDiscovery({getScope:id=>f.scopes.fingerprint(id),getCatalog:()=>[{name:'memory_recall',description:'memory search',inputSchema:{type:'object',properties:{}}}],getEligible:(tool,id)=>f.scopes.toolAllowed(id,tool.name),evaluate:()=>({decision:'allow'})});
  const ref=(await discovery.discover({query:'memory'},'a')).results[0].ref;
  await f.scopes.manage({action:'setMember',organizationId:f.org.id,principalId:'helper',role:'contributor',clientIds:[f.a.id]});
  assert.notEqual(before,f.scopes.cacheKey('a','same query'));assert.throws(()=>f.scopes.assertJob(job),/authorization changed/);await assert.rejects(discovery.details({ref},'a'),/stale/);
  const current=f.scopes.captureJob('a');await f.scopes.manage({action:'retireClient',organizationId:f.org.id,clientId:f.a.id});assert.throws(()=>f.scopes.assertJob(current),/unavailable/);
});
test('same query never has a cache key shared by another client or personal conversation',async()=>{
  const f=await fixture();assert.equal(new Set(['a','b','personal'].map(chatId=>f.scopes.cacheKey(chatId,'tax report'))).size,3);
});
test('derived artifacts retain every source scope, and mixed-client derivation is refused',async()=>{
  const f=await fixture();await f.bind('artifact','alpha-report',f.a.id,[{kind:'chat',id:'a'}]);
  assert.equal(f.scopes.allowsResource('a',{kind:'artifact',id:'alpha-report'}),true);
  await assert.rejects(f.bind('artifact','mixed-report',f.a.id,[{kind:'chat',id:'a'},{kind:'chat',id:'b'}]),/every source/);
  await assert.rejects(f.bind('artifact','unscoped-report',f.a.id,[{kind:'chat',id:'personal'}]),/every source/);
  assert.deepEqual(f.scopes.binding('artifact','alpha-report').sources,[{kind:'chat',id:'a'}]);
});
test('existing resource relabelling and contradictory project/chat scope are refused',async()=>{
  const f=await fixture();await assert.rejects(f.bind('project','pa',f.b.id),/cannot be relabelled/);await assert.rejects(f.bind('chat','a',f.b.id),/cannot be relabelled/);
  await f.bind('chat','loose',f.b.id);f.chats.push({id:'loose',projectId:'pc'});await assert.rejects(f.bind('project','pc',f.a.id),/another client/);
});
test('scope survives store serialization and a new authorizer instance without broadening access',async()=>{
  const f=await fixture(),store={state:JSON.parse(JSON.stringify(f.store.state)),save:async()=>{}};
  const next=new ClientScopes({store,getPrincipal:()=> 'owner',getChat:id=>store.state.conversations.find(chat=>chat.id===id)});
  assert.equal(next.context('a').clientId,f.a.id);assert.equal(next.allowsResource('a',{kind:'chat',id:'b'}),false);
});
test('unknown native or external tools are refused for scoped chats',async()=>{
  const f=await fixture();for(const name of ['archive_search','workspace_shell','external_arbitrary','browser_snapshot'])assert.equal(f.scopes.toolAllowed('a',name),false);
  assert.equal(f.scopes.toolAllowed('a','memory_recall'),true);assert.equal(f.scopes.toolAllowed('personal','workspace_shell'),true);
});
test('missing principal and malformed persisted authorization fail closed',async()=>{
  const f=await fixture();f.as(null);assert.throws(()=>f.scopes.context('a'),/unavailable/);assert.equal(f.scopes.toolAllowed('a','memory_recall'),false);
  const bad=structuredClone(f.store.state.clientScopes);bad.bindings.push({...bad.bindings[0]});assert.throws(()=>validateClientScopes(bad),/Invalid resource/);
  assert.throws(()=>new ClientScopes({store:{state:{clientScopes:{version:1}}}}),/Invalid client/);
});
test('the last administrator cannot be removed and foreign client grants cannot be persisted',async()=>{
  const f=await fixture();await assert.rejects(f.scopes.manage({action:'setMember',organizationId:f.org.id,principalId:'owner',role:'none'}),/administrator/);
  await assert.rejects(f.scopes.manage({action:'setMember',organizationId:f.org.id,principalId:'x',role:'reader',clientIds:['not-this-organization']}),/crosses an organization/);
  assert.equal(f.scopes.context('a').clientId,f.a.id);
});
test('a failed durable authorization write poisons reads rather than restoring a usable stale grant',async()=>{
  const f=await fixture();f.scopes.save=async()=>{throw Error('disk full');};
  await assert.rejects(f.scopes.manage({action:'retireClient',organizationId:f.org.id,clientId:f.a.id}),/disk full/);
  assert.equal(f.scopes.allowsResource('a',{kind:'chat',id:'a'}),false);assert.equal(f.scopes.toolAllowed('a','memory_recall'),false);
  await assert.rejects(f.scopes.manage({action:'createClient',organizationId:f.org.id,name:'Another'}),/storage failed/);
});
test('authorization does not publish usable grants while the durable configuration write is pending',async()=>{
  const f=await fixture();let release;f.scopes.save=()=>new Promise(resolve=>{release=resolve;});
  const pending=f.scopes.manage({action:'setMember',organizationId:f.org.id,principalId:'helper',role:'reader',clientIds:[f.a.id]});
  while(!release)await new Promise(resolve=>setImmediate(resolve));assert.throws(()=>f.scopes.context('a'),/pending/);release();await pending;assert.ok(f.scopes.context('a'));
});
test('stored mixed sources and dependency cycles are refused before retrieval',async()=>{
  const f=await fixture();await f.bind('artifact','report',f.a.id,[{kind:'project',id:'pa'}]);
  const mixed=structuredClone(f.store.state.clientScopes);mixed.bindings.find(row=>row.id==='report').sources=[{kind:'project',id:'pb'}];assert.throws(()=>validateClientScopes(mixed),/cross clients/);
  await assert.rejects(f.bind('artifact','report',f.a.id,[{kind:'artifact',id:'report'}]),/own source/);
});
