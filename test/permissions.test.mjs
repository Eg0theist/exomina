import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionPolicy, normalizeRule, normalizeRules, suggestRule, commandPrefix, hostAction, claudeAction, acpAction, codexPolicy, claudePermissionMode, permissionMode } from '../desktop/permissions.mjs';

const policyWith = (settings) => new PermissionPolicy({ getSettings: () => settings });

test('soul inspection is a read and explicit learning deny rules remain effective', () => {
 const settings={permissionMode:'full',permissionRules:[normalizeRule({effect:'deny',tool:'soul_reflect',match:'consolidate'})]},policy=policyWith(settings);
 assert.deepEqual(hostAction('soul_reflect',{action:'inspect'}),{kind:'read',tool:'soul_reflect',target:'inspect'});
 assert.equal(hostAction('soul_reflect',{action:'consolidate'}).kind,'memory');
 assert.equal(policy.evaluate(hostAction('soul_reflect',{action:'consolidate'})).decision,'deny');
 assert.equal(policy.evaluate(hostAction('soul_reflect',{action:'inspect'})).decision,'allow');
});

test('note annotation is an edit and respects levels and explicit deny rules', () => {
 const settings={permissionMode:'read-only',permissionRules:[]},policy=policyWith(settings),action=hostAction('notes_annotate',{id:'approved-note'});
 assert.deepEqual(action,{kind:'write',tool:'notes_annotate',target:'approved-note'});assert.equal(policy.evaluate(action).decision,'deny');
 settings.permissionMode='ask';assert.equal(policy.evaluate(action).decision,'ask');settings.permissionMode='auto-edit';assert.equal(policy.evaluate(action).decision,'allow');
 settings.permissionMode='full';settings.permissionRules=[normalizeRule({effect:'deny',tool:'notes_annotate',match:'approved-note'})];assert.equal(policy.evaluate(action).decision,'deny');
});

test('completed-note cleanup is an edit and respects levels and explicit deny rules', () => {
 const settings={permissionMode:'read-only',permissionRules:[]},policy=policyWith(settings),action=hostAction('notes_remove_completed',{id:'approved-note'});
 assert.deepEqual(action,{kind:'write',tool:'notes_remove_completed',target:'approved-note'});assert.equal(policy.evaluate(action).decision,'deny');
 settings.permissionMode='ask';assert.equal(policy.evaluate(action).decision,'ask');settings.permissionMode='auto-edit';assert.equal(policy.evaluate(action).decision,'allow');
 settings.permissionMode='full';settings.permissionRules=[normalizeRule({effect:'deny',tool:'notes_remove_completed'})];assert.equal(policy.evaluate(action).decision,'deny');
 assert.equal(hostAction('notes_read',{id:'approved-note'}).kind,'read');
});

test('each permission level decides by action kind', () => {
  const settings = { permissionMode: 'ask', permissionRules: [] };
  const policy = policyWith(settings);
  const kinds = ['read', 'write', 'execute', 'network', 'browser', 'desktop'];
  const decide = () => kinds.map(kind => policy.evaluate({ kind, tool: 't' }).decision);
  settings.permissionMode = 'read-only'; assert.deepEqual(decide(), ['allow', 'deny', 'deny', 'deny', 'deny', 'deny']);
  settings.permissionMode = 'ask'; assert.deepEqual(decide(), ['allow', 'ask', 'ask', 'ask', 'ask', 'ask']);
  settings.permissionMode = 'auto-edit'; assert.deepEqual(decide(), ['allow', 'allow', 'ask', 'ask', 'ask', 'ask']);
  settings.permissionMode = 'full'; assert.deepEqual(decide(), ['allow', 'allow', 'allow', 'allow', 'allow', 'allow']);
});

test('unknown or missing levels fall back to asking', () => {
  assert.equal(permissionMode('yolo'), 'ask');
  assert.equal(policyWith({}).evaluate({ kind: 'execute', tool: 'x' }).decision, 'ask');
});

test('deny rules win over full access, allow rules and chat grants', () => {
  const settings = { permissionMode: 'full', permissionRules: [normalizeRule({ effect: 'deny', tool: 'workspace_shell', match: 'Remove-Item' }), normalizeRule({ effect: 'allow', tool: 'workspace_shell', match: 'Remove-Item' })] };
  const policy = policyWith(settings);
  policy.grant('chat', { tool: 'workspace_shell', match: '' });
  assert.equal(policy.evaluate({ kind: 'execute', tool: 'workspace_shell', target: 'remove-item -Recurse C:\\x' }, 'chat').decision, 'deny');
  assert.equal(policy.evaluate({ kind: 'execute', tool: 'workspace_shell', target: 'Get-ChildItem' }, 'chat').decision, 'allow');
});

test('allow rules match by prefix or wildcard and chat grants stay in their chat', () => {
  const settings = { permissionMode: 'ask', permissionRules: [normalizeRule({ effect: 'allow', tool: 'claude.Bash', match: 'npm test' }), normalizeRule({ effect: 'allow', tool: 'browser_*', match: 'https://docs.example.com*' })] };
  const policy = policyWith(settings);
  assert.equal(policy.evaluate({ kind: 'execute', tool: 'claude.Bash', target: 'npm test -- --watch' }).decision, 'allow');
  assert.equal(policy.evaluate({ kind: 'execute', tool: 'claude.Bash', target: 'npm publish' }).decision, 'ask');
  assert.equal(policy.evaluate({ kind: 'browser', tool: 'browser_open', target: 'https://docs.example.com/a' }).decision, 'allow');
  assert.equal(policy.evaluate({ kind: 'browser', tool: 'browser_open', target: 'https://evil.example/' }).decision, 'ask');
  policy.grant('a', { tool: 'codex.command', match: 'git status' });
  assert.equal(policy.evaluate({ kind: 'execute', tool: 'codex.command', target: 'git status --short' }, 'a').decision, 'allow');
  assert.equal(policy.evaluate({ kind: 'execute', tool: 'codex.command', target: 'git status --short' }, 'b').decision, 'ask');
  policy.clearChat('a');
  assert.equal(policy.evaluate({ kind: 'execute', tool: 'codex.command', target: 'git status' }, 'a').decision, 'ask');
});

test('a chat level overrides the default for that chat only', () => {
  const settings = { permissionMode: 'ask', permissionRules: [] };
  const chats = { trusted: 'full', locked: 'read-only', bogus: 'yolo' };
  const policy = new PermissionPolicy({ getSettings: () => settings, getChatMode: id => chats[id] });
  const run = { kind: 'execute', tool: 'workspace_shell', target: 'npm test' };
  assert.equal(policy.modeFor('trusted'), 'full');
  assert.equal(policy.evaluate(run, 'trusted').decision, 'allow');
  assert.match(policy.evaluate(run, 'trusted').reason, /for this chat/);
  assert.equal(policy.evaluate({ kind: 'read', tool: 'workspace_read' }, 'locked').decision, 'allow');
  assert.equal(policy.evaluate(run, 'locked').decision, 'deny');
  assert.equal(policy.evaluate(run, 'other').decision, 'ask', 'chats without a level follow the default');
  assert.equal(policy.modeFor('bogus'), 'ask', 'an invalid stored level falls back to the default');
  assert.equal(policy.modeFor(undefined), 'ask');
  settings.permissionMode = 'auto-edit';
  assert.equal(policy.modeFor('other'), 'auto-edit', 'chats following the default track changes to it');
  assert.equal(policy.modeFor('trusted'), 'full', 'changing the default leaves chat levels alone');
  assert.equal(policy.mode, 'auto-edit');
});

test('deny rules still win over a chat with full access', () => {
  const settings = { permissionMode: 'ask', permissionRules: [normalizeRule({ effect: 'deny', tool: 'workspace_shell', match: 'Remove-Item' })] };
  const policy = new PermissionPolicy({ getSettings: () => settings, getChatMode: () => 'full' });
  assert.equal(policy.evaluate({ kind: 'execute', tool: 'workspace_shell', target: 'Remove-Item C:\\x' }, 'c').decision, 'deny');
});

test('memory review is never upgraded by a level or allow rule', () => {
  const policy = policyWith({ permissionMode: 'full', permissionRules: [normalizeRule({ effect: 'allow', tool: 'memory_note' })] });
  assert.equal(policy.evaluate({ kind: 'memory', tool: 'memory_note' }).decision, 'ask');
});

test('rules are validated and an allow-everything rule is refused', () => {
  assert.throws(() => normalizeRule({ effect: 'allow', tool: '*' }), /Full access/);
  assert.throws(() => normalizeRule({ effect: 'maybe', tool: 'x' }), /allow or deny/);
  assert.throws(() => normalizeRule({ effect: 'deny', tool: 'x\ny' }), /tool/);
  assert.throws(() => normalizeRules(new Array(201).fill({ effect: 'deny', tool: 'x' })), /at most/);
  const rule = normalizeRule({ effect: 'deny', tool: ' * ', match: '' });
  assert.equal(rule.tool, '*'); assert.ok(rule.id);
});

test('suggested rules narrow commands to their program and subcommand', () => {
  assert.equal(commandPrefix('npm run build -- --prod'), 'npm run');
  assert.equal(commandPrefix('"C:\\tools\\x.exe" /flag'), 'C:\\tools\\x.exe');
  assert.deepEqual(suggestRule({ kind: 'execute', tool: 'workspace_shell', target: 'git commit -m x' }), { tool: 'workspace_shell', match: 'git commit', label: 'git commit commands' });
  assert.equal(suggestRule({ kind: 'browser', tool: 'browser_open', target: 'https://a.example/x?y' }).match, 'https://a.example*');
  assert.equal(suggestRule({ kind: 'write', tool: 'workspace_write', target: 'a.txt' }).match, '');
});

test('runtime requests are classified for the policy', () => {
  assert.deepEqual(hostAction('workspace_shell', { command: 'dir' }), { kind: 'execute', tool: 'workspace_shell', target: 'dir' });
  assert.equal(hostAction('workspace_read', { path: 'a' }).kind, 'read');
  assert.equal(hostAction('browser_snapshot').kind, 'browser');
  assert.equal(claudeAction('Bash', { command: 'ls' }).kind, 'execute');
  assert.equal(claudeAction('Edit', { file_path: 'a' }).kind, 'write');
  assert.equal(claudeAction('WebFetch', { url: 'https://x.example/a' }).target, 'x.example');
  assert.equal(claudeAction('mcp__exomina__workspace_shell').host, true);
  assert.equal(claudeAction('ExitPlanMode').plan, true);
  assert.equal(acpAction('grok', { kind: 'edit', rawInput: { file_path: 'a.js' } }).kind, 'write');
  assert.equal(acpAction('grok', { kind: 'execute', rawInput: { command: 'ls' } }).target, 'ls');
});

test('native runtimes follow the selected level', () => {
  assert.deepEqual([codexPolicy('read-only').sandbox, codexPolicy('ask').approvalPolicy, codexPolicy('auto-edit').approvalPolicy, codexPolicy('full').sandbox], ['read-only', 'untrusted', 'on-request', 'danger-full-access']);
  assert.equal(codexPolicy('full').approvalPolicy, 'on-request', 'Full access must keep native confirmations available');
  assert.deepEqual(codexPolicy('full').sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(codexPolicy('read-only').approvalPolicy, 'never');
  assert.equal(codexPolicy('nonsense').effective, 'workspaceWrite');
  assert.equal(claudePermissionMode('read-only'), 'plan');
  assert.equal(claudePermissionMode('full'), 'manual');
  // Without native tools, plan mode would only refuse Exomina's read tools; the gateway enforces read only.
  assert.equal(claudePermissionMode('read-only', { nativeTools: false }), 'manual');
  assert.equal(claudePermissionMode('read-only', { nativeTools: true }), 'plan');
});

test('native required confirmation survives Full access, allow rules and chat grants', () => {
  const action = { kind: 'execute', tool: 'codex.command', target: 'synthetic-cleanup approved-fixture' };
  const settings = { permissionMode: 'full', permissionRules: [] };
  const policy = policyWith(settings);
  assert.equal(policy.evaluate(action, 'native').decision, 'allow', 'ordinary Full actions remain automatic');
  assert.equal(policy.evaluate(action, 'native', { requireConfirmation: true }).decision, 'ask');
  settings.permissionRules = [normalizeRule({ effect: 'allow', tool: action.tool, match: 'synthetic-cleanup' })];
  assert.equal(policy.evaluate(action, 'native').decision, 'allow');
  assert.equal(policy.evaluate(action, 'native', { requireConfirmation: true }).decision, 'ask', 'a stored allow rule cannot answer a native confirmation');
  settings.permissionMode = 'ask';
  settings.permissionRules = [];
  policy.grant('native', { tool: action.tool, match: 'synthetic-cleanup' });
  assert.equal(policy.evaluate(action, 'native').decision, 'allow');
  assert.equal(policy.evaluate(action, 'native', { requireConfirmation: true }).decision, 'ask', 'a chat grant cannot answer a native confirmation');
});

test('required confirmation preserves explicit deny and Read only decisions', () => {
  const action = { kind: 'execute', tool: 'codex.command', target: 'synthetic-cleanup fixture' };
  const settings = { permissionMode: 'full', permissionRules: [normalizeRule({ effect: 'deny', tool: action.tool, match: 'synthetic-cleanup' }), normalizeRule({ effect: 'allow', tool: action.tool })] };
  const policy = policyWith(settings);
  policy.grant('native', { tool: action.tool, match: '' });
  assert.equal(policy.evaluate(action, 'native', { requireConfirmation: true }).decision, 'deny');
  settings.permissionMode = 'read-only'; settings.permissionRules = []; policy.clearChat('native');
  for (const kind of ['execute', 'write', 'network', 'elevate']) {
    assert.equal(policy.evaluate({ ...action, kind }, 'native', { requireConfirmation: true }).decision, 'deny', `Read only still blocks ${kind}`);
  }
  assert.equal(policy.evaluate({ kind: 'read', tool: 'workspace_read' }, 'native').decision, 'allow');
});
