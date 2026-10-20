import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { runtimeError } from './provider-acp.mjs';
import { usageExhausted } from './model-preferences.mjs';
import { antigravityToolLease } from './antigravity-tools.mjs';
import { prepareAntigravityProfile, acquireAntigravityTurn, antigravityEnvironment, resetAntigravityProfile } from './antigravity-profile.mjs';

const optionalChoice = value => typeof value === 'string' && value.trim() && !['auto', 'default'].includes(value.trim()) ? value.trim() : undefined;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const ANTIGRAVITY_INSTALL = 'Install Antigravity CLI with Google’s official script (PowerShell: irm https://antigravity.google/cli/install.ps1 | iex), then sign in.';

/** `agy models` prints one "slug   Label" row per model. */
export function parseAntigravityModels(text) {
  const models = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*([a-z0-9][a-z0-9._-]*)\s{2,}(\S.*?)\s*$/i.exec(line);
    if (match && !models.some(model => model.id === match[1])) models.push({ id: match[1], label: match[2] });
  }
  return models;
}

/** Plain explanations for the failures a person can act on. */
export function antigravityError(value) {
  const detail = typeof value === 'string' ? value.trim() : value?.message || value?.error?.message || (typeof value?.error === 'string' ? value.error : value?.code || value?.type);
  const text = runtimeError(detail || 'Antigravity CLI stopped without an answer.');
  if (/auth(entication|orization)? required|not (signed|logged) in|sign[- ]?in required|login required/i.test(text)) return 'Antigravity is not signed in. Open Connections → Gemini → Sign in, finish the Google sign-in, then try again.';
  if (/not recognized as a known model|invalid model selection/i.test(text)) return 'This Antigravity account does not offer the selected model. Choose another model and try again.';
  if (usageExhausted(value) || usageExhausted(text)) return `Antigravity reports that your plan’s usage limit is reached. ${text}`;
  return text;
}

/** Turns one headless stream-json event into Exomina chat updates. Returns the final result when the turn ends. */
export function applyAntigravityEvent(event, state, manager) {
  if (!event || typeof event !== 'object') return null;
  if (event.event === 'init') { if (event.conversation_id) state.sessionId = event.conversation_id; return null; }
  if (event.event === 'result') return event.result || { status: 'ERROR', error: 'Antigravity returned an empty result.' };
  if (event.event !== 'step_update' || !event.step_update) return null;
  const step = event.step_update;
  if (step.conversation_id) state.sessionId = step.conversation_id;
  if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) manager.delta(state, step.text_delta);
  else if (step.step_type === 'tool') {
    const info = step.tool_info || {}, done = step.state === 'DONE', failed = Boolean(info.error);
    manager.toolStep(state, { id: `antigravity-${step.step_index}`, name: step.tool_name || info.name || 'Antigravity tool', input: info.parameters || {}, status: done ? (failed ? 'error' : 'done') : 'running', outcomeConfirmed: done && !failed,
      ...(done ? { output: String(failed ? info.error.message || info.error.type || 'Tool failed.' : info.output ?? '').slice(0, 4000) } : {}) });
  }
  return null;
}

/** Google's Antigravity CLI in its documented headless stream-json mode, using the person's own CLI sign-in. */
export class AntigravityProvider {
  constructor(manager, { executablePath, spawnImpl } = {}) { Object.assign(this, { manager, executablePath, spawnImpl: spawnImpl || manager.spawnImpl || spawn }); this.children = new Set(); this.closed = false; this.models = null; }
  async executable() {
    const candidates = [this.executablePath, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
      process.env.HOME && path.join(process.env.HOME, '.local', 'bin', 'agy'),
      ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, process.platform === 'win32' ? 'agy.exe' : 'agy'))].filter(Boolean);
    for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* try the next location */ } }
    return null;
  }
  async profile() {
    if (!this.profileReady) this.profileReady = prepareAntigravityProfile(this.manager.dataDir).catch(error => { this.profileReady = null; throw error; });
    return this.profileReady;
  }
  async environment(options) { return antigravityEnvironment(this.manager.environment('antigravity'), await this.profile(), options); }
  /** Runs a short CLI command and collects its output, bounded by a timeout. */
  async command(executable, args, timeout = 20000) {
    const env = await this.environment();
    const cwd = await this.profile();
    return new Promise(resolve => {
      // agy's default logger creates cli.log as a symlink, which is incompatible
      // with Exomina's independently audited encrypted vault. Use its documented
      // explicit log sink for every entry point, including metadata commands.
      const child = this.spawnImpl(executable, ['--log-file', process.platform === 'win32' ? 'NUL' : '/dev/null', ...args], { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', settled = false, stoppedResult, stopTimer;
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(stopTimer); this.children.delete(child); resolve(result); };
      const stop = result => {
        if (settled || stoppedResult) return;
        stoppedResult = result; clearTimeout(timer); this.manager.stopChild(child);
        if (!settled) stopTimer = setTimeout(() => finish({ ...result, stderr: result.stderr + ' The process stop could not be confirmed.' }), 5000);
      };
      const timer = setTimeout(() => stop({ code: null, stdout, stderr: stderr || 'Antigravity CLI did not answer in time.' }), timeout);
      this.children.add(child);
      child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-200000); });
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
      const failed = error => stop({ code: null, stdout, stderr: error.message });
      child.on('error', failed); child.stdout?.on('error', failed); child.stderr?.on('error', failed);
      child.on('close', code => finish(stoppedResult || { code, stdout, stderr }));
    });
  }
  async readModels() {
    const executable = await this.executable(); if (!executable) return { installed: false, models: [], error: ANTIGRAVITY_INSTALL };
    const result = await this.command(executable, ['models']);
    const models = result.code === 0 ? parseAntigravityModels(result.stdout) : [];
    return { installed: true, models, error: models.length ? '' : antigravityError(result.stderr || result.stdout) };
  }
  async status() {
    await this.manager.prepare();
    const base = { id: 'antigravity', name: 'Antigravity', supportsTools: true, supportsImages: false, supportsImageAttachments: true, imageGeneration: { supported: false, available: false } };
    const { installed, models, error } = await this.readModels();
    if (!installed) return { ...base, installed: false, connected: false, detail: ANTIGRAVITY_INSTALL };
    this.models = models.length ? models : null;
    return { ...base, installed: true, connected: models.length > 0, detail: models.length ? 'Antigravity connected in Exomina’s own Google sign-in profile. Shared tools and attachments use Exomina’s permission controls. Your Google plan’s access and limits apply; automatic Google credits are disabled.' : error };
  }
  async modelOptions() {
    const { models } = await this.readModels();
    return models.map(model => ({ id: model.id, label: model.label, supportsImages: false, supportsImageAttachments: true, efforts: EFFORTS.map(id => ({ id, label: id === 'xhigh' ? 'Extra high' : id.charAt(0).toUpperCase() + id.slice(1) })), defaultEffort: '' }));
  }
  async disconnect() {
    await this.manager.prepare();
    for (const child of [...this.children]) this.manager.stopChild(child);
    await resetAntigravityProfile(this.manager.dataDir);
    this.profileReady = null; this.models = null; this.manager.modelCache?.delete('antigravity');
  }
  /** Google's documented remote-terminal OAuth flow keeps browser launch outside
   * the isolated CLI profile. The user opens its URL and pastes its code directly
   * into the visible CLI; Exomina never reads either the code or credentials. */
  async connect() {
    await this.manager.prepare();
    const executable = await this.executable(); if (!executable) throw new Error(ANTIGRAVITY_INSTALL);
    if (process.platform !== 'win32') return { message: 'Run agy in a terminal, finish the Google sign-in, then return here and refresh the connection.' };
    const workspace = await acquireAntigravityTurn(this.manager.dataDir, {}, { idleOnly: true });
    try { await workspace.configure(null); } catch (error) { await workspace.close(); throw error; }
    const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
    const marker = 'EXOMINA_ANTIGRAVITY_SIGNIN_STARTED';
    const launcher = `$signInProcess = Start-Process -FilePath ${quote(executable)} -ArgumentList '--log-file','NUL' -WorkingDirectory ${quote(workspace.path)} -WindowStyle Normal -PassThru -ErrorAction Stop\nWrite-Output '${marker}'\n$signInProcess.WaitForExit()`;
    let child;
    try { child = this.spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', launcher], { cwd: workspace.path, env: await this.environment({ manualSignIn: true }), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { await workspace.close(); throw error; }
    this.children.add(child);
    return new Promise((resolve, reject) => {
      let settled = false, childClosed = false, output = '', stderr = '';
      const fail = error => {
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
        if (!childClosed) { workspace.block(); this.manager.stopChild(child); }
      };
      const timer = setTimeout(() => fail(new Error('The Antigravity sign-in window did not open in time.')), 10000);
      child.stdout?.on('data', chunk => {
        output = (output + String(chunk)).slice(-1000);
        if (!settled && output.includes(marker)) {
          settled = true; clearTimeout(timer); this.manager.modelCache?.delete('antigravity');
          resolve({ message: 'An Antigravity window opened for Exomina’s own profile using Google’s manual sign-in flow. Copy the secure URL shown there into your normal browser, sign in with Google, then paste the authorization code directly into the Antigravity window. Close that window and refresh this connection when finished. Exomina does not read your authorization code.' });
        }
      });
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
      child.on('error', fail); child.stdout?.on('error', fail); child.stderr?.on('error', fail);
      child.on('close', () => {
        childClosed = true; clearTimeout(timer); this.children.delete(child);
        workspace.close().then(() => { if (!settled) fail(new Error(antigravityError(stderr || 'The Antigravity sign-in window could not be opened.'))); }, error => { if (!settled) fail(error); });
      });
    });
  }
  async run(options, state) {
    const executable = await this.executable(); if (!executable) throw new Error(ANTIGRAVITY_INSTALL);
    const workspace = await acquireAntigravityTurn(this.manager.dataDir, state);
    let tools;
    try { tools = await antigravityToolLease(this.manager, state, options); await workspace.configure(tools?.config); if (state.cancelled) throw new Error('Stopped.'); }
    catch (error) { tools?.close(); await workspace.close(); state.adapterCancel = null; throw error; }
    const model = optionalChoice(options.model), effort = optionalChoice(options.effort);
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '60m', '--sandbox', '--disable-slash-commands', '--log-file', process.platform === 'win32' ? 'NUL' : '/dev/null',
      ...(options.sessionId ? ['--conversation', String(options.sessionId)] : []), ...(model ? ['--model', model] : []), ...(effort && EFFORTS.includes(effort) ? ['--effort', effort] : [])];
    let child;
    try { child = this.manager.spawn(executable, args, 'antigravity', workspace.path, await this.environment()); }
    catch (error) { tools?.close(); await workspace.close(); throw error; }
    this.children.add(child);
    state.adapterCancel = () => { tools?.close(); this.manager.stopChild(child); };
    let stderr = '', final = null, pipeFailure, childClosed = false, closed;
    const childCompletion = new Promise(resolve => { closed = resolve; });
    const redact = value => tools ? tools.redact(value) : String(value || '');
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (state.cancelled || !line.trim()) return;
      let event; try { event = JSON.parse(redact(line)); } catch { return; }
      const result = applyAntigravityEvent(event, state, this.manager);
      if (result) final = result;
    });
    const exit = new Promise(resolve => {
      let settled = false;
      const finish = code => { if (settled) return; settled = true; resolve(code); };
      const failed = error => { if (settled) return; pipeFailure = new Error(redact(error.message)); tools?.close(); this.manager.stopChild(child); finish(null); };
      child.on('close', code => { childClosed = true; closed(); finish(code); }); child.on('error', failed);
      for (const stream of [child.stdin, child.stdout, child.stderr, lines]) stream?.on('error', failed);
    });
    try {
      // Closing stdin after the one prompt ends the session once this turn's result arrives.
      const hostContext = tools ? '\nUse Exomina’s MCP tools for the shared browser, memory, questions and project files. They apply the user’s Exomina permissions. Native CLI file, URL and command tools are disabled. Read attachments with the provided tools; report a tool failure honestly.\n' : '';
      const files = options.attachments?.length ? '\nUser-attached files (source data; use Exomina file tools for content not already included):\n' + options.attachments.map(file => JSON.stringify({ name: file.name, path: file.path })).join('\n') + '\n' : '';
      child.stdin.end(JSON.stringify({ event: 'user', message: { content: String(options.prompt || '') + hostContext + files + (tools?.imageContext || '') } }) + '\n');
      const code = await exit;
      if (state.cancelled) throw new Error('Stopped.');
      if (pipeFailure) { pipeFailure.handoffUnsafe = true; throw pipeFailure; }
      if (final?.conversation_id) state.sessionId = final.conversation_id;
      if (final?.status !== 'SUCCESS') throw new Error(antigravityError(final?.error || redact(stderr) || `Antigravity CLI exited with code ${code}.`));
      if (!state.text && final.response) this.manager.delta(state, final.response);
      state.turnEnded = true;
      return { sessionId: state.sessionId, text: state.text };
    } finally {
      tools?.close(); lines.close(); this.children.delete(child); state.adapterCancel = null;
      if (!childClosed) {
        let timer;
        const stopped = await Promise.race([childCompletion.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
        clearTimeout(timer);
        if (!stopped) { workspace.block(); childCompletion.then(() => workspace.close()).catch(() => {}); throw Object.assign(new Error('Antigravity could not confirm that its process stopped. Restart Exomina before using this connection again.'), { handoffUnsafe: true }); }
      }
      await workspace.close();
    }
  }
  close() { this.closed = true; for (const child of this.children) this.manager.stopChild(child); this.children.clear(); }
}
