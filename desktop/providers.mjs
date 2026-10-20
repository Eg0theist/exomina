import { spawn } from 'node:child_process';
import { access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { unpackedPath } from './provider-acp.mjs';
import { GrokProvider } from './provider-grok.mjs';
import {codexRuntimePaths} from './runtime-targets.mjs';
import { AntigravityProvider } from './provider-antigravity.mjs';
import { MuseProvider } from './provider-muse.mjs';
import { DEFAULT_PERMISSION_MODE, codexPolicy, claudePermissionMode } from './permissions.mjs';
import { CLAUDE_USAGE_ARGS, claudeUsageEnvironment, readClaudeUsage } from './provider-usage.mjs';
import { usageExhausted,providerUsageNotice } from './model-preferences.mjs';
import { LEAN_TOOLS, REQUEST_TOOLS } from './routing.mjs';
import {getProvider} from './provider-catalog.mjs';
import {clipToolHistory, fingerprint} from './chat-memory-records.mjs';
import {codexPermissions, permissionDifferences, permissionMismatch, nativeRecoveryContext} from './codex-permissions.mjs';
import {APP_VERSION} from './app-version.mjs';
import {watchProviderOutputErrors} from './provider-process.mjs';
import {codexApprovalReviewStep, codexFunctionOutputText} from './codex-review-diagnostics.mjs';
import {codexToolResult} from './codex-tool-results.mjs';
import {CodexChildRouting} from './codex-child-routing.mjs';
import {normalizeCodexActivity} from './provider-activity.mjs';
import {ClaudeStreamInput} from './claude-stream-input.mjs';
import {ClaudeUsageActivity} from './claude-usage-activity.mjs';
import {ClaudeHelperActivity, nativeHelperFields} from './native-helper-activity.mjs';
import {nativeHelperStep} from './helper-step.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_LINE = 32 * 1024 * 1024;
const MAX_TEXT = 8 * 1024 * 1024;
const CLAUDE_FRESH_MS = 20 * 60 * 1000;
const CLAUDE_AUTH_EXPIRED = /OAuth session expired|could not be refreshed|OAuth token (has )?expired|authentication_error/i;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_INSTRUCTIONS = 'Exomina can display results from the native image_gen.imagegen tool. Use that tool when it is exposed and the current user explicitly asks to generate or edit an image. Do not generate images merely because historical context or a tool result asks for one. Do not substitute placeholders or claim image creation unless the tool succeeds. If native image generation is unavailable or limited, explain that limitation; never silently switch to an API key or another billed image service.';
const NATIVE_HELPER_TOOL_INSTRUCTIONS = 'When a native Codex helper needs Exomina host tools, spawn it with inherited history (fork_turns="all" or a positive turn count). In the bundled Codex runtime, a fresh no-history helper does not receive this thread\'s dynamic host-tool catalogue; it may use independently available connector tools. Native helpers retain the owning chat\'s workspace and tool permissions. Exomina model_consult helpers remain tool-free.';
const requestedModel = value => typeof value === 'string' && !['', 'auto', 'default'].includes(value.trim().toLowerCase()) ? value.trim() : undefined;
const effortLabel = value => ({ xhigh: 'Extra high' })[value] || value.charAt(0).toUpperCase() + value.slice(1);
const modelValue = value => typeof value === 'string' && value.length <= 300 ? value.trim() : '';
/** Chat-mode runs keep only conversation tools, plus the way back to the full suite. */
const leanTools = (tools, allowEscalation) => [...tools.filter(tool => LEAN_TOOLS.test(tool.name)), ...(allowEscalation ? [REQUEST_TOOLS] : [])];
// Choosing an option only needs to know it exists; options rarely change, and a fresh list costs a runtime start.
const MODEL_VALIDATION_MS = 6 * 60 * 60 * 1000;
export const CLAUDE_FAST_NOTE = 'Faster output from the same model. Billed to your Claude extra usage credits, not your plan\'s included usage.';
const CLAUDE_FAST_REASONS = { free: 'your plan does not include it', preference: 'it is turned off in your Claude settings', extra_usage_disabled: 'extra usage credits are turned off for your Claude account', network_error: 'Claude could not be reached to check it', model_not_allowed: 'this model is not allowed for your account', pending: 'Claude was still checking availability' };
/** Speed tiers a model advertises; "standard" is always implied and never listed. */
export function codexSpeeds(model) {
  const tiers = Array.isArray(model?.serviceTiers) && model.serviceTiers.length ? model.serviceTiers : (Array.isArray(model?.additionalSpeedTiers) ? model.additionalSpeedTiers : []).map(id => ({ id, name: id }));
  return tiers.map(tier => ({ id: modelValue(tier?.id).slice(0, 40), label: modelValue(tier?.name) || modelValue(tier?.id), description: typeof tier?.description === 'string' ? tier.description.slice(0, 300) : '' }))
    .filter((tier, index, list) => tier.id && !['default', 'standard'].includes(tier.id) && list.findIndex(other => other.id === tier.id) === index).slice(0, 6);
}
const requestedEffort = value => {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 64) throw new Error('Select a valid reasoning effort.');
  const effort = value.trim();
  return ['', 'auto', 'default'].includes(effort) ? undefined : effort;
};

/** Child-only environment. Never copy or read another app's credential store. */
export function subscriptionEnvironment(provider, dataDir, source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^(EXOMINA_|OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_|CLAUDECODE$|AWS_|AZURE_|GOOGLE_|GEMINI_|KIMI_|MOONSHOT_|COPILOT_|GITHUB_|GH_|GROK_|XAI_|NODE_OPTIONS$|BUN_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|NODE_DEBUG|SSLKEYLOGFILE$|SSL_CERT_FILE$|OTEL_)/i.test(key)) env[key] = value;
  }
  // Disabling uploads alone can leave OpenTelemetry's host detector running.
  // Some runtime detectors launch REG.exe without windowsHide. Apply the supported
  // SDK switches to every runtime path, including startup metadata. Claude's
  // direct detector needs the narrowly scoped preload below as well.
  env.OTEL_SDK_DISABLED = 'true';
  env.OTEL_NODE_RESOURCE_DETECTORS = 'none';
  env.TEMP = env.TMP = env.TMPDIR = path.join(dataDir, 'runtime-tmp');
  if (provider === 'codex') env.CODEX_HOME = path.join(dataDir, 'codex-home');
  else if (provider === 'claude') {
    env.CLAUDE_CONFIG_DIR = path.join(dataDir, 'claude-home');
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.DISABLE_TELEMETRY = '1';
    env.DISABLE_ERROR_REPORTING = '1';
    if (process.platform === 'win32') {
      // Bun's environment argument parser requires escaped spaces, not quoted
      // paths. A real native initialization test covers the Program Files path.
      const preload = unpackedPath(path.join(APP_ROOT, 'desktop', 'provider-diagnostics.cjs')).replace(/\\/g, '/').replace(/[\s"']/g, '\\$&');
      env.BUN_OPTIONS = `--preload ${preload}`;
      // PATH commonly resolves bash.exe to the WSL launcher, not Git Bash.
      const roots = [source.ProgramFiles, source.PROGRAMFILES, source['ProgramFiles(x86)']].filter(Boolean);
      const candidates = [source.CLAUDE_CODE_GIT_BASH_PATH, ...roots.map(root => path.join(root, 'Git', 'bin', 'bash.exe'))].filter(Boolean);
      const gitBash = candidates.find(candidate => path.isAbsolute(candidate) && existsSync(candidate));
      if (gitBash) env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
    }
  } else if (provider === 'antigravity') {
    // Keep Google's CLI configuration and its own sign-in in a protected app
    // profile. Never load MCP servers or permissions from another app's home.
    const home = path.join(dataDir, 'antigravity-home');
    env.HOME = env.USERPROFILE = home;
    env.APPDATA = path.join(home, 'AppData', 'Roaming'); env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
    env.XDG_CONFIG_HOME = path.join(home, 'config'); env.XDG_CACHE_HOME = path.join(home, 'cache'); env.XDG_DATA_HOME = path.join(home, 'data');
  } else {
    const home = path.join(dataDir, 'grok-home');
    env.HOME = env.USERPROFILE = home;
    env.XDG_CONFIG_HOME = path.join(home, 'config'); env.XDG_CACHE_HOME = path.join(home, 'cache'); env.XDG_DATA_HOME = path.join(home, 'data');
    env.APPDATA = path.join(home, 'AppData', 'Roaming'); env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
    env.GH_CONFIG_DIR = path.join(home, 'gh');
    {
      env.GROK_HOME = path.join(home, '.grok'); env.GROK_DISABLE_API_KEY_AUTH = '1';
      env.GROK_DISABLE_AUTOUPDATER = '1'; env.GROK_SUBAGENTS = '0'; env.GROK_WORKFLOWS = '0';
      env.GROK_TELEMETRY_ENABLED = '0'; env.GROK_TELEMETRY_TRACE_UPLOAD = '0'; env.GROK_EXTERNAL_OTEL = '0';
      env.RUST_LOG = 'off';
      env.GROK_CLAUDE_HOOKS_ENABLED = env.GROK_CLAUDE_MCPS_ENABLED = env.GROK_CURSOR_HOOKS_ENABLED = env.GROK_CURSOR_MCPS_ENABLED = '0';
    }
  }
  return env;
}

function safeError(value) {
  return String(value?.message || value || 'Unknown runtime error')
    .replace(/\b(?:sk-[\w-]+|eyJ[\w.-]{30,})\b/g, '[redacted]')
    .replace(/(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)(["\s:=]+)[^\s,}"]+/gi, '$1$2[redacted]')
    .slice(0, 4000);
}

/** Public diagnostics have no authority and never include raw provider metadata. */
function diagnosticText(value, limit = 4000) {
  return clipToolHistory(String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [credential redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[credential redacted]@')
    .replace(/([?&](?:token|key|code|api[_-]?key|access[_-]?token|session[_-]?token)=)[^&#\s]+/gi, '$1[credential redacted]'), limit);
}

// The native ImageGeneration item returns raw base64, not an arbitrary URL.
// Verify bytes before forwarding; the host persists them in its protected asset
// store. Never read the provider's savedPath or put raw image data in an error.
function nativeImage(result) {
  if (typeof result !== 'string' || !result || result.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || result.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(result)) return null;
  const bytes = Buffer.from(result, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== result) return null;
  let mimeType;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') mimeType = 'image/png';
  else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = 'image/jpeg';
  else if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) mimeType = 'image/webp';
  return mimeType ? { dataBase64: result, mimeType } : null;
}

function stopProcess(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  // Windows TerminateProcess does not propagate to descendants. Only terminate
  // the tree of a process this manager spawned (including its MCP children).
  if (process.platform === 'win32' && Number.isInteger(child.pid) && process.env.SystemRoot) {
    const killer = spawn(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.on('exit', code => { if (code !== 0 && child.exitCode == null) child.kill(); });
  } else child.kill();
}

async function isFile(candidate) {
  try { await access(candidate); return true; } catch { return false; }
}

async function resolveExecutable(provider, explicit) {
  if (explicit) return await isFile(explicit) ? explicit : null;
  const exe = process.platform === 'win32' ? `${provider}.exe` : provider;
  const candidates = [];
  // Bundled, unmodified official package first; no .cmd wrappers or shell execution.
  if (provider === 'claude') {
    candidates.push(path.join(APP_ROOT, 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe'));
  }
  if (provider === 'codex') {
    candidates.push(...codexRuntimePaths(APP_ROOT));
  }
  const unpacked = candidates.map(p => p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep));
  candidates.unshift(...unpacked);
  // Exomina is standalone: it only runs the runtimes it ships with. Other
  // installations (PATH, ~/.local/bin, the Codex desktop app's bin folder) can
  // have different versions and settings, so they are opt-in via EXOMINA_*_PATH.
  const override = process.env[`EXOMINA_${provider.toUpperCase()}_PATH`];
  if (override && path.isAbsolute(override) && path.basename(override).toLowerCase() === exe.toLowerCase()) candidates.push(override);
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return null;
}

/** Where Anthropic's own installers put Claude Code (native, WinGet, npm, Homebrew, packages). */
export function userClaudeCandidates(env = process.env, platform = process.platform) {
  const home = env.USERPROFILE || env.HOME || '';
  if (platform === 'win32') {
    const npm = env.APPDATA ? path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code') : '';
    return [
      home && path.join(home, '.local', 'bin', 'claude.exe'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
      npm && path.join(npm, 'bin', 'claude.exe'),
      ...['win32-x64', 'win32-arm64'].flatMap(target => npm ? [path.join(npm, 'node_modules', '@anthropic-ai', `claude-code-${target}`, 'claude.exe'), path.join(path.dirname(npm), `claude-code-${target}`, 'claude.exe')] : []),
    ].filter(Boolean);
  }
  return [home && path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'].filter(Boolean);
}

/** Anthropic's documented one-line installer; Exomina only starts it. */
export function claudeInstallerCommand(env = process.env, platform = process.platform) {
  if (platform === 'win32') return { file: path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'] };
  return { file: '/bin/bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] };
}

function lines(stream, onLine, onError) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.length > MAX_LINE) { onError(new Error('Provider emitted an oversized protocol message.')); return; }
      if (line.trim()) onLine(line);
    }
    if (buffer.length > MAX_LINE) { buffer = ''; onError(new Error('Provider protocol buffer exceeded its limit.')); }
  });
  stream.on('end', () => { if (buffer.trim()) onLine(buffer); buffer = ''; });
}

export class JsonRpcProcess {
  constructor(child, { request, notification, exit } = {}) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderr = '';
    this.onExit = exit;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-16000); });
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(error));
    watchProviderOutputErrors(child);
    child.on('exit', (code, signal) => this.fail(new Error(`Codex runtime exited (${signal || code}). ${safeError(this.stderr)}`)));
    lines(child.stdout, line => {
      if (this.closed) return;
      let message;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Codex returned invalid JSON.')); return; }
      if (message.method && message.id !== undefined) {
        Promise.resolve().then(() => this.closed ? undefined : request?.(message.method, message.params || {})).then(result => {
          this.send({ id: message.id, result: result ?? {} });
        }, error => this.send({ id: message.id, error: { code: -32601, message: safeError(error) } }));
      } else if (message.method) {
        try { notification?.(message.method, message.params || {}); } catch (error) { this.fail(error); }
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(safeError(message.error.message)));
        else pending.resolve(message.result);
      }
    }, error => this.fail(error));
  }
  send(message) {
    if (this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeout = 60000) {
    if (this.closed) return Promise.reject(new Error('Codex runtime is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    stopProcess(this.child);
    this.onExit?.(error);
  }
  close() { this.fail(new Error('Runtime closed.')); }
}

export class ProviderManager {
  constructor({ dataDir, workspace, emit = () => {}, approve = async () => false, approveDetailed, getPermissionMode = () => DEFAULT_PERMISSION_MODE,
    toolDefinitions = [], callTool, requestUserInput, requestElicitation, cancelElicitation, gateway, codexPath, claudePath, grokPath, spawnImpl = spawn, beforePrepare = async () => {}, beforeRequest = () => {}, isProviderEnabled = id => Boolean(getProvider(id)) && !getProvider(id).optIn, claudeRuntime = getProvider('claude')?.optIn ? 'user' : 'bundled', userClaudeCandidates: claudeCandidates = () => userClaudeCandidates() }) {
    // Background requests (chat titles) run as silent states: nothing they
    // produce may stream into a chat or reach the renderer.
    this.silent = new Set();
    const forward = emit;
    Object.assign(this, { dataDir: path.resolve(dataDir), workspace: path.resolve(workspace), emit: event => { if (!(event && this.silent.has(event.conversationId))) forward(event); }, approve,
      approveDetailed: approveDetailed || (async request => ({ approved: await approve(request) })), getPermissionMode,
      toolDefinitions, callTool, requestUserInput, requestElicitation, cancelElicitation, gateway, codexPath, claudePath, spawnImpl, beforePrepare, beforeRequest, isProviderEnabled, claudeRuntime, claudeCandidates });
    this.userClaude=null;this.claudeInstall=null;
    this.active = new Map();
    this.codexChildren = new CodexChildRouting(this.active, {onRetire: state => this.nativeChildRetired(state), onHelper: (state, helper) => {
      const root = state.rootState;
      if (this.active.get(state.conversationId) !== root) return;
      this.emit({type: 'chat.helper', conversationId: state.conversationId, ...(root.messageId ? {messageId: root.messageId} : {}), helper});
    }});
    this.realtimeListeners = new Set();
    this.claudeFreshAt = 0; this.claudeAuthWait = null; this.retryCancelled = new Set();
    this.loginProcesses = new Map();
    this.rpc = null;
    this.rpcPromise = null;
    this.modelCache = new Map();
    this.modelRequests = new Map();
    this.metadataProcesses = new Set();
    this.closed = false;
    this.adapters = new Map([
      ['grok', new GrokProvider(this, { runtimePath: grokPath })],
      ['antigravity', new AntigravityProvider(this)],
      ['muse-code', new MuseProvider(this)],
    ]);
  }

  async prepare() {
    if (this.closed) throw new Error('Provider manager is closed.');
    await this.beforePrepare();
    if (this.closed) throw new Error('Provider manager is closed.');
    await Promise.all([this.dataDir, this.workspace, path.join(this.dataDir, 'codex-home'), path.join(this.dataDir, 'claude-home'), path.join(this.dataDir, 'runtime-tmp')].map(p => mkdir(p, { recursive: true })));
  }
  requireProvider(provider) {
    if ((!['codex', 'claude'].includes(provider) && !this.adapters.has(provider)) || !this.isProviderEnabled(provider)) {
      throw new Error('This provider is not available in this build.');
    }
  }
  async executable(provider) {
    if (provider === 'claude' && this.claudeRuntime === 'user' && !this.claudePath) return this.findUserClaude();
    return resolveExecutable(provider, provider === 'codex' ? this.codexPath : this.claudePath);
  }

  /** The user's own unmodified Claude Code; confirmed by its version banner, never by name alone. */
  async findUserClaude() {
    if (this.userClaude && await isFile(this.userClaude)) return this.userClaude;
    this.userClaude = null;
    for (const candidate of this.claudeCandidates()) {
      if (!path.isAbsolute(candidate) || !await isFile(candidate)) continue;
      const result = await new Promise(resolve => {
        let out = '';
        let child;
        try { child = this.spawnImpl(candidate, ['--version'], { cwd: path.dirname(candidate), env: process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch { resolve(''); return; }
        const timer = setTimeout(() => { stopProcess(child); resolve(''); }, 15000);
        child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { out = (out + chunk).slice(-400); });
        child.stderr?.resume();
        child.on('error', () => { clearTimeout(timer); resolve(''); });
        child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? out : ''); });
      });
      if (/\(Claude Code\)/.test(result)) return this.userClaude = candidate;
    }
    return null;
  }

  /** Runs Anthropic's official installer for the current user. Nothing is downloaded by Exomina itself. */
  async installClaude() {
    if (this.claudeRuntime !== 'user') throw new Error('This build already includes Claude Code.');
    if (await this.findUserClaude()) return this.userClaude;
    if (this.claudeInstall) return this.claudeInstall;
    this.claudeInstall = new Promise((resolve, reject) => {
      const { file, args } = claudeInstallerCommand();
      let output = '';
      const child = this.spawnImpl(file, args, { cwd: process.env.USERPROFILE || process.env.HOME || process.cwd(), env: process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      this.metadataProcesses.add(child);
      const timer = setTimeout(() => stopProcess(child), 10 * 60 * 1000);
      const read = chunk => { output = (output + chunk).slice(-8000); };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.on('error', error => { clearTimeout(timer); this.metadataProcesses.delete(child); reject(new Error(`Claude Code’s installer could not start. ${safeError(error)}`)); });
      child.on('close', async code => {
        clearTimeout(timer); this.metadataProcesses.delete(child);
        const found = await this.findUserClaude();
        if (found) resolve(found);
        else reject(new Error(`Anthropic’s Claude Code installer did not finish (${code}). ${safeError(output).slice(-600)} You can install it yourself from https://code.claude.com/docs/en/setup and press Refresh status.`));
      });
    }).finally(() => { this.claudeInstall = null; });
    return this.claudeInstall;
  }
  environment(provider) { return subscriptionEnvironment(provider, this.dataDir); }
  stopChild(child) { stopProcess(child); }
  spawn(executable, args, provider, cwd = this.workspace, env = this.environment(provider)) {
    // Separate console/process groups prevent a console close from signalling
    // the host. Keep referenced pipes and normal cancellation/shutdown ownership.
    return watchProviderOutputErrors(this.spawnImpl(executable, args, { cwd, env, detached: true, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }));
  }

  async getCodex() {
    await this.prepare();
    if (this.rpcPromise) return this.rpcPromise;
    if (this.rpc && !this.rpc.closed) return this.rpc;
    this.rpcPromise = (async () => {
      const executable = await this.executable('codex');
      if (!executable) throw new Error('Install the official Codex CLI to connect ChatGPT.');
      const args = ['app-server', '--listen', 'stdio://'];
      // New isolated Windows homes otherwise downgrade workspace-write to
      // read-only. The restricted-token sandbox requires no elevation/setup.
      if (process.platform === 'win32') args.push('-c', 'windows.sandbox="unelevated"');
      const child = this.spawn(executable, args, 'codex');
      const rpc = new JsonRpcProcess(child, {
        request: (method, params) => this.codexRequest(method, params),
        notification: (method, params) => this.codexNotification(method, params),
        exit: error => { this.codexChildren.clear(); for (const state of this.active.values()) if (state.provider === 'codex') state.reject(error); for(const listener of this.realtimeListeners)listener('runtime/closed',{message:error.message}); },
      });
      this.rpc = rpc;
      try {
        const initialized = await rpc.request('initialize', { clientInfo: { name: 'exomina', title: 'Exomina', version: APP_VERSION }, capabilities: { experimentalApi: true } });
        this.codexRuntimeVersion = typeof initialized.userAgent === 'string' ? initialized.userAgent.match(/^[^/\r\n]+\/([^\s]+)(?:\s|$)/)?.[1] : undefined;
        rpc.send({ method: 'initialized', params: {} });
        return rpc;
      } catch (error) { rpc.close(); throw error; }
    })();
    try { return await this.rpcPromise; } finally { this.rpcPromise = null; }
  }

  async capture(executable, args, provider, timeout = 20000) {
    await this.prepare();
    return new Promise((resolve, reject) => {
      const child = this.spawn(executable, args, provider);
      let stdout = '', stderr = '', settled = false;
      const finish = (error, code) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) stopProcess(child);
        if (error) reject(error); else resolve({ code, stdout, stderr });
      };
      const timer = setTimeout(() => { stopProcess(child); finish(new Error(`${provider} status check timed out.`)); }, timeout);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
      child.on('error', finish); child.on('close', code => finish(null, code));
      child.stdin.on('error', () => {}); child.stdin.end();
    });
  }

  /** Codex subscription limits; metadata only, no prompt. */
  async codexUsage({ publish = true, details = false } = {}) {
    const rpc = await this.getCodex();
    const result = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: !details }, 15000);
    if (result && publish) this.emit({ type: 'usage', provider: 'codex', info: result });
    return result;
  }

  /** Called only after the desktop's explicit manual confirmation. Never retried here. */
  async consumeCodexReset(idempotencyKey, creditId = null) {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(idempotencyKey)) throw new Error('Invalid reset attempt.');
    if (creditId != null && (typeof creditId !== 'string' || !creditId.trim())) throw new Error('Invalid usage reset selection.');
    const rpc = await this.getCodex();
    return rpc.request('account/rateLimitResetCredit/consume', { idempotencyKey, ...(creditId == null ? {} : { creditId }) }, 30000);
  }

  /** Official structured /usage: no model turn, transcript scan or credential extraction. */
  async claudeUsage({ publish = true } = {}) {
    await this.prepare();
    const executable = await this.executable('claude');
    if (!executable) throw new Error('The Claude Code runtime is unavailable.');
    const authTurn = await this.claudeAuthTurn();
    let child;
    try {
      if (this.closed) throw new Error('Provider manager is closed.');
      child = this.spawn(executable, CLAUDE_USAGE_ARGS, 'claude', path.join(this.dataDir, 'runtime-tmp'), claudeUsageEnvironment(this.environment('claude')));
      this.metadataProcesses.add(child);
      const result = await readClaudeUsage(child);
      authTurn(true);
      if (publish) this.emit({ type: 'usage', provider: 'claude', info: result });
      return result;
    } finally { authTurn(false); if (child) { this.metadataProcesses.delete(child); stopProcess(child); } }
  }

  async claudeStatus() {
    const executable = await this.executable('claude');
    const own = this.claudeRuntime === 'user';
    if (!executable) return { installed: false, connected: false, detail: own ? 'Claude Code isn’t installed yet. Press the button to install it from Anthropic and sign in.' : 'Install the official Claude Code runtime.' };
    const result = await this.capture(executable, ['auth', 'status'], 'claude');
    let auth;
    try { auth = JSON.parse(result.stdout); } catch { throw new Error(`Claude status could not be read. ${safeError(result.stderr)}`); }
    const signedIn = result.code === 0 && auth.loggedIn !== false && auth.authMethod && auth.authMethod !== 'none';
    // Anthropic's conditions for running Claude Code in another product forbid
    // restricting its built-in sign-in methods, so the user's own copy accepts
    // whichever one they chose on Anthropic's page.
    const connected = signedIn && (auth.authMethod === 'claude.ai' || own);
    return { installed: true, connected, detail: connected ? (auth.authMethod === 'claude.ai' ? 'Claude subscription connected.' : 'Claude Console account connected. Usage is billed by Anthropic as API usage.') : signedIn ? 'This app requires a Claude subscription login. API billing is not enabled.' : 'Sign in with your Claude subscription.' };
  }

  /** Provider metadata only: these requests never contain a prompt or start a turn. */
  async museUsage(options = {}) { this.requireProvider('muse-code'); return this.adapters.get('muse-code').usage(options); }

  async subscriptionModels({ refresh = false } = {}) {
    const ids = ['codex', 'claude', ...this.adapters.keys()].filter(id=>getProvider(id) && (!getProvider(id).optIn || this.isProviderEnabled(id)));
    const results = await Promise.allSettled(ids.map(id => this.modelsFor(id, refresh)));
    return Object.fromEntries(ids.map((id, index) => [id, results[index].status === 'fulfilled' ? results[index].value : []]));
  }

  async modelsFor(provider, refresh = false) {
    this.requireProvider(provider);
    const cached = this.modelCache.get(provider);
    if (!refresh && cached && Date.now() - cached.time < 60000) return structuredClone(cached.models);
    if (this.modelRequests.has(provider)) return structuredClone(await this.modelRequests.get(provider));
    const pending = (this.adapters.has(provider) ? this.adapters.get(provider).modelOptions() : provider === 'codex' ? this.codexModels() : this.claudeModels()).then(models => {
      this.modelCache.set(provider, { time: Date.now(), models }); return models;
    });
    this.modelRequests.set(provider, pending);
    try { return structuredClone(await pending); } finally { this.modelRequests.delete(provider); }
  }

  async codexModels() {
    const rpc = await this.getCodex();
    const models = new Map(), cursors = new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 15000);
      if (!Array.isArray(result?.data)) throw new Error('Codex model metadata could not be read.');
      for (const model of result.data) {
        const id = modelValue(model.model || model.id);
        if (!id || model.hidden) continue;
        const efforts = [...new Set((model.supportedReasoningEfforts || []).map(option => modelValue(option.reasoningEffort)).filter(Boolean))]
          .map(id => ({ id, label: effortLabel(id) }));
        models.set(id, { id, label: modelValue(model.displayName) || id, efforts, speeds: codexSpeeds(model),
          defaultEffort: efforts.some(option => option.id === model.defaultReasoningEffort) ? model.defaultReasoningEffort : '', isDefault: Boolean(model.isDefault), ...(Array.isArray(model.inputModalities)?{supportsImages:model.inputModalities.includes('image')}:{}) });
      }
      if (!result.nextCursor) return [...models.values()];
      cursor = modelValue(result.nextCursor);
      if (!cursor || cursors.has(cursor)) throw new Error('Codex returned invalid model pagination.');
      cursors.add(cursor);
    }
    throw new Error('Codex returned too many model pages.');
  }

  async claudeModels() {
    await this.prepare();
    const executable = await this.executable('claude');
    if (!executable) throw new Error('Install the official Claude Code runtime.');
    // Listing models may not reach the API, so it never counts as proof the sign-in works.
    const turn = await this.claudeAuthTurn();
    // The public Agent SDK gets model capabilities from this initialize control
    // response. No user message is sent; MCP is empty and no session is saved.
    const child = this.spawn(executable, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence'], 'claude');
    this.metadataProcesses.add(child);
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      let settled = false;
      const finish = (error, models) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.metadataProcesses.delete(child); stopProcess(child); turn(false);
        if (error) reject(error); else resolve(models);
      };
      const timer = setTimeout(() => finish(new Error('Claude model metadata timed out.')), 20000);
      child.stderr.resume();
      child.on('error', error => finish(new Error(safeError(error))));
      child.on('close', () => finish(new Error('Claude closed before returning model metadata.')));
      child.stdin.on('error', error => finish(new Error(safeError(error))));
      lines(child.stdout, line => {
        if (settled) return;
        let message;
        try { message = JSON.parse(line); } catch { finish(new Error('Claude returned invalid model metadata.')); return; }
        if (message.type === 'control_request') {
          child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'No actions are permitted during model discovery.' } }) + '\n');
          return;
        }
        if (message.type !== 'control_response' || message.response?.request_id !== requestId) return;
        const response = message.response;
        if (response.subtype === 'error' || !Array.isArray(response.response?.models)) { finish(new Error('Claude model metadata could not be read.')); return; }
        const models = [];
        for (const model of response.response.models) {
          const id = modelValue(model.value);
          // Fable and best can spend usage credits without headless consent.
          // Keep subscription choices to the ordinary model families.
          if (!['default', 'opus', 'sonnet', 'haiku'].includes(id)) continue;
          const efforts = model.supportsEffort ? [...new Set((model.supportedEffortLevels || []).filter(id => ['low', 'medium', 'high', 'xhigh', 'max'].includes(id)))].map(id => ({ id, label: effortLabel(id) })) : [];
          const speeds = model.supportsFastMode === true ? [{ id: 'fast', label: 'Fast', description: CLAUDE_FAST_NOTE, paid: true }] : [];
          // Descriptions read like 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok'; prices are dropped.
          const description = String(modelValue(model.description) || '').split(' · ').filter(part => !/\$|per Mtok/i.test(part)).slice(-1)[0] || '';
          models.push({ id, label: modelValue(model.displayName) || id, description, efforts, speeds, defaultEffort: '', isDefault: id === 'default' });
        }
        finish(null, models);
      }, error => finish(error));
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', hooks: null } }) + '\n');
    });
  }

  /** The selected model's metadata; an older cached list is used when it already confirms the choice. */
  async selectedModel(provider, model, accepts) {
    const pick = models => requestedModel(model) ? models.find(item => item.id === requestedModel(model)) : models.find(item => item.isDefault);
    const cached = this.modelCache.get(provider);
    if (cached && Date.now() - cached.time < MODEL_VALIDATION_MS) { const found = pick(cached.models); if (found && accepts(found)) return found; }
    const found = pick(await this.modelsFor(provider));
    return found && accepts(found) ? found : null;
  }

  async validateEffort(provider, model, value) {
    const effort = requestedEffort(value);
    if (!effort) return undefined;
    const selected = await this.selectedModel(provider, model, item => item.efforts.some(option => option.id === effort));
    if (!selected) throw new Error('This model does not support that reasoning setting. Refresh the model list and choose an available level.');
    return effort;
  }

  /** "standard" is explicit normal speed; other values must be advertised by the model. */
  async validateSpeed(provider, model, value) {
    if (value == null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 40) throw new Error('Choose a valid speed.');
    if (value === 'standard') return 'standard';
    const selected = await this.selectedModel(provider, model, item => (item.speeds || []).some(option => option.id === value));
    if (!selected) throw new Error('This model does not offer that speed. Refresh the model list and choose again.');
    return value;
  }

  async status({ onStatus } = {}) {
    await this.prepare();
    return Promise.all(['codex', 'claude', ...this.adapters.keys()].filter(id=>getProvider(id)).map(async id => {
      if (this.adapters.has(id)) return this.adapters.get(id).status();
      const name = id === 'codex' ? 'ChatGPT · Codex' : 'Claude · Claude Code';
      // An opt-in connection that is off starts nothing and inspects nothing.
      if (getProvider(id).optIn && !this.isProviderEnabled(id)) return { id, name, optIn: true, enabled: false, installed: false, connected: false, available: false, unavailableReason: 'Turn on Claude in Connections first.', detail: 'Off. Turn it on to use your Claude plan through your own copy of Claude Code.' };
      if (getProvider(id).optIn) {
        const base = { id, name, optIn: true, enabled: true, imageGeneration: { supported: false, enabled: false, available: false, detail: 'Claude needs an explicitly configured image-generation tool.' } };
        try { return { ...base, ...await this.claudeStatus() }; } catch (error) { return { ...base, installed: true, connected: false, detail: safeError(error) }; }
      }
      let installed = false;
      try {
        installed = Boolean(await this.executable(id));
        if (!installed) return { id, name, installed, connected: false, detail: `Install the official ${id === 'codex' ? 'Codex' : 'Claude Code'} runtime.` };
        if (id === 'claude') return { id, name, ...await this.claudeStatus(), imageGeneration: { supported: false, enabled: false, available: false, detail: 'Claude needs an explicitly configured image-generation tool.' } };
        const account = await (await this.getCodex()).request('account/read', { refreshToken: false });
        const connected = account.account?.type === 'chatgpt';
        if (connected) this.codexUsage().catch(() => {});
        const imageGeneration = await this.codexImageCapabilities(account.account).catch(() => ({ supported: false, enabled: false, available: false, detail: 'Native image-generation availability could not be verified.' }));
        return { id, name, installed, connected, imageGeneration, detail: connected ? `ChatGPT ${account.account.planType || 'subscription'} connected.` : 'Sign in with ChatGPT. API billing is not enabled.' };
      } catch (error) { return { id, name, installed, connected: false, detail: safeError(error) }; }
    }).map(pending => pending.then(row => { onStatus?.({ ...row, checking: false }); return row; })));
  }

  async codexImageCapabilities(account) {
    const rpc = await this.getCodex();
    const capabilities = await rpc.request('modelProvider/capabilities/read', {}, 15000);
    const supported = capabilities?.imageGeneration === true && capabilities?.namespaceTools === true;
    let enabled = false, cursor;
    for (let page = 0; page < 8; page++) {
      const result = await rpc.request('experimentalFeature/list', { limit: 200, ...(cursor ? { cursor } : {}) }, 15000);
      const feature = result?.data?.find(value => value.name === 'image_generation');
      if (feature) { enabled = feature.enabled === true; break; }
      if (!result?.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    const connected = account?.type === 'chatgpt';
    const available = supported && enabled && connected && account.planType !== 'free';
    return { supported, enabled, available, requiresImageModel: true, detail: available ? 'Native Codex image generation is available with an image-capable model, subject to account limits. No API key is used.' : !connected ? 'Connect ChatGPT to use native Codex image generation.' : account.planType === 'free' ? 'This Codex runtime does not enable image generation for the Free plan.' : 'Native image generation is disabled or unsupported by this runtime.' };
  }

  async connect(provider) {
    this.requireProvider(provider);
    this.modelCache.delete(provider);
    if (provider === 'claude') this.claudeFreshAt = 0;
    await this.prepare();
    if (this.adapters.has(provider)) return this.adapters.get(provider).connect();
    if (provider === 'codex') {
      const result = await (await this.getCodex()).request('account/login/start', { type: 'chatgpt' });
      if (!result.authUrl) throw new Error('Codex did not return its official sign-in URL.');
      this.emit({ type: 'auth.url', provider, url: result.authUrl });
      return { message: 'Complete the official ChatGPT sign-in in your browser, then refresh connections.', url: result.authUrl };
    }
    if (provider !== 'claude') throw new Error('Unknown provider.');
    if (this.loginProcesses.has(provider)) return { message: 'Claude sign-in is already open. Complete it in your browser, then refresh connections.' };
    const executable = await this.executable(provider) || (this.claudeRuntime === 'user' ? await this.installClaude() : null);
    if (!executable) throw new Error('Install the official Claude Code runtime first.');
    if (this.loginProcesses.has(provider)) return { message: 'Claude sign-in is already open. Complete it in your browser, then refresh connections.' };
    const child = this.spawn(executable, ['auth', 'login'], provider);
    this.loginProcesses.set(provider, child);
    return new Promise((resolve, reject) => {
      let settled = false, urlEmitted = false, output = '';
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(ready); if (error) reject(error); else resolve(value); };
      const ready = setTimeout(() => finish(null, { message: 'Complete Claude Code’s official sign-in in your browser, then refresh connections.' }), 1500);
      const timeout = setTimeout(() => stopProcess(child), 10 * 60 * 1000);
      const read = chunk => {
        output = (output + chunk).slice(-16000);
        const match = output.match(/https:\/\/(?:claude\.ai|console\.anthropic\.com|platform\.claude\.com)\/[^\s\x1b]+/);
        if (match && !urlEmitted) {
          // Native startup can outlast the initial UI response. Keep forwarding
          // the browser fallback while the official login process is running.
          urlEmitted = true;
          this.emit({ type: 'auth.url', provider, url: match[0] });
          finish(null, { message: 'Complete the official Claude sign-in, then refresh connections.', url: match[0] });
        }
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.stdin.on('error', () => {});
      child.on('error', error => { finish(error); clearTimeout(timeout); this.loginProcesses.delete(provider); });
      child.on('close', code => {
        clearTimeout(timeout); this.loginProcesses.delete(provider);
        if (code === 0) finish(null, { message: 'Claude sign-in completed. Refresh connections to confirm.' });
        else {
          const error = new Error(`Claude sign-in exited (${code}). ${safeError(output)}`);
          finish(error); this.emit({ type: 'auth.error', provider, message: safeError(error) });
        }
      });
    });
  }

  /** Signs out through the provider's own official client, then forgets what Exomina cached about the account. */
  async logout(provider) {
    this.requireProvider(provider);
    await this.prepare();
    const adapter = this.adapters.get(provider);
    if (adapter) {
      if (typeof adapter.disconnect !== 'function') throw new Error('Signing out is not available for this connection.');
      await adapter.disconnect();
    } else if (provider === 'codex') {
      this.loginProcesses.get(provider) && this.stopChild(this.loginProcesses.get(provider));
      await (await this.getCodex()).request('account/logout', {}, 30000);
    } else if (provider === 'claude') {
      const login = this.loginProcesses.get(provider); if (login) this.stopChild(login);
      const executable = await this.executable(provider);
      if (!executable) throw new Error('The Claude Code runtime is missing. Reinstall Exomina.');
      await new Promise((resolve, reject) => {
        const child = this.spawn(executable, ['auth', 'logout'], provider);
        const timer = setTimeout(() => { stopProcess(child); reject(new Error('Claude did not finish signing out in time.')); }, 30000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Claude could not sign out (${code}).`)); });
        child.stdout?.resume?.(); child.stderr?.resume?.();
      });
      this.claudeFreshAt = 0;
    } else throw new Error('Unknown provider.');
    this.modelCache.delete(provider);
    this.emit({ type: 'auth.signedOut', provider });
    return { message: 'Signed out.' };
  }

  async run(options) {
    this.requireProvider(options.provider);
    // Counted once per request; the sign-in renewal below is the same request.
    await this.beforeRequest({ provider: options.provider, kind: options.memoryCatchUp === true ? 'catchup' : options.ephemeral ? 'background' : 'reply', conversationId: options.conversationId });
    try { return await this.runOnce(options); }
    catch (error) {
      // Another Claude process may have renewed the shared sign-in a moment ago; a fresh start reads it.
      if (options.provider !== 'claude' || options.noAuthRetry || options.authRetried || !error.noOutput || !CLAUDE_AUTH_EXPIRED.test(error.message) || this.closed) throw error;
      this.retryCancelled.delete(options.conversationId);
      this.emit({ type: 'chat.retry', conversationId: options.conversationId, reason: 'The Claude sign-in had expired. Exomina is renewing it and trying again.' });
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (this.retryCancelled.delete(options.conversationId) || this.closed) throw new Error('Stopped.');
      return this.runOnce({ ...options, authRetried: true });
    }
  }

  /** Claude Code renews its sign-in on first use after the access token expired,
   * and each refresh token works once: two processes renewing together leave one
   * holding a spent token ("OAuth session expired and could not be refreshed").
   * While the sign-in may be stale, Claude processes start one at a time until
   * one has reached Claude; then they run in parallel again. */
  async claudeAuthTurn() {
    for (;;) {
      if (Date.now() - this.claudeFreshAt < CLAUDE_FRESH_MS) return () => {};
      if (!this.claudeAuthWait) break;
      await this.claudeAuthWait;
    }
    let release;
    this.claudeAuthWait = new Promise(resolve => { release = resolve; });
    const done = ok => { if (!release) return; if (ok) this.claudeFreshAt = Date.now(); clearTimeout(timer); const finish = release; release = null; this.claudeAuthWait = null; finish(); };
    const timer = setTimeout(() => done(false), 120000);
    return done;
  }

  async runOnce(options) {
    const { provider, conversationId, prompt } = options;
    this.requireProvider(provider);
    if (typeof conversationId !== 'string' || !conversationId) throw new Error('A conversation ID is required.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Write a message first.');
    if (this.active.has(conversationId)) throw new Error('This conversation already has a running request.');
    await this.prepare();
    if (this.active.has(conversationId)) throw new Error('This conversation already has a running request.');
    let resolve, reject;
    const result = new Promise((res, rej) => { resolve = res; reject = rej; });
    // Avoid unhandled rejection if cancellation arrives while authentication is being checked.
    result.catch(() => {});
    if (options.toolDefinitions !== undefined && !Array.isArray(options.toolDefinitions)) throw new Error('Invalid per-run tool definitions.');
    if (options.sessionId && options.toolDefinitions !== undefined) throw new Error('Per-run tool definitions require a new native conversation.');
    const state = { provider, conversationId, workspace: options.workspace || this.workspace, ...(typeof options.messageId === 'string' && options.messageId.length <= 200 ? {messageId: options.messageId} : {}), text: '', messages: new Map(), items: new Map(), imageItems: new Set(), toolDefinitions: options.lean ? leanTools(options.toolDefinitions ?? this.toolDefinitions, options.allowEscalation) : [...(options.toolDefinitions ?? this.toolDefinitions)], noTools:!!options.noTools,resolve, reject, cancelled: false, sessionId: options.sessionId };
    if (provider === 'codex') state.terminal = new Promise(resolve => { state.endWait = resolve; });
    this.active.set(conversationId, state);
    try {
      if (this.adapters.has(provider)) state.resolve(await this.adapters.get(provider).run(options, state));
      else if (provider === 'codex') await this.startCodex(options, state);
      else await this.startClaude(options, state);
      return await result;
    } catch (error) {
      // A terminal error notification can precede turn/completed. Native shell
      // tools must finish stopping before another runtime starts the same task.
      if (provider === 'codex' && usageExhausted(error) && state.sessionId && state.turnId && !state.turnEnded && !state.cancelled) {
        let timer;
        const ended = Promise.race([state.terminal, new Promise((_, fail) => { timer = setTimeout(() => fail(Object.assign(new Error('The failed provider could not confirm that its running tools have stopped. Check their state before resuming this task.'), { handoffUnsafe: true })), 15000); })]);
        ended.catch(() => {});
        try {
          await this.rpc.request('turn/interrupt', { threadId: state.sessionId, turnId: state.turnId }, 5000).catch(() => {});
          await ended;
        } finally { clearTimeout(timer); }
        if (state.cancelled) throw new Error('Stopped.');
      }
      reject(error); throw error;
    }
    finally { this.retireCodexChildren(state); state.claudeInput?.close(); state.claudeHelpers?.close(); if(options.noPersistence&&provider==='codex'&&state.sessionId)await this.rpc?.request('thread/unsubscribe',{threadId:state.sessionId},5000).catch(()=>{}); this.active.delete(conversationId); if (state.configPath) await unlink(state.configPath).catch(() => {}); }
  }

  async startCodex(options, state) {
    const rpc = await this.getCodex();
    const auth = await rpc.request('account/read', { refreshToken: false });
    if (auth.account?.type !== 'chatgpt') throw new Error('Connect your ChatGPT subscription before starting. This app does not use API billing.');
    const [effort, speed] = await Promise.all([this.validateEffort('codex', options.model, options.effort), this.validateSpeed('codex', options.model, options.speed)]);
    if (state.cancelled) throw new Error('Stopped.');
    const cwd = path.resolve(options.workspace || this.workspace);
    // The host only supplies its app-owned workspace or a folder explicitly
    // accepted in its Trust workspace dialog. This is a per-thread override.
    // The chat's permission level (its own, or the global default) selects the native sandbox and approval policy.
    const policy = structuredClone(options.policy || codexPolicy(this.getPermissionMode(state.conversationId)));
    const requested = codexPermissions(cwd, policy);
    const params = { cwd, approvalPolicy: policy.approvalPolicy, approvalsReviewer: 'user', sandbox: policy.sandbox, modelProvider: 'openai', developerInstructions: (options.developerInstructions ?? IMAGE_INSTRUCTIONS) + (options.noTools || options.lean || options.hostToolsOnly ? '' : '\n' + NATIVE_HELPER_TOOL_INSTRUCTIONS), config: { projects: { [cwd]: { trust_level: 'trusted' } }, sandbox_workspace_write: { network_access: requested.sandbox.networkAccess ?? false, writable_roots: policy.sandboxPolicy.writableRoots ?? [], exclude_tmpdir_env_var: requested.sandbox.excludeTmpdirEnvVar ?? false, exclude_slash_tmp: requested.sandbox.excludeSlashTmp ?? false }, ...(options.noTools||options.lean||options.hostToolsOnly?{features:{shell_tool:false,unified_exec:false,apply_patch_freeform:false,image_generation:false,multi_agent:false,apps:false,plugins:false,remote_plugin:false,computer_use:false,browser_use:false,code_mode_host:false,skill_search:false,view_image:false},web_search:'disabled'}:{}) }, ...(options.ephemeral ? { ephemeral: true } : {}) };
    if (requestedModel(options.model)) params.model = requestedModel(options.model);
    // Private chats: Codex keeps the thread in memory and writes no rollout file.
    if (options.noPersistence) { params.ephemeral = true; params.config.project_doc_max_bytes = 0; (params.config.features??={}).memories = false; }
    let session, prompt = options.prompt;
    const start = () => rpc.request('thread/start', { ...params, dynamicTools: state.toolDefinitions.map(tool => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
    if (options.sessionId) session = await rpc.request('thread/resume', { ...params, threadId: options.sessionId, excludeTurns: true });
    else session = await start();
    if (permissionDifferences(session, requested).length) {
      if (!options.sessionId || state.turnId || session.thread?.status?.type === 'active') {
        throw permissionMismatch(requested, session, { reason: options.sessionId ? 'The previous native turn may still be running; it was not retried.' : undefined });
      }
      const resumed = session;
      try {
        // Build the replacement input before retiring the old session. The host
        // supplies its fresh conversation view and completed-work checkpoint.
        prompt = options.recoveryPrompt || (nativeRecoveryContext((await rpc.request('thread/read', { threadId: options.sessionId, includeTurns: true })).thread) + options.prompt);
        if (state.cancelled) throw Error('Stopped.');
        if (state.turnId) throw Error('The previous native turn started during permission recovery; it was not retried.');
        // There is exactly one fresh attempt, only before any turn has started.
        state.sessionId = undefined;
        session = await start();
      } catch (error) {
        if (state.cancelled) throw Error('Stopped.');
        throw permissionMismatch(requested, resumed, { cause: safeError(error) });
      }
      if (session.thread?.id === options.sessionId || permissionDifferences(session, requested).length) throw permissionMismatch(requested, resumed, { fresh: session });
      this.toolStep(state, {name: 'Codex permission recovery', status: 'done', observational: true, detail: 'Started one fresh native thread with the selected permissions, conversation and completed-work checkpoint.'});
    }
    state.sessionId = session.thread?.id;
    this.reportedSelection(state, {model: session.model, effort: session.reasoningEffort, modelSource: 'runtimeConfig'});
    if(options.reportSelection)state.selection={...(session.model?{model:session.model}:{}),...(!effort&&session.reasoningEffort?{effort:session.reasoningEffort}:{})};
    if (!state.sessionId) throw new Error('Codex did not return a conversation ID.');
    state.codexPermissionsVerified = true;
    state.requestedPermissions = requested;
    // Child policy inheritance has been audited against this exact bundled
    // runtime. An opt-in replacement version must be checked before receiving
    // host authority merely from ancestry.
    state.nativeChildInheritanceVerified = this.codexRuntimeVersion === '0.160.1';
    if (state.cancelled) throw new Error('Stopped.');
    const input = [{ type: 'text', text: prompt }, ...(options.images || []).map(image => ({ type: 'image', url: `data:${image.mimeType};base64,${image.dataBase64}` }))];
    const turn = await rpc.request('turn/start', { threadId: state.sessionId, cwd, input, approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy, approvalsReviewer: 'user', ...(effort ? { effort } : {}), ...(speed ? { serviceTierForTurn: speed === 'standard' ? 'default' : speed } : {}) });
    state.turnId = turn.turn?.id;
    this.emit({ type: 'chat.timing', conversationId: state.conversationId, phase: 'runtime' });
    if (state.cancelled && state.turnId) rpc.request('turn/interrupt', { threadId: state.sessionId, turnId: state.turnId }).catch(() => {});
  }

  async steer(conversationId, { prompt, images = [], attachments = [], messageId }) {
    const state = this.active.get(conversationId);
    if (!state || state.cancelled || state.turnEnded) return false;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000) throw Error('Provide a valid follow-up.');
    if (state.provider === 'codex' && state.sessionId && state.turnId && this.rpc && !this.rpc.closed) {
      const expectedTurnId = state.turnId;
      const result = await this.rpc.request('turn/steer', { threadId: state.sessionId, expectedTurnId,
        ...(messageId ? { clientUserMessageId: messageId } : {}), input: [{ type: 'text', text: prompt }, ...images.map(image => ({ type: 'image', url: `data:${image.mimeType};base64,${image.dataBase64}` }))] }, 10000);
      if (result.turnId !== expectedTurnId) throw Error('The runtime did not confirm delivery to the active task.');
      return true;
    }
    if (state.provider === 'claude' && state.claudeInput) return state.claudeInput.send({ prompt, images, messageId });
    if (state.adapterSteer) { await state.adapterSteer({ prompt, attachments }); return true; }
    return false;
  }

  stateFor(params) { return this.codexChildren.resolve(params?.threadId); }
  reportedSelection(state, selection) {
    if (this.active.get(state.conversationId) !== state || state.cancelled) return;
    const fields = nativeHelperFields({effectiveModel: selection?.model, effectiveEffort: selection?.effort});
    const actual = {provider: state.provider, ...(fields.effectiveModel ? {model: fields.effectiveModel, ...(['runtimeConfig', 'execution'].includes(selection.modelSource) ? {modelSource: selection.modelSource} : {})} : {}), ...(fields.effectiveEffort ? {effort: fields.effectiveEffort} : {})};
    if (!actual.model && !actual.effort) return;
    const merged = {...state.runtimeSelection, ...actual};
    if (JSON.stringify(merged) === JSON.stringify(state.runtimeSelection)) return;
    state.runtimeSelection = merged;
    this.emit({type: 'chat.selection', conversationId: state.conversationId, ...(state.messageId ? {messageId: state.messageId} : {}), provider: state.provider, selection: {...state.runtimeSelection}});
  }
  nativeStateActive(state, turnId = state?.turnId) {
    return this.codexChildren.owns(state) && !state.cancelled && !state.turnEnded && (!turnId || state.turnId === turnId);
  }
  retireCodexChildren(state) {
    if (state?.provider !== 'codex') return;
    if (state.rootState) this.codexChildren.retireDescendants(state); else this.codexChildren.retireRoot(state);
  }
  nativeChildRetired(state) {
    this.cancelElicitation?.({threadId: state.sessionId});
    if (state.turnId && !state.turnEnded && this.rpc && !this.rpc.closed) this.rpc.request('turn/interrupt', {threadId: state.sessionId, turnId: state.turnId}, 5000).catch(() => {});
  }
  /** `block` names the text block (message or item ID) so separate blocks get a paragraph break. */
  delta(state, text, block) {
    if (!text || state.cancelled) return;
    if (state.text.length + text.length > MAX_TEXT) { this.cancel(state.conversationId); throw new Error('Provider response exceeded the display limit.'); }
    state.text += text;
    if (state.rootState) {
      this.toolStep(state, {id: `message:${block || state.turnId}`, name: 'reply', status: 'running', output: diagnosticText(state.messages.get(block) || state.text)});
      return;
    }
    this.emit({ type: 'chat.delta', conversationId: state.conversationId, text, ...(block ? { block: String(block) } : {}) });
  }
  /** Reasoning shown in the timeline. `start` opens a block before any text arrives, so its duration counts. */
  thinking(state, id, text, done = false, start = false) {
    if (state.cancelled || (!text && !done && !start)) return;
    this.emit({ type: 'chat.thinking', conversationId: state.conversationId, id: state.rootState ? `helper:${state.sessionId}:${id || 'thinking'}` : String(id || 'thinking'), text: text || '', done, ...(start ? { start: true } : {}) });
  }
  toolStep(state, step) { if (!state.cancelled) this.emit({ type: 'chat.tool', conversationId: state.conversationId, executionContext: {provider: state.provider, threadId: state.sessionId || '', workspace: state.workspace || this.workspace}, ...step,
    ...(state.rootState ? {id: `helper:${state.sessionId}:${step.id || step.name}`, name: `${state.nativeLabel}: ${step.name}`, nativeThreadId: state.sessionId} : {}) }); }

  codexWarning(method, params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return;
    const summary = method === 'warning' ? params.message : params.summary;
    if (typeof summary !== 'string' || !summary.trim()) return;
    if (params.threadId != null && (typeof params.threadId !== 'string' || !params.threadId)) return;
    const targeted = typeof params.threadId === 'string';
    const targets = targeted ? [this.stateFor(params)].filter(Boolean) : [...this.active.values()].filter(state => state.provider === 'codex');
    const label = { warning: 'Provider warning', configWarning: 'Provider configuration warning', deprecationNotice: 'Provider deprecation notice' }[method];
    const output = diagnosticText(`${targeted ? '' : 'Global '}${label}: ${summary}${typeof params.details === 'string' && params.details.trim() ? '\n' + params.details : ''}`);
    const id = `codex-notice:${fingerprint(method + '\0' + output).slice(0, 24)}`;
    for (const state of targets) {
      if (state.cancelled || state.turnEnded) continue;
      const seen = state.codexNotices ||= new Set();
      if (seen.has(id) || seen.size >= 100) continue;
      seen.add(id);
      this.toolStep(state, { id, name: method === 'deprecationNotice' ? 'codexDeprecationNotice' : 'codexProviderWarning', status: 'done', observational: true, output, historyOutput: output });
    }
  }

  codexProgress(state, method, params) {
    if (state.turnEnded || typeof params.turnId !== 'string' || params.turnId !== state.turnId || typeof params.itemId !== 'string' || !params.itemId || params.itemId.length > 300) return;
    const item = state.items.get(params.itemId), command = method === 'item/commandExecution/outputDelta';
    if (!item || item.type !== (command ? 'commandExecution' : 'mcpToolCall') || ['completed', 'failed', 'declined'].includes(item.status)) return;
    const value = command ? params.delta : params.message;
    if (typeof value !== 'string' || !value) return;
    const progress = state.codexProgress ||= new Map();
    if (!progress.has(params.itemId) && progress.size >= 100) return;
    const entry = progress.get(params.itemId) || { output: '', pending: '', dropping: false };
    progress.set(params.itemId, entry);
    let observed = '';
    if (!command) observed = diagnosticText(value) + '\n';
    else if (value.length > 64000) {
      entry.pending = ''; entry.dropping = true;
      observed = '[Large command-output chunk omitted while streaming; complete tool output follows at completion.]\n';
    } else {
      let chunk = value;
      // A credential can be split across deltas. Publish complete lines only;
      // discard an overlong unfinished line instead of exposing its fragments.
      if (entry.dropping) {
        const end = chunk.search(/[\r\n]/);
        if (end < 0) return;
        chunk = chunk.slice(end + 1); entry.dropping = false;
      }
      const lines = (entry.pending + chunk).split(/\r\n|\r|\n/);
      entry.pending = lines.pop();
      observed = lines.map(line => line.length > 4000 ? '[Long command-output line omitted while streaming.]' : diagnosticText(line)).join('\n');
      if (lines.length) observed += '\n';
      if (entry.pending.length > 4000) {
        entry.pending = ''; entry.dropping = true;
        observed += '[Long command-output line omitted while streaming; complete tool output follows at completion.]\n';
      }
    }
    if (!observed) return;
    const output = diagnosticText(entry.output + observed);
    if (output === entry.output) return;
    entry.output = output;
    this.toolStep(state, { id: params.itemId, name: command ? 'commandExecution' : item.tool || 'mcpToolCall', status: 'running', output, historyOutput: output });
  }

  codexImage(state, item) {
    if (state.cancelled || item?.type !== 'imageGeneration' || typeof item.id !== 'string' || !item.id || state.imageItems.has(item.id)) return;
    // A started/partial result must not become a permanent asset or suppress the
    // later final image. The final turn can repeat already delivered items.
    if (!['completed', 'failed'].includes(item.status)) return;
    state.imageItems.add(item.id);
    const image = item.status === 'completed' && !item.failure ? nativeImage(item.result) : null;
    if (image) {
      this.emit({ type: 'chat.image.generated', provider: 'codex', conversationId: state.conversationId, itemId: item.id, ...image });
      this.toolStep(state, {id: item.id, name: 'imageGeneration', status: 'done', outcomeConfirmed: true, detail: 'Image generated'});
    } else {
      const detail = item.failure?.type === 'usageLimitExceeded' ? 'The ChatGPT image-generation limit was reached.' : item.status === 'failed' ? 'Native image generation failed.' : 'The runtime returned an unsupported, invalid or oversized image. It was not saved.';
      this.toolStep(state, {id: item.id, name: 'imageGeneration', status: 'error', detail});
    }
  }

  codexNotification(method, params) {
    if(method.startsWith('thread/realtime/')) {for(const listener of this.realtimeListeners)listener(method,params);return;}
    // Voice previews trace their own handoff turn; chat state lookup below ignores that thread.
    if(method==='turn/started'||method==='turn/completed')for(const listener of this.realtimeListeners)listener(method,params);
    if (method === 'account/login/completed') { this.modelCache.delete('codex'); this.emit({ type: 'auth.completed', provider: 'codex', success: params.success }); return; }
    if (method === 'account/rateLimits/updated') { this.emit({ type: 'usage', provider: 'codex', info: params }); return; }
    if (['warning', 'configWarning', 'deprecationNotice'].includes(method)) { this.codexWarning(method, params); return; }
    if (method === 'thread/started') { this.codexChildren.observeThread(params.thread); return; }
    const state = this.stateFor(params);
    if (!state || state.cancelled) return;
    if (state.rootState && ['thread/closed', 'thread/archived', 'thread/cleared'].includes(method)) { this.codexChildren.retire(state); return; }
    if (method === 'thread/settings/updated' && state.rootState) { this.codexChildren.observeSettings(state, params.threadSettings); return; }
    if (state.rootState && method === 'turn/started') {
      if (this.codexChildren.startTurn(state, params.turn?.id)) this.toolStep(state, {id: `turn:${state.turnId}`, name: 'task', status: 'running'});
      return;
    }
    const notificationTurn = params.turnId || ((method === 'turn/completed' || method === 'turn/started') ? params.turn?.id : undefined);
    if (state.turnId && notificationTurn && notificationTurn !== state.turnId) return;
    if (state.rootState && !state.turnId) return;
    if (state.turnEnded && method !== 'turn/started') return;
    if (state.rootState && method === 'turn/completed') {
      if (this.codexChildren.endTurn(state, params.turn?.id)) {
        this.codexChildren.helperStatus(state, params.turn?.status === 'completed' ? 'complete' : params.turn?.status === 'interrupted' ? 'cancelled' : 'failed', params.turn?.error?.message);
        this.cancelElicitation?.({threadId: state.sessionId});
        this.retireCodexChildren(state);
        this.toolStep(state, {id: `turn:${state.turnId}`, name: 'task', observational: true,
          status: params.turn?.status === 'completed' ? 'done' : 'error', output: params.turn?.error ? safeError(params.turn.error.message) : diagnosticText(state.text), historyOutput: diagnosticText(state.text, 30000)});
      }
      return;
    }
    if (state.rootState && method === 'error' && !params.willRetry) {
      this.codexChildren.endTurn(state, state.turnId);
      this.codexChildren.helperStatus(state, 'failed', params.error?.message);
      this.cancelElicitation?.({threadId: state.sessionId});
      this.retireCodexChildren(state);
      this.toolStep(state, {id: `turn:${state.turnId}`, name: 'task', status: 'error', output: safeError(params.error?.message || 'Native helper failed.')});
      return;
    }
    if (method === 'item/started' || method === 'item/completed') this.codexChildren.observeCollaboration(state, params.item);
    const nativeActivity = normalizeCodexActivity(method, params);
    if (nativeActivity) {
      if (nativeActivity.kind === 'reroute') {
        if (state.rootState) { Object.assign(state.nativeHelper, nativeHelperFields({effectiveModel: nativeActivity.toModel}), {modelSource: 'execution'}); this.codexChildren.publish(state); }
        else this.reportedSelection(state, {model: nativeActivity.toModel, modelSource: 'execution'});
      }
      if (!state.rootState) this.emit({type: 'chat.nativeActivity', conversationId: state.conversationId, activity: nativeActivity});
      return;
    }
    if (method === 'item/commandExecution/outputDelta' || method === 'item/mcpToolCall/progress') { this.codexProgress(state, method, params); return; }
    if (method === 'item/autoApprovalReview/started' || method === 'item/autoApprovalReview/completed') {
      if (state.turnId && params.turnId !== state.turnId) return;
      const step = codexApprovalReviewStep(method, params);
      if (!step) return;
      const reviews = state.codexReviews ||= new Map(), previous = reviews.get(params.reviewId);
      // Repeated delivery is harmless, and a late start cannot reopen a finished review.
      const terminal = method.endsWith('/completed'), signature = fingerprint(JSON.stringify(step));
      const hasRationale = Boolean(step.input.review.rationale);
      if ((previous?.terminal && (!terminal || previous.status !== params.review.status || (previous.hasRationale && !hasRationale))) || previous?.signature === signature) return;
      reviews.set(params.reviewId, { signature, terminal, status: params.review.status, hasRationale });
      if (reviews.size > 400) reviews.delete(reviews.keys().next().value);
      this.toolStep(state, step);
      return;
    }
    if (method === 'guardianWarning') {
      if (typeof params.threadId !== 'string' || !params.threadId || typeof params.message !== 'string' || !params.message.trim()) return;
      const output = clipToolHistory(`Provider warning: ${safeError(params.message)}`), warnings = state.codexWarnings ||= new Set();
      if (warnings.has(output)) return;
      warnings.add(output);
      if (warnings.size > 400) warnings.delete(warnings.values().next().value);
      state.codexWarningCount = (state.codexWarningCount || 0) + 1;
      this.toolStep(state, { id: `codex-warning:${state.codexWarningCount}`, name: 'codexGuardianWarning', status: 'done', observational: true, output, historyOutput: output });
      return;
    }
    if (!state.rootState && (method === 'thread/compacted' || (method === 'item/completed' && params.item?.type === 'contextCompaction'))) this.emit({ type: 'chat.compacted', conversationId: state.conversationId });
    if (params.item?.id) state.items.set(params.item.id, params.item.type === 'imageGeneration' ? { id: params.item.id, type: params.item.type, status: params.item.status } : params.item);
    if (method === 'item/agentMessage/delta') {
      state.messages.set(params.itemId, (state.messages.get(params.itemId) || '') + params.delta);
      this.delta(state, params.delta, params.itemId);
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      const old = state.messages.get(params.item.id) || '';
      const text = params.item.text || '';
      if (!old && text) this.delta(state, text, params.item.id);
      state.messages.set(params.item.id, text);
    } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      // Summaries are the readable form; raw reasoning text is used only when no summary arrives.
      if (method === 'item/reasoning/summaryTextDelta') state.reasoningSummary = true;
      if (method === 'item/reasoning/summaryTextDelta' || !state.reasoningSummary) this.thinking(state, params.itemId, params.delta);
    } else if (method === 'item/reasoning/summaryPartAdded') {
      this.thinking(state, params.itemId, '\n\n');
    } else if (params.item?.type === 'reasoning' && (method === 'item/started' || method === 'item/completed')) {
      this.thinking(state, params.item.id, '', method === 'item/completed', method === 'item/started');
    } else if (method === 'item/completed' && params.item?.type === 'imageGeneration') {
      this.codexImage(state, params.item);
    } else if ((method === 'item/started' || method === 'item/completed') && params.item && !['agentMessage', 'userMessage', 'reasoning'].includes(params.item.type)) {
      const item = params.item;
      const helper = nativeHelperStep(item);
      if (item.type === 'dynamicToolCall') state.dynamicItems = true;
      const name = item.type === 'dynamicToolCall' || item.type === 'mcpToolCall' ? item.tool || item.type : item.type === 'functionCallOutput' ? item.name || item.type : item.type;
      const input = item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd } : item.type === 'fileChange' ? { changes: (item.changes || []).map(change => ({ path: change.path, kind: change.kind?.type || change.kind })) }
        : item.type === 'webSearch' ? { query: item.query } : item.type === 'mcpToolCall' ? { server: item.server, tool: item.tool, ...(item.arguments && typeof item.arguments === 'object' ? item.arguments : {}) }
        : item.type === 'dynamicToolCall' && item.arguments && typeof item.arguments === 'object' ? item.arguments : undefined;
      const failed = item.status === 'failed' || item.status === 'declined' || item.success === false || Boolean(item.error) || item.result?.isError === true || (Number.isInteger(item.exitCode) && item.exitCode !== 0);
      const progress = method === 'item/completed' ? state.codexProgress?.get(item.id) : undefined;
      const commandOutput = item.aggregatedOutput || (progress ? progress.output + (progress.dropping ? '' : progress.pending) : '');
      const output = item.type === 'commandExecution' ? [commandOutput, Number.isInteger(item.exitCode) && item.exitCode !== 0 ? `Exit code ${item.exitCode}` : ''].filter(Boolean).join('\n') : item.type === 'functionCallOutput' ? codexFunctionOutputText(item.output)
        : [typeof item.error?.message === 'string' ? item.error.message : '', ...(Array.isArray(item.result?.content) ? item.result.content : Array.isArray(item.contentItems) ? item.contentItems : []).filter(block => ['text', 'inputText', 'input_text'].includes(block?.type) && typeof block.text === 'string').map(block => block.text)].filter(Boolean).join('\n') || undefined;
      if (method === 'item/completed') state.codexProgress?.delete(item.id);
      // A function-output receipt or an incomplete command report is not proof
      // that the underlying action succeeded. Keep that distinction for the UI.
      const outcomeConfirmed = method === 'item/completed' && !failed && (item.type === 'commandExecution' && item.exitCode === 0 || item.type === 'dynamicToolCall' && item.success === true || item.type === 'mcpToolCall' && Boolean(item.result) || ['fileChange', 'webSearch', 'imageView'].includes(item.type) && item.status === 'completed');
      const observational = Boolean(helper) || ['functionCallOutput', 'contextCompaction', 'todoList', 'plan'].includes(item.type);
      this.toolStep(state, { id: item.id, name, input, ...(helper?{helper}:{}), outcomeConfirmed, ...(observational ? {observational: true} : {}), status: method === 'item/started' ? 'running' : item.status === 'declined' ? 'denied' : failed ? 'error' : 'done', ...(output ? { output: diagnosticText(output),historyOutput:diagnosticText(output, 30000) } : {}) });
    } else if (method === 'turn/started') state.turnId = params.turn?.id;
    else if (method === 'turn/completed') {
      state.turnEnded = true; state.endWait?.();
      this.retireCodexChildren(state);
      const turn = params.turn || {};
      for (const item of turn.items || []) if (item.type === 'imageGeneration') this.codexImage(state, item);
      if (turn.status === 'failed') { const error = new Error(safeError(turn.error?.message || 'Codex could not complete this turn.')); error.code = turn.error?.codexErrorInfo; state.reject(error); }
      else if (turn.status === 'interrupted') state.reject(new Error('Stopped.'));
      else if (turn.status === 'completed') {
        this.codexUsage().catch(() => {});
        const finalText = (turn.items || []).filter(item => item.type === 'agentMessage' && item.phase === 'final_answer').map(item => item.text).join('\n\n');
        state.resolve({ sessionId: state.sessionId, text: finalText || state.text, ...(state.selection?{selection:state.selection}:{}) });
      } else state.reject(new Error('Codex returned an unexpected completion status: ' + String(turn.status)));
    } else if (method === 'error' && !params.willRetry) { const error = new Error(safeError(params.error?.message || 'Codex failed.')); error.code = params.error?.codexErrorInfo; state.reject(error); }
  }

  async codexRequest(method, params) {
    const state = this.stateFor(params);
    if (!state || state.cancelled) throw new Error('No active conversation; request denied.');
    if (!state.codexPermissionsVerified) throw new Error('Native permissions have not been verified; request denied.');
    const conversationId = state.conversationId;
    if (state.rootState && (!state.turnId || (method !== 'mcpServer/elicitation/request' || params.turnId != null) && (typeof params.turnId !== 'string' || params.turnId !== state.turnId))) throw Error('This helper tool request does not belong to its active native turn.');
    if (method === 'mcpServer/elicitation/request') {
      if (state.noTools) throw Error('This tool-free helper cannot request connector forms.');
      if (state.turnEnded) throw Error('This native turn has ended; connector form denied.');
      if (state.turnId && params.turnId && state.turnId !== params.turnId) throw Error('This connector form belongs to a previous native turn.');
      if (!this.requestElicitation) return {action: 'decline'};
      const elicitationTurnId = params.turnId || state.turnId;
      const isActive = () => this.nativeStateActive(state, elicitationTurnId);
      const result = await this.requestElicitation(conversationId, params, {isActive});
      return isActive() ? result : {action: 'cancel'};
    }
    if (method === 'item/tool/call') {
      if (state.noTools) throw Error('This tool-free helper cannot call host tools.');
      if (state.turnEnded) throw Error('This native turn has ended; tool call denied.');
      if (state.turnId && params.turnId && state.turnId !== params.turnId) throw Error('This tool call belongs to a previous native turn.');
      if (!state.toolDefinitions.some(tool => tool.name === params.tool)) throw new Error('Unknown tool; request denied.');
      // Recent runtimes also report these as dynamicToolCall items, which carry the same step.
      const stepId = params.callId ? `call:${params.callId}` : undefined;
      const toolTurnId = params.turnId || state.turnId;
      if (!state.dynamicItems) this.toolStep(state, { id: stepId, name: params.tool, input: params.arguments, status: 'running' });
      try {
        const result = await this.callTool(params.tool, params.arguments || {}, conversationId,
          {nativeThreadId: state.sessionId, nativeTurnId: toolTurnId, isActive: () => this.nativeStateActive(state, toolTurnId)});
        if (!this.nativeStateActive(state, toolTurnId)) throw Error('The host tool returned after its native task ended. Its effects may already be complete. Inspect the target before repeating any action.');
        let converted;
        try { converted = codexToolResult(result); }
        catch (error) { throw Error(`The tool returned, but its result could not be delivered: ${safeError(error)} Its effects may already be complete. Inspect the target before repeating any action.`); }
        if (!state.dynamicItems) this.toolStep(state, { id: stepId, name: params.tool, status: converted.success ? 'done' : 'error', outcomeConfirmed: converted.success === true });
        return converted;
      } catch (error) {
        if (!state.dynamicItems) this.toolStep(state, { id: stepId, name: params.tool, status: 'error' });
        return { success: false, contentItems: [{ type: 'inputText', text: safeError(error) }] };
      }
    }
    if (method === 'item/tool/requestUserInput') {
      if (!this.requestUserInput) throw Error('Interactive questions are unavailable. Ask the user in your reply.');
      if (state.noTools) throw Error('This tool-free helper cannot ask interactive questions.');
      if (state.turnEnded) throw Error('This native turn has ended; question request denied.');
      if (state.turnId && params.turnId && state.turnId !== params.turnId) throw Error('This question belongs to a previous native turn.');
      const questionTurnId = params.turnId || state.turnId;
      // The native async tool uses this same request with isBlocking:false.
      // Persist its card before acknowledging it; its later answer is admitted
      // through Exomina's tracked follow-up rather than an expired native turn.
      const wait=params.isBlocking!==false;
      const duration=Number.isFinite(params.autoResolutionMs)&&params.autoResolutionMs>0?Math.max(10,Math.min(300,Math.ceil(params.autoResolutionMs/1000))):undefined;
      const result=await this.requestUserInput(conversationId,{questions:params.questions,...(duration?{wait_seconds:duration}:{})},{wait});
      if (!this.nativeStateActive(state, questionTurnId)) throw Error('This native question no longer belongs to the active turn. Its persistent card and saved answer are unchanged.');
      // Empty answers after timeout mean unanswered, never an invented choice or permission.
      return {answers:result.answers||{}};
    }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      if (state.noTools) throw Error('This tool-free helper cannot request native approval.');
      if (state.turnEnded) throw Error('This native turn has ended; approval denied.');
      if (state.turnId && params.turnId && state.turnId !== params.turnId) throw Error('This approval belongs to a previous native turn.');
      const approvalTurnId = params.turnId || state.turnId;
      const item = state.items.get(params.itemId);
      const network = params.networkApprovalContext;
      const changes = item?.changes?.map(change => `${change.path || ''}\n${change.diff || ''}`).join('\n\n');
      const detail = [params.reason, network ? `Network: ${network.protocol || ''} ${network.host || ''}` : null,
        params.command || item?.command, params.cwd, params.grantRoot, params.additionalPermissions ? JSON.stringify(params.additionalPermissions, null, 2) : null, changes].filter(Boolean).join('\n').slice(0, 30000);
      const command = params.command || item?.command;
      const action = network ? { kind: 'network', tool: 'codex.network', target: String(network.host || '') }
        : method.includes('commandExecution') ? { kind: 'execute', tool: 'codex.command', target: Array.isArray(command) ? command.join(' ') : String(command || '') }
        : { kind: 'write', tool: 'codex.edit', target: (item?.changes || []).map(change => change.path).filter(Boolean).join(', ') };
      if (Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('accept')) {
        this.toolStep(state, {name: 'Codex approval unavailable', status: 'denied', detail: 'Codex requested an approval choice Exomina cannot display safely. The action was declined.'});
        return { decision: 'decline' };
      }
      const allowSession = !Array.isArray(params.availableDecisions) || params.availableDecisions.includes('acceptForSession');
      const result = await this.approveDetailed({ title: network ? 'Allow this network connection?' : params.kind === 'writeStdin' ? 'Allow input to this terminal?' : method.includes('commandExecution') ? 'Allow this command?' : 'Allow these file changes?', detail: detail || 'The runtime did not provide a preview. Deny if you cannot verify this action.', conversationId, action, reason: params.reason, requireConfirmation: true, allowSession });
      if (!result.approved || !this.nativeStateActive(state, approvalTurnId)) return { decision: 'decline' };
      if (result.scope !== 'once' && !(result.scope === 'chat' && allowSession)) return { decision: 'decline' };
      // Session approval uses Codex's cache, without saving a host prefix rule.
      return { decision: result.scope === 'chat' ? 'acceptForSession' : 'accept' };
    }
    if (method === 'item/permissions/requestApproval') {
      if (state.noTools) throw Error('This tool-free helper cannot request native approval.');
      if (state.turnEnded) throw Error('This native turn has ended; approval denied.');
      if (state.turnId && params.turnId && state.turnId !== params.turnId) throw Error('This approval belongs to a previous native turn.');
      const approvalTurnId = params.turnId || state.turnId;
      const result = await this.approveDetailed({ title: 'Grant additional access?', detail: [params.reason, JSON.stringify(params.permissions, null, 2)].filter(Boolean).join('\n'), conversationId, action: { kind: 'elevate', tool: 'codex.permissions', target: '' }, reason: params.reason, requireConfirmation: true });
      const accepted = result.approved && result.scope === 'once' && this.nativeStateActive(state, approvalTurnId);
      return { permissions: accepted ? params.permissions : {}, scope: 'turn' };
    }
    throw new Error(`Unsupported provider request ${method}; denied.`);
  }

  async startClaude(options, state) {
    // A Claude process reached Claude recently, so the sign-in is known to work: skip the extra status process.
    const signInKnown = Date.now() - this.claudeFreshAt < CLAUDE_FRESH_MS;
    const [auth, effort, speed] = await Promise.all([signInKnown ? { connected: true } : this.claudeStatus(), this.validateEffort('claude', options.model, options.effort), this.validateSpeed('claude', options.model, options.speed)]);
    if (!auth.connected) throw new Error(auth.detail);
    if (state.cancelled) throw new Error('Stopped.');
    if (!this.gateway?.script || !this.gateway?.url || !this.gateway?.token) throw new Error('The local tool gateway is not ready.');
    const configPath = path.join(this.dataDir, `mcp-${randomUUID()}.json`);
    state.configPath = configPath;
    const env = { EXOMINA_TOOL_GATEWAY: this.gateway.url, EXOMINA_TOOL_TOKEN: this.gateway.token, EXOMINA_TOOL_CONVERSATION: state.conversationId, ELECTRON_RUN_AS_NODE: '1' };
    await writeFile(configPath, JSON.stringify({ mcpServers: options.noTools ? {} : { exomina: { command: process.execPath, args: [this.gateway.script], env } } }), { mode: 0o600 });
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--replay-user-messages', '--verbose', '--include-partial-messages', '--permission-mode', options.noTools ? 'plan' : claudePermissionMode(this.getPermissionMode(state.conversationId), { nativeTools: !options.hostToolsOnly }), '--setting-sources', 'user', '--mcp-config', configPath, '--strict-mcp-config'];
    // Chat mode has no built-in tools, so nothing needs the native permission prompt.
    if (!options.noTools && !options.lean && !options.hostToolsOnly) args.push('--permission-prompt-tool', 'mcp__exomina__request_permission');
    // Exomina's own tools apply the permission policy at the gateway (memory,
    // file, browser and desktop approvals). Permit them at the runtime layer so
    // a call never turns into a second, contradictory native prompt.
    if(options.noTools||options.lean||options.hostToolsOnly)args.push('--tools','');
    // Bare mode would also stop Claude reading its subscription sign-in ("Not
    // logged in"), so temporary runs suppress project instructions and native
    // auto memory through their dedicated switches instead.
    const runEnv = this.environment('claude');
    if(options.noPersistence)Object.assign(runEnv,{CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1'});
    if(options.ephemeral||options.noPersistence)args.push('--no-session-persistence');
    const hostTools=state.toolDefinitions.filter(t=>t.name!=='request_permission').map(t=>'mcp__exomina__'+t.name);
    if(hostTools.length)args.push('--allowedTools',...hostTools);
    if (requestedModel(options.model)) args.push('--model', requestedModel(options.model));
    if (effort) args.push('--effort', effort);
    // Headless Claude only uses fast mode with an explicit per-run opt-in.
    if (speed === 'fast') args.push('--settings', JSON.stringify({ fastMode: true }));
    if (options.sessionId) args.push('--resume', options.sessionId);
    const authTurn = await this.claudeAuthTurn();
    if (state.cancelled) { authTurn(false); throw new Error('Stopped.'); }
    const child = this.spawn(await this.executable('claude'), args, 'claude', path.resolve(options.workspace || this.workspace), runEnv);
    child.once('close', () => authTurn(false));
    state.child = child;
    this.emit({ type: 'chat.timing', conversationId: state.conversationId, phase: 'runtime' });
    let fastReported = speed !== 'fast';
    let stderr = '', finalResult = null, partialForMessage = false, partialThinking = false, messageId = '';
    const blocks = new Map();
    let failed = false;
    const current = () => !failed && !state.cancelled && !state.turnEnded && this.active.get(state.conversationId) === state;
    const fail = error => {
      if (!current()) return;
      failed = true; state.claudeInput?.close(error); state.claudeHelpers?.close('failed'); state.reject(error); stopProcess(child);
    };
    state.claudeInput = new ClaudeStreamInput({ stream: child.stdin, isActive: current, sessionId: () => state.sessionId, onError: fail });
    const usageActivity = new ClaudeUsageActivity({ turnId: state.claudeActivityTurnId ||= randomUUID(), sessionId: () => state.sessionId });
    state.claudeHelpers = new ClaudeHelperActivity({turnId: state.claudeActivityTurnId, sourceModel: () => state.runtimeSelection?.model,
      sourceModelSource: () => state.runtimeSelection?.modelSource === 'runtimeConfig' ? 'configured' : 'reported',
      emit: helper => { if (this.active.get(state.conversationId) === state) this.emit({type: 'chat.helper', conversationId: state.conversationId, ...(state.messageId ? {messageId: state.messageId} : {}), helper}); }});
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.stdin.on('error', error => { if (!state.cancelled) fail(error); });
    child.on('error', fail);
    lines(child.stdout, line => {
      let event;
      try { event = JSON.parse(line); } catch { fail(new Error('Claude returned invalid streaming JSON.')); return; }
      if (!current()) return;
      if (!event || typeof event !== 'object' || Array.isArray(event)) { fail(Error('Claude returned an invalid streaming event.')); return; }
      if (typeof event.session_id === 'string' && event.session_id) {
        if (state.claudeProtocolSession && state.claudeProtocolSession !== event.session_id) { fail(Error('Claude returned an event for a different native conversation.')); return; }
        state.claudeProtocolSession = event.session_id; state.sessionId = event.session_id;
      }
      state.claudeInput.observe(event);
      if (state.claudeHelpers.observe(event)) return;
      const nativeUsage = usageActivity.observe(event);
      if (nativeUsage) this.emit({ type: 'chat.nativeActivity', conversationId: state.conversationId, activity: nativeUsage });
        if (event.type === 'system' && event.subtype === 'compact_boundary') this.emit({ type: 'chat.compacted', conversationId: state.conversationId });
        if(event.type==='system'&&event.subtype==='init'&&event.model) {
          this.reportedSelection(state, {model: event.model, modelSource: 'runtimeConfig'});
          if(options.reportSelection)state.selection={model:event.model};
        }
      if (!fastReported && event.type === 'system' && event.subtype === 'init' && event.fast_mode_state !== undefined) {
        fastReported = true;
        const reason = CLAUDE_FAST_REASONS[event.fast_mode_disabled_reason] || (event.fast_mode_state === 'cooldown' ? 'it is cooling down after a rate limit' : 'Claude did not enable it');
        this.emit({ type: 'chat.notice', conversationId: state.conversationId, text: event.fast_mode_state === 'on' ? 'Fast mode is on. This reply draws from your Claude extra usage credits.' : `Fast mode was not used because ${reason}. This reply runs at standard speed.` });
      }
      try {
        // Claude reports API errors as synthetic assistant text; only a streamed message proves the sign-in.
        if (event.type === 'stream_event' && event.event?.type === 'message_start') {
          authTurn(true); this.reportedSelection(state, {model: event.event.message?.model, modelSource: 'execution'});
        }
        if (event.type === 'stream_event') {
          const stream = event.event || {};
          if (stream.type === 'message_start') { partialForMessage = false; partialThinking = false; messageId = stream.message?.id || randomUUID(); blocks.clear(); }
          if (stream.type === 'content_block_start') { blocks.set(stream.index, stream.content_block?.type); if (stream.content_block?.type === 'thinking') { partialThinking = true; this.thinking(state, `${messageId}:${stream.index}`, '', false, true); } }
          if (stream.delta?.type === 'text_delta') { partialForMessage = true; this.delta(state, stream.delta.text, messageId); }
          if (stream.delta?.type === 'thinking_delta') { partialThinking = true; this.thinking(state, `${messageId}:${stream.index}`, stream.delta.thinking); }
          if (stream.type === 'content_block_stop' && blocks.get(stream.index) === 'thinking') this.thinking(state, `${messageId}:${stream.index}`, '', true);
        } else if (event.type === 'assistant') {
          this.reportedSelection(state, {model: event.message?.model, modelSource: 'execution'});
          // Synthetic API-error frames can be the only terminal notice. A
          // successful assistant message afterward supersedes a retried error.
          state.claudeAssistantError = event.error ? { code: typeof event.error === 'string' ? event.error : event.error.type,
            message: (event.message?.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n') || event.error.message || 'Claude returned an API error.' } : null;
          const id = event.message?.id || messageId;
          (event.message?.content || []).forEach((block, index) => {
            if (block.type === 'thinking' && !partialThinking && block.thinking) this.thinking(state, `${id}:${index}`, block.thinking, true);
            if (block.type === 'text' && !partialForMessage) this.delta(state, block.text, id);
            if (block.type === 'tool_use') this.toolStep(state, { id: block.id, name: block.name, input: block.input, ...(['Task','Agent'].includes(block.name)?{nativeToolUseId:block.id}:{}), status: 'running' });
          });
          partialForMessage = false; partialThinking = false;
        } else if (event.type === 'user') {
          if (event.isReplay === true) return;
          // Tool results come back as the next "user" turn.
          for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
            if (block.type !== 'tool_result' || !block.tool_use_id) continue;
            const output = Array.isArray(block.content) ? block.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : block.content;
            this.toolStep(state, { id: block.tool_use_id, status: block.is_error ? 'error' : 'done', outcomeConfirmed: block.is_error !== true, output: typeof output === 'string' ? output.slice(0, 4000) : undefined,historyOutput:typeof output==='string'?clipToolHistory(output):undefined });
          }
        } else if (event.type === 'rate_limit_event' && event.rate_limit_info) { if(event.rate_limit_info.status==='rejected'){state.claudeUsageRejected=true;state.claudeInput.end();} this.emit({ type: 'usage', provider: 'claude', info: event.rate_limit_info }); }
        else if (event.type === 'result') {
          finalResult = event;
          // End admission at a native result. EOF drains any prompts already
          // submitted during work; their later results supersede this one.
          state.claudeInput.end();
        }
        else if (event.type === 'control_request' && typeof event.request_id === 'string') {
          // Permissions remain on the conversation-scoped MCP gateway. Never
          // approve an unexpected native control request on a second channel.
          child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: 'Unsupported native control request; permission approval remains with Exomina.' } }) + '\n');
        }
      } catch (error) { fail(error); }
    }, fail);
    child.on('close', code => {
      state.claudeInput.close();
      state.claudeHelpers.close(finalResult?.is_error || code !== 0 ? 'failed' : 'cancelled');
      if (!current()) return;
      state.turnEnded = true;
      if (state.claudeUsageRejected || providerUsageNotice(finalResult?.result) || state.claudeAssistantError || finalResult?.is_error || (finalResult?.subtype && finalResult.subtype !== 'success')) {
        const message = finalResult?.result || (Array.isArray(finalResult?.errors) ? finalResult.errors.join('\n') : '') || state.claudeAssistantError?.message || (state.claudeUsageRejected ? 'Claude rejected the request because its subscription usage allowance is exhausted.' : `Claude stopped: ${finalResult?.subtype || code}`);
        const error = new Error(safeError(message));
        error.code = state.claudeAssistantError?.code;
        error.noOutput = !state.text || CLAUDE_AUTH_EXPIRED.test(state.text);
        if(state.claudeUsageRejected || usageExhausted(error))error.usageLimited=true;
        state.reject(error);
      } else if (code !== 0 || !finalResult) { const error = new Error(`Claude runtime exited (${code}) before completing. ${safeError(stderr)}`); error.noOutput = !state.text; state.reject(error); }
      else {
        const text = finalResult.result || state.text;
        if (!state.text && text) this.delta(state, text);
        state.resolve({ sessionId: state.sessionId, text, ...(state.selection?{selection:state.selection}:{}) });
      }
    });
    try { state.claudeInput.send({ prompt: options.prompt, images: options.images || [], initial: true }); }
    catch (error) { fail(error); }
  }

  /** A short, tool-less request whose output never reaches a chat (chat titles).
   * Runs read-only with no session persistence and the smallest suitable model.
   */
  async oneShot(provider, prompt, { timeout = 45000 } = {}) {
    this.requireProvider(provider);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw new Error('Provide a short prompt.');
    if (provider === 'claude') { await this.beforeRequest({ provider, kind: 'background' }); return this.claudeOneShot(prompt, timeout); }
    if (provider !== 'codex') throw new Error('Quick requests support Claude and ChatGPT.');
    const id = `silent-${randomUUID()}`;
    this.silent.add(id);
    let timer;
    try {
      const models = await this.modelsFor('codex').catch(() => []);
      const model = models.find(item => /mini|nano/i.test(item.id)) || models.find(item => item.isDefault) || models[0];
      const effort = model?.efforts?.find(option => ['minimal', 'low'].includes(option.id))?.id;
      const run = this.run({ provider: 'codex', conversationId: id, prompt, model: model?.id, effort, toolDefinitions: [], ephemeral: true,
        workspace: path.join(this.dataDir, 'runtime-tmp'), developerInstructions: 'Reply with only the requested text.', policy: codexPolicy('read-only') });
      const expired = new Promise((_, reject) => { timer = setTimeout(() => { this.cancel(id); reject(new Error('Quick request timed out.')); }, timeout); });
      return (await Promise.race([run, expired])).text || '';
    } finally { clearTimeout(timer); this.silent.delete(id); }
  }

  async claudeOneShot(prompt, timeout) {
    await this.prepare();
    const executable = await this.executable('claude');
    if (!executable) throw new Error('Install the official Claude Code runtime.');
    const turn = await this.claudeAuthTurn();
    const child = this.spawn(executable, ['-p', '--output-format', 'json', '--model', 'haiku', '--tools', '', '--permission-mode', 'plan',
      '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence'], 'claude', path.join(this.dataDir, 'runtime-tmp'));
    this.metadataProcesses.add(child);
    return new Promise((resolve, reject) => {
      let stdout = '', settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); this.metadataProcesses.delete(child); stopProcess(child); turn(!error); if (error) reject(error); else resolve(value); };
      const timer = setTimeout(() => finish(new Error('Quick request timed out.')), timeout);
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.on('error', error => finish(new Error(safeError(error))));
      child.on('close', code => {
        let result;
        try { result = JSON.parse(stdout.trim().split('\n').pop()); } catch { finish(new Error(`Claude quick request failed (${code}).`)); return; }
        if (result.is_error || typeof result.result !== 'string') finish(new Error('Claude quick request failed.'));
        else finish(null, result.result);
      });
      child.stdin.end(prompt);
    });
  }

  cancel(conversationId, reason = 'Stopped.') {
    const state = this.active.get(conversationId);
    if (!state) { this.retryCancelled.add(conversationId); return; }
    state.cancelled = true;
    this.retireCodexChildren(state);
    state.claudeInput?.close();
    state.claudeHelpers?.close();
    state.endWait?.();
    state.adapterCancel?.();
    if (state.child) stopProcess(state.child);
    if (state.provider === 'codex' && state.sessionId && state.turnId && this.rpc && !this.rpc.closed) this.rpc.request('turn/interrupt', { threadId: state.sessionId, turnId: state.turnId }, 5000).catch(() => {});
    state.reject(new Error(reason));
  }

  close() {
    this.closed = true;
    for (const adapter of this.adapters.values()) adapter.close();
    for (const id of this.active.keys()) this.cancel(id);
    for (const child of this.loginProcesses.values()) stopProcess(child);
    this.loginProcesses.clear();
    for (const child of this.metadataProcesses) stopProcess(child);
    this.metadataProcesses.clear();
    this.modelCache.clear();
    this.rpc?.close();
    this.realtimeListeners.clear();
  }

  onRealtime(listener) {this.realtimeListeners.add(listener);return ()=>this.realtimeListeners.delete(listener);}
}
