import test from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOWUP_READ_TOOLS, followupReadDefinitions, readFollowupTool } from '../desktop/followup-tools.mjs';
import { LiveFollowups } from '../desktop/live-followups.mjs';
import { ApiAgent } from '../desktop/api-agent.mjs';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('side read allowlist excludes all actions, new tools, native permissions and model delegation', async () => {
  const denied = ['workspace_write', 'workspace_shell', 'notes_remove_completed', 'notes_annotate', 'browser_open', 'browser_click', 'browser_tab_new', 'memory_note', 'memory_nap', 'analysis_run', 'analysis_select', 'ghidra_query', 'request_permission', 'request_tools', 'model_consult', 'followup_update', 'handoff_save', 'external_read_file', 'future_read_tool'];
  const tools = ['workspace_read', 'conversation_find', 'browser_inspect', ...denied].map(name => ({ name }));
  assert.deepEqual(followupReadDefinitions(tools).map(tool => tool.name), ['workspace_read', 'conversation_find', 'browser_inspect']);
  let dispatched = 0;
  for (const name of denied) await assert.rejects(readFollowupTool({ item: {} }, name, {}, { live: () => true, dispatch: async () => { dispatched++; } }), /only use their read-only/);
  assert.equal(dispatched, 0); assert.ok(FOLLOWUP_READ_TOOLS.has('memory_recall'));
});
test('side reads are bounded and cancellation discards a late read', async () => {
  const work = { item: {} }; let live = true;
  const dispatch = async () => ({ content: [] });
  for (let index = 0; index < 12; index++) await readFollowupTool(work, 'workspace_read', {}, { live: () => live, dispatch });
  await assert.rejects(readFollowupTool(work, 'workspace_read', {}, { live: () => live, dispatch }), /read limit/);
  assert.equal(work.item.reads.length, 12);
  const late = { item: {} };
  await assert.rejects(readFollowupTool(late, 'workspace_read', {}, { live: () => live, dispatch: async () => { live = false; return { content: [] }; } }), /stopped/);
  assert.equal(late.item.reads[0].status, 'error');
});
test('follow-up reads use the owning active parent and stop with the side answer', async () => {
  const run = { message: { id: 'reply' } }; let finish;
  const agent = new LiveFollowups({ getRun: id => id === 'parent' ? run : undefined, getChat: () => ({ messages: [] }), prepare: async () => ({ selection: { provider: 'codex' }, prompt: 'Read the file.' }), steer: async () => false,
    execute: async request => { await agent.read(request.conversationId, 'workspace_read', { path: 'file.txt' }, async (_tool, _args, parent) => { assert.equal(parent, 'parent'); return { content: [] }; }); return new Promise(resolve => { finish = resolve; }); }, save: async () => {}, emit: () => {}, stop: () => {} });
  const { followup } = await agent.send({ conversationId: 'parent', text: 'Read the file.' });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.message.followups[0].reads[0].status, 'done');
  agent.cancelOne('parent', followup);
  await assert.rejects(agent.read(followup, 'workspace_read', {}, async () => { throw Error('Must not dispatch'); }), /stopped/);
  finish({ text: 'Late result' }); await agent.settle('parent');
  assert.equal(agent.readScope(followup), null);
});

test('a real streaming API side answer reads through the same bounded tool scope while the main task stays active', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-side-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'fixture.txt'), 'Actual API-side read evidence.', 'utf8');
  const run = { message: { id: 'main-reply' }, cancelled: false }; let requests = 0, reads = 0;
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
  const definitions = followupReadDefinitions([{ name: 'workspace_read', description: 'Read a fixture.', inputSchema: schema }, { name: 'workspace_write', inputSchema: schema }]);
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests++;
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['workspace_read']);
    const last = body.messages.at(-1);
    const delta = last.role === 'tool' ? { content: 'Checked: ' + last.content } : { tool_calls: [{ index: 0, id: 'read-once', type: 'function', function: { name: 'workspace_read', arguments: JSON.stringify({ path: 'fixture.txt' }) } }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: last.role === 'tool' ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const api = new ApiAgent({ getConnection: () => ({ protocol: 'openai', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'synthetic-side' }),
    callTool: (name, args, id) => followups.read(id, name, args, async (_name, input, parent) => { assert.equal(parent, 'main'); assert.equal(input.path, 'fixture.txt'); reads++; return { content: [{ type: 'text', text: await readFile(path.join(dir, input.path), 'utf8') }] }; }) });
  const followups = new LiveFollowups({ getRun: id => id === 'main' ? run : undefined, getChat: () => ({ messages: [] }), prepare: async () => ({ selection: { provider: 'openai-api' }, readOnlyTools: true, prompt: 'Check the fixture.' }),
    steer: async () => false, execute: input => api.run({ provider: input.selection.provider, conversationId: input.conversationId, prompt: input.prompt, toolDefinitions: definitions, ephemeral: true, noPersistence: true }), save: async () => {}, emit: () => {}, stop: id => api.cancel(id) });
  await followups.send({ conversationId: 'main', text: 'Check the fixture.' }); await followups.settle('main');
  const item = run.message.followups[0];
  assert.equal(item.status, 'answered'); assert.match(item.answer, /Actual API-side read evidence/); assert.equal(item.taskStatus, 'pending');
  assert.equal(reads, 1); assert.equal(requests, 2); assert.equal(run.cancelled, false);
});
