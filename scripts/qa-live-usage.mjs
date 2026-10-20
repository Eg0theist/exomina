// Calls only official runtime usage protocols. Never opens credential files or sends a model prompt.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProcess, subscriptionEnvironment } from '../desktop/providers.mjs';
import { CLAUDE_USAGE_ARGS, claudeUsageEnvironment, readClaudeUsage } from '../desktop/provider-usage.mjs';
import { claudeUsage, codexUsage, UsageTracker } from '../desktop/usage.mjs';
import { UsagePoller } from '../desktop/usage-poller.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const accounts = process.argv[2];
if (!accounts || !path.isAbsolute(accounts)) throw new Error('Pass the Exomina accounts root for the official runtimes.');
const claudeExe = path.join(root, 'node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe');
const codexExe = path.join(root, 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
function start(exe, args, provider) { const base = subscriptionEnvironment(provider, accounts), env = provider === 'claude' ? claudeUsageEnvironment(base) : base; return spawn(exe, args, { cwd: path.join(root, '../Workspace'), env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
async function readClaude() {
  const diagnose = process.argv.includes('--diagnose'), diagnostics = {};
  const child = start(claudeExe, [...CLAUDE_USAGE_ARGS, ...(diagnose ? ['--debug-to-stderr'] : [])], 'claude');
  let debugBuffer = '';
  if (diagnose) child.stderr.on('data', chunk => {
    debugBuffer = (debugBuffer + String(chunk)).slice(-65536);
    const text = debugBuffer;
    if (text.includes('fetchUtilization: GET /api/oauth/usage')) diagnostics.fetchAttempted = true;
    if (text.includes('Usage fetch returned a fieldless')) diagnostics.fieldlessResponse = true;
    if (text.includes('Failed to load usage data')) diagnostics.failed = true;
    const code = text.match(/status(?: code)?\D{0,12}(\d{3})/i); if (code) diagnostics.httpStatus = Number(code[1]);
    if (/session expired|could not be refreshed/i.test(text)) diagnostics.authExpired = true;
    for (const word of ['429', '401', '403', 'EPERM', 'EACCES', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'rate_limit_error', 'authentication_error', 'AxiosError', 'Auth error', 'fieldless', 'snapshot']) if (text.includes(word)) diagnostics[word] = true;
    if (text.includes('fetchUtilization: 200')) diagnostics.httpSuccess = true;
  });
  try { return await readClaudeUsage(child); } catch (error) { if (diagnose) await new Promise(resolve => setTimeout(resolve, 200)); error.usageDiagnostic = { ...error.usageDiagnostic, ...diagnostics }; throw error; } finally { child.kill(); }
}
async function readCodex() {
  const child = start(codexExe, ['app-server', '--listen', 'stdio://'], 'codex');
  const rpc = new JsonRpcProcess(child, { request: async () => { throw new Error('No actions allowed during usage verification.'); } });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'exomina_usage_verification', version: '0.4.0' } }, 15_000);
    rpc.send({ method: 'initialized', params: {} });
    return await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }, 15_000);
  } finally { rpc.close(); }
}
if (process.argv.includes('--poll')) {
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const seen = {}, counts = { claude: 0, codex: 0 };
  const tracker = new UsageTracker({ onUpdate: entries => {
    for (const [provider, entry] of Object.entries(entries)) if (entry.updatedAt && entry.updatedAt !== seen[provider]) {
      seen[provider] = entry.updatedAt; counts[provider]++;
      console.log(JSON.stringify({ provider, reading: counts[provider], usage: entry }));
    }
    if (Object.values(counts).every(count => count >= 2)) complete();
  } });
  const poller = new UsagePoller({ tracker, connected: () => true, providers: { claudeUsage: readClaude, codexUsage: readCodex } });
  const deadline = setTimeout(() => { process.exitCode = 1; complete(); }, 90_000);
  poller.start(); await done; poller.stop(); clearTimeout(deadline);
  console.log(JSON.stringify({ periodicReadings: counts, passed: Object.values(counts).every(count => count >= 2) }));
} else {
const results = await Promise.allSettled([readClaude().then(claudeUsage), readCodex().then(codexUsage)]);
for (let i = 0; i < results.length; i++) {
  const result = results[i];
  // Only normalized limit windows are ever printed, never native account/session payloads.
  console.log(JSON.stringify({ provider: i ? 'codex' : 'claude', ...(result.status === 'fulfilled' ? { usage: result.value } : { error: String(result.reason.message).replace(/(token|authorization)\S*/gi, '[redacted]').slice(0, 200), diagnostic: result.reason.usageDiagnostic }) }));
}
if (results.some(result => result.status === 'rejected' || !result.value?.windows?.length)) process.exitCode = 1;
}
