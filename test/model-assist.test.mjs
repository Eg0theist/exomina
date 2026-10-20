import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelAssist, collaborationInstructions } from '../desktop/model-assist.mjs';
const fixture=()=>{const run={message:{}},usage={codex:{provider:'codex',fetchStatus:'ready',updatedAt:new Date().toISOString(),windows:[{id:'primary',usedPercent:30}]}},events=[];let calls=0;const a=new ModelAssist({getConnections:()=>[{id:'codex',connected:true}],getUsage:()=>usage,refreshUsage:async()=>{},getPreferences:()=>({}),getModels:()=>({codex:[{id:'gpt-6'}]}),getRun:()=>run,approve:async()=>true,save:async()=>{},emit:e=>events.push(e),execute:async()=>{calls++;return {text:'Review result'};}});return {a,run,usage,events,calls:()=>calls};};
test('helpers require verified available subscription usage',()=>{const f=fixture();assert.ok(f.a.available().find(m=>m.provider==='codex').available);delete f.usage.codex;assert.equal(f.a.available().find(m=>m.provider==='codex').available,false);});
test('a helper result is attributed and stored in the parent reply',async()=>{const f=fixture();await f.a.call('model_consult',{provider:'codex',task:'Review this draft',context:'Only the draft.'},'parent');assert.equal(f.calls(),1);assert.equal(f.run.message.helpers[0].text,'Review result');assert.equal(f.run.message.helpers[0].status,'complete');assert.equal(f.events[0].conversationId,'parent');assert.equal(f.a.routes.size,0);});
test('exhaustion, stale usage, denial and consumption while approving prevent inference',async()=>{for(const condition of ['exhausted','stale','denied','changed']){const f=fixture();if(condition==='exhausted')f.usage.codex.windows[0].usedPercent=100;if(condition==='stale')f.usage.codex.fetchStatus='stale';if(condition==='denied')f.a.approve=async()=>false;if(condition==='changed')f.a.approve=async()=>{f.usage.codex.windows[0].usedPercent=100;return true;};await assert.rejects(f.a.call('model_consult',{provider:'codex',task:'Review'},'parent'));assert.equal(f.calls(),0);}});
test('helper requests are bounded and cannot create recursive host delegation',async()=>{const f=fixture();for(let i=0;i<4;i++)await f.a.call('model_consult',{provider:'codex',task:'Review'},'parent');await assert.rejects(f.a.call('model_consult',{provider:'codex',task:'Review'},'parent'),/four/);assert.equal(f.calls(),4);});
test('cancelling a parent identifies and stops its active helper',async()=>{const f=fixture();let release;f.a.execute=()=>new Promise(r=>release=r);const p=f.a.call('model_consult',{provider:'codex',task:'Review'},'parent');await new Promise(r=>setImmediate(r));let stopped;f.a.cancel('parent',id=>stopped=id);assert.match(stopped,/^helper-/);f.a.getRun=()=>null;release({text:'late'});await assert.rejects(p,/stopped/);assert.equal(f.run.message.helpers[0].status,'cancelled');});
test('hidden providers and unchecked models cannot be used as helpers',()=>{const f=fixture();f.a.getPreferences=()=>({hiddenProviders:['codex'],models:{grok:[]}});assert.deepEqual(f.a.available(),[]);f.a.getPreferences=()=>({models:{codex:[]}});assert.ok(!f.a.available().some(m=>m.provider==='codex'));});
test('stop during persistence prevents a helper from starting afterwards',async()=>{const f=fixture();f.a.save=async()=>{f.a.getRun=()=>null;};await assert.rejects(f.a.call('model_consult',{provider:'codex',task:'Review'},'parent'),/stopped/);assert.equal(f.calls(),0);assert.equal(f.a.routes.size,0);});

test('difficulty selects an available task role and supported effort, with explicit overrides',async()=>{
  const f=fixture();
  f.a.getModels=()=>({codex:[{id:'gpt-6-sol',efforts:[{id:'low'},{id:'medium'},{id:'high'}]},{id:'gpt-6-luna',efforts:[{id:'low'},{id:'medium'}]},{id:'gpt-6-astra',efforts:[{id:'medium'},{id:'high'},{id:'ultra'}]}]});
  const selected=[];f.a.execute=async request=>{selected.push(request);return {text:'Synthetic review',selection:{model:request.model}};};
  for(const difficulty of ['simple','standard','complex'])await f.a.call('model_consult',{provider:'codex',task:'Review',difficulty},'parent');
  await f.a.call('model_consult',{provider:'codex',model:'gpt-6-sol',effort:'high',difficulty:'simple',task:'Review'},'parent');
  assert.deepEqual(selected.map(x=>[x.model,x.effort]),[['gpt-6-luna','low'],['gpt-6-sol','medium'],['gpt-6-astra','high'],['gpt-6-sol','high']]);
  assert.equal(f.run.message.helpers[2].difficulty,'complex');assert.equal(f.run.message.helpers[3].effortSource,'explicit');
});
test('unavailable larger models and unsupported efforts are not silently selected',async()=>{
  const f=fixture();f.a.getModels=()=>({codex:[{id:'gpt-6-sol',efforts:[{id:'medium'}]},{id:'gpt-6-astra',efforts:[{id:'high'}]}]});
  f.usage.codex.modelLimits=[{id:'gpt-6-astra',knownAvailable:true,blocked:true}];
  let chosen;f.a.execute=async request=>{chosen=request;return {text:'Synthetic review'};};
  await f.a.call('model_consult',{provider:'codex',difficulty:'complex',task:'Review'},'parent');assert.equal(chosen.model,'gpt-6-sol');
  await assert.rejects(f.a.call('model_consult',{provider:'codex',model:'gpt-6-sol',effort:'ultra',task:'Review'},'parent'),/does not support/);
  await assert.rejects(f.a.call('model_consult',{difficulty:'impossible',task:'Review'},'parent'),/difficulty/);
});
test('image references are approved before bytes are read, forwarded and recorded without pixels',async()=>{
  const f=fixture(),sequence=[];const image={mimeType:'image/png',dataBase64:'synthetic-pixels',bytes:100};
  f.a.approve=async request=>{sequence.push('approve');assert.match(request.detail,/concept\.png/);return true;};
  f.a.readImages=async refs=>{sequence.push('read');assert.deepEqual(refs.image_paths,['concept.png']);return [image];};
  f.a.execute=async request=>{sequence.push('execute');assert.deepEqual(request.images,[image]);return {text:'Saw the image'};};
  const result=await f.a.call('model_consult',{provider:'codex',task:'Inspect the icon',image_paths:['concept.png']},'parent');
  assert.deepEqual(sequence,['approve','read','execute']);assert.equal(JSON.parse(result.content[0].text).imageCount,1);
  assert.deepEqual(f.run.message.helpers[0].images,[{path:'concept.png'}]);assert.ok(!JSON.stringify(f.run.message.helpers).includes('synthetic-pixels'));
});
test('declined image sharing, nonvisual helpers and excess references prevent reads and inference',async()=>{
  const f=fixture();let reads=0;f.a.readImages=async()=>{reads++;return [];};
  f.a.approve=async()=>false;
  await assert.rejects(f.a.call('model_consult',{provider:'codex',task:'Inspect',image_paths:['concept.png']},'parent'),/declined/);
  assert.equal(reads,0);
  f.a.approve=async()=>true;
  await assert.rejects(f.a.call('model_consult',{provider:'ollama',task:'Inspect',image_paths:['concept.png']},'parent'),/can read images/);
  await assert.rejects(f.a.call('model_consult',{provider:'codex',task:'Inspect',image_paths:Array(5).fill('a.png'),image_ids:['a'.repeat(64)]},'parent'),/five images/);
  assert.equal(reads,0);assert.equal(f.calls(),0);
});

test('explicit provider default aliases and runtime-default effort remain selectable',async()=>{
  const f=fixture();f.a.getModels=()=>({codex:[{id:'gpt-6-sol',efforts:[{id:'medium'}]},{id:'default',efforts:[{id:'high'}]}]});
  let selected;f.a.execute=async request=>{selected=request;return {text:'Synthetic review'};};
  await f.a.call('model_consult',{provider:'codex',model:'default',effort:'default',difficulty:'complex',task:'Use the provider default'},'parent');
  assert.equal(selected.model,'default');assert.equal(selected.effort,'');assert.equal(f.run.message.helpers[0].effortSource,'runtime-default');
});

const bidirectionalFixture = sourceProvider => {
  const f = fixture();
  f.run.message.id = 'parent-reply'; f.run.message.provider = sourceProvider;
  f.run.selection = { provider: sourceProvider, model: sourceProvider === 'codex' ? 'gpt-6-sol' : 'claude-sonnet-requested' };
  f.run.reportedSelection = { provider: sourceProvider, model: sourceProvider === 'codex' ? 'gpt-6-sol-reported' : 'claude-sonnet-reported' };
  f.a.getConnections = () => [{ id: 'codex', connected: true }, { id: 'claude', connected: true }];
  f.a.getModels = () => ({ codex: [{ id: 'gpt-6-sol', efforts: ['medium', 'high'] }], claude: [{ id: 'claude-sonnet-requested', efforts: ['low', 'high'] }] });
  f.usage.claude = { ...f.usage.codex, provider: 'claude' };
  return f;
};

test('ChatGPT delegates to Claude with distinct requested and reported identities', async () => {
  const f = bidirectionalFixture('codex'); let sent;
  f.a.execute = async request => { sent = request; return { text: 'Claude review', selection: { provider: 'claude', model: 'claude-sonnet-reported', effort: 'high' } }; };
  const answer = JSON.parse((await f.a.call('model_consult', { provider: 'claude', model: 'claude-sonnet-requested', effort: 'high', task: 'Review the argument' }, 'parent')).content[0].text);
  assert.equal(sent.provider, 'claude'); assert.equal(sent.noTools, true); assert.deepEqual(sent.toolDefinitions, []);
  const helper = f.run.message.helpers[0];
  assert.equal(helper.kind, 'consult'); assert.equal(helper.sourceProvider, 'codex'); assert.equal(helper.sourceModel, 'gpt-6-sol-reported'); assert.equal(helper.sourceModelSource, 'reported'); assert.equal(helper.sourceRequestedModel, 'gpt-6-sol');
  assert.equal(helper.requestedProvider, 'claude'); assert.equal(helper.requestedModel, 'claude-sonnet-requested'); assert.equal(helper.effectiveProvider, 'claude'); assert.equal(helper.effectiveModel, 'claude-sonnet-reported'); assert.equal(helper.effectiveEffort, 'high'); assert.deepEqual(helper.fallback, []);
  assert.equal(answer.provider, 'claude'); assert.equal(answer.requestedModel, 'claude-sonnet-requested'); assert.equal(answer.effectiveModel, 'claude-sonnet-reported');
  assert.deepEqual(f.events.map(event => event.helper.status), ['running', 'complete']);
  assert.ok(f.events.every(event => event.messageId === 'parent-reply' && event.conversationId === 'parent'));
});

test('Claude delegates to ChatGPT and live selection updates the pinned parent card', async () => {
  const f = bidirectionalFixture('claude'); let child, release;
  f.a.execute = request => { child = request.conversationId; return new Promise(resolve => { release = resolve; }); };
  const pending = f.a.call('model_consult', { provider: 'codex', model: 'gpt-6-sol', effort: 'medium', task: 'Check the implementation' }, 'parent');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.a.observe({ type: 'chat.selection', conversationId: child, selection: { provider: 'codex', model: 'gpt-6-sol-reported', effort: 'high' } }), true);
  assert.equal(f.events.at(-1).helper.status, 'running'); assert.equal(f.events.at(-1).helper.effectiveProvider, 'codex'); assert.equal(f.events.at(-1).helper.effectiveModel, 'gpt-6-sol-reported'); assert.equal(f.events.at(-1).messageId, 'parent-reply');
  release({ text: 'ChatGPT review', selection: { provider: 'codex', model: 'gpt-6-sol-reported', effort: 'high' } }); await pending;
  const helper = f.run.message.helpers[0];
  assert.equal(helper.sourceProvider, 'claude'); assert.equal(helper.sourceModel, 'claude-sonnet-reported'); assert.equal(helper.requestedProvider, 'codex'); assert.equal(helper.requestedEffort, 'medium'); assert.equal(helper.effectiveEffort, 'high'); assert.equal(helper.status, 'complete');
  assert.equal(f.events[0].helper.effectiveModel, undefined); assert.equal(f.events[0].helper.status, 'running');
  assert.equal(f.a.observe({ type: 'chat.selection', conversationId: child, selection: { provider: 'claude', model: 'late-model' } }), false);
});

test('unreported model defaults stay explicitly requested and do not invent fallback receipts', async () => {
  const f = bidirectionalFixture('codex'); delete f.run.reportedSelection;
  f.a.getModels = () => ({ claude: [{ id: 'default', efforts: ['high'] }] });
  f.a.execute = async () => ({ text: 'Review without runtime selection' });
  const answer = JSON.parse((await f.a.call('model_consult', { provider: 'claude', model: 'default', effort: 'default', task: 'Review' }, 'parent')).content[0].text);
  const helper = f.run.message.helpers[0];
  assert.equal(helper.sourceModelSource, 'requested'); assert.equal(helper.requestedModel, 'default'); assert.equal(helper.requestedEffort, ''); assert.equal(helper.effectiveModel, undefined); assert.equal(helper.effectiveEffort, undefined); assert.deepEqual(helper.fallback, []);
  assert.equal(answer.effectiveModel, null); assert.match(answer.notice, /runtime did not report/);
});

test('native helper reroutes record bounded grounded attempts without changing the requested target', async () => {
  const f = bidirectionalFixture('claude'); let child, release;
  f.a.execute = request => { child = request.conversationId; return new Promise(resolve => { release = resolve; }); };
  const pending = f.a.call('model_consult', { provider: 'codex', task: 'Review' }, 'parent'); await new Promise(resolve => setImmediate(resolve));
  f.a.observe({ type: 'chat.selection', conversationId: child, selection: { provider: 'codex', model: 'gpt-6-sol', effort: 'medium' } });
  const event = { type: 'chat.nativeActivity', conversationId: child, activity: { kind: 'reroute', fromModel: 'gpt-6-sol', toModel: 'gpt-6-luna', reason: 'native usage fallback' } };
  f.a.observe(event); f.a.observe(event);
  assert.deepEqual(f.run.message.helpers[0].fallback, [{ provider: 'codex', model: 'gpt-6-luna', reason: 'native usage fallback' }]);
  assert.equal(f.run.message.helpers[0].requestedModel, 'gpt-6-sol'); assert.equal(f.run.message.helpers[0].effectiveModel, 'gpt-6-luna');
  assert.equal(f.run.message.helpers[0].effectiveEffort, null);
  for (let i = 0; i < 20; i++) f.a.observe({ ...event, activity: { ...event.activity, toModel: 'reported-model-' + i, reason: 'x'.repeat(2000) } });
  assert.equal(f.run.message.helpers[0].fallback.length, 8); assert.equal(f.run.message.helpers[0].fallback[0].reason.length, 400);
  release({ text: 'Review', selection: { provider: 'codex', model: 'reported-model-19' } }); await pending;
  assert.equal(f.run.message.helpers[0].effectiveModel, 'reported-model-19');
});

test('Stop immediately publishes cancellation and suppresses late selection and results', async () => {
  const f = bidirectionalFixture('claude'); let child, release, stops = 0;
  f.a.execute = request => { child = request.conversationId; return new Promise(resolve => { release = resolve; }); };
  const pending = f.a.call('model_consult', { provider: 'codex', task: 'Review' }, 'parent'); await new Promise(resolve => setImmediate(resolve));
  f.a.cancel('parent', () => { stops++; }); f.a.cancel('parent', () => { stops++; });
  assert.equal(stops, 1); assert.equal(f.events.at(-1).helper.status, 'cancelled'); assert.equal(f.a.parent(child), 'parent');
  assert.equal(f.a.observe({ type: 'chat.selection', conversationId: child, selection: { provider: 'codex', model: 'late-selection' } }), true);
  release({ text: 'late output', selection: { provider: 'codex', model: 'late-selection' } }); await assert.rejects(pending, /stopped/);
  assert.equal(f.run.message.helpers[0].status, 'cancelled'); assert.equal(f.run.message.helpers[0].text, undefined); assert.equal(f.run.message.helpers[0].effectiveModel, undefined); assert.equal(f.a.parent(child), undefined); assert.equal(f.a.entries.size, 0);
});

test('actual provider transitions explicitly clear old model and effort in partial metadata updates', async () => {
  const f = bidirectionalFixture('claude'); let child, release;
  f.a.execute = request => { child = request.conversationId; return new Promise(resolve => { release = resolve; }); };
  const pending = f.a.call('model_consult', { provider: 'codex', task: 'Review' }, 'parent'); await new Promise(resolve => setImmediate(resolve));
  f.a.observe({ type: 'chat.selection', conversationId: child, selection: { provider: 'codex', model: 'gpt-6-sol', effort: 'medium' } });
  f.a.observe({ type: 'chat.selection', conversationId: child, selection: { provider: 'claude', effort: 'high' } });
  const update = f.events.at(-1).helper;
  assert.equal(update.effectiveProvider, 'claude'); assert.equal(update.effectiveModel, null); assert.equal(update.effectiveEffort, 'high');
  assert.equal(update.requestedProvider, 'codex'); assert.equal(update.requestedModel, 'gpt-6-sol');
  assert.equal(f.events.at(-2).helper.effectiveModel, 'gpt-6-sol');
  release({ text: 'Review', selection: { provider: 'claude', model: 'claude-sonnet-reported' } }); await pending;
  assert.equal(f.run.message.helpers[0].effectiveProvider, 'claude'); assert.equal(f.run.message.helpers[0].effectiveModel, 'claude-sonnet-reported');
});

test('a replaced parent run cannot receive a helper selection or successful late completion', async () => {
  const f = bidirectionalFixture('codex'); let child, release;
  f.a.execute = request => { child = request.conversationId; return new Promise(resolve => { release = resolve; }); };
  const pending = f.a.call('model_consult', { provider: 'claude', task: 'Review' }, 'parent'); await new Promise(resolve => setImmediate(resolve));
  const replacement = { message: { id: 'new-reply' } }; f.a.getRun = () => replacement;
  f.a.observe({ type: 'chat.selection', conversationId: child, provider: 'claude', selection: { model: 'late-selection' } });
  release({ text: 'late output' }); await assert.rejects(pending, /stopped/);
  assert.equal(replacement.message.helpers, undefined); assert.equal(f.run.message.helpers[0].status, 'cancelled'); assert.equal(f.events.at(-1).messageId, 'parent-reply');
});

test('helper errors persist a bounded readable failure with no credential in card metadata', async () => {
  const f = bidirectionalFixture('codex'); f.a.execute = async () => { throw Error('native error api_key=sk-synthetic-key ' + 'x'.repeat(5000)); };
  await assert.rejects(f.a.call('model_consult', { provider: 'claude', task: 'Review' }, 'parent'), /native error/);
  const helper = f.run.message.helpers[0]; assert.equal(helper.status, 'failed'); assert.ok(helper.finishedAt); assert.equal(helper.error.length, 2000); assert.ok(!helper.error.includes('sk-synthetic-key')); assert.equal(f.a.routes.size, 0);
});

test('collaboration instructions name both Exomina provider routes and keep native helpers distinct', () => {
  assert.match(collaborationInstructions, /ChatGPT\/Codex chat can call model_consult with provider:"claude"/);
  assert.match(collaborationInstructions, /Claude chat can call it with provider:"codex"/);
  assert.match(collaborationInstructions, /provider-native subagents remain within their own provider/);
  assert.match(collaborationInstructions, /have no tools and cannot delegate further/);
});
