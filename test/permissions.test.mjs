import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PermissionPolicy, normalizeRule, normalizeRules, suggestRule, commandPrefix, hostAction, claudeAction, acpAction, codexPolicy, claudePermissionMode, permissionMode } from '../desktop/permissions.mjs';
import { WorkspaceTools } from '../desktop/workspace-tools.mjs';

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

test('remembered command prefixes require a word boundary and cannot authorize shell syntax', () => {
  const settings = { permissionMode: 'ask', permissionRules: [normalizeRule({ effect: 'allow', tool: 'workspace_shell', match: 'npm test' })] };
  const policy = policyWith(settings);
  const decide = command => policy.evaluate(hostAction('workspace_shell', { command }), 'chat').decision;
  assert.equal(decide('npm test -- --watch'), 'allow');
  assert.equal(decide('npm test\t--watch'), 'allow');
  for (const command of ['npm testevil', 'npm test; Write-Output unapproved', 'npm test && echo unapproved', 'npm test | Other-Command', 'npm test > output.txt', 'npm test\necho unapproved', 'npm test $(Other-Command)', 'npm test `Other-Command`', 'npm test "$(Other-Command)"', 'npm test # comment', 'npm test --flag\u2028echo unapproved']) {
    assert.equal(decide(command), 'ask', command);
  }
  settings.permissionRules = [];
  policy.grant('chat', { tool: 'workspace_shell', match: 'npm test' });
  assert.equal(decide('npm test; Write-Output unapproved'), 'ask', 'per-chat grants use the same boundary');
  assert.equal(decide('npm test -- --watch'), 'allow');
});

test('complex command grants stay exact while explicit wildcard grants and deny prefixes retain their scope', () => {
  const command = 'npm test; Write-Output reviewed';
  assert.equal(commandPrefix(command), command);
  assert.equal(suggestRule({ kind: 'execute', tool: 'workspace_shell', target: command }).match, command);
  const settings = { permissionMode: 'ask', permissionRules: [normalizeRule({ effect: 'allow', tool: 'workspace_shell', match: command })] };
  const policy = policyWith(settings), decide = target => policy.evaluate({ kind: 'execute', tool: 'workspace_shell', target }).decision;
  assert.equal(decide(command), 'allow');
  assert.equal(decide(command + '; Write-Output unapproved'), 'ask');
  settings.permissionRules = [normalizeRule({ effect: 'allow', tool: 'workspace_shell', match: '*' })];
  assert.equal(decide(command), 'allow', 'a deliberately unrestricted tool rule remains explicit');
  settings.permissionRules.unshift(normalizeRule({ effect: 'deny', tool: 'workspace_shell', match: 'npm test' }));
  assert.equal(decide(command), 'deny', 'command hardening must not narrow deny rules');
});

test('legacy browser origin grants cannot authorize a suffix host, credentials, or another port', () => {
  const settings = { permissionMode: 'ask', permissionRules: [normalizeRule({ effect: 'allow', tool: 'browser_*', match: 'https://docs.example.com*' })] };
  const policy = policyWith(settings), decide = url => policy.evaluate(hostAction('browser_open', { url }), 'chat').decision;
  for (const url of ['https://docs.example.com', 'https://docs.example.com/path?q=1#part', 'https://DOCS.example.com:443/a']) assert.equal(decide(url), 'allow', url);
  for (const url of ['https://docs.example.com.evil.test/a', 'https://docs.example.com@evil.test/a', 'https://someone@docs.example.com/a', 'https://docs.example.com:444/a', 'http://docs.example.com/a']) assert.equal(decide(url), 'ask', url);
  settings.permissionRules = [];
  policy.grant('chat', { tool: 'browser_open', match: 'https://docs.example.com*' });
  assert.equal(decide('https://docs.example.com.evil.test/a'), 'ask', 'previous per-chat origin grants are also bounded');
  settings.permissionRules = [normalizeRule({ effect: 'allow', tool: 'browser_open', match: 'https://*.example.com/public/*' })];
  assert.equal(decide('https://other.example.com/public/page'), 'allow', 'explicit host and path globs retain their scope');
  assert.equal(decide('https://other.example.com/private/page'), 'ask');
});

test('new browser suggestions include a slash after the exact origin', () => {
  const suggestion = suggestRule(hostAction('browser_open', { url: 'https://docs.example.com/a' }));
  assert.equal(suggestion.match, 'https://docs.example.com/*');
  const policy = policyWith({ permissionMode: 'ask', permissionRules: [normalizeRule({ effect: 'allow', ...suggestion })] });
  assert.equal(policy.evaluate(hostAction('browser_open', { url: 'https://docs.example.com/path' })).decision, 'allow');
  assert.equal(policy.evaluate(hostAction('browser_open', { url: 'https://docs.example.com' })).decision, 'allow');
  assert.equal(policy.evaluate(hostAction('browser_open', { url: 'https://DOCS.example.com:443/path' })).decision, 'allow');
  assert.equal(policy.evaluate(hostAction('browser_open', { url: 'https://someone@docs.example.com/path' })).decision, 'ask');
  assert.equal(policy.evaluate(hostAction('browser_open', { url: 'https://docs.example.com.evil.test/path' })).decision, 'ask');
});

test('workspace shell refuses a second command under an existing first-command grant', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'exomina-permission-'));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  await mkdir(workspace); await mkdir(dataDir);
  const settings = { workspace, permissionMode: 'ask', permissionRules: [normalizeRule({ effect: 'allow', tool: 'workspace_shell', match: 'Write-Output reviewed' })] };
  const policy = policyWith(settings);
  const tools = new WorkspaceTools({ dataDir, getSettings: () => settings, approve: request => policy.evaluate(request.action, 'chat').decision === 'allow' });
  try {
    await assert.rejects(tools.shell({ command: 'Write-Output reviewed; Write-Output unapproved' }, 'chat'), { code: 'TERMINAL_DENIED' });
  } finally { tools.close(); await rm(root, { recursive: true, force: true }); }
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
  assert.equal(commandPrefix('"C:\\tools\\x.exe" /flag'), '"C:\\tools\\x.exe" /flag', 'quoted commands are remembered exactly');
  assert.deepEqual(suggestRule({ kind: 'execute', tool: 'workspace_shell', target: 'git commit -m x' }), { tool: 'workspace_shell', match: 'git commit', label: 'git commit commands' });
  assert.equal(suggestRule({ kind: 'browser', tool: 'browser_open', target: 'https://a.example/x?y' }).match, 'https://a.example/*');
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
