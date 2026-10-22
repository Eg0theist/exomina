import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import {approveTerminalCommand} from '../desktop/terminal-approval.mjs';
import { PermissionPolicy, normalizeRule, suggestRule } from '../desktop/permissions.mjs';
const base = () => ({conversationId:'chat', request:{conversationId:'chat',detail:'preview',input:{command:'Get-Date'}}, getContext:async()=>({workspace:'C:/work'}), evaluate:()=>({decision:'ask'}), ask:async()=>true});

test('manual terminal obeys a deny without creating an approval and uses exact chat command policy', async()=>{
  const input=base();input.evaluate=(action,id)=>{assert.equal(id,'chat');assert.deepEqual(action,{kind:'execute',tool:'workspace_shell',target:'Get-Date'});return {decision:'deny',reason:'Read-only access blocks commands.'};};input.ask=()=>{throw Error('Must not ask around a denial');};
  await assert.rejects(approveTerminalCommand(input), error=>error.code==='TERMINAL_DENIED'&&error.message==='Read-only access blocks commands.');
});
test('manual terminal keeps user confirmation outside the agent activity and cannot turn it into a permanent grant', async()=>{
  const input=base();input.ask=async request=>{assert.equal(request.conversationId,undefined);assert.equal(request.requireConfirmation,true);assert.equal(request.allowSession,undefined);assert.equal(request.input.command,'Get-Date');return true;};
  assert.equal(await approveTerminalCommand(input),true);
});
test('manual terminal rechecks changed policy, workspace and cancelled confirmation', async()=>{
  let mode='ask';const denied=base();denied.evaluate=()=>({decision:mode,reason:'New deny rule'});denied.ask=async()=>{mode='deny';return true;};await assert.rejects(approveTerminalCommand(denied),/New deny rule/);
  let workspace='C:/before';const moved=base();moved.getContext=async()=>({workspace});moved.ask=async()=>{workspace='C:/after';return true;};await assert.rejects(approveTerminalCommand(moved),/workspace changed/);
  const controller=new AbortController(),cancelled=base();cancelled.signal=controller.signal;cancelled.ask=async()=>{controller.abort();return true;};assert.equal(await approveTerminalCommand(cancelled),false);
});
test('manual terminal honors existing allow rules but refuses lost chat context after confirmation', async()=>{
  const allowed=base();allowed.evaluate=()=>({decision:'allow'});allowed.ask=()=>{throw Error('Existing grant should not ask');};assert.equal(await approveTerminalCommand(allowed),true);
  let exists=true;const gone=base();gone.getContext=async()=>{if(!exists)throw Error('Chat removed');return {workspace:'C:/work'};};gone.ask=async()=>{exists=false;return true;};await assert.rejects(approveTerminalCommand(gone),/Chat removed/);
});

// Exercise the actual desktop coordinator without importing Electron or opening
// account storage. The dependencies below are synthetic in-memory UI state.
async function hostApprovalFixture(t, permissionMode = 'ask') {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function requestApproval('), end = source.indexOf('\nconst approve=request=>', start);
  assert.ok(start >= 0 && end > start, 'desktop approval coordinator remains discoverable');
  const settings = { permissionMode, permissionRules: [] }, approvals = new Map();
  const policy = new PermissionPolicy({ getSettings: () => settings });
  const context = { settings, approvals, policy, normalizeRule, suggestRule, createHash, randomUUID, setTimeout, clearTimeout,
    toolContext: { getStore: () => undefined }, nativeScopeLive: () => true,
    active: new Map([['chat', {}]]), store: { state: { settings, conversations: [{ id: 'chat' }] }, save: async () => {} },
    emit: () => {}, getProvider: () => ({ name: 'Synthetic provider' }), explainAction: () => ({}),
    DECISION_NOTE: { once: 'Approved once.', chat: 'Approved for chat.', always: 'Approved always.', deny: 'Declined.' } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  t.after(() => { for (const request of [...approvals.values()]) request.finish(false); });
  return { settings, approvals, policy, ask: context.requestApproval };
}

test('pending host approvals obey a new deny rule or Read only mode before execution', async t => {
  for (const change of ['deny-rule', 'read-only']) {
    const fixture = await hostApprovalFixture(t);
    const action = { kind: 'execute', tool: 'workspace_shell', target: 'Write-Output reviewed' };
    const pending = fixture.ask({ title: 'Allow terminal command?', detail: action.target, conversationId: 'chat', action });
    assert.equal(fixture.approvals.size, 1);
    if (change === 'deny-rule') fixture.settings.permissionRules = [normalizeRule({ effect: 'deny', tool: 'workspace_shell' })];
    else fixture.settings.permissionMode = 'read-only';
    fixture.approvals.values().next().value.finish({ decision: 'always' });
    const answer = await pending;
    assert.equal(answer.approved, false, change);
    assert.match(answer.message, change === 'deny-rule' ? /Blocked by your rule/ : /Read only mode/);
    assert.equal(fixture.settings.permissionRules.some(rule => rule.effect === 'allow'), false, 'stale approval cannot create an allow rule');
    assert.equal(fixture.policy.chatGrants('chat').length, 0);
  }
});

test('native confirmations still require the explicit answer and honor current denials', async t => {
  const fixture = await hostApprovalFixture(t, 'full');
  const action = { kind: 'execute', tool: 'codex.command', target: 'Write-Output reviewed' };
  const pending = fixture.ask({ title: 'Native confirmation', detail: action.target, conversationId: 'chat', action, requireConfirmation: true });
  assert.equal(fixture.approvals.size, 1, 'Full access cannot answer the native confirmation');
  fixture.approvals.values().next().value.finish({ decision: 'once' });
  assert.equal((await pending).approved, true);
  assert.equal(fixture.settings.permissionRules.length, 0);
  const denied = fixture.ask({ title: 'Native confirmation', detail: action.target, conversationId: 'chat', action, requireConfirmation: true });
  fixture.settings.permissionRules = [normalizeRule({ effect: 'deny', tool: 'codex.command' })];
  fixture.approvals.values().next().value.finish({ decision: 'once' });
  assert.equal((await denied).approved, false);
});
