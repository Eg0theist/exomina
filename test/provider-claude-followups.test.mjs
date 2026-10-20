import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ProviderManager } from '../desktop/providers.mjs';

class Child extends EventEmitter {
  constructor() { super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.exitCode = null; this.signalCode = null; }
  json(value) { this.stdout.write(JSON.stringify(value) + '\n'); }
  kill() { if (this.signalCode || this.exitCode != null) return; this.signalCode = 'SIGTERM'; this.emit('close', null, 'SIGTERM'); }
  finish(code = 0) { this.exitCode = code; this.emit('close', code); }
}
async function fixture(t, spawnImpl = () => new Child()) {
  const base = path.resolve(process.cwd()), dataDir = await mkdtemp(path.join(base, 'claude-followups-test-'));
  const events = [], calls = [], children = [];
  const manager = new ProviderManager({ dataDir, workspace: dataDir, claudePath: process.execPath, isProviderEnabled: () => true,
    gateway: { url: 'http://127.0.0.1:1', token: 'synthetic-token', script: path.join(dataDir, 'gateway.mjs') },
    toolDefinitions: [{ name: 'memory_note', description: 'Synthetic memory', inputSchema: { type: 'object' } }],
    emit: event => events.push(event), spawnImpl: (executable, args, options) => {
      const child = spawnImpl(executable, args, options); calls.push({ args, options }); children.push(child); return child;
    } });
  manager.adapters.clear(); manager.claudeFreshAt = Date.now();
  t.after(async () => {
    const stopped = children.filter(child => Number.isInteger(child.pid) && child.exitCode == null && child.signalCode == null)
      .map(child => new Promise(resolve => child.once('close', resolve)));
    manager.close(); await Promise.all(stopped);
    assert.equal(path.dirname(dataDir), base); assert.match(path.basename(dataDir), /^claude-followups-test-/);
    await rm(dataDir, { recursive: true, force: true });
  });
  return { manager, events, calls, children, dataDir };
}
async function started(f, id = 'chat') {
  while (!f.manager.active.get(id)?.claudeInput) await new Promise(resolve => setImmediate(resolve));
  return { state: f.manager.active.get(id), child: f.children.at(-1) };
}
const ID = '17003897-99c2-47eb-ae98-4a7c7e9f1660';

test('Claude live native helper receipts report execution identity and never join child output into the root reply', async t => {
  const f = await fixture(t), task = f.manager.run({provider: 'claude', conversationId: 'chat', messageId: 'owning-reply', prompt: 'Original task.'});
  const {child} = await started(f);
  child.json({type: 'system', subtype: 'init', session_id: 'session', model: 'actual-main-model'});
  child.json({type: 'assistant', session_id: 'session', message: {id: 'main', content: [{type: 'tool_use', id: 'native-spawn', name: 'Task', input: {prompt: 'Inspect the parser.', model: 'sonnet', description: 'Parser review'}}]}});
  child.json({type: 'system', subtype: 'task_started', session_id: 'session', task_id: 'native-task', tool_use_id: 'native-spawn', task_type: 'local_agent', description: 'Parser review', is_backgrounded: true});
  child.json({type: 'stream_event', session_id: 'session', parent_tool_use_id: 'native-spawn', event: {type: 'message_start', message: {model: 'actual-helper-model'}}});
  child.json({type: 'stream_event', session_id: 'session', parent_tool_use_id: 'native-spawn', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'Child-only reply.'}}});
  child.json({type: 'system', subtype: 'task_notification', session_id: 'session', task_id: 'native-task', status: 'completed', summary: 'Parser inspected.'});
  child.json({type: 'result', subtype: 'success', session_id: 'session', result: 'Root reply.'}); child.finish();
  assert.equal((await task).text, 'Root reply.');
  const helpers = f.events.filter(event => event.type === 'chat.helper').map(event => event.helper);
  assert.ok(f.events.filter(event => event.type === 'chat.helper' || event.type === 'chat.selection').every(event => event.messageId === 'owning-reply'));
  assert.equal(helpers.at(-1).effectiveModel, 'actual-helper-model'); assert.equal(helpers.at(-1).requestedModel, 'sonnet');
  assert.equal(helpers.at(-1).sourceModel, 'actual-main-model'); assert.equal(helpers.at(-1).status, 'complete');
  assert.equal(f.events.some(event => event.type === 'chat.delta' && event.text === 'Child-only reply.'), false);
  assert.ok(f.events.some(event => event.type === 'chat.selection' && event.selection.model === 'actual-main-model'));
});

test('a read-only Claude follow-up keeps its Exomina read tools callable; a read-only tool run still plans', async t => {
  const f = await fixture(t); f.manager.getPermissionMode = () => 'read-only';
  const mode = args => args[args.indexOf('--permission-mode') + 1];
  const side = f.manager.run({provider: 'claude', conversationId: 'side', prompt: 'Follow-up.', hostToolsOnly: true, ephemeral: true, toolDefinitions: [{ name: 'workspace_list', description: 'Synthetic read', inputSchema: { type: 'object' } }]});
  const {child} = await started(f, 'side');
  const args = f.calls.at(-1).args;
  // Plan mode refuses every MCP tool; with no native tools the gateway's read scope is the boundary.
  assert.equal(mode(args), 'manual'); assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__exomina__workspace_list');
  child.json({type: 'result', subtype: 'success', session_id: 's', result: 'Answer.'}); child.finish(); await side;
  const main = f.manager.run({provider: 'claude', conversationId: 'chat', prompt: 'Main task.'});
  const second = await started(f);
  assert.equal(mode(f.calls.at(-1).args), 'plan');
  second.child.json({type: 'result', subtype: 'success', session_id: 's2', result: 'Done.'}); second.child.finish(); await main;
});

test('Claude Stop emits native helper cancellation and late child receipts cannot replace the new run', async t => {
  const f = await fixture(t), task = f.manager.run({provider: 'claude', conversationId: 'chat', prompt: 'Original task.'});
  const rejection = assert.rejects(task, /Stopped/), {child} = await started(f);
  child.json({type: 'assistant', message: {id: 'main', content: [{type: 'tool_use', id: 'native-spawn', name: 'Agent', input: {prompt: 'Pending native task.'}}]}});
  f.manager.cancel('chat'); await rejection;
  const helper = f.events.filter(event => event.type === 'chat.helper').at(-1).helper;
  assert.equal(helper.status, 'cancelled'); assert.equal(helper.effectiveModel, undefined);
  const count = f.events.filter(event => event.type === 'chat.helper').length;
  child.json({type: 'assistant', parent_tool_use_id: 'native-spawn', message: {model: 'late-model', content: []}});
  assert.equal(f.events.filter(event => event.type === 'chat.helper').length, count);
});

test('Claude live steering retains the subscription, resume and scoped MCP setup and requires receipt', async t => {
  const f = await fixture(t), task = f.manager.run({ provider: 'claude', conversationId: 'chat', prompt: 'Original task.', sessionId: 'saved-session' });
  const { state, child } = await started(f), frames = [];
  child.stdin.on('data', chunk => frames.push(JSON.parse(chunk.toString())));
  assert.equal(child.stdin.writableEnded, false);
  assert.ok(f.calls[0].args.includes('--replay-user-messages'));
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('--resume') + 1], 'saved-session');
  const config = JSON.parse(await readFile(state.configPath, 'utf8'));
  assert.equal(config.mcpServers.exomina.env.EXOMINA_TOOL_CONVERSATION, 'chat');
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('--permission-prompt-tool') + 1], 'mcp__exomina__request_permission');
  let received = false;
  const steering = f.manager.steer('chat', { prompt: 'Apply the extra correction.', messageId: ID, images: [{ mimeType: 'image/png', dataBase64: 'aW1hZ2U=' }] });
  steering.then(() => { received = true; }); await Promise.resolve(); assert.equal(received, false);
  const followupFrames = frames.filter(frame => frame.uuid === ID);
  assert.equal(followupFrames.length, 1); assert.equal(followupFrames[0].session_id, 'saved-session');
  assert.equal(followupFrames[0].message.content[1].source.data, 'aW1hZ2U=');
  child.json({ type: 'user', isReplay: true, uuid: ID, session_id: 'saved-session', parent_tool_use_id: null, message: followupFrames[0].message });
  assert.equal(await steering, true);
  child.json({ type: 'result', subtype: 'success', result: 'Both completed.', session_id: 'saved-session', user_message_uuids: [ID] });
  assert.equal(child.stdin.writableEnded, true); assert.equal(await f.manager.steer('chat', { prompt: 'Too late.' }), false);
  child.finish(); assert.equal((await task).text, 'Both completed.');
});

test('Claude closes pending receipts immediately on Stop and cannot dispatch late input', async t => {
  const f = await fixture(t), task = f.manager.run({ provider: 'claude', conversationId: 'chat', prompt: 'Original task.' });
  const rejection = assert.rejects(task, /Stopped/), { child } = await started(f);
  const steering = f.manager.steer('chat', { prompt: 'Queued correction.', messageId: ID });
  f.manager.cancel('chat'); assert.equal(await steering, false); await rejection;
  child.json({ type: 'user', isReplay: true, uuid: ID, session_id: 'session' });
  assert.equal(await f.manager.steer('chat', { prompt: 'Late correction.' }), false);
});

test('Claude abrupt output errors reject task and pending receipt without leaking to its next run', async t => {
  const f = await fixture(t), task = f.manager.run({ provider: 'claude', conversationId: 'chat', prompt: 'Original task.' });
  const taskFailure = assert.rejects(task, /Synthetic pipe failure/), { child } = await started(f);
  const steering = f.manager.steer('chat', { prompt: 'Queued correction.', messageId: ID }), steerFailure = assert.rejects(steering, /Synthetic pipe failure/);
  assert.doesNotThrow(() => child.stdout.emit('error', Error('Synthetic pipe failure')));
  await Promise.all([taskFailure, steerFailure]); assert.equal(f.manager.active.has('chat'), false);
  const next = f.manager.run({ provider: 'claude', conversationId: 'chat', prompt: 'Resume after pipe failure.' });
  const newer = await started(f); newer.child.json({ type: 'result', subtype: 'success', result: 'Recovered.', session_id: 'new-session' }); newer.child.finish();
  assert.equal((await next).text, 'Recovered.'); assert.equal(f.children.length, 2);
});

test('Claude refuses cross-session streaming events and unrequested native control approval', async t => {
  const f = await fixture(t), task = f.manager.run({ provider: 'claude', conversationId: 'chat', prompt: 'Original task.' });
  const failure = assert.rejects(task, /different native conversation/), { child } = await started(f), frames = [];
  child.stdin.on('data', chunk => frames.push(JSON.parse(chunk.toString())));
  child.json({ type: 'system', subtype: 'init', session_id: 'correct-session' });
  child.json({ type: 'control_request', request_id: 'unexpected-approval', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  await new Promise(resolve => setImmediate(resolve));
  const response = frames.find(frame => frame.type === 'control_response');
  assert.equal(response.response.subtype, 'error');
  assert.match(response.response.error, /permission approval remains with Exomina/);
  child.json({ type: 'assistant', session_id: 'another-session', message: { content: [{ type: 'text', text: 'Wrong output.' }] } });
  await failure; assert.equal(f.events.some(event => event.text === 'Wrong output.'), false);
});

test('Claude emits stable latest-request context activity separately from cumulative provider totals', async t => {
  const f = await fixture(t), task = f.manager.run({ provider: 'claude', conversationId: 'chat', prompt: 'Original task.' });
  const { child, state } = await started(f);
  child.json({ type: 'system', subtype: 'init', session_id: 'usage-session' });
  child.json({ type: 'stream_event', session_id: 'usage-session', event: { type: 'message_start', message: { id: 'latest', model: 'claude-exact', usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 3000, output_tokens: 0 } } } });
  child.json({ type: 'stream_event', session_id: 'usage-session', event: { type: 'message_delta', usage: { output_tokens: 100 } } });
  child.json({ type: 'result', subtype: 'success', result: 'Done.', session_id: 'usage-session', usage: { input_tokens: 99999999 }, modelUsage: { 'claude-exact': { inputTokens: 1000000, cacheReadInputTokens: 2000000, cacheCreationInputTokens: 3000000, outputTokens: 100000, contextWindow: 200000 } } });
  await new Promise(resolve => setImmediate(resolve));
  const snapshots = f.events.filter(event => event.type === 'chat.nativeActivity').map(event => event.activity);
  assert.equal(snapshots.length, 3); assert.ok(snapshots.every(snapshot => snapshot.turnId === state.claudeActivityTurnId));
  assert.ok(snapshots.every(snapshot => snapshot.threadId === 'usage-session' && snapshot.provider === 'claude'));
  assert.equal(snapshots.at(-1).last.inputTokens, 6000); assert.equal(snapshots.at(-1).last.outputTokens, 100);
  assert.equal(snapshots.at(-1).total.inputTokens, 6000000); assert.equal(snapshots.at(-1).modelContextWindow, 200000);
  child.finish(); assert.equal((await task).text, 'Done.');
});

test('a real isolated synthetic Claude process drains queued follow-ups after its first result', async t => {
  // This is protocol/process QA only. It launches Node, never a model or an
  // authenticated Claude profile, and mimics queued-turn behavior on real pipes.
  const script = `let buffer='',first=true,turnTimer;const messages=[];const output=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const frame=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(frame.type!=='user')continue;messages.push(frame);
      if(first){first=false;output({type:'system',subtype:'init',session_id:'synthetic-session'});output({type:'assistant',session_id:'synthetic-session',message:{id:'initial',content:[{type:'text',text:'Working.'}]}});turnTimer=setTimeout(()=>output({type:'result',subtype:'success',result:'Initial result.',session_id:'synthetic-session',user_message_uuid:frame.uuid}),250);}
      output({...frame,session_id:'synthetic-session',isReplay:true});}});
    process.stdin.on('end',()=>{clearTimeout(turnTimer);output({type:'result',subtype:'success',session_id:'synthetic-session',user_message_uuids:messages.map(frame=>frame.uuid),result:JSON.stringify({count:messages.length,prompts:messages.map(frame=>frame.message.content[0].text),images:messages.at(-1).message.content.filter(block=>block.type==='image').length})});});`;
  const f = await fixture(t, (_executable, _args, options) => spawn(process.execPath, ['-e', script], options));
  const task = f.manager.run({ provider: 'claude', conversationId: 'chat', prompt: 'Complete original task.' });
  await started(f);
  while (!f.events.some(event => event.text === 'Working.')) await new Promise(resolve => setImmediate(resolve));
  const request = { prompt: 'Preserve filenames and apply correction.', messageId: ID, images: [{ mimeType: 'image/png', dataBase64: 'aW1hZ2U=' }] };
  const first = f.manager.steer('chat', request), duplicate = f.manager.steer('chat', request);
  assert.equal(await first, true); assert.equal(await duplicate, true);
  assert.equal(f.children[0].stdin.writableEnded, false);
  const result = JSON.parse((await task).text);
  assert.deepEqual(result, { count: 2, prompts: ['Complete original task.', request.prompt], images: 1 });
  assert.equal(f.manager.active.has('chat'), false); assert.equal(f.children[0].exitCode, 0);
});
