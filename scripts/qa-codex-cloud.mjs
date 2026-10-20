// Hidden renderer and an isolated Git repository. No personal data or model calls.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CodexCloud } from '../desktop/codex-cloud.mjs';
const root = process.cwd(), output = path.resolve(process.argv[2] || '../Workspace/codex-cloud-audit-20261012/qa'), packaged = process.env.EXOMINA_QA_PACKAGED_ASAR;
await mkdir(output, { recursive: true });
const report = { scope: 'Synthetic backend and hidden renderer; isolated real Git diff application. No real cloud task submitted.', checks: {}, errors: [] };
const plugin = packaged ? { name: 'packaged-cloud-qa', configureServer(server) { server.middlewares.use((req, res, next) => {
  const pathname = new URL(req.url, 'http://localhost').pathname; if (!pathname.startsWith('/__cloud_package/')) return next();
  const relative = pathname.slice('/__cloud_package/'.length); if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) { res.statusCode = 400; return res.end(); }
  try { const bytes = extractFile(packaged, path.join('dist', relative)); res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' })[path.extname(relative)] || 'application/octet-stream'); res.end(relative === 'index.html' ? bytes.toString('utf8').replaceAll('./assets/', '/__cloud_package/assets/').replace('<head>', '<head><script type="module" src="/preview/mock-studio.mjs"></script>') : bytes); } catch { res.statusCode = 404; res.end(); }
}); } } : null;
const server = await createServer({ root, plugins: plugin ? [plugin] : [], server: { port: 0, hmr: false }, logLevel: 'error' }); await server.listen();
let app, cloud;
try {
  const repo = await mkdtemp(path.join(output, 'repository-'));
  const exec = promisify(execFile), git = async (...args) => exec('git', args, { cwd: repo, windowsHide: true });
  await git('init'); await git('config', 'core.autocrlf', 'false'); await writeFile(path.join(repo, 'file.txt'), 'before\n'); await git('add', 'file.txt'); await git('-c', 'user.name=Synthetic QA', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'Synthetic base');
  await writeFile(path.join(repo, 'file.txt'), 'after\n'); const patch = (await git('diff')).stdout; await writeFile(path.join(repo, 'file.txt'), 'before\n');
  const model = { state: {}, save: async () => {} }, calls = [];
  const provider = { requireProvider() {}, getCodex: async () => ({ request: async () => ({ account: { type: 'chatgpt' } }) }), executable: async () => process.execPath, stopChild: child => child.kill(), spawn(exe, args, provider, cwd) { calls.push({ exe, args }); return exe === 'git' ? spawn(exe, args, { cwd, windowsHide: true, shell: false }) : spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(patch)})`], { cwd, windowsHide: true, shell: false }); } };
  cloud = new CodexCloud({ providers: provider, store: model, getWorkspace: () => repo, validatePath: async file => { assert.equal(file, 'file.txt'); }, approve: async request => { assert.match(request.detail, /after/); return true; } });
  const applied = await cloud.apply({ taskId: 'task-synthetic', sha256: createHash('sha256').update(patch).digest('hex') }); assert.equal(applied.applied, true); assert.equal(await readFile(path.join(repo, 'file.txt'), 'utf8'), 'after\n'); report.checks.realGitAppliesReviewedBytes = true;
  assert.equal(calls.some(call => call.args[0] === 'cloud' && call.args[1] === 'apply'), false);
  const env = { ...process.env, EXOMINA_DESIGN_QA_URL: `http://localhost:${server.config.server.port}${packaged ? '/__cloud_package/index.html' : '/preview.html'}`, EXOMINA_DESIGN_QA_DIR: output }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(root, 'scripts/qa-design-main.cjs')], env }); const page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => report.errors.push(e.message));
  await page.getByRole('button', { name: 'Projects & prompts', exact: true }).waitFor();
  await page.evaluate(() => {
    const state = { connected: true, plan: 'pro', environments: [], submissions: [] }; let listing = false, error = false;
    window.__cloudTestState = { state, setListing: value => { listing = value; }, setError: value => { error = value; } };
    window.__exominaCloudQa = async (method, payload) => {
      if (method === 'codexCloud.info') return structuredClone(state);
      if (method === 'codexCloud.configure') { state.environments = state.environments.filter(item => item.id !== payload.id); if (!payload.remove) state.environments.push({ id: payload.id, name: payload.name }); return structuredClone(state); }
      if (method === 'codexCloud.list') { if (error) throw Error('Synthetic cloud network failure'); return { ...structuredClone(state), tasks: listing ? [{ id: 'task-synthetic', title: 'Fix the bug', status: 'completed', url: 'https://chatgpt.com/codex/tasks/task-synthetic', environmentId: 'env-test', environmentLabel: 'Project' }] : [], cursor: null }; }
      if (method === 'codexCloud.submit') { state.submissions.push({ requestId: payload.requestId, title: payload.prompt, status: 'submitted' }); listing = true; return { status: 'submitted' }; }
      if (method === 'codexCloud.status') return { taskId: payload.taskId, text: 'Completed: all checks passed.' };
      if (method === 'codexCloud.diff') return { taskId: payload.taskId, text: payload.offset ? 'second page' : 'first page', nextOffset: payload.offset ? null : 10, sha256: 'a'.repeat(64), totalCharacters: 21 };
      if (method === 'codexCloud.apply') return { applied: true, repository: 'Synthetic repository' };
      return {};
    };
  });
  await page.getByRole('button', { name: 'Projects & prompts', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Saved prompts', exact: true }).click(); await page.getByRole('button', { name: 'New saved prompt', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Scheduled tasks', exact: true }).click(); await page.getByRole('button', { name: 'New scheduled task', exact: true }).waitFor(); report.checks.existingWorkbenchTabs = true;
  await page.getByRole('tab', { name: 'Codex Cloud' }).click();
  await page.getByText('ChatGPT pro connected.', { exact: false }).waitFor(); await page.getByRole('button', { name: 'Load cloud tasks' }).click(); await page.getByText('No cloud tasks were returned.', { exact: false }).waitFor(); report.checks.emptyAndConnectedState = true;
  await page.getByRole('button', { name: 'Add environment', exact: true }).click(); await page.getByLabel('Cloud environment name').fill('Project'); await page.getByLabel('Cloud environment ID').fill('env-test'); await page.getByRole('button', { name: 'Save environment', exact: true }).click();
  await page.getByLabel('Cloud task environment').selectOption('env-test'); await page.getByLabel('Cloud task prompt').fill('Fix the bug and test it.'); await page.getByRole('button', { name: 'Review & start task', exact: true }).click(); await page.getByRole('heading', { name: 'Fix the bug', exact: true }).waitFor(); report.checks.environmentAndSubmission = true;
  await page.getByRole('button', { name: 'Check status', exact: true }).click(); await page.getByText('Completed: all checks passed.', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Close review', exact: true }).click(); report.checks.statusReview = true;
  await page.getByRole('button', { name: 'Review changes', exact: true }).click(); const apply = page.getByRole('button', { name: 'Review & apply locally', exact: true }); assert.equal(await apply.isDisabled(), true); await page.getByRole('button', { name: 'Load remaining changes' }).click(); assert.equal(await apply.isEnabled(), true); await apply.click(); await page.getByText('Applied to Synthetic repository.', { exact: false }).waitFor(); report.checks.paginatedReviewGatesApply = true;
  await page.evaluate(() => window.__cloudTestState.setError(true)); await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Synthetic cloud network failure' }).waitFor(); report.checks.errorsStayVisible = true;
  await page.getByText('Cloud storage and hosting', { exact: true }).click(); await page.getByText('This is not a permanent Exomina server', { exact: false }).waitFor(); report.checks.hostingLimitationVisible = true;
  await page.screenshot({ path: path.join(output, 'cloud-controls.png') });
  const data = await page.evaluate(() => window.__exominaPreviewCalls.filter(item => item.method.startsWith('codexCloud.'))); assert.ok(data.some(item => item.method === 'codexCloud.apply' && item.payload.sha256 === 'a'.repeat(64))); report.calls = data;
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (e) { report.errors.push(e.stack); process.exitCode = 1; }
finally { cloud?.close(); await app?.close(); await server.close(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed === true, checks: report.checks, errors: report.errors, output })); }
