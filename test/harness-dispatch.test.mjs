import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import { PermissionPolicy, normalizeRule, hostAction } from '../desktop/permissions.mjs';
import {assertFeature} from '../desktop/features.mjs';
import { PIPELINE_READ_TOOLS } from '../desktop/tool-pipeline.mjs';
import { ExternalMcpTools } from '../desktop/external-mcp.mjs';
import {ClientScopes} from '../desktop/client-scopes.mjs';
import {ClientRuntime} from '../desktop/client-runtime.mjs';

const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
function extract(startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, 'actual desktop coordinator remains extractable');
  return source.slice(start, end);
}

test('actual pipeline dispatcher enforces original read denials and preserves browser policy before dispatch', async () => {
  const settings = { permissionMode: 'ask', permissionRules: [] }, calls = [];
  const policy = new PermissionPolicy({ getSettings: () => settings });
  const context = { PIPELINE_READ_TOOLS, hostAction, policy,toolContext:new AsyncLocalStorage(), callToolImpl: async (...args) => { assert.equal(context.toolContext.getStore().hostTool,args[0]);calls.push(args); return { source: 'ordinary dispatcher' }; } };
  vm.createContext(context); vm.runInContext(extract('function authorizeReadTool(', '\nasync function hostTool('), context);
  for (const tool of ['notes_read', 'memory_recall']) {
    settings.permissionRules = [normalizeRule({ effect: 'deny', tool })];
    await assert.rejects(context.executePipelineRead(tool, tool === 'notes_read' ? { id: 'shared' } : { query: 'fixture' }, 'chat'), /Blocked by your rule/);
  }
  assert.equal(calls.length, 0);
  settings.permissionRules = [normalizeRule({ effect: 'allow', tool: 'memory_recall' })];
  await context.executePipelineRead('memory_recall', { query: 'fixture' }, 'chat');
  assert.deepEqual(calls, [['memory_recall', { query: 'fixture' }, 'chat']]);
  settings.permissionMode = 'read-only'; settings.permissionRules = [];
  await assert.rejects(context.executePipelineRead('browser_snapshot', { include_screenshot: false }, 'chat'), /Read only mode/);
  await context.executePipelineRead('notes_read', { id: 'shared' }, 'chat');
  assert.equal(calls.length, 2, 'ordinary reads dispatch without adding a second approval layer');
  await assert.rejects(context.executePipelineRead('workspace_shell', { command: 'ignored' }, 'chat'), /not an allowed pipeline read/);
});

function coordinator({ privateChat = false, scoped = false, pipelineError = false } = {}) {
  const run = { cancelled: false, toolController: new AbortController(), ...(scoped ? { noteWork: {} } : {}) }, active = new Map([['chat', run]]), calls = [];
  const settings = { permissionMode: 'full', permissionRules: [], memoryEnabled: true };
  const context = {
    active, isPrivateChat: () => privateChat, hostAction, PIPELINE_READ_TOOLS,
    policy: new PermissionPolicy({ getSettings: () => settings }),
    workers: { call: async (args, id, options) => { calls.push({ tool: 'worker_run', args, id, signal: options.signal }); return { exitCode: 0 }; }, cancel: id => calls.push({ cancelWorker: id }) },
    sharedSkills: { call: async (args, id) => { calls.push({ tool: 'skill_library', args, id }); return { skills: [] }; } },
    toolPipeline: { call: async (args, id, options) => { calls.push({ tool: 'tool_pipeline', args, id, signal: options.signal }); return pipelineError ? { status: 'failed', isError: true } : { status: 'completed' }; } },
    scratchpad: { readNotes: (...args) => { calls.push({ tool: 'notes_read', args }); return [{ id: 'fixture' }]; } },
    store: { state: { settings,conversations:[] } },
    clientScopes:{state:()=>({bindings:[]}),captureJob:id=>({chatId:id}),assertJob:()=>{}},
    memoryApproval: () => () => {}, approve: () => {},
    memory: { call: async (...args) => { calls.push({ tool: 'memory_recall', args }); return { content: [{ type: 'text', text: 'fixture' }] }; } },
    terminalPty: undefined, updater: { merge: {} }, chatCompactor: undefined, connectorForms: undefined, appAnalysis: undefined, ghidraWorkspaces: undefined,
    browser: undefined, liveFollowups: undefined, userQuestions: undefined, assist: undefined, approvals: new Map(), providers: { cancel: () => {} }, imageSupport: undefined, apiAgent: undefined, workspaceTools: undefined,
  };
  context.memoryFor=async()=>context.memory;
  vm.createContext(context);
  vm.runInContext(extract('function authorizeReadTool(', '\nasync function executePipelineRead('), context);
  vm.runInContext(extract('async function hostTool(', '\nasync function restartForUpdate('), context);
  vm.runInContext(extract('function cancel(id){', '\nconst permissionTool='), context);
  return { context, run, calls, settings };
}

test('actual host dispatcher reaches skill, worker and pipeline services and passes chat cancellation to jobs', async () => {
  const f = coordinator();
  await f.context.hostTool('skill_library', { action: 'catalog' }, 'chat');
  await f.context.hostTool('worker_run', { action: 'run', id: 'fixture', command: 'synthetic only' }, 'chat');
  await f.context.hostTool('tool_pipeline', { action: 'run', steps: [] }, 'chat');
  assert.deepEqual(f.calls.map(call => call.tool), ['skill_library', 'worker_run', 'tool_pipeline']);
  assert.equal(f.calls[1].signal, f.run.toolController.signal); assert.equal(f.calls[2].signal, f.run.toolController.signal);
  f.context.cancel('chat');
  assert.equal(f.run.toolController.signal.aborted, true); assert.equal(f.run.cancelled, true); assert.deepEqual(f.calls.at(-1), { cancelWorker: 'chat' });
  await assert.rejects(f.context.hostTool('worker_run', { action: 'list' }, 'chat'), /stopped/);
});

test('actual external host route uses the current chat run signal and preserves the MCP result', async () => {
  const f = coordinator(), expected = { content: [{ type: 'text', text: 'fixture' }], structuredContent: { connected: true } };
  f.context.external = { call: async (...args) => { f.calls.push(args); return expected; } };
  const replacement = { cancelled: false, toolController: new AbortController() };
  f.context.active.set('chat', replacement);
  for (const name of ['external_cua_fixture', 'external_suno_fixture']) {
    const input = { query: 'fixture' };
    assert.equal(await f.context.hostTool(name, input, 'chat'), expected);
    const [receivedName, receivedInput, id, options] = f.calls.at(-1);
    assert.equal(receivedName, name); assert.equal(receivedInput, input); assert.equal(id, 'chat');
    assert.equal(options.signal, replacement.toolController.signal);
    assert.notEqual(options.signal, f.run.toolController.signal);
  }
});

test('actual external host route refuses absent, stopped and already-aborted runs before dispatch', async () => {
  for (const state of ['missing', 'cancelled', 'aborted', 'private']) {
    const f = coordinator({ privateChat: state === 'private' });
    f.context.external = { call: async () => { f.calls.push('must not dispatch'); } };
    if (state === 'missing') f.context.active.delete('chat');
    if (state === 'cancelled') f.run.cancelled = true;
    if (state === 'aborted') f.run.toolController.abort();
    await assert.rejects(f.context.hostTool('external_suno_fixture', {}, 'chat'), /stopped|temporary chats/);
    assert.equal(f.calls.length, 0, state);
  }
});

test('actual external host route preserves invocation approval and Stop prevents dispatch after pending consent', async () => {
  const f = coordinator(), approvals = [], requests = [];
  const config = { id: 'synthetic', name: 'Synthetic remote', transport: 'http', url: 'https://example.test/mcp', enabled: true };
  f.settings.externalMcpServers = [config];
  let allow = true, release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const client = {
    dead: false, async connect() {}, async listTools() { return [{ name: 'echo', inputSchema: { type: 'object' } }]; },
    async request(...args) { requests.push(args); return { content: [{ type: 'text', text: 'approved fixture' }] }; }, async close() { this.dead = true; },
  };
  const external = new ExternalMcpTools({
    getSettings: () => f.settings, createRemoteClient: () => client,
    approve: async request => { approvals.push(request); if (allow === 'wait') { entered(); return new Promise(resolve => { release = resolve; }); } return allow; },
  });
  f.context.external = external;
  try {
    await external.refresh('chat');
    const name = external.definitions[0].name;
    allow = false;
    const declined = await f.context.hostTool(name, {}, 'chat');
    assert.equal(declined.isError, true); assert.match(declined.content[0].text, /did not approve/); assert.equal(requests.length, 0);
    allow = true;
    assert.equal((await f.context.hostTool(name, { text: 'fixture' }, 'chat')).content[0].text, 'approved fixture');
    assert.equal(requests.length, 1); assert.equal(requests[0][2].signal, f.run.toolController.signal);
    assert.equal(approvals.at(-1).requireConfirmation, true);
    allow = 'wait';
    const pending = f.context.hostTool(name, {}, 'chat');
    await ready; f.context.cancel('chat'); release(true);
    const stopped = await pending;
    assert.equal(stopped.isError, true); assert.match(stopped.content[0].text, /cancelled/);
    assert.equal(requests.length, 1, 'late approval must not reach the remote transport');
    assert.equal(client.dead, false, 'Stop must not close an unrelated shared connection');
  } finally { await external.close(); }
});

test('nested pipeline reads recheck their own feature after a pending approval',async()=>{
 const settings={disabledFeatures:[]},toolContext=new AsyncLocalStorage(),calls=[];
 let entered,release;const ready=new Promise(resolve=>entered=resolve);
 const context={PIPELINE_READ_TOOLS,hostAction,policy:{evaluate:()=>({decision:'allow'})},toolContext,store:{state:{settings}},assertFeature,assertNativeScope:()=>{},requestApproval:async()=>{entered();return new Promise(resolve=>release=resolve);}};
 context.callToolImpl=async name=>{assertFeature(name,settings);await context.approve({action:{tool:name}});calls.push(name);};
 vm.createContext(context);vm.runInContext(extract('const approve=','\nfunction cancel(')+'\nglobalThis.approve=approve;',context);vm.runInContext(extract('function authorizeReadTool(','\nasync function hostTool('),context);
 const pending=toolContext.run({hostTool:'tool_pipeline'},()=>context.executePipelineRead('browser_snapshot',{},'chat'));
 await ready;settings.disabledFeatures=['browser'];release({approved:true});await assert.rejects(pending,/turned off/);assert.equal(calls.length,0);
});

test('actual host dispatcher rejects private and scoped requests before any new service runs', async () => {
  for (const options of [{ privateChat: true }, { scoped: true }]) {
    const f = coordinator(options);
    for (const tool of ['skill_library', 'worker_run', 'tool_pipeline']) await assert.rejects(f.context.hostTool(tool, { action: 'read' }, 'chat'), /temporary chats|scoped note/);
    assert.equal(f.calls.length, 0);
  }
});

test('direct notes and memory reads enforce the same deny rules before reading source data', async () => {
  const f = coordinator();
  for (const tool of ['notes_read', 'memory_recall']) {
    f.settings.permissionRules = [normalizeRule({ effect: 'deny', tool })];
    await assert.rejects(f.context.hostTool(tool, { id: 'fixture', query: 'fixture' }, 'chat'), /Blocked by your rule/);
  }
  assert.equal(f.calls.length, 0);
  f.settings.permissionRules = [normalizeRule({ effect: 'allow', tool: 'notes_read' }), normalizeRule({ effect: 'allow', tool: 'memory_recall' })];
  await f.context.hostTool('notes_read', { id: 'fixture' }, 'chat');
  await f.context.hostTool('memory_recall', { query: 'fixture' }, 'chat');
  assert.deepEqual(f.calls.map(call => call.tool), ['notes_read', 'memory_recall']);
});

test('pipeline failures propagate through the actual host tool result envelope', async () => {
  const f = coordinator({ pipelineError: true });
  const result = await f.context.hostTool('tool_pipeline', { action: 'run', steps: [] }, 'chat');
  assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0].text).status, 'failed');
});
test('automatic memory capture never overrides an explicit memory-write denial',async()=>{
  const f=coordinator();f.settings.memoryCapture='automatic';f.settings.permissionRules=[normalizeRule({effect:'deny',tool:'memory_note'})];
  await assert.rejects(f.context.hostTool('memory_note',{text:'Synthetic note that must not be saved'},'chat'),/Blocked by your rule/);assert.equal(f.calls.length,0);
});
test('memory permission is rechecked after a save approval before writing',async()=>{
  const f=coordinator();let writes=0;f.context.memoryApproval=()=>async()=>{f.settings.permissionRules=[normalizeRule({effect:'deny',tool:'memory_note'})];return true;};f.context.memory.call=async(name,args,approve)=>{await approve({title:'fixture'});writes++;return {};};
  await assert.rejects(f.context.hostTool('memory_note',{text:'Must not cross a revoked approval'},'chat'),/Blocked by your rule/);assert.equal(writes,0);
});

test('removed Storage tools cannot dispatch through a stale tool catalogue', async () => {
  const f = coordinator();
  for (const name of ['disk_status','disk_scan','disk_read','disk_delete']) await assert.rejects(f.context.hostTool(name, {}, 'chat'), /Storage feature has been removed/);
  assert.equal(f.calls.length, 0);
});

test('actual reply final cleanup aborts run tools and cancels workers before dropping the active run', async () => {
  for (const failed of [false,true]) {
  const run = { toolController: new AbortController(), cancelled: false }, active = new Map([['chat', run]]), calls = [];
  const context = { active, c: { id: 'chat' }, message: failed?{error:'provider terminated'}:{}, imageSupport: { finish: async () => {} }, restartRequested: null,
    store: { save: async () => {} }, noteTask: null, discoveryRun: null, privateChat:false,scopedClient:false,payload:{},soulLearning:{notify:id=>calls.push({learn:id,stillActive:active.has(id)})},
    workers: { cancel: id => calls.push({ id, stillActive: active.has(id), aborted: run.toolController.signal.aborted }) },
    connectorForms: undefined, browser: undefined, chatCompactor: undefined, approvals: new Map(), usagePoller: undefined, workPlans: undefined,
    runWaiters: new Map(), queues: new Map(), emit: () => {}, autoTitle: () => {}, drainQueue: () => {}, restartWhenIdle: () => {} };
  const start = source.indexOf('    finally{await imageSupport.finish(c.id).catch(()=>{});'), end = source.indexOf('\n  },50);', start);
  assert.ok(start >= 0 && end > start, 'actual final cleanup remains extractable');
  const finalClause = source.slice(start, end);
  vm.createContext(context);
  await vm.runInContext('(async function(){try{throw Error("provider terminated")}catch{}' + finalClause + '})()', context);
  assert.equal(run.toolController.signal.aborted, true); assert.equal(active.has('chat'), false);
  assert.deepEqual(calls, [{ id: 'chat', stillActive: true, aborted: true },...(failed?[]:[{learn:'chat',stillActive:false}])]);
  }
});

test('actual outer dispatcher denies tools without a client adapter before any global host service',async()=>{
  const f=coordinator(),chats=[{id:'chat',projectId:'client-project'}];f.context.store.state.conversations=chats;f.context.store.save=async()=>{};
  const scopes=new ClientScopes({store:f.context.store,getPrincipal:()=> 'owner',getChat:id=>chats.find(chat=>chat.id===id),resourceExists:()=>true});
  const org=(await scopes.manage({action:'createOrganization',name:'Fixture agency'})).result,client=(await scopes.manage({action:'createClient',organizationId:org.id,name:'Fixture client'})).result;
  await scopes.manage({action:'bindResource',organizationId:org.id,clientId:client.id,kind:'project',id:'client-project'});
  f.context.clientScopes=scopes;f.context.clientRuntime=new ClientRuntime({scopes,dataDir:'.',getChats:()=>chats});f.context.assertNativeScope=()=>{};f.context.toolContext=new AsyncLocalStorage();f.context.assertFeature=assertFeature;
  let dispatches=0;f.context.hostTool=async()=>{dispatches++;};
  vm.runInContext(extract('async function callToolImpl(', '\nfunction authorizeReadTool('),f.context);
  for(const tool of ['archive_search','notes_read','worker_run','external_client_fixture'])await assert.rejects(f.context.callToolImpl(tool,{query:'secret'},'chat'),/no client-isolated adapter/);
  assert.equal(dispatches,0);
});
