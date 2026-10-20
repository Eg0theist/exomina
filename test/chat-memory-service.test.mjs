import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatMemoryTree } from '../desktop/chat-memory-tree.mjs';
import { ChatMemoryCompactor } from '../desktop/chat-memory-compactor.mjs';
import { ChatMemoryService } from '../desktop/chat-memory-service.mjs';
import { attachmentReferences, clipToolHistory, historyObject, historyText, recordableTool, splitHistory, toolResultHistory } from '../desktop/chat-memory-records.mjs';
import { chatViewBlocks, formatChatView } from '../desktop/chat-memory-context.mjs';
import { ConversationTools } from '../desktop/conversation-tools.mjs';

const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.verification', 'chat-memory-service-tests');
const unpack = response => JSON.parse(response.content[0].text);
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'synthetic-'));
  const tree = new ChatMemoryTree(directory, options.treeOptions);
  const settings = { chatMemoryEnabled: true, chatMemorySummaries: true };
  const notifications = [], statuses = [];
  const compactor = options.summarize ? new ChatMemoryCompactor({ tree, available: () => [{ provider: 'codex', model: 'gpt-luna', role: 'light', available: true, efforts: ['low'] }], summarize: options.summarize }) : { notify: chatId => notifications.push(chatId), stats: () => ({ state: 'idle' }), close: async () => {} };
  const service = new ChatMemoryService({ tree, compactor, settings: () => settings, onStatus: value => statuses.push(value), ...options.serviceOptions });
  t.after(async () => {
    await service.close();
    const target = path.resolve(directory);
    assert.ok(target.startsWith(parent + path.sep) && path.basename(target).startsWith('synthetic-'));
    await rm(target, { recursive: true, force: true });
  });
  return { tree, service, settings, compactor, notifications, statuses, directory };
}
async function originals(tree, chatId) {
  const rows = [], stats = await tree.stats(chatId);
  for (let id = 0; id < stats.total; id++) rows.push(await tree.zoom(chatId, id, 1, { limit: 32000 }));
  return rows;
}

test('transcript sync is idempotent and legacy timestamps remain unknown instead of using chat dates', async t => {
  const f = await fixture(t);
  const chat = { id: 'chat', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2026-10-08T10:00:00Z', messages: [
    { id: 'legacy-user', role: 'user', content: 'Legacy decision: retain the original source.' },
    { id: 'dated-assistant', role: 'assistant', content: 'Verified response.', createdAt: '2026-10-08T10:00:01Z', finishedAt: '2026-10-08T10:00:02Z' }
  ] };
  await f.service.sync(chat); const before = await f.tree.stats('chat');
  await f.service.sync(chat); await f.service.sync(chat);
  assert.equal((await f.tree.stats('chat')).total, before.total);
  assert.equal(before.total, 2);
  assert.deepEqual(await f.tree.date('chat', 0), { chatId: 'chat', id: 0, count: 1, first: null, last: null });
  assert.equal((await f.tree.date('chat', 1)).first, '2026-10-08T10:00:01.000Z');
  const source = await f.tree.zoom('chat', 0, 1);
  assert.equal(source.metadata.dateKnown, false); assert.equal(source.metadata.legacy, true);
});

test('changed legacy observations remain append-only and do not stop transcript catch-up after restart',async t=>{
  const f=await fixture(t),message={id:'old-reply',role:'assistant',content:'Saved answer.',activity:[{id:'step',kind:'note',text:'Started.'}]},chat={id:'chat',messages:[message]};
  await f.service.sync(chat);const before=await originals(f.tree,'chat');
  message.activity[0].text='Verified completion.';
  await f.service.sync(chat);
  let rows=await originals(f.tree,'chat');assert.equal(f.service.failures,0);assert.equal(rows.length,before.length+1);assert.equal(rows[0].text,'Started.');assert.equal(rows.at(-1).text,'Verified completion.');assert.equal(rows.at(-1).metadata.revisedObservation,true);
  f.service.seen.clear();f.service.imported.clear();await f.service.sync(chat);assert.equal((await f.tree.stats('chat')).total,rows.length);
  await f.service.append('chat',{key:'strict-source',kind:'user',text:'First.'});f.service.seen.clear();await f.service.append('chat',{key:'strict-source',kind:'user',text:'Changed.'});assert.equal(f.service.failures,1,'Unrecognised event-key collisions still fail.');
});

test('direct inspection waits for already queued recording and reports coverage without importing or summarising',async t=>{
  const f=await fixture(t);let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  f.service.enqueue(async()=>{started();await new Promise(resolve=>{release=resolve;});await f.service.record('chat',{key:'source',kind:'user',text:'Retained decision.'});});
  await entered;let done=false;const snapshot=f.service.inspectSnapshot('chat').then(value=>{done=true;return value;});await nextTurn();assert.equal(done,false);release();
  const view=await snapshot;assert.equal(view.total,1);assert.equal(view.coverage.transcriptSynced,false);assert.equal(view.coverage.throughMessages,0);assert.equal(view.coverage.pendingRecording,false);assert.deepEqual(f.notifications,['chat']);
});

test('active assistant transcripts are deferred until finished, then recorded once', async t => {
  let active = true;
  const f = await fixture(t, { serviceOptions: { isActive: () => active } });
  const assistant = { id: 'reply', role: 'assistant', content: 'Partially streamed reply.' };
  const chat = { id: 'chat', messages: [{ id: 'question', role: 'user', content: 'Question.' }, assistant] };
  await f.service.sync(chat);
  assert.equal((await f.tree.stats('chat')).total, 1);
  assistant.content = 'Completed reply.'; assistant.finishedAt = '2026-10-08T10:01:02Z'; active = false;
  await f.service.finish(chat); await f.service.sync(chat);
  assert.equal((await f.tree.stats('chat')).total, 2);
  assert.equal((await f.tree.zoom('chat', 1, 1)).text, 'Completed reply.');
});
test('question cards and late user answers remain source-linked and searchable',async t=>{
  const f=await fixture(t),group={id:'question-card',status:'answered',createdAt:'2026-10-09T10:00:00Z',answeredAt:'2026-10-09T10:01:30Z',questions:[{id:'choice',question:'Which colour?',options:[{label:'Blue'}]}],answers:{choice:{answers:['Violet']}}};
  f.service.providerEvent({type:'chat.question',conversationId:'chat',question:group});await f.service.queue;await f.service.recordQuestion('chat',group);
  const rows=await originals(f.tree,'chat');assert.equal(rows.length,2);assert.equal(rows[0].kind,'assistant');assert.equal(rows[1].kind,'user');assert.match(rows[0].text,/Which colour/);assert.match(rows[1].text,/Violet/);assert.equal(rows[1].metadata.questionId,'question-card');
  const chats=[{id:'chat',messages:[{id:'reply',role:'assistant',content:'Done.',questions:[group]}]}],tools=new ConversationTools({getConversations:()=>chats,getMemoryEnabled:()=>false});
  const result=await tools.call('conversation_read',{messageId:'reply'},'chat');assert.match(JSON.stringify(result),/Which colour.*Violet/s);
});

test('deferred legacy assistant activity is captured when the reply finishes', async t => {
  let active = true;
  const f = await fixture(t, { serviceOptions: { isActive: () => active } });
  const assistant = { id: 'legacy-reply', role: 'assistant', content: 'Partial legacy answer.', activity: [{ id: 'read', kind: 'tool', name: 'workspace_read', input: '{"path":"source.txt"}', output: 'Legacy source output.' }, { id: 'note', kind: 'note', text: 'Legacy verification completed.' }] };
  const chat = { id: 'chat', messages: [{ id: 'question', role: 'user', content: 'Question.' }, assistant] };
  await f.service.sync(chat); active = false; assistant.finishedAt = '2026-10-08T10:01:02Z'; assistant.content = 'Legacy completed answer.';
  await f.service.finish(chat); await f.service.sync(chat);
  const rows = await originals(f.tree, 'chat');
  assert.deepEqual(rows.map(row => row.kind), ['user', 'tool', 'echo', 'assistant', 'assistant']);
  assert.equal(rows[2].text, 'Legacy source output.'); assert.equal(rows[3].text, 'Legacy verification completed.');
});

test('dated live assistant timelines do not duplicate the full native event journal', async t => {
  const f = await fixture(t);
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', name: 'read_file', id: 'live-read', input: { path: 'source.txt' }, output: 'Complete native source result.' }, 'live-run');
  await f.service.queue;
  const chat = { id: 'chat', messages: [{ id: 'dated-assistant', role: 'assistant', content: 'Final live answer.', createdAt: '2026-10-08T12:00:00Z', finishedAt: '2026-10-08T12:00:02Z', activity: [{ id: 'legacy-read', kind: 'tool', name: 'read_file', input: '{"path":"source.txt"}', output: 'Clipped native result.' }] }] };
  await f.service.sync(chat); await f.service.sync(chat);
  const rows = await originals(f.tree, 'chat');
  assert.deepEqual(rows.map(row => row.kind), ['tool', 'echo', 'assistant']);
  assert.equal(rows[1].text, 'Complete native source result.');
  assert.ok(!JSON.stringify(rows).includes('Clipped native result'));
});

test('visible narration, tool calls and echoes retain their event order and omit hidden reasoning', async t => {
  const f = await fixture(t);
  const event = value => f.service.providerEvent({ conversationId: 'chat', provider: 'codex', ...value }, 'run-1');
  event({ type: 'chat.delta', text: 'I inspected the source. ' });
  event({ type: 'chat.thinking', text: 'HIDDEN_THOUGHT' });
  event({ type: 'chat.tool', id: 'native-tool', name: 'read_file', input: { path: '/project/source.mjs' }, output: 'Source output.' });
  event({ type: 'chat.delta', text: 'Next I verified the report.' });
  await f.service.hostCall('chat', 'host-1', 'workspace_read', { path: 'report.md' });
  await f.service.hostResult('chat', 'host-1', 'workspace_read', 'Verified report output.');
  await f.service.queue;
  const rows = await originals(f.tree, 'chat');
  assert.deepEqual(rows.map(row => row.kind), ['assistant', 'tool', 'echo', 'assistant', 'tool', 'echo']);
  assert.deepEqual(rows.map(row => row.text), ['I inspected the source. ', 'read_file\n{"path":"/project/source.mjs"}', 'Source output.', 'Next I verified the report.', 'workspace_read\n{"path":"report.md"}', 'Verified report output.']);
  assert.ok(!JSON.stringify(rows).includes('HIDDEN_THOUGHT'));
});

test('unnamed native completions preserve security and authentication exclusions from their initial names', async t => {
  const f = await fixture(t);
  for (const [id, name] of [['security-tool', 'security_export'], ['auth-tool', 'provider_login']]) {
    f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id, name, input: { request: 'AUTH_INPUT_SECRET' }, status: 'working' }, 'run-1');
    f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id, output: 'AUTH_OUTPUT_SECRET', historyOutput: 'AUTH_HISTORY_SECRET', status: 'done' }, 'run-1');
  }
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id: 'never-seen', output: 'UNKNOWN_OUTPUT_SECRET', status: 'done' }, 'run-1');
  await f.service.queue;
  assert.equal((await f.tree.stats('chat')).total, 0);
});

test('native host-tool completion without a name does not duplicate the authoritative host result', async t => {
  const f = await fixture(t, { serviceOptions: { isHostTool: name => name === 'workspace_read' } });
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id: 'native-host', name: 'workspace_read', input: { path: 'report.txt' }, status: 'working' }, 'run-1');
  await f.service.hostCall('chat', 'host-call', 'workspace_read', { path: 'report.txt' });
  await f.service.hostResult('chat', 'host-call', 'workspace_read', 'Complete authoritative host result.');
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id: 'native-host', output: 'Duplicate cropped runtime result.', status: 'done' }, 'run-1');
  await f.service.queue;
  const rows = await originals(f.tree, 'chat');
  assert.deepEqual(rows.map(row => row.kind), ['tool', 'echo']);
  assert.equal(rows[1].text, 'Complete authoritative host result.');
  assert.ok(!JSON.stringify(rows).includes('Duplicate cropped runtime result'));
});

test('ordinary unnamed native completion retains its full result tail and tool attribution', async t => {
  const f = await fixture(t);
  const output = 'HEAD_NATIVE_RESULT\n' + 'Source evidence. '.repeat(1000) + '\nTAIL_NATIVE_REFERENCE /project/verified.mjs';
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id: 'ordinary-read', name: 'read_file', input: { path: 'source.txt' }, status: 'working' }, 'run-1');
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id: 'ordinary-read', output: 'Cropped visible output.', historyOutput: output, status: 'done' }, 'run-1');
  await f.service.queue;
  const rows = await originals(f.tree, 'chat');
  assert.deepEqual(rows.map(row => row.kind), ['tool', 'echo']);
  assert.equal(rows[1].text, output); assert.equal(rows[1].metadata.tool, 'read_file');
  assert.ok(rows[1].text.endsWith('TAIL_NATIVE_REFERENCE /project/verified.mjs'));
  assert.ok(!JSON.stringify(rows).includes('Cropped visible output'));
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id: 'ordinary-read', output: 'Unrecognized other-run output.', status: 'done' }, 'different-run');
  await f.service.queue;
  assert.equal((await f.tree.stats('chat')).total, 2, 'Tool names must not leak across runs sharing a runtime item id.');
  await f.service.finish({ id: 'chat', messages: [] });
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id: 'ordinary-read', output: 'Late finished-run output.', status: 'done' }, 'run-1');
  await f.service.queue;
  assert.equal((await f.tree.stats('chat')).total, 2, 'Completed-run tool maps must be cleared.');
});

test('completed helper events remain idempotent through transcript finish and a process-style restart', async t => {
  const f = await fixture(t);
  const helper = { id: 'helper-1', provider: 'codex', model: 'gpt-luna', effectiveModel: 'gpt-luna', status: 'complete', text: 'Reviewed the exact /project/source.mjs reference.', finishedAt: '2026-10-08T12:00:02Z' };
  f.service.emitted({ type: 'chat.helper', conversationId: 'chat', helper }); await f.service.queue;
  const chat = { id: 'chat', messages: [{ id: 'reply', role: 'assistant', content: 'Completed parent reply.', createdAt: '2026-10-08T12:00:00Z', finishedAt: '2026-10-08T12:00:03Z', helpers: [helper] }] };
  await f.service.finish(chat); await f.service.sync(chat);
  assert.equal(f.service.failures, 0); assert.equal((await f.tree.stats('chat')).total, 2);
  const before = await originals(f.tree, 'chat');
  await f.service.close();
  const tree = new ChatMemoryTree(f.directory), restarted = new ChatMemoryService({ tree, settings: () => f.settings });
  try {
    await restarted.sync(chat); await restarted.sync(chat);
    assert.equal(restarted.failures, 0); assert.equal((await tree.stats('chat')).total, 2);
    assert.deepEqual(await originals(tree, 'chat'), before);
  } finally { await restarted.close(); }
});

test('repeated follow-up resolutions retain distinct known timestamps without immutable source conflicts', async t => {
  const f = await fixture(t);
  const first = { id: 'followup-1', question: 'Use the revised project path.', queuedAt: '2026-10-08T12:00:00Z', taskStatus: 'handled', summary: 'Applied and verified /project/new.', taskUpdatedAt: '2026-10-08T12:00:01Z' };
  const second = { ...first, taskUpdatedAt: '2026-10-08T12:00:05Z' };
  f.service.emitted({ type: 'chat.followup', conversationId: 'chat', followup: first }); await f.service.queue;
  f.service.emitted({ type: 'chat.followup', conversationId: 'chat', followup: second }); await f.service.queue;
  const chat = { id: 'chat', messages: [{ id: 'reply', role: 'assistant', content: '', followups: [second] }] };
  await f.service.finish(chat); await f.service.sync(chat);
  assert.equal(f.service.failures, 0);
  const resolutions = (await originals(f.tree, 'chat')).filter(row => row.kind === 'work');
  assert.equal(resolutions.length, 2);
  assert.deepEqual(resolutions.map(row => row.date), ['2026-10-08T12:00:01.000Z', '2026-10-08T12:00:05.000Z']);
  assert.equal(resolutions[0].text, resolutions[1].text);
});

test('auth calls, thought metadata and binary payloads stay out of recorded tool history', async t => {
  const f = await fixture(t);
  await f.service.hostCall('chat', 'auth-1', 'subscription_login', { password: 'AUTH_INPUT_SECRET' });
  await f.service.hostResult('chat', 'auth-1', 'subscription_login', 'AUTH_OUTPUT_SECRET');
  assert.equal((await f.tree.stats('chat')).total, 0);
  await f.service.hostCall('chat', 'read-1', 'workspace_read', { path: 'report.md', api_key: 'KEY_SECRET', nested: { reasoning: 'THOUGHT_SECRET', dataBase64: 'PIXELS_SECRET', session_token: 'TOKEN_SECRET' } });
  await f.service.hostResult('chat', 'read-1', 'workspace_read', toolResultHistory({ content: [{ type: 'image', data: 'PIXELS_SECRET' }, { type: 'text', text: 'Visible result. api_key=KEY_SECRET' }], structuredContent: { thinking: 'THOUGHT_SECRET', password: 'PASSWORD_SECRET', value: 42 } }));
  const text = JSON.stringify(await originals(f.tree, 'chat'));
  for (const secret of ['AUTH_INPUT_SECRET', 'AUTH_OUTPUT_SECRET', 'KEY_SECRET', 'THOUGHT_SECRET', 'PIXELS_SECRET', 'TOKEN_SECRET', 'PASSWORD_SECRET']) assert.ok(!text.includes(secret), secret);
  assert.match(text, /Visible result/); assert.match(text, /image content omitted/); assert.match(text, /credential redacted/);
  const attachments = attachmentReferences({ attachments: [{ id: 'image-id', name: 'image.png', kind: 'image', mimeType: 'image/png', path: '/private/file', dataBase64: 'PIXELS_SECRET' }] });
  assert.deepEqual(attachments, [{ id: 'image-id', name: 'image.png', kind: 'image', mimeType: 'image/png' }]);
});

test('plain history credentials and auth tool-name separators are consistently excluded', () => {
  const fields = ['authorization', 'api_key', 'access_token', 'refresh_token', 'password', 'passwd', 'session_token', 'session_cookie', 'login_code', 'device_code', 'user_code', 'recovery_key', 'client_secret'];
  for (const field of fields) {
    const value = `${field}=FIELD_SECRET_VALUE`;
    assert.ok(!historyText(value).includes('FIELD_SECRET_VALUE'), `Unredacted ${field} in plain text history.`);
    assert.equal(historyObject({ [field]: 'FIELD_SECRET_VALUE' })[field], '[credential redacted]');
  }
  for (const name of ['auth', 'auth/login', 'subscription_login', 'provider.auth.read', 'mcp__service__request_permission']) assert.equal(recordableTool(name), false, name);
});

test('tool echoes are clipped to a Unicode-safe 30k head and tail while long prose remains complete', async t => {
  const f = await fixture(t);
  const output = 'HEAD_REFERENCE /project/source.mjs\n' + '😀'.repeat(20_000) + '\nTAIL_REFERENCE result=verified';
  await f.service.append('chat', { key: 'echo', kind: 'echo', text: output });
  const clipped = (await f.tree.zoom('chat', 0, 1, { limit: 32000 })).text;
  assert.ok(clipped.length <= 30_000); assert.match(clipped, /^HEAD_REFERENCE/); assert.match(clipped, /TAIL_REFERENCE result=verified$/); assert.match(clipped, /middle omitted/);
  assert.equal(Buffer.from(clipped, 'utf8').toString('utf8'), clipped);
  const prose = 'Original start. ' + '😀x'.repeat(25_000) + ' Original end.';
  await f.service.append('chat', { key: 'prose', kind: 'user', text: prose });
  const rows = (await originals(f.tree, 'chat')).filter(row => row.eventKey.startsWith('prose:'));
  assert.ok(rows.length > 2); assert.equal(rows.map(row => row.text).join(''), prose);
  assert.ok(rows.every(row => row.text.length <= 30_000 && Buffer.from(row.text, 'utf8').toString('utf8') === row.text));
  assert.equal(clipToolHistory(output), clipped); assert.equal(splitHistory(prose).join(''), prose);
});

test('disabled recording resumes from originals and deletion prevents queued chat resurrection', async t => {
  const f = await fixture(t);
  const chat = { id: 'chat', messages: [{ id: 'm1', role: 'user', content: 'First source.' }] };
  f.settings.chatMemoryEnabled = false;
  await f.service.sync(chat); await f.service.append('chat', { key: 'disabled-event', kind: 'user', text: 'Disabled source.' });
  assert.equal((await f.tree.stats('chat')).total, 0);
  f.settings.chatMemoryEnabled = true; await f.service.sync(chat);
  assert.equal((await f.tree.stats('chat')).total, 1);
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.delta', text: 'Pending narration.' }, 'run-1');
  const queued = f.service.hostCall('chat', 'queued-read', 'workspace_read', { path: 'file.txt' });
  await f.service.remove('chat'); await queued;
  await f.service.hostResult('chat', 'queued-read', 'workspace_read', 'Late output.');
  await f.service.sync(chat); await f.service.finish(chat);
  assert.equal((await f.tree.stats('chat')).total, 0);
  assert.equal(f.service.status('chat').enabled, true);
});

test('service deletion stops an active summary before removing its exact originals', async t => {
  let signal, release;
  const f = await fixture(t, { summarize: request => { signal = request.signal; return new Promise(resolve => { release = resolve; }); } });
  const chat = { id: 'chat', messages: [{ id: 'long', role: 'user', content: 'Long original. '.repeat(100) }] };
  await f.service.sync(chat); await nextTurn();
  assert.ok(signal); await f.service.remove('chat');
  assert.equal(signal.aborted, true); release('Late summary.'); await nextTurn();
  await f.service.sync(chat); await f.compactor.drain();
  assert.equal((await f.tree.stats('chat')).total, 0); assert.equal(f.compactor.stats().running, 0);
});

test('a failed record does not poison the serialized queue or block later valid captures', async t => {
  const f = await fixture(t);
  await f.service.append('chat', { key: 'bad', kind: 'user', text: 'Unusable timestamp.', createdAt: 'invalid-date' });
  assert.equal(f.service.failures, 1); assert.match(f.service.status('chat').lastError, /date/);
  await f.service.append('chat', { key: 'good', kind: 'user', text: 'A later valid correction.' });
  assert.equal((await f.tree.stats('chat')).total, 1); assert.equal((await f.tree.zoom('chat', 0, 1)).text, 'A later valid correction.');
});

test('prepare reports recent-context fallback when the transcript update fails', async t => {
  const f = await fixture(t);
  await f.service.append('chat', { key: 'previous', kind: 'user', text: 'Previously captured source.' });
  const result = await f.service.prepare({ id: 'chat', messages: [{ id: 'invalid', role: 'user', content: 'New source could not be indexed.', createdAt: 'invalid-date' }] });
  assert.equal(result.usable, false); assert.equal(result.text, ''); assert.deepEqual(result.lines, []);
  assert.match(result.stats.lastError, /Recent-message context/);
  assert.equal((await f.tree.stats('chat')).total, 1);
  assert.equal((await f.tree.zoom('chat', 0, 1)).text, 'Previously captured source.');
});

test('failed background summaries preserve the source queue and an over-budget turn view reports fallback', async t => {
  let calls = 0;
  const f = await fixture(t, { summarize: async () => { calls++; throw Error('Synthetic helper failure.'); } });
  const chat = { id: 'chat', messages: Array.from({ length: 360 }, (_, index) => ({ id: `m-${index}`, role: 'user', content: `Reference ${index}: /project/new-${index}. ${'Original evidence '.repeat(22)}` })) };
  const before = await f.service.prepare(chat);
  await f.compactor.drain();
  const after = await f.service.prepare(chat), stats = await f.tree.stats('chat');
  assert.ok(calls > 0); assert.ok(stats.jobs.failed > 0); assert.equal(stats.total, chat.messages.length);
  assert.equal(before.usable, false); assert.equal(after.usable, false);
  assert.equal(after.text.includes('<chat>'), true);
  assert.match((await f.tree.zoom('chat', 19, 1)).text, /^Reference 19: \/project\/new-19/);
  const attempts = calls; await nextTurn(); await f.service.prepare(chat); await f.compactor.drain();
  assert.equal(calls, attempts, 'Same transcript must not unlock failed helpers repeatedly.');
});

test('four-line prompt blocks concatenate exactly, including empty and partially filled views', () => {
  for (const count of [0, 1, 3, 4, 5, 8, 9]) {
    const entries = Array.from({ length: count }, (_, id) => ({ id, count: 1, text: `Line ${id}\ncontinued` }));
    const view = formatChatView({ entries });
    const blocks = chatViewBlocks(view.lines);
    assert.equal(blocks.map(block => block.text).join(''), view.text, `${count} lines`);
    assert.equal(blocks.filter(block => block.cache).length, count >= 4 ? 1 : 0);
  }
  const four = chatViewBlocks(formatChatView({ entries: Array.from({ length: 4 }, (_, id) => ({ id, count: 1, text: `Line ${id}` })) }).lines);
  const five = chatViewBlocks(formatChatView({ entries: Array.from({ length: 5 }, (_, id) => ({ id, count: 1, text: `Line ${id}` })) }).lines);
  assert.equal(four[1].text, five[1].text); assert.equal(four[1].cache, true); assert.equal(five[1].cache, true);
});

test('conversation zoom and date enforce current-chat and shared-memory access before tree reads', async t => {
  const f = await fixture(t);
  const current = { id: 'current', title: 'Current', messages: [{ id: 'm-current', role: 'user', content: 'Current source.' }] };
  const other = { id: 'other', title: 'Other', messages: [{ id: 'm-other', role: 'user', content: 'Other source.', createdAt: '2026-10-08T11:22:33Z' }] };
  await f.service.sync(current); await f.service.sync(other);
  let shared = false, reads = 0;
  const tools = new ConversationTools({ getConversations: () => [current, other], getMemoryEnabled: () => shared, getChatMemory: async () => { reads++; return f.tree; } });
  assert.equal(unpack(await tools.call('conversation_zoom', { id: 0, count: 1 }, 'current')).text, 'Current source.');
  assert.equal(unpack(await tools.call('conversation_date', { id: 0 }, 'current')).first, null);
  const count = reads;
  for (const name of ['conversation_zoom', 'conversation_date']) await assert.rejects(tools.call(name, { conversationId: 'other', id: 0, count: 1 }, 'current'), /Only the current chat/);
  assert.equal(reads, count);
  shared = true;
  assert.equal(unpack(await tools.call('conversation_zoom', { conversationId: 'other', id: 0, count: 1 }, 'current')).text, 'Other source.');
  assert.equal(unpack(await tools.call('conversation_date', { conversationId: 'other', id: 0 }, 'current')).first, '2026-10-08T11:22:33.000Z');
  await assert.rejects(tools.call('conversation_zoom', { id: 1, count: 2 }, 'current'), /aligned/);
  await assert.rejects(tools.call('conversation_date', { id: 0 }, 'missing'), /No active conversation/);
});

test('growing streamed tool output is stored once as its final snapshot', async t => {
  const f = await fixture(t);
  const event = value => f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id: 'stream', ...value }, 'run-1');
  event({ name: 'execute', input: { command: 'build' }, status: 'running' });
  for (const text of ['step 1', 'step 1\nstep 2', 'step 1\nstep 2\nstep 3']) event({ output: text });
  await f.service.queue;
  assert.deepEqual((await originals(f.tree, 'chat')).map(row => row.kind), ['tool']);
  event({ output: 'step 1\nstep 2\nstep 3\nfinished', status: 'done' });
  await f.service.queue;
  const rows = await originals(f.tree, 'chat');
  assert.deepEqual(rows.map(row => row.kind), ['tool', 'echo']);
  assert.equal(rows[1].text, 'step 1\nstep 2\nstep 3\nfinished');
});

test('unfinished streamed tool output is stored when the reply finishes', async t => {
  const f = await fixture(t);
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id: 's', name: 'execute', input: {}, status: 'running' }, 'run-1');
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id: 's', output: 'partial 1' }, 'run-1');
  f.service.providerEvent({ conversationId: 'chat', type: 'chat.tool', id: 's', output: 'partial 1 and 2' }, 'run-1');
  await f.service.finish({ id: 'chat', messages: [] });
  const rows = await originals(f.tree, 'chat');
  assert.deepEqual(rows.map(row => row.text).slice(1), ['partial 1 and 2']);
});
