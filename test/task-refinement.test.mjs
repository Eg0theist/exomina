import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskRefinement} from '../desktop/task-refinement.mjs';
import {hostAction,PermissionPolicy} from '../desktop/permissions.mjs';
const fixture=()=>{let clock=new Date('2026-10-20T10:00:00Z');const run={message:{id:'m',startedAt:clock.toISOString()}},chat={id:'a',projectId:'p',messages:[]},store={state:{settings:{memoryEnabled:true},conversations:[chat]},save:async()=>{}};const service=new TaskRefinement({store,getRun:id=>id==='a'?run:undefined,now:()=>clock});return {service,store,run,chat,tick:()=>{clock=new Date(+clock+1000);},observe(result={content:[{type:'text',text:'PRIVATE_RESULT_SENTINEL'}]}){clock=new Date(+clock+1000);service.observe('a',run,'workspace_read',result,clock.toISOString());return service.view('a').evidence.at(-1).id;}};};
const proposal=e=>({action:'propose',goal:'Read a large document reliably',baseline:'Single large read',candidate:'Bounded pages',criterion:'Complete source coverage without truncation',baselineEvidence:[e]});
async function compared(f){const before=f.observe();await f.service.call(proposal(before),'a');const id=f.chat.approachRefinements.at(-1).id,after=f.observe();await f.service.call({action:'compare',id,candidateEvidence:[after],observation:'The paginated read completed without truncation. File type may matter.'},'a');return id;}
const adopt=id=>({action:'adopt',id,scope:'project',lesson:'Use bounded reads for large documents.',appliesWhen:'A supported text document exceeds a read page.',caveat:'This does not establish completeness for scans or images.'});
test('propose/compare/adopt requires real distinct later evidence and stores no tool output',async()=>{
 const f=fixture();await assert.rejects(f.service.call(proposal('invented'),'a'),/recorded/);const base=f.observe();await f.service.call(proposal(base),'a');const record=f.chat.approachRefinements[0];await assert.rejects(f.service.call(adopt(record.id),'a'),/Compare/);await assert.rejects(f.service.call({action:'compare',id:record.id,candidateEvidence:[base],observation:'Claim'},'a'),/distinct/);
 const after=f.observe();await f.service.call({action:'compare',id:record.id,candidateEvidence:[after],observation:'A contrast with limitations.'},'a');await f.service.call(adopt(record.id),'a');assert.equal(f.service.view('a').lessons.length,1);assert.equal(JSON.stringify(f.chat).includes('PRIVATE_RESULT_SENTINEL'),false);assert.match(record.baselineEvidence[0].digest,/^[0-9a-f]{64}$/);
});
test('proposal budget and open-comparison cap prevent an unbounded refinement loop',async()=>{
 const f=fixture(),e=f.observe();await f.service.call(proposal(e),'a');await f.service.call(proposal(e),'a');await assert.rejects(f.service.call(proposal(e),'a'),/Two approach/);assert.equal(f.service.view('a').remainingProposals,0);
});
test('a retired lesson is not reused, and rejection never promotes a claim',async()=>{
 const f=fixture(),id=await compared(f);await f.service.call(adopt(id),'a');await f.service.call({action:'retire',id},'a');assert.equal(f.service.view('a').lessons.length,0);
 const base=f.observe();await f.service.call(proposal(base),'a');const rejected=f.chat.approachRefinements.at(-1).id;await f.service.call({action:'reject',id:rejected,observation:'No demonstrated improvement.'},'a');await assert.rejects(f.service.call(adopt(rejected),'a'),/Compare/);
});
test('project library requires sharing, same project, explicit project scope and earlier adoption',async()=>{
 const f=fixture();f.store.state.conversations.push({id:'b',projectId:'p',approachRefinements:[{id:'earlier',status:'adopted',scope:'project',adoptedAt:'2026-10-19T10:00:00Z'},{id:'future',status:'adopted',scope:'project',adoptedAt:'2026-10-21T10:00:00Z'},{id:'private-lesson',status:'adopted',scope:'chat',adoptedAt:'2026-10-19T10:00:00Z'}]},{id:'c',projectId:'other',approachRefinements:[{id:'wrong-project',status:'adopted',scope:'project'}]},{id:'d',projectId:'p',private:true,approachRefinements:[{id:'temporary',status:'adopted',scope:'project'}]});
 assert.deepEqual(f.service.view('a','project').lessons.map(l=>l.id),['earlier']);assert.equal(f.service.view('a','chat').lessons.length,0);f.store.state.settings.memoryEnabled=false;assert.equal(f.service.view('a','project').lessons.length,0);const id=await compared(f);await assert.rejects(f.service.call(adopt(id),'a'),/shared memory/);
});
test('cancelled or replaced runs cannot contribute evidence; metadata survives a new service instance',async()=>{
 const f=fixture(),id=await compared(f);await f.service.call(adopt(id),'a');const before=f.service.view('a').evidence.length;f.service.observe('a',{},'workspace_read',{isError:false},'');assert.equal(f.service.view('a').evidence.length,before);f.run.cancelled=true;await assert.rejects(f.service.call({action:'view'},'a'),/stopped/);assert.equal(new TaskRefinement({store:f.store,getRun:()=>null}).view('a').records[0].status,'adopted');
});
test('explicit deny rules apply to refinement; bookkeeping grants no execution permissions',()=>{
 const policy=new PermissionPolicy({getSettings:()=>({permissionMode:'read-only',permissionRules:[{tool:'task_refine',effect:'deny',match:''}]})});assert.equal(policy.evaluate(hostAction('task_refine',{action:'adopt'}),'a').decision,'deny');assert.equal(policy.evaluate(hostAction('workspace_shell',{command:'test'}),'a').decision,'deny');
});
test('failed command receipts are classified without turning completion into proof',()=>{
 const f=fixture();f.observe({content:[{type:'text',text:JSON.stringify({exitCode:1,output:'failure'})}]});assert.equal(f.service.view('a').evidence[0].status,'failed');assert.match(f.service.view('a').notice,/not the model/);
});
test('failed saves roll back a proposal and its budget; retained lessons are never silently evicted',async()=>{
 const f=fixture(),e=f.observe();f.service.save=async()=>{throw Error('Disk full');};await assert.rejects(f.service.call(proposal(e),'a'),/Disk full/);assert.equal(f.chat.approachRefinements,undefined);assert.equal(f.service.view('a').remainingProposals,2);
 f.service.save=async()=>{};f.chat.approachRefinements=Array.from({length:24},(_,i)=>({id:String(i),status:'adopted'}));await assert.rejects(f.service.call(proposal(e),'a'),/24 retained/);assert.equal(f.chat.approachRefinements.length,24);
});
test('observer ignores deleted/private chats and unserializable receipts without failing the actual tool',async()=>{
 const f=fixture();f.chat.private=true;await f.service.observe('a',f.run,'workspace_read',{a:1},'');f.chat.private=false;await f.service.observe('a',f.run,'workspace_read',{a:1n},'');assert.equal(f.service.view('a').evidence.length,0);
});
