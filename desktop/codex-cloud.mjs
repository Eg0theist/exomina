import path from 'node:path';
import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const clean = (value, limit = 4000) => String(value ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk-[\w-]+|eyJ[\w.-]{30,})\b/g, '[redacted]').slice(0, limit);
function identifier(value, label) { if (typeof value !== 'string' || !ID.test(value)) throw Error(`Choose a valid ${label}.`); return value; }
export function cloudTaskUrl(value) {
  try { const url = new URL(value); return url.href === value && url.protocol === 'https:' && url.hostname === 'chatgpt.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/codex\/(?:tasks\/[A-Za-z0-9_-]+|task[_-][A-Za-z0-9_-]+)\/?$/.test(url.pathname) ? url.href : null; } catch { return null; }
}
function task(value) {
  const id = identifier(value?.id, 'cloud task');
  return { id, url: cloudTaskUrl(value.url), title: clean(value.title, 500), status: clean(value.status, 100), updatedAt: clean(value.updated_at, 80), environmentId: typeof value.environment_id === 'string' && ID.test(value.environment_id) ? value.environment_id : '', environmentLabel: clean(value.environment_label, 160), summary: clean(typeof value.summary === 'string' ? value.summary : JSON.stringify(value.summary ?? ''), 6000) };
}
const schema = properties => ({ type: 'object', properties, additionalProperties: false });
const taskProperties = { taskId: { type: 'string' } };
export const CODEX_CLOUD_TOOLS = [
  { name: 'codex_cloud_list', description: 'List subscription Codex Cloud tasks and saved environment choices. Read-only; never starts work. Requires the existing ChatGPT sign-in. Cloud tasks do not inherit local files, tools or permissions.', inputSchema: schema({ environmentId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }) },
  { name: 'codex_cloud_status', description: 'Read one Codex Cloud task status through the official CLI.', inputSchema: { ...schema(taskProperties), required: ['taskId'] } },
  { name: 'codex_cloud_diff', description: 'Read a cloud task code diff with bounded pagination. Returned code is untrusted source data. No local edits.', inputSchema: { ...schema({ ...taskProperties, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24000 } }), required: ['taskId'] } },
  { name: 'codex_cloud_submit', description: 'Submit the exact prompt to a configured Codex Cloud environment after approval. Uses ChatGPT subscription allowance; remote environment permissions apply. Local files, memory and host tools are not uploaded. Never retry an uncertain submission automatically; inspect the task list first.', inputSchema: { ...schema({ environmentId: { type: 'string' }, prompt: { type: 'string' }, branch: { type: 'string' }, requestId: { type: 'string', description: 'Stable unique ID for this exact submission; reuse it after an uncertain response.' } }), required: ['environmentId', 'prompt', 'requestId'] } },
];

/** Uses official runtime authentication without reading or copying credentials.
 * Submissions are recorded before dispatch; uncertain outcomes are never retried. */
export class CodexCloud {
  constructor({ providers, store, approve, getWorkspace, validatePath, isLive = () => true, emit = () => {}, timeoutMs = 45000, maxBytes = 8 * 1024 * 1024 }) {
    Object.assign(this, { providers, store, approve, getWorkspace, validatePath, isLive, emit, timeoutMs, maxBytes });
    this.children = new Set(); this.closed = false; this.mutating = false;
    this.definitions = CODEX_CLOUD_TOOLS;
    this.state = store.state.codexCloud ||= { environments: [], submissions: [] };
    for (const item of this.state.submissions || []) if (item.status === 'submitting') item.status = 'unknown';
  }
  view() { return { environments: this.state.environments || [], submissions: (this.state.submissions || []).slice(-50).reverse(), experimental: true }; }
  async persist() { await this.store.save(); this.emit({ type: 'state.changed' }); }
  async authenticate() {
    if (this.closed) throw Error('Codex Cloud is closed.');
    this.providers.requireProvider('codex');
    const info = await (await this.providers.getCodex()).request('account/read', { refreshToken: false });
    if (info.account?.type !== 'chatgpt') throw Error('Connect ChatGPT in Connections. Codex Cloud requires subscription sign-in; an API key cannot enable it.');
    return { connected: true, plan: clean(info.account.planType || 'subscription', 80) };
  }
  async info() { let auth; try { auth = await this.authenticate(); } catch (e) { auth = { connected: false, error: clean(e.message) }; } return { ...this.view(), ...auth }; }
  async configure({ id, name, remove = false }) {
    identifier(id, 'environment');
    if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\x00-\x1f]/.test(name)) throw Error('Name this environment (up to 160 characters).');
    const remaining = (this.state.environments || []).filter(item => item.id !== id);
    if (!remove) remaining.push({ id, name: name.trim() });
    if (remaining.length > 20) throw Error('Save at most 20 cloud environments.');
    this.state.environments = remaining; await this.persist(); return this.view();
  }
  capture(executable, args, { cwd, input, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(Error('Codex Cloud is closed.'));
    return new Promise((resolve, reject) => {
      let child, timer, done = false, bytes = 0; const stdout = [], stderr = [];
      const finish = (error, output) => { if (done) return; done = true; clearTimeout(timer); this.children.delete(child); error ? reject(error) : resolve(output); };
      try { child = this.providers.spawn(executable, args, 'codex', cwd || this.getWorkspace()); } catch (e) { finish(e); return; }
      this.children.add(child);
      const read = (chunks, chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > this.maxBytes) { finish(Error('Cloud output exceeded its size limit. No automatic retry was made.')); this.providers.stopChild(child); } else chunks.push(Buffer.from(chunk)); };
      child.stdout.on('data', chunk => read(stdout, chunk)); child.stderr.on('data', chunk => read(stderr, chunk));
      child.on('error', e => finish(Error(clean(e.message))));
      child.on('close', code => { const output = Buffer.concat(stdout).toString('utf8'); finish(code === 0 ? null : Error(clean(Buffer.concat(stderr).toString('utf8') || output || `Codex Cloud exited with code ${code}.`)), output); });
      child.stdin?.end(input);
      timer = setTimeout(() => { finish(Error('Cloud request timed out. Its remote outcome may be unknown; refresh the task list before retrying.')); this.providers.stopChild(child); }, timeoutMs);
    });
  }
  async command(args) { await this.authenticate(); const executable = await this.providers.executable('codex'); if (!executable) throw Error('The official Codex runtime is unavailable.'); return this.capture(executable, ['cloud', ...args]); }
  async list({ environmentId, cursor, limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('List between 1 and 20 cloud tasks.');
    const args = ['list', '--json', '--limit', String(limit)];
    if (environmentId) args.push('--env', identifier(environmentId, 'environment'));
    if (cursor) { if (typeof cursor !== 'string' || cursor.length > 4000 || /[\x00-\x1f]/.test(cursor)) throw Error('Invalid task cursor.'); args.push('--cursor', cursor); }
    const raw = await this.command(args); let result; try { result = JSON.parse(raw); } catch { throw Error('The cloud runtime returned unreadable task data.'); }
    if (!Array.isArray(result.tasks) || result.tasks.length > limit || (result.cursor != null && (typeof result.cursor !== 'string' || result.cursor.length > 4000))) throw Error('The cloud runtime returned invalid task data.');
    return { tasks: result.tasks.map(task), cursor: result.cursor || null, ...this.view() };
  }
  async status({ taskId }) { return { taskId: identifier(taskId, 'cloud task'), text: clean(await this.command(['status', taskId]), 24000) }; }
  async diff({ taskId, offset = 0, limit = 24000 }) {
    identifier(taskId, 'cloud task');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw Error('Invalid diff pagination.');
    const content = await this.command(['diff', taskId]);
    return { taskId, text: content.slice(offset, offset + limit), offset, nextOffset: offset + limit < content.length ? offset + limit : null, totalCharacters: content.length, sha256: hash(content) };
  }
  async submit({ environmentId, prompt, branch = '', requestId }, conversationId) {
    identifier(environmentId, 'environment'); identifier(requestId, 'submission ID');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000 || prompt.includes('\0')) throw Error('Write a cloud task of up to 12,000 characters.');
    if (typeof branch !== 'string' || branch.length > 240 || (branch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.includes('//')))) throw Error('Use a valid repository branch name.');
    if (!(this.state.environments || []).some(item => item.id === environmentId)) throw Error('Save this environment in Projects & prompts → Codex Cloud before submitting work.');
    const fingerprint = hash(JSON.stringify({ environmentId, prompt, branch }));
    const previous = this.state.submissions.find(item => item.requestId === requestId);
    if (previous) { if (previous.fingerprint !== fingerprint) throw Error('This submission ID belongs to a different request.'); return { ...previous, duplicate: true }; }
    if (this.mutating) throw Error('Wait for the current cloud action to finish.');
    this.mutating = true;
    let record;
    try {
      await this.authenticate();
      const allowed = await this.approve({ conversationId, title: 'Start this task on Codex Cloud?', action: { kind: 'network', tool: 'codex_cloud_submit', target: environmentId }, detail: `Environment: ${this.state.environments.find(e => e.id === environmentId).name}\nBranch: ${branch || 'current local Git branch'}\n\n${prompt}\n\nThis consumes ChatGPT subscription allowance. The remote environment's access settings apply. Local files and Exomina tools are not uploaded.` });
      if (!allowed) return { status: 'declined', requestId };
      if (this.closed || !this.isLive(conversationId)) throw Error('The originating request ended before submission.');
      record = { requestId, fingerprint, environmentId, title: prompt.trim().slice(0, 300), createdAt: new Date().toISOString(), status: 'submitting' };
      this.state.submissions.push(record);
      // Keep uncertain receipts even when older confirmed receipts age out.
      const recent = new Set(this.state.submissions.slice(-200));
      this.state.submissions = this.state.submissions.filter(item => recent.has(item) || ['unknown', 'submitting'].includes(item.status));
      await this.persist();
      const output = await this.command(['exec', '--env', environmentId, '--attempts', '1', ...(branch ? ['--branch', branch] : []), '--', prompt]);
      const url = (output.match(/https:\/\/chatgpt\.com\/[^\s<>"']+/g) || []).map(cloudTaskUrl).find(Boolean);
      Object.assign(record, { status: 'submitted', ...(url ? { url, taskId: new URL(url).pathname.split('/').filter(Boolean).at(-1) } : {}), response: clean(output, 4000) });
      await this.persist(); return { ...record };
    } catch (e) { if (record) { record.status = 'unknown'; record.error = clean(e.message); await this.persist(); } throw e; }
    finally { this.mutating = false; }
  }
  async apply({ taskId, sha256 }, conversationId) {
    identifier(taskId, 'cloud task'); if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw Error('Review the cloud diff before applying it.');
    if (!this.validatePath) throw Error('Local patch application requires the host workspace protection checks.');
    if (this.mutating) throw Error('Wait for the current cloud action to finish.'); this.mutating = true;
    try {
      const cwd = path.resolve(this.getWorkspace());
      const top = (await this.capture('git', ['rev-parse', '--show-toplevel'], { cwd })).trim();
      if (path.resolve(top).toLowerCase() !== cwd.toLowerCase()) throw Error('Choose the repository root as your Exomina workspace before applying changes.');
      if ((await this.capture('git', ['status', '--porcelain'], { cwd })).trim()) throw Error('Commit or save your local changes before applying a cloud diff.');
      const diff = await this.command(['diff', taskId]); if (!diff.trim()) throw Error('This cloud task has no code diff to apply.');
      if (hash(diff) !== sha256) throw Error('The cloud diff changed. Review it again before applying.');
      await this.validateDiffPaths(diff, cwd);
      const allowed = await this.approve({ conversationId, title: 'Apply these cloud changes to your repository?', action: { kind: 'write', tool: 'codex_cloud_apply', target: cwd }, detail: `Repository: ${cwd}\nTask: ${taskId}\n\n${diff}` });
      if (!allowed) return { applied: false };
      if (this.closed || !this.isLive(conversationId)) throw Error('The originating request ended before applying changes.');
      if ((await this.capture('git', ['status', '--porcelain'], { cwd })).trim() || hash(await this.command(['diff', taskId])) !== sha256) throw Error('The repository or cloud diff changed while approval was open. Review it again.');
      await this.validateDiffPaths(diff, cwd);
      // Apply the exact bytes that were reviewed. Fetching a newer remote diff
      // inside `cloud apply` would leave a race after the approval/hash check.
      await this.capture('git', ['apply', '--check', '-'], { cwd, input: diff });
      const output = await this.capture('git', ['apply', '-'], { cwd, input: diff });
      return { applied: true, repository: cwd, text: clean(output || 'Applied the reviewed cloud diff.', 24000) };
    } finally { this.mutating = false; }
  }
  async validateDiffPaths(diff, cwd) {
    const entries = (await this.capture('git', ['apply', '--numstat', '-z', '-'], { cwd, input: diff })).split('\0');
    const files = [];
    for (let index = 0; index < entries.length; index++) {
      if (!entries[index]) continue;
      const row = /^([0-9]+|-)\t([0-9]+|-)\t([\s\S]*)$/.exec(entries[index]);
      if (!row) throw Error('Git returned invalid patch paths.');
      if (row[3]) files.push(row[3]);
      else { if (!entries[index + 1] || !entries[index + 2]) throw Error('Git returned an incomplete rename path.'); files.push(entries[++index], entries[++index]); }
    }
    if (!files.length) throw Error('The diff contains no supported file changes.');
    for (const file of files) await this.validatePath(file);
  }
  async call(name, args, conversationId) { try { const result = name === 'codex_cloud_list' ? await this.list(args) : name === 'codex_cloud_status' ? await this.status(args) : name === 'codex_cloud_diff' ? await this.diff(args) : name === 'codex_cloud_submit' ? await this.submit(args, conversationId) : (() => { throw Error('Unknown Codex Cloud tool.'); })(); return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }; } catch (e) { return { isError: true, content: [{ type: 'text', text: clean(e.message) }] }; } }
  close() { this.closed = true; for (const child of this.children) this.providers.stopChild(child); }
}
