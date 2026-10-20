import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ProviderManager } from '../desktop/providers.mjs';
import { RunActivity } from '../desktop/activity.mjs';
import { codexApprovalReviewStep, codexFunctionOutputText } from '../desktop/codex-review-diagnostics.mjs';

const started = 'item/autoApprovalReview/started', completed = 'item/autoApprovalReview/completed';
const review = (status = 'denied', extra = {}) => ({ threadId: 'thread', turnId: 'turn', reviewId: 'review-1',
  startedAtMs: 10, completedAtMs: 20, decisionSource: 'agent', targetItemId: null,
  action: { type: 'command', command: 'Remove-Item -LiteralPath disposable', cwd: 'workspace', source: 'unifiedExec' },
  review: { status, ...extra } });

function fixture() {
  const events = [], calls = [], message = { content: '' }, activity = new RunActivity(message, { conversationId: 'chat', emit: () => {} });
  const forbidden = name => (...args) => { calls.push({ name, args }); throw Error('Diagnostics must not act.'); };
  const manager = new ProviderManager({ dataDir: path.resolve('synthetic-review-profile'), workspace: process.cwd(),
    emit: event => { events.push(event); if (event.type === 'chat.tool') activity.tool(event); },
    approve: forbidden('approve'), approveDetailed: forbidden('approveDetailed'), callTool: forbidden('callTool'),
    getPermissionMode: forbidden('getPermissionMode'), spawnImpl: forbidden('spawn'), beforePrepare: forbidden('prepare') });
  manager.rpc = { request: forbidden('rpc.request'), send: forbidden('rpc.send') };
  const permissions = Object.freeze({ sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' });
  const state = { provider: 'codex', conversationId: 'chat', sessionId: 'thread', turnId: 'turn', cancelled: false,
    items: new Map(), codexPermissionsVerified: true, requestedPermissions: permissions, effectivePermissions: permissions };
  manager.active.set('chat', state);
  return { manager, events, calls, message, state, permissions };
}

test('native review diagnostics preserve an actual rationale and supplied assessment', () => {
  const f = fixture();
  f.manager.codexNotification(completed, review('denied', { rationale: 'The resolved target includes files outside the approved folder.', riskLevel: 'high', userAuthorization: 'low' }));
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].status, 'denied');
  assert.match(f.events[0].output, /Reason: The resolved target includes files outside the approved folder\./);
  assert.match(f.events[0].output, /Reported risk: high/);
  assert.deepEqual(f.events[0].input.action, review().action);
  assert.equal(f.message.activity[0].status, 'denied');
  assert.equal(f.state.requestedPermissions, f.permissions);
  assert.equal(f.state.effectivePermissions, f.permissions);
  assert.deepEqual(f.calls, []);
});

test('native denial without a rationale reports that the provider supplied no reason', () => {
  const f = fixture();
  f.manager.codexNotification(completed, review('denied', { rationale: null }));
  assert.match(f.events[0].output, /The provider did not supply a reason\./);
  assert.doesNotMatch(f.events[0].output, /user declined|your rule|Read only|blocked by policy/i);
  assert.deepEqual(f.calls, []);
});

test('started, completed and repeated review notifications keep one stable activity step', () => {
  const f = fixture(), begin = review('inProgress'), end = review();
  f.manager.codexNotification(started, begin);
  f.manager.codexNotification(started, begin);
  f.manager.codexNotification(completed, end);
  f.manager.codexNotification(completed, end);
  f.manager.codexNotification(started, begin);
  assert.equal(f.events.length, 2);
  assert.equal(f.events[0].id, f.events[1].id);
  assert.match(f.events[0].id, /^codex-review:[a-f0-9]{24}$/);
  assert.equal(f.message.activity.filter(item => item.kind === 'tool').length, 1);
  assert.equal(f.message.activity[0].status, 'denied');
  assert.equal(f.message.activity[0].detail, undefined);
  assert.deepEqual(f.calls, []);
});

test('review completion distinguishes denial, timeout, cancellation and approval', () => {
  for (const [status, expected] of [['denied', 'denied'], ['timedOut', 'error'], ['aborted', 'stopped'], ['approved', 'done']]) {
    const f = fixture();
    f.manager.codexNotification(completed, review(status));
    assert.equal(f.events[0].status, expected);
    if (status === 'timedOut' || status === 'aborted') assert.match(f.events[0].output, /without a decision/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.state.requestedPermissions, f.permissions);
  }
});

test('a completed review cannot change its reported decision but can gain a reason', () => {
  const f = fixture();
  f.manager.codexNotification(completed, review('denied'));
  f.manager.codexNotification(completed, review('approved', { rationale: 'Conflicting later delivery.' }));
  f.manager.codexNotification(completed, review('denied', { rationale: 'The target was outside the selected folder.' }));
  f.manager.codexNotification(completed, review('denied'));
  assert.equal(f.events.length, 2);
  assert.equal(f.message.activity[0].status, 'denied');
  assert.match(f.message.activity[0].output, /The target was outside the selected folder/);
  assert.doesNotMatch(f.message.activity[0].output, /approved|Conflicting/);
  assert.deepEqual(f.calls, []);
});

test('review notifications ignore cancelled, unknown-thread and stale-turn delivery', () => {
  const f = fixture();
  f.manager.codexNotification(completed, { ...review(), threadId: 'other-thread' });
  f.manager.codexNotification(completed, { ...review(), turnId: 'old-turn' });
  f.state.cancelled = true;
  f.manager.codexNotification(completed, review());
  assert.equal(f.events.length, 0);
  f.state.cancelled = false;
  f.state.sessionId = undefined;
  f.state.turnId = undefined;
  f.manager.codexNotification(completed, { ...review(), threadId: undefined });
  f.manager.codexNotification(started, { ...review('inProgress'), threadId: undefined, turnId: undefined });
  f.manager.codexNotification('guardianWarning', { message: 'Missing thread must not reach this chat.' });
  assert.equal(f.events.length, 0);
  assert.equal(codexApprovalReviewStep(completed, { ...review(), turnId: undefined }), null);
  assert.equal(f.state.codexReviews, undefined);
  assert.deepEqual(f.calls, []);
});

test('guardian warnings are reported once without changing or requesting access', () => {
  const f = fixture(), warning = { threadId: 'thread', message: 'The action requires review.' };
  f.manager.codexNotification('guardianWarning', warning);
  f.manager.codexNotification('guardianWarning', warning);
  f.manager.codexNotification('guardianWarning', { ...warning, threadId: 'another-thread' });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].name, 'codexGuardianWarning');
  assert.equal(f.events[0].output, 'Provider warning: The action requires review.');
  assert.equal(f.state.requestedPermissions, f.permissions);
  assert.equal(f.state.codexPermissionsVerified, true);
  assert.deepEqual(f.calls, []);
});

test('ordinary native tool output retains string errors without inventing their status', () => {
  const f = fixture();
  f.manager.codexNotification('item/completed', { threadId: 'thread', item: { id: 'output-1', type: 'functionCallOutput', name: 'exec_command',
    output: 'exec_command failed: CreateProcess Rejected (blocked by policy)' } });
  assert.equal(f.events[0].name, 'exec_command');
  assert.match(f.events[0].output, /CreateProcess Rejected \(blocked by policy\)/);
  assert.equal(f.events[0].historyOutput, f.events[0].output);
  // This status marks receipt of the result, not success or denial of the action.
  assert.equal(f.events[0].status, 'done');
  assert.deepEqual(f.calls, []);
});

test('ordinary native tool output extracts input_text and omits media and encrypted blocks', () => {
  const blocks = [{ type: 'input_text', text: 'First detail' }, { type: 'input_image', image_url: 'data:image/png;base64,SECRETIMAGE' },
    { type: 'input_audio', audio_url: 'SECRETAUDIO' }, { type: 'encrypted_content', encrypted_content: 'SECRETCIPHERTEXT' },
    { type: 'input_text', text: 'Second detail' }];
  assert.equal(codexFunctionOutputText(blocks), 'First detail\nSecond detail');
  assert.equal(codexFunctionOutputText([{ type: 'input_image', image_url: 'image' }]), undefined);
  assert.equal(codexFunctionOutputText({ output: 'unsupported object' }), undefined);
  const f = fixture();
  f.manager.codexNotification('item/completed', { threadId: 'thread', item: { id: 'output-2', type: 'functionCallOutput', name: 'exec_command', output: blocks } });
  assert.equal(f.events[0].output, 'First detail\nSecond detail');
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET/);
  assert.deepEqual(f.calls, []);
});

test('diagnostic text is redacted and bounded without copying unsupported action fields', () => {
  const params = review('denied', { rationale: 'access_token=synthetic-token\n' + 'x'.repeat(10000) });
  params.action.extraImage = 'data:image/png;base64,SECRETIMAGE';
  const step = codexApprovalReviewStep(completed, params);
  assert.doesNotMatch(JSON.stringify(step), /synthetic-token|SECRETIMAGE/);
  assert.match(step.historyOutput, /credential redacted/);
  assert.ok(step.output.length <= 4000);
  assert.ok(step.input.review.rationale.length <= 4000);
  assert.equal(codexApprovalReviewStep(completed, { ...params, review: { status: 'unexpected' } }), null);
});

test('malformed prototype action names and contradictory starts cannot fail the runtime', () => {
  const f = fixture();
  for (const type of ['constructor', 'toString', '__proto__']) {
    assert.doesNotThrow(() => f.manager.codexNotification(completed, { ...review(), action: { type } }));
  }
  f.manager.codexNotification(started, review('denied'));
  assert.equal(f.events.length, 0);
  assert.equal(f.state.codexReviews, undefined);
  assert.deepEqual(f.calls, []);
});

test('aggregate action metadata is bounded and review ids cannot leak credentials into step ids', () => {
  const params = review('denied', { rationale: 'A separately preserved explanation.' });
  params.reviewId = 'access_token=synthetic-review-secret';
  params.action = { type: 'execve', program: 'p'.repeat(10000), argv: Array.from({ length: 128 }, () => '\\'.repeat(10000)),
    cwd: 'w'.repeat(10000), source: 'unifiedExec' };
  const step = codexApprovalReviewStep(completed, params);
  assert.ok(JSON.stringify(step.input.action).length <= 8000);
  assert.equal(step.input.review.rationale, 'A separately preserved explanation.');
  assert.doesNotMatch(JSON.stringify(step), /synthetic-review-secret/);
});

test('review diagnostics use only official action fields for every supported action type', () => {
  for (const action of [{ type: 'execve', program: 'tool', argv: ['arg'], cwd: 'workspace', source: 'shell' },
    { type: 'writeStdin', approvalId: 'child', processId: 'process', cwd: 'workspace', stdin: 'input' },
    { type: 'applyPatch', cwd: 'workspace', files: ['one.txt'] },
    { type: 'networkAccess', host: 'example.test', port: 443, protocol: 'https', target: 'example.test' },
    { type: 'mcpToolCall', server: 'server', toolName: 'tool', connectorName: 'Connector' },
    { type: 'requestPermissions', permissions: { fileSystem: { read: ['workspace'] } }, reason: 'Read the selected folder.' }]) {
    const step = codexApprovalReviewStep(completed, { ...review(), action });
    assert.equal(step.input.action.type, action.type);
    assert.equal(step.status, 'denied');
  }
});
