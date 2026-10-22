import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderManager, claudeInstallerCommand, userClaudeCandidates } from '../desktop/providers.mjs';
import { getProvider, isOptInProvider } from '../desktop/provider-catalog.mjs';
import { DISTRIBUTION_PROFILE } from '../desktop/distribution.mjs';

class Child extends EventEmitter {
  constructor() { super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); }
  kill() { this.emit('close', null); }
  finish(code = 0, text = '') { if (text) this.stdout.write(text); this.stdout.end(); this.stderr.end(); setImmediate(() => { this.emit('exit', code); this.emit('close', code); }); }
}

async function fixture(t, { enabled = true, runtime = 'user', files = [], handler = () => {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-claude-optin-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  const candidates = files.map(name => path.join(bin, name));
  for (const file of candidates) await writeFile(file, '');
  const calls = [], events = [];
  const manager = new ProviderManager({
    dataDir: path.join(dir, 'private'), workspace: path.join(dir, 'workspace'),
    isProviderEnabled: id => id !== 'claude' || enabled, claudeRuntime: runtime,
    userClaudeCandidates: () => [...candidates, path.join(bin, 'missing-claude')],
    emit: event => events.push(event),
    spawnImpl: (exe, args, options) => { const child = new Child(); calls.push({ exe, args, options }); setImmediate(() => handler(child, exe, args, candidates)); return child; },
  });
  manager.adapters.clear();
  t.after(async () => { manager.close(); await rm(dir, { recursive: true, force: true }); });
  return { manager, calls, events, candidates, bin };
}

test('shared builds keep Claude in the catalog as an opt-in that starts off', () => {
  const entry = getProvider('claude');
  assert.ok(entry);
  assert.equal(isOptInProvider('claude'), ['beta','public'].includes(DISTRIBUTION_PROFILE));
  if (['beta','public'].includes(DISTRIBUTION_PROFILE)) assert.match(entry.description, /your own copy/);
  for (const id of ['codex', 'anthropic-api', 'grok']) assert.equal(isOptInProvider(id), false);
});

test('a turned-off Claude connection reports Off without finding, starting or installing anything', async t => {
  const f = await fixture(t, { enabled: false });
  f.manager.getCodex = async () => { throw new Error('Codex is not part of this check.'); };
  const rows = await f.manager.status();
  const claude = rows.find(row => row.id === 'claude');
  assert.equal(claude.optIn, true); assert.equal(claude.enabled, false);
  assert.equal(claude.connected, false); assert.equal(claude.available, false);
  assert.match(claude.detail, /Off/);
  assert.deepEqual(f.calls, [], 'No Claude Code lookup, installer or sign-in process ran.');
  assert.equal((await f.manager.subscriptionModels()).claude, undefined);
  await assert.rejects(f.manager.connect('claude'), /not available in this build/);
});

test('only a program that identifies itself as Claude Code is used', async t => {
  const f = await fixture(t, { files: ['impostor.exe', 'claude.exe'], handler: (child, exe) => child.finish(0, path.basename(exe) === 'claude.exe' ? '2.1.211 (Claude Code)\n' : 'something else 1.0\n') });
  assert.equal(await f.manager.executable('claude'), f.candidates[1]);
  assert.deepEqual(f.calls.map(call => call.args), [['--version'], ['--version']]);
  assert.equal(f.calls[0].options.shell, false);
});

test('turning on without Claude Code runs Anthropic’s installer, then Anthropic’s sign-in', async t => {
  let installed = false;
  const f = await fixture(t, { handler: (child, exe, args, candidates) => {
    if (args[0] === '--version') return child.finish(installed ? 0 : 1, installed ? '2.1.211 (Claude Code)\n' : '');
    if (args.includes('-Command') || args[0] === '-c') { installed = true; return writeFile(path.join(path.dirname(candidates[0] || path.join(f.bin, 'x')), 'claude.exe'), '').then(() => child.finish(0)); }
    if (args[0] === 'auth') { child.stdout.write('Open https://claude.ai/oauth/authorize?code=synthetic\n'); }
  } });
  // The installer creates the binary at a location the finder already checks.
  f.manager.claudeCandidates = () => [path.join(f.bin, 'claude.exe')];
  const result = await f.manager.connect('claude');
  const installer = f.calls.find(call => call.args.includes('-Command') || call.args[0] === '-c');
  assert.ok(installer, 'installer ran');
  assert.equal(installer.exe, claudeInstallerCommand().file);
  assert.equal(installer.options.shell, false);
  const login = f.calls.find(call => call.args[0] === 'auth');
  assert.deepEqual(login.args, ['auth', 'login']);
  assert.equal(login.exe, path.join(f.bin, 'claude.exe'));
  assert.match(login.options.env.CLAUDE_CONFIG_DIR, /claude-home$/, 'Exomina keeps its own separate Claude sign-in');
  assert.match(result.url, /^https:\/\/claude\.ai\//);
});

test('the user’s own copy accepts every sign-in method Claude Code offers; the bundled one stays subscription-only', async t => {
  const console = JSON.stringify({ loggedIn: true, authMethod: 'console' });
  const answer = (child, exe, args) => child.finish(0, args[0] === '--version' ? '2.1.211 (Claude Code)\n' : console);
  const own = await fixture(t, { files: ['claude.exe'], handler: answer });
  const ownStatus = await own.manager.claudeStatus();
  assert.equal(ownStatus.connected, true);
  assert.match(ownStatus.detail, /API usage/);
  const bundled = await fixture(t, { runtime: 'bundled', handler: answer });
  bundled.manager.claudePath = process.execPath;
  const bundledStatus = await bundled.manager.claudeStatus();
  assert.equal(bundledStatus.connected, false);
});

test('installer and search locations match Anthropic’s documented setup', () => {
  assert.deepEqual(claudeInstallerCommand({ SystemRoot: 'C:\\Windows' }, 'win32').args.at(-1), 'irm https://claude.ai/install.ps1 | iex');
  assert.deepEqual(claudeInstallerCommand({}, 'linux'), { file: '/bin/bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] });
  assert.equal(userClaudeCandidates({ USERPROFILE: 'C:\\Users\\synthetic' }, 'win32')[0], path.join('C:\\Users\\synthetic', '.local', 'bin', 'claude.exe'));
  assert.ok(userClaudeCandidates({ HOME: '/home/a' }, 'darwin').includes('/opt/homebrew/bin/claude'));
});
