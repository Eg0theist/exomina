import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AntigravityProvider, parseAntigravityModels, antigravityError, applyAntigravityEvent } from '../desktop/provider-antigravity.mjs';
import { subscriptionEnvironment } from '../desktop/providers.mjs';
import { getProvider } from '../desktop/provider-catalog.mjs';
import { acquireAntigravityTurn, antigravityEnvironment } from '../desktop/antigravity-profile.mjs';

function fakeChild(lines, { code = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.written = '';
  child.stdin.on('data', chunk => { child.written += chunk; });
  child.stdin.on('finish', () => setImmediate(() => {
    for (const line of lines) child.stdout.write(typeof line === 'string' ? line + '\n' : JSON.stringify(line) + '\n');
    if (stderr) child.stderr.write(stderr);
    child.stdout.end(); child.stderr.end();
    setImmediate(() => child.emit('close', code));
  }));
  return child;
}
function manager(child, t) {
  const calls = { spawn: [], steps: [], stopped: 0 };
  const dataDir = path.join(process.cwd(), '.verification', `antigravity-test-${randomUUID()}`);
  t?.after(() => rm(dataDir, { recursive: true, force: true }));
  return { calls, workspace: process.cwd(), dataDir, prepare: async () => {}, environment: () => ({}), modelCache: new Map(),
    spawn: (exe, args, provider, cwd, env) => { calls.spawn.push({ exe, args, provider, cwd, env }); return child; },
    stopChild: () => { calls.stopped++; },
    delta(state, text) { state.text = (state.text || '') + text; },
    toolStep(state, step) { calls.steps.push(step); } };
}

test('model list is parsed from agy models output', () => {
  assert.deepEqual(parseAntigravityModels('gemini-3.8-flash-high     Gemini 3.8 Flash (High)\r\ngemini-3.1-pro-high       Gemini 3.1 Pro (High)\n...\n'),
    [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }, { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' }]);
});

test('errors become plain next steps', () => {
  assert.match(antigravityError('Error: authentication required'), /not signed in.*Sign in/);
  assert.match(antigravityError('invalid model selection (--model "x")'), /does not offer the selected model/);
  assert.match(antigravityError(''), /stopped without an answer/);
  assert.match(antigravityError('daily usage quota exhausted'), /plan’s usage limit is reached/);
  assert.doesNotMatch(antigravityError('temporary rate limit, retry later'), /plan’s usage limit is reached/);
  assert.doesNotMatch(antigravityError('RESOURCE_EXHAUSTED: requests per minute exceeded'), /plan’s usage limit is reached/);
});

test('stream events update text, tool steps and the conversation id', () => {
  const m = manager(), state = {};
  applyAntigravityEvent({ event: 'init', conversation_id: 'c-1', init: {} }, state, m);
  applyAntigravityEvent({ event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hel' } }, state, m);
  applyAntigravityEvent({ event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'lo' } }, state, m);
  applyAntigravityEvent({ event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\r\n' } } }, state, m);
  applyAntigravityEvent({ event: 'step_update', step_update: { step_index: 5, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { error: { type: 'denied', message: 'Permission denied' } } } }, state, m);
  const result = applyAntigravityEvent({ event: 'result', result: { status: 'SUCCESS', response: 'Hello' } }, state, m);
  assert.equal(state.sessionId, 'c-1'); assert.equal(state.text, 'Hello'); assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(m.calls.steps.map(step => [step.name, step.status, step.output]), [['run_command', 'done', 'hi\r\n'], ['write_to_file', 'error', 'Permission denied']]);
});

test('a turn sends one prompt over stdin, continues the saved conversation and returns the streamed reply', async t => {
  const child = fakeChild([
    { event: 'init', conversation_id: 'conv-9', init: { tools: [] } },
    'not json is ignored',
    { event: 'step_update', step_update: { conversation_id: 'conv-9', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'Answer.' } },
    { event: 'result', result: { conversation_id: 'conv-9', status: 'SUCCESS', response: 'Answer.' } },
  ]);
  const m = manager(child, t), provider = new AntigravityProvider(m, { executablePath: process.execPath }), state = {};
  const result = await provider.run({ prompt: 'Hi there', sessionId: 'conv-9', model: 'gemini-3.8-flash-high', effort: 'high' }, state);
  assert.deepEqual(result, { sessionId: 'conv-9', text: 'Answer.' });
  const { args, provider: id } = m.calls.spawn[0];
  assert.equal(id, 'antigravity');
  for (const pair of [['--input-format', 'stream-json'], ['--output-format', 'stream-json'], ['--conversation', 'conv-9'], ['--model', 'gemini-3.8-flash-high'], ['--effort', 'high']]) assert.equal(args[args.indexOf(pair[0]) + 1], pair[1]);
  assert.ok(args.includes('--sandbox')); assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.equal(m.calls.spawn[0].env.USERPROFILE, path.join(m.dataDir, 'antigravity-home'));
  assert.notEqual(m.calls.spawn[0].cwd, m.workspace);
  assert.deepEqual(JSON.parse(child.written), { event: 'user', message: { content: 'Hi there' } });
});

test('a failed turn reports the provider error in plain language', async t => {
  const child = fakeChild([{ event: 'result', result: { status: 'ERROR', error: 'authentication required' } }], { code: 1 });
  const m = manager(child, t), provider = new AntigravityProvider(m, { executablePath: process.execPath });
  await assert.rejects(provider.run({ prompt: 'x' }, {}), /not signed in/);
});

test('stopping a reply stops the CLI process and reports Stopped', async t => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const m = manager(child, t), provider = new AntigravityProvider(m, { executablePath: process.execPath }), state = {};
  const running = provider.run({ prompt: 'x' }, state);
  while (!m.calls.spawn.length) await new Promise(resolve => setImmediate(resolve));
  state.cancelled = true; state.adapterCancel(); child.stdout.end(); child.emit('close', null);
  await assert.rejects(running, /Stopped/); assert.equal(m.calls.stopped, 1);
});

test('a missing CLI is reported as not installed with the official install route', async () => {
  const m = manager(), provider = new AntigravityProvider(m);
  provider.executable = async () => null;
  const status = await provider.status();
  assert.equal(status.installed, false); assert.equal(status.connected, false); assert.match(status.detail, /antigravity\.google\/cli\/install\.ps1/);
  await assert.rejects(provider.connect(), /Install Antigravity CLI/);
});

test('Antigravity uses its protected Exomina profile and never receives Google API keys', () => {
  const env = subscriptionEnvironment('antigravity', 'C:\\data', { USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', GEMINI_API_KEY: 'secret', GOOGLE_API_KEY: 'secret', PATH: 'C:\\bin' });
  assert.equal(env.USERPROFILE, path.join('C:\\data', 'antigravity-home')); assert.equal(env.LOCALAPPDATA, path.join('C:\\data', 'antigravity-home', 'AppData', 'Local'));
  assert.equal(env.GEMINI_API_KEY, undefined); assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(getProvider('antigravity')?.mode, 'subscription');
});

test('a tool-enabled Antigravity turn receives isolated MCP settings and attached image/file references', async t => {
  const child = fakeChild([{ event: 'result', result: { status: 'SUCCESS', response: 'Done.' } }]);
  const m = manager(child, t);
  m.gateway = { script: path.join(process.cwd(), 'desktop', 'mcp-stdio.mjs') };
  m.callTool = async () => ({ content: [] });
  const state = { conversationId: 'attachment-run', toolDefinitions: [{ name: 'browser_snapshot', inputSchema: { type: 'object' } }] };
  const provider = new AntigravityProvider(m, { executablePath: process.execPath });
  let config;
  const spawn = m.spawn;
  m.spawn = (exe, args, id, cwd, env) => { config = readFile(path.join(cwd, '.gemini', 'config', 'mcp_config.json'), 'utf8'); return spawn(exe, args, id, cwd, env); };
  await provider.run({ prompt: 'Inspect these.', attachments: [{ name: 'notes.md', path: path.join(m.workspace, 'notes.md') }], images: [{ mimeType: 'image/png', dataBase64: 'cGl4ZWxz' }] }, state);
  assert.deepEqual(Object.keys(JSON.parse(await config).mcpServers), ['exomina']);
  const prompt = JSON.parse(child.written).message.content;
  assert.match(prompt, /notes.md/); assert.match(prompt, /antigravity_attachment_read/);
  const settings = JSON.parse(await readFile(path.join(m.dataDir, 'antigravity-home', '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.equal(settings.useG1Credits, false); assert.deepEqual(settings.permissions.allow, ['mcp(exomina/*)']);
  assert.ok(settings.permissions.deny.includes('command(*)'));
  assert.deepEqual(JSON.parse(await readFile(path.join(m.dataDir, 'antigravity-home', '.gemini', 'config', 'mcp_config.json'), 'utf8')), { mcpServers: {} });
  assert.deepEqual(JSON.parse(await readFile(path.join(m.calls.spawn[0].cwd, '.gemini', 'config', 'mcp_config.json'), 'utf8')), { mcpServers: {} });
});

test('Antigravity contains failed input and output pipes and rejects the turn safely', async t => {
  for (const name of ['stdin', 'stdout', 'stderr']) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    const m = manager(child, t), provider = new AntigravityProvider(m, { executablePath: process.execPath });
    m.stopChild = () => { m.calls.stopped++; child.emit('close', 1); };
    const running = provider.run({ prompt: 'x' }, {}), rejected = assert.rejects(running, error => error.handoffUnsafe && /Synthetic/.test(error.message));
    while (!m.calls.spawn.length) await new Promise(resolve => setImmediate(resolve));
    assert.doesNotThrow(() => child[name].emit('error', new Error('Synthetic pipe failure')));
    await rejected;
    assert.equal(m.calls.stopped, 1);
    assert.doesNotThrow(() => child[name].emit('error', new Error('Late pipe failure')));
  }
});

test('Antigravity preserves structured provider errors', () => {
  assert.match(antigravityError({ message: 'authentication required', code: 401 }), /not signed in/);
  assert.match(antigravityError({ code: 'usage_limit_exceeded', message: 'Allowance ended.' }), /plan’s usage limit/);
});

test('Google manual sign-in uses a safely quoted launcher and holds the empty-profile lease until its window closes', { skip: process.platform !== 'win32' }, async t => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const m = manager(child, t), launches = [];
  m.environment = () => ({ HOME: 'unowned', USERPROFILE: 'unowned', APPDATA: 'unowned', SSH_CLIENT: 'unrelated', SSH_TTY: 'unrelated', SSH_CONNECTION: 'unrelated' });
  const provider = new AntigravityProvider(m, { spawnImpl: (exe, args, options) => {
    launches.push({ exe, args, options });
    setImmediate(() => child.stdout.write('EXOMINA_ANTIGRAVITY_SIGNIN_STARTED\n'));
    return child;
  } });
  provider.executable = async () => "C:\\an & odd's directory\\agy.exe";
  assert.match((await provider.connect()).message, /manual sign-in flow.*normal browser.*authorization code directly/);
  assert.equal(launches.length, 1); assert.equal(launches[0].exe, 'powershell.exe');
  assert.equal(launches[0].args.at(-2), '-Command');
  assert.ok(!launches[0].args.includes('-EncodedCommand'));
  const launcher = launches[0].args.at(-1);
  assert.ok(launcher.includes("-FilePath 'C:\\an & odd''s directory\\agy.exe'"));
  assert.ok(launcher.includes("-ArgumentList '--log-file','NUL'"));
  assert.match(launcher, /-WindowStyle Normal -PassThru/); assert.match(launcher, /WaitForExit/);
  assert.equal(launches[0].options.windowsHide, true);
  assert.equal(launches[0].options.env.SSH_TTY, 'exomina-manual-oauth');
  assert.equal(launches[0].options.env.SSH_CLIENT, undefined);
  assert.equal(launches[0].options.env.SSH_CONNECTION, undefined);
  assert.equal(launches[0].options.env.USERPROFILE, path.join(m.dataDir, 'antigravity-home'));
  assert.equal(launches[0].options.env.APPDATA, path.join(m.dataDir, 'antigravity-home', 'AppData', 'Roaming'));
  await assert.rejects(provider.connect(), /Stop the Antigravity reply or close its sign-in window/);
  let started = false;
  const pendingTurn = acquireAntigravityTurn(m.dataDir, {}).then(turn => { started = true; return turn; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, false);
  const config = path.join(m.dataDir, 'antigravity-home', '.gemini', 'config', 'mcp_config.json');
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { mcpServers: {} });
  child.emit('close', 0);
  const next = await pendingTurn; await next.close();
  assert.equal(started, true);
});

test('manual OAuth activation is sign-in only and cannot leak unrelated SSH environment into metadata or replies', async t => {
  const home = path.join(process.cwd(), '.verification', 'manual-profile');
  const original = { SSH_CLIENT: 'other', SSH_TTY: 'other', SSH_CONNECTION: 'other', ssh_tty: 'other', USERPROFILE: 'personal-profile', APPDATA: 'personal-appdata', PATH: 'native-path' };
  const metadata = antigravityEnvironment(original, home);
  const signIn = antigravityEnvironment(original, home, { manualSignIn: true });
  assert.equal(metadata.SSH_TTY, undefined); assert.equal(metadata.ssh_tty, undefined);
  assert.equal(metadata.SSH_CLIENT, undefined); assert.equal(metadata.SSH_CONNECTION, undefined);
  assert.equal(metadata.USERPROFILE, home); assert.equal(metadata.APPDATA, path.join(home, 'AppData', 'Roaming'));
  assert.equal(signIn.SSH_TTY, 'exomina-manual-oauth'); assert.equal(signIn.PATH, 'native-path');
  assert.equal(original.SSH_TTY, 'other');
  const child = fakeChild([{ event: 'result', result: { status: 'SUCCESS', response: 'Done.' } }]);
  const m = manager(child, t); m.environment = () => original;
  await new AntigravityProvider(m, { executablePath: process.execPath }).run({ prompt: 'x' }, {});
  assert.equal(m.calls.spawn[0].env.SSH_TTY, undefined);
  assert.equal(m.calls.spawn[0].env.SSH_CONNECTION, undefined);
});

test('metadata pipe failures settle only after the owned process closes and contain late errors', async t => {
  for (const name of ['stdout', 'stderr']) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const m = manager(child, t); let closed = false;
    m.stopChild = () => setImmediate(() => { closed = true; child.emit('close', 1); });
    const provider = new AntigravityProvider(m, { spawnImpl: (_exe, args) => {
      assert.deepEqual(args, ['--log-file', process.platform === 'win32' ? 'NUL' : '/dev/null', 'models']); return child;
    } });
    const command = provider.command(process.execPath, ['models']);
    while (!child[name].listenerCount('error')) await new Promise(resolve => setImmediate(resolve));
    assert.doesNotThrow(() => child[name].emit('error', new Error('Synthetic metadata pipe failure')));
    assert.match((await command).stderr, /Synthetic metadata/); assert.equal(closed, true);
    assert.doesNotThrow(() => child[name].emit('error', new Error('Late metadata failure')));
  }
});

test('a gateway token split across stderr chunks is redacted before a turn error is returned', async t => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const m = manager(child, t);
  m.gateway = { script: path.join(process.cwd(), 'desktop', 'mcp-stdio.mjs') }; m.callTool = async () => ({ content: [] });
  const provider = new AntigravityProvider(m, { executablePath: process.execPath });
  let token;
  child.stdin.on('finish', async () => {
    const config = JSON.parse(await readFile(path.join(m.dataDir, 'antigravity-home', '.gemini', 'config', 'mcp_config.json'), 'utf8'));
    token = config.mcpServers.exomina.env.EXOMINA_TOOL_TOKEN;
    child.stderr.write('Synthetic failure ' + token.slice(0, 31)); child.stderr.write(token.slice(31));
    child.stdout.end(); child.emit('close', 1);
  });
  const running = provider.run({ prompt: 'x' }, { conversationId: 'redaction', toolDefinitions: [{ name: 'memory_note', inputSchema: {} }] });
  await assert.rejects(running, error => !error.message.includes(token) && /\[redacted\]/.test(error.message));
});
