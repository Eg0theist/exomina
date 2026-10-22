import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { PermissionPolicy, normalizeRule, hostAction } from '../desktop/permissions.mjs';
import { PIPELINE_READ_TOOLS } from '../desktop/tool-pipeline.mjs';

const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
function extract(startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, 'actual desktop coordinator remains extractable');
  return source.slice(start, end);
}

test('actual pipeline dispatcher enforces original read denials and preserves browser policy before dispatch', async () => {
  const settings = { permissionMode: 'ask', permissionRules: [] }, calls = [];
  const policy = new PermissionPolicy({ getSettings: () => settings });
  const context = { PIPELINE_READ_TOOLS, hostAction, policy, callToolImpl: async (...args) => { calls.push(args); return { source: 'ordinary dispatcher' }; } };
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
    store: { state: { settings } },
    memoryApproval: () => () => {}, approve: () => {},
    memory: { call: async (...args) => { calls.push({ tool: 'memory_recall', args }); return { content: [{ type: 'text', text: 'fixture' }] }; } },
    terminalPty: undefined, updater: { merge: {} }, chatCompactor: undefined, connectorForms: undefined, appAnalysis: undefined, ghidraWorkspaces: undefined,
    browser: undefined, liveFollowups: undefined, userQuestions: undefined, assist: undefined, approvals: new Map(), providers: { cancel: () => {} }, imageSupport: undefined, apiAgent: undefined, workspaceTools: undefined,
  };
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

test('actual reply final cleanup aborts run tools and cancels workers before dropping the active run', async () => {
  const run = { toolController: new AbortController(), cancelled: false }, active = new Map([['chat', run]]), calls = [];
  const context = { active, c: { id: 'chat' }, message: {}, imageSupport: { finish: async () => {} }, restartRequested: null,
    store: { save: async () => {} }, noteTask: null, discoveryRun: null,
    workers: { cancel: id => calls.push({ id, stillActive: active.has(id), aborted: run.toolController.signal.aborted }) },
    connectorForms: undefined, browser: undefined, chatCompactor: undefined, approvals: new Map(), usagePoller: undefined, workPlans: undefined,
    runWaiters: new Map(), queues: new Map(), emit: () => {}, autoTitle: () => {}, drainQueue: () => {}, restartWhenIdle: () => {} };
  const start = source.indexOf('    finally{await imageSupport.finish(c.id).catch(()=>{});'), end = source.indexOf('\n  },50);', start);
  assert.ok(start >= 0 && end > start, 'actual final cleanup remains extractable');
  const finalClause = source.slice(start, end);
  vm.createContext(context);
  await vm.runInContext('(async function(){try{throw Error("provider terminated")}catch{}' + finalClause + '})()', context);
  assert.equal(run.toolController.signal.aborted, true); assert.equal(active.has('chat'), false);
  assert.deepEqual(calls, [{ id: 'chat', stillActive: true, aborted: true }]);
});
