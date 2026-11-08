import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudClient} from '../desktop/cloud-client.mjs';
import {createDataExport} from '../desktop/data-export.mjs';
import {ConversationTools} from '../desktop/conversation-tools.mjs';
import {Workbench} from '../desktop/workbench.mjs';

test('client-bearing libraries reject plain transfer before serialization or source reads',async()=>{
 let reads=0;const store={state:{clientScopes:{bindings:[{kind:'project',id:'isolated'}]}}};
 await assert.rejects(()=>createDataExport({store,memory:{list:()=>{reads++;}},archive:{exportDocuments:()=>{reads++;}}}),/Library backup/);assert.equal(reads,0);
});
test('private sync guard fails closed for client libraries before any request and after a generation change',async()=>{
 const client=new CloudClient({dataDir:'.',store:{state:{}},isBusy:()=>false});assert.doesNotThrow(()=>client.guard());client.store.state.clientScopes={bindings:[{kind:'project',id:'isolated'}]};assert.throws(()=>client.guard(),/client boundaries/);await assert.rejects(()=>client.performSync(),/client boundaries/);
});
test('conversation search passes the trusted active identity to the pre-retrieval source',async()=>{
 const rows=[{id:'active',messages:[{id:'one',role:'user',content:'revenue 17'}]},{id:'foreign',messages:[{id:'two',role:'user',content:'revenue 93'}]}];let selected;
 const service=new ConversationTools({getConversations:active=>{selected=active;return rows.filter(row=>row.id===active);},getMemoryEnabled:()=>true});
 const result=await service.call('conversation_search',{query:'revenue'},'active');assert.equal(selected,'active');assert.match(JSON.stringify(result),/17/);assert.doesNotMatch(JSON.stringify(result),/93|foreign/);
 await assert.rejects(()=>service.call('conversation_read',{conversationId:'foreign'},'active'),/not found/);
});
test('deleting a client project cannot release its conversations into personal scope',async()=>{
 const store={state:{settings:{},projects:[{id:'isolated'}],conversations:[{id:'one',projectId:'isolated'}],clientScopes:{bindings:[{kind:'project',id:'isolated'}]}},save:async()=>{}};
 const workbench=new Workbench({store});await assert.rejects(()=>workbench.remove('projects','isolated'),/cannot make their history personal/);assert.equal(store.state.conversations[0].projectId,'isolated');assert.equal(store.state.projects.length,1);
});
