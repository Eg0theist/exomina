import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CodexCloud, cloudTaskUrl, CODEX_CLOUD_TOOLS } from '../desktop/codex-cloud.mjs';

function fixture(t, overrides = {}) {
  const calls = [], approvals = [], store = { state: {}, saves: 0, async save() { this.saves++; } };
  let response = ['{}', 0], account = { type: 'chatgpt', planType: 'pro' }, handler;
  const providers = {
    requireProvider() {}, async getCodex() { return { request: async () => ({ account }) }; }, async executable() { return 'synthetic-codex'; },
    spawn(exe, args, provider, cwd) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { child.emit('close', 1); }; const call = { exe, args, provider, cwd, child, stdin: '' }; calls.push(call);
      child.stdin.on('data', chunk => { call.stdin += chunk; });
      queueMicrotask(() => { const result = handler ? handler(call) : response; if (result === null) return; const [text, code = 0, error = ''] = result; child.stdout.write(text); child.stderr.write(error); child.emit('close', code); });
      return child;
    }, stopChild(child) { child.kill(); },
  };
  const cloud = new CodexCloud({ providers, store, getWorkspace: () => path.resolve('synthetic-repository'), validatePath: async () => {}, approve: async request => { approvals.push(request); return true; }, ...overrides });
  t.after(() => cloud.close());
  return { cloud, store, calls, approvals, setResponse: value => { response = value; }, setAccount: value => { account = value; }, setHandler: value => { handler = value; } };
}
const submit = { environmentId: 'env-test', prompt: 'Fix this bug.', requestId: 'request-1' };
async function configured(f) { await f.cloud.configure({ id: 'env-test', name: 'Test repository' }); }

test('cloud task links reject credential, query and foreign-origin URLs', () => {
  assert.equal(cloudTaskUrl('https://chatgpt.com/codex/tasks/task-one'), 'https://chatgpt.com/codex/tasks/task-one');
  for (const url of ['https://evil.example/codex/tasks/task-one', 'https://chatgpt.com.evil.example/codex/tasks/task-one', 'https://user:secret@chatgpt.com/codex/task-one', 'https://chatgpt.com/codex/task-one?token=secret', 'http://chatgpt.com/codex/task-one', 'https://chatgpt.com:444/codex/task-one', 'https://chatgpt.com/codex/tasks/../settings']) assert.equal(cloudTaskUrl(url), null);
});
test('API authentication and absent authentication never launch cloud commands', async t => {
  const f = fixture(t); for (const account of [null, { type: 'apiKey' }]) { f.setAccount(account); await assert.rejects(f.cloud.list(), /subscription sign-in/); } assert.equal(f.calls.length, 0);
});
test('task listing preserves official pagination and returns only bounded public metadata', async t => {
  const f = fixture(t); f.setResponse([JSON.stringify({ tasks: [{ id: 'task-one', title: 'Task', url: 'https://chatgpt.com/codex/tasks/task-one', status: 'completed', environment_id: 'env-test', environment_label: 'Project', secret: 'never returned' }], cursor: 'next-page' })]);
  const result = await f.cloud.list({ limit: 1, environmentId: 'env-test', cursor: 'opaque' }); assert.equal(result.tasks[0].environmentId, 'env-test'); assert.equal(result.cursor, 'next-page'); assert.equal(result.tasks[0].secret, undefined);
  assert.deepEqual(f.calls[0].args, ['cloud', 'list', '--json', '--limit', '1', '--env', 'env-test', '--cursor', 'opaque']); assert.equal(f.approvals.length, 0);
  for (const options of [{ limit: 0 }, { limit: 21 }, { environmentId: '--config' }, { cursor: 'bad\nvalue' }]) await assert.rejects(f.cloud.list(options));
});
test('malformed task responses are errors, never empty success', async t => {
  const f = fixture(t); for (const response of ['HTML', '{"tasks":{}}', '{"tasks":[{"id":"../outside"}]}', '{"tasks":[],"cursor":123}']) { f.setResponse([response]); await assert.rejects(f.cloud.list()); }
});
test('environment choices are local metadata, validated and removable', async t => {
  const f = fixture(t); await configured(f); assert.deepEqual(f.cloud.view().environments, [{ id: 'env-test', name: 'Test repository' }]); assert.equal(f.calls.length, 0);
  await assert.rejects(f.cloud.configure({ id: '--help', name: 'Invalid' })); await assert.rejects(f.cloud.configure({ id: 'env', name: '' }));
  await f.cloud.configure({ id: 'env-test', name: 'Test repository', remove: true }); assert.deepEqual(f.cloud.view().environments, []);
});
test('submission is approved exactly, saved before launch and dispatched only once', async t => {
  const f = fixture(t); await configured(f); f.setHandler(() => { assert.equal(f.cloud.state.submissions[0].status, 'submitting'); assert.ok(f.store.saves >= 2); return ['Created task: https://chatgpt.com/codex/tasks/task-one', 0]; });
  const result = await f.cloud.submit({ ...submit, prompt: '--help $(malicious)' }, 'chat-one'); assert.equal(result.status, 'submitted'); assert.equal(result.taskId, 'task-one');
  assert.match(f.approvals[0].detail, /--help \$\(malicious\)/); assert.equal(f.approvals[0].conversationId, 'chat-one');
  assert.deepEqual(f.calls[0].args, ['cloud', 'exec', '--env', 'env-test', '--attempts', '1', '--', '--help $(malicious)']);
  assert.equal((await f.cloud.submit({ ...submit, prompt: '--help $(malicious)' })).duplicate, true); assert.equal(f.calls.length, 1);
  await assert.rejects(f.cloud.submit(submit), /different request/);
});
test('declined or stale approvals cannot submit a remote task', async t => {
  const declined = fixture(t, { approve: async () => false }); await configured(declined); assert.equal((await declined.cloud.submit(submit)).status, 'declined'); assert.equal(declined.calls.length, 0);
  const stale = fixture(t, { isLive: () => false }); await configured(stale); await assert.rejects(stale.cloud.submit(submit, 'stopped'), /originating request ended/); assert.equal(stale.calls.length, 0);
});
test('timeouts persist an uncertain receipt and never retry its submission ID', async t => {
  const f = fixture(t, { timeoutMs: 10 }); await configured(f); f.setHandler(() => null);
  await assert.rejects(f.cloud.submit(submit), /timed out/); assert.equal(f.cloud.view().submissions[0].status, 'unknown');
  assert.equal((await f.cloud.submit(submit)).status, 'unknown'); assert.equal(f.calls.length, 1);
});
test('failed dispatch and restart cannot automatically repeat cloud work', async t => {
  const f = fixture(t); await configured(f); f.setResponse(['', 1, 'network unavailable']); await assert.rejects(f.cloud.submit(submit), /network unavailable/);
  assert.equal((await f.cloud.submit(submit)).duplicate, true); assert.equal(f.calls.length, 1);
  f.cloud.state.submissions[0].status = 'submitting'; const restarted = new CodexCloud({ providers: f.cloud.providers, store: f.store, getWorkspace: f.cloud.getWorkspace, approve: async () => true }); assert.equal(restarted.view().submissions[0].status, 'unknown'); restarted.close();
});
test('output is bounded and diagnostics redact credential-like values', async t => {
  const f = fixture(t, { maxBytes: 20 }); f.setResponse(['x'.repeat(21)]); await assert.rejects(f.cloud.list(), /size limit/);
  const g = fixture(t); g.setResponse(['', 1, 'Bearer private-credential sk-abc123']); await assert.rejects(g.cloud.list(), e => !e.message.includes('private-credential') && !e.message.includes('sk-abc123'));
});
test('diff reads carry a full checksum across pages without editing files', async t => {
  const f = fixture(t); f.setResponse(['0123456789']); const result = await f.cloud.diff({ taskId: 'task-one', offset: 3, limit: 4 }); assert.equal(result.text, '3456'); assert.equal(result.nextOffset, 7); assert.equal(result.sha256, createHash('sha256').update('0123456789').digest('hex')); assert.equal(f.calls[0].args[1], 'diff');
});
test('apply refuses dirty repositories and changed diffs before approval', async t => {
  const f = fixture(t); const cwd = f.cloud.getWorkspace(); f.setHandler(call => call.args[0] === 'rev-parse' ? [cwd] : [' M changed.txt']); await assert.rejects(f.cloud.apply({ taskId: 'task-one', sha256: 'a'.repeat(64) }), /local changes/); assert.equal(f.approvals.length, 0);
  f.setHandler(call => call.args[0] === 'rev-parse' ? [cwd] : call.args[0] === 'status' ? [''] : ['changed diff']); await assert.rejects(f.cloud.apply({ taskId: 'task-one', sha256: 'a'.repeat(64) }), /diff changed/); assert.equal(f.approvals.length, 0);
});
test('apply uses the exact reviewed patch on stdin and never refetches during the write', async t => {
  const f = fixture(t); const cwd = f.cloud.getWorkspace(), patch = 'diff --git a/file.txt b/file.txt\nreviewed bytes\n';
  f.setHandler(call => call.args[0] === 'rev-parse' ? [cwd] : call.args[0] === 'status' ? [''] : call.args[0] === 'cloud' ? [patch] : call.args.includes('--numstat') ? ['1\t1\tfile.txt\0'] : ['', 0]);
  const result = await f.cloud.apply({ taskId: 'task-one', sha256: createHash('sha256').update(patch).digest('hex') }); assert.equal(result.applied, true);
  const writes = f.calls.filter(call => call.args[0] === 'apply' && !call.args.includes('--numstat')); assert.deepEqual(writes.map(call => call.args), [['apply', '--check', '-'], ['apply', '-']]); for (const call of writes) assert.equal(call.stdin, patch);
  assert.equal(f.calls.some(call => call.args[0] === 'cloud' && call.args[1] === 'apply'), false); assert.equal(f.approvals.length, 1);
});
test('shared cloud tools return errors explicitly and never enable local write tools', async t => {
  const f = fixture(t); const result = await f.cloud.call('codex_cloud_diff', { taskId: '../bad' }); assert.equal(result.isError, true); assert.equal(CODEX_CLOUD_TOOLS.length, 4); assert.equal(CODEX_CLOUD_TOOLS.some(tool => tool.name.endsWith('_apply')), false);
});
test('patch paths pass the host private-directory checks before approval', async t => {
  const checked = [], f = fixture(t, { validatePath: async file => { checked.push(file); throw Error('Private account stores are excluded.'); } }), patch = 'synthetic diff', cwd = f.cloud.getWorkspace();
  f.setHandler(call => call.args[0] === 'rev-parse' ? [cwd] : call.args[0] === 'status' ? [''] : call.args[0] === 'cloud' ? [patch] : ['1\t1\tPrivate/accounts/secret\0']);
  await assert.rejects(f.cloud.apply({ taskId: 'task-one', sha256: createHash('sha256').update(patch).digest('hex') }), /Private account/); assert.deepEqual(checked, ['Private/accounts/secret']); assert.equal(f.approvals.length, 0); assert.equal(f.calls.some(call => call.args[0] === 'apply' && !call.args.includes('--numstat')), false);
});
test('uncertain receipts survive history trimming', async t => {
  const f = fixture(t); await configured(f); f.cloud.state.submissions = Array.from({ length: 201 }, (_, i) => ({ requestId: `old-${i}`, status: i === 0 ? 'unknown' : 'submitted' })); f.setResponse(['Created task: https://chatgpt.com/codex/tasks/task-one']); await f.cloud.submit(submit); assert.equal(f.cloud.state.submissions.find(item => item.requestId === 'old-0').status, 'unknown');
});
