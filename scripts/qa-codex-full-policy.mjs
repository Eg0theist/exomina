// Official bundled Codex only, in a fresh synthetic home. No account read,
// login, model turn, shell tool, deletion or personal provider configuration.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { JsonRpcProcess } from '../desktop/providers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = process.argv[2] ? path.resolve(process.argv[2]) : null;
const runtimeRoot = build ? path.join(build, 'resources/app.asar.unpacked') : root;
const runtime = path.join(runtimeRoot, 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const evidenceRoot = path.resolve(root, '../Workspace/codex-full-access-20261010');
await mkdir(evidenceRoot, { recursive: true });
const output = await mkdtemp(path.join(evidenceRoot, build ? 'native-package-' : 'native-source-'));
const home = path.join(output, 'synthetic-home'), workspace = path.join(output, 'workspace');
const codexHome = path.join(home, 'codex-home'), schemas = path.join(output, 'schemas');
const temp = path.join(output, 'runtime-tmp');
await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(workspace), mkdir(temp), mkdir(path.join(home, 'AppData/Roaming'), { recursive: true }), mkdir(path.join(home, 'AppData/Local'), { recursive: true })]);
assert.deepEqual(await readdir(codexHome), [], 'The test must start with a completely fresh Codex home.');

// Build a small Windows execution environment instead of inheriting provider
// credentials, auth hints, proxy credentials or personal profile locations.
const systemKeys = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.has(key.toUpperCase())));
Object.assign(env, {
  CODEX_HOME: codexHome, HOME: home, USERPROFILE: home,
  APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
  XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
  TEMP: temp, TMP: temp, TMPDIR: temp, OTEL_SDK_DISABLED: 'true', OTEL_NODE_RESOURCE_DETECTORS: 'none',
});
for (const key of Object.keys(env)) assert.ok(!/(?:token|secret|password|api_?key|credential|authorization)/i.test(key), 'Credentials cannot be inherited by native metadata QA.');

const report = {
  startedAt: new Date().toISOString(), output, runtime, runtimeRoot,
  scope: 'Unmodified bundled Codex app-server; fresh synthetic home; generated native schemas and local thread metadata only. No account/read, login, model turn, shell execution, deletion, personal account stores or native policy file changes.',
  checks: {}, requests: [], limitations: [
    'Signed-out thread metadata acceptance does not prove a live dangerous-command approval or subsequent execution.',
    'No model turn, native tool command, cleanup deletion or personal runtime state was exercised.',
    'Matching source explains policy decisions; it is not a newly captured trace of the earlier rejected cleanup.',
  ],
};
let rpc, child;
const digest = value => createHash('sha256').update(value).digest('hex');
const runNative = args => {
  const result = spawnSync(runtime, args, { cwd: workspace, env, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};
const scalarVariants = definition => definition?.enum || definition?.oneOf?.flatMap(value => value.enum || []) || [];
const safeResponse = response => ({
  threadId: response.thread?.id, status: response.thread?.status,
  cwd: response.cwd, sandbox: response.sandbox, approvalPolicy: response.approvalPolicy,
  approvalsReviewer: response.approvalsReviewer, activePermissionProfile: response.activePermissionProfile,
});

try {
  report.runtimeVersion = runNative(['--version']);
  assert.match(report.runtimeVersion, /0\.160\.1\b/);
  report.runtimeSha256 = digest(await readFile(runtime));
  if (build) {
    report.build = JSON.parse(await readFile(path.join(build, 'exomina.build.json'), 'utf8'));
    assert.equal(report.runtimeSha256, digest(await readFile(path.join(root, 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'))));
    report.checks.packagedRuntimeMatchesSource = true;
  }
  runNative(['app-server', 'generate-json-schema', '--experimental', '--out', schemas]);
  const schemaEvidence = {};
  for (const name of ['ThreadStartParams', 'ThreadResumeParams', 'TurnStartParams', 'ThreadStartResponse', 'ThreadResumeResponse']) {
    const filename = path.join(schemas, 'v2', name + '.json');
    const bytes = await readFile(filename), schema = JSON.parse(bytes);
    assert.ok(schema.properties.approvalPolicy, name + ' exposes approvalPolicy');
    assert.ok(schema.properties.approvalsReviewer, name + ' exposes approvalsReviewer');
    assert.ok(scalarVariants(schema.definitions.AskForApproval).includes('on-request'), name + ' permits on-request');
    assert.ok(scalarVariants(schema.definitions.ApprovalsReviewer).includes('user'), name + ' permits the user reviewer');
    if (name === 'TurnStartParams') {
      assert.ok(schema.definitions.SandboxPolicy.oneOf.some(value => value.properties?.type?.enum?.includes('dangerFullAccess')));
    } else if (name.endsWith('Params')) {
      assert.ok(scalarVariants(schema.definitions.SandboxMode).includes('danger-full-access'));
    }
    schemaEvidence[name] = { file: filename, sha256: digest(bytes), required: schema.required || [], nativeApprovalPolicies: scalarVariants(schema.definitions.AskForApproval), nativeReviewers: scalarVariants(schema.definitions.ApprovalsReviewer) };
  }
  report.checks.nativeSchemas = schemaEvidence;

  const moduleUrl = name => pathToFileURL(path.join(runtimeRoot, name)).href;
  const { codexPolicy } = await import(moduleUrl('desktop/permissions.mjs'));
  const { codexPermissions, permissionDifferences } = await import(moduleUrl('desktop/codex-permissions.mjs'));
  const selected = codexPolicy('full');
  assert.deepEqual({ sandbox: selected.sandbox, approvalPolicy: selected.approvalPolicy, sandboxPolicy: selected.sandboxPolicy }, {
    sandbox: 'danger-full-access', approvalPolicy: 'on-request', sandboxPolicy: { type: 'dangerFullAccess' },
  });
  report.checks.selectedExominaPolicy = selected;

  const notifications = [], nativeRequests = [];
  child = spawn(runtime, ['app-server', '--listen', 'stdio://'], { cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  rpc = new JsonRpcProcess(child, {
    request: (method) => { nativeRequests.push(method); throw Error('Native actions are prohibited in metadata-only QA.'); },
    notification: method => { notifications.push(method); },
  });
  const allowedMethods = new Set(['initialize', 'thread/start', 'thread/resume', 'thread/read']);
  const request = async (method, params) => {
    assert.ok(allowedMethods.has(method), 'Only local metadata methods are allowed.');
    report.requests.push({ method, ...(method.startsWith('thread/') ? { approvalPolicy: params.approvalPolicy, sandbox: params.sandbox, approvalsReviewer: params.approvalsReviewer } : {}) });
    return rpc.request(method, params, 20000);
  };
  await request('initialize', { clientInfo: { name: 'exomina-full-policy-qa', title: 'Exomina isolated permission QA', version: '0.5.0' }, capabilities: { experimentalApi: true } });
  rpc.send({ method: 'initialized', params: {} });
  const params = approvalPolicy => ({
    cwd: workspace, sandbox: 'danger-full-access', approvalPolicy, approvalsReviewer: 'user',
    dynamicTools: [], modelProvider: 'openai',
    config: { projects: { [workspace]: { trust_level: 'trusted' } } },
  });
  const old = await request('thread/start', params('never'));
  assert.deepEqual(permissionDifferences(old, codexPermissions(workspace, { ...selected, approvalPolicy: 'never' })), []);
  report.checks.oldFullThreadStart = safeResponse(old);

  const fresh = await request('thread/start', params('on-request'));
  assert.deepEqual(permissionDifferences(fresh, codexPermissions(workspace, selected)), []);
  assert.equal(fresh.thread?.status?.type, 'idle');
  report.checks.newFullThreadStart = safeResponse(fresh);

  // Threads without a first turn have no persisted rollout in this runtime.
  // Test the supported ID-based request and document that boundary instead of
  // fabricating a rollout or using the cloud-only history override.
  const resumeOutcomes = [];
  for (const [initialPolicy, started] of [['never', old], ['on-request', fresh]]) {
    try {
      const resumed = await request('thread/resume', { ...params('on-request'), threadId: started.thread.id, excludeTurns: true });
      assert.equal(resumed.thread.id, started.thread.id);
      assert.deepEqual(permissionDifferences(resumed, codexPermissions(workspace, selected)), []);
      resumeOutcomes.push({ initialPolicy, effective: safeResponse(resumed), passed: true });
    } catch (error) {
      assert.match(error.message, /no rollout found for thread id/);
      assert.doesNotMatch(error.message, /invalid params|unknown (?:field|variant)|on-request|approvalPolicy|approvalsReviewer|sandbox/i);
      resumeOutcomes.push({ initialPolicy, outcome: 'Accepted request reaches missing-rollout lookup.', error: error.message, effectiveSettingsVerified: false });
    }
  }
  report.checks.nativeResumeRequests = resumeOutcomes;
  if (resumeOutcomes.some(value => !value.passed)) report.limitations.push('Native ID-based resume reaches rollout lookup, but a metadata-only thread has no rollout. Returned resumed settings remain unverified here; no synthetic native history or model turn was fabricated to avoid that boundary.');
  assert.equal(Array.isArray(fresh.thread.turns) ? fresh.thread.turns.length : 0, 0, 'No inference or tool turn may occur.');
  assert.deepEqual(nativeRequests, [], 'No native actions were requested.');
  assert.equal(notifications.some(method => method.startsWith('turn/') || method.startsWith('item/')), false);
  report.checks.noTurnsOrNativeActions = { threadTurns: 0, nativeRequests, notifications };

  const sourcePath = path.resolve(root, '../Workspace/codex-policy-source-01601/codex-rs/core/src/exec_policy.rs');
  const sourceBytes = await readFile(sourcePath), source = sourceBytes.toString('utf8');
  const dangerousStart = source.indexOf('if dangerous_command_match.is_some() || windows_managed_fs_restrictions_without_sandbox_backend');
  const sourceEnd = source.indexOf('AskForApproval::Granular(_) => match file_system_sandbox_policy.kind', dangerousStart);
  assert.ok(dangerousStart >= 0 && sourceEnd > dangerousStart);
  const decisionBranch = source.slice(dangerousStart, sourceEnd);
  assert.match(decisionBranch, /AskForApproval::Never => Decision::Forbidden/);
  assert.match(decisionBranch, /AskForApproval::OnRequest[\s\S]*?=> Decision::Prompt/);
  assert.match(decisionBranch, /AskForApproval::OnRequest =>[\s\S]*?FileSystemSandboxKind::Unrestricted[\s\S]*?Decision::Allow/);
  report.checks.matchingSourceDecision = {
    sourcePath, sha256: digest(sourceBytes), firstLine: source.slice(0, dangerousStart).split('\n').length,
    sourceDecision: { dangerousWithNever: 'Forbidden', dangerousWithOnRequest: 'Prompt', ordinaryUnrestrictedWithOnRequest: 'Allow' },
    evidence: decisionBranch,
    note: 'Read-only matching release source. No source program or dangerous command was executed.',
  };
  assert.equal((await readdir(codexHome)).some(name => /^(auth\.json|config\.toml)$/i.test(name)), false, 'No sign-in or native policy file is created by this QA script.');
  report.checks.freshSyntheticProfile = { home, codexHome, initialFiles: [], authenticationSupplied: false, accountReadRequested: false, credentialVariablesInherited: false };
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
} finally {
  rpc?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(evidenceRoot, build ? 'native-packaged-result.json' : 'native-source-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, output, runtimeVersion: report.runtimeVersion, checks: Object.keys(report.checks), error: report.error, limitations: report.limitations }, null, 2));
}
