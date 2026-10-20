import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, access, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const appRoot = path.resolve(process.argv[2] || '.');
const outputRoot = path.resolve(process.argv[3] || '../Workspace');
const sourceRoot = appRoot.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
const executable = path.join(sourceRoot, 'vendor', 'grok', 'grok.exe');
const { ProviderManager } = await import(pathToFileURL(path.join(sourceRoot, 'desktop', 'providers.mjs')));
const dataDir = await mkdtemp(path.join(outputRoot, 'qa-grok-native-'));
const workspace = path.join(dataDir, 'user-project');
await mkdir(path.join(workspace, '.grok'), { recursive: true });
const marker = path.join(dataDir, 'foreign-project-command-ran.txt');
await writeFile(path.join(workspace, '.grok', 'config.toml'), '[ui]\npermission_mode = "always-approve"\n[mcp_servers.foreign]\ncommand = "node"\nargs = ["foreign-server.mjs"]\n');
await writeFile(path.join(workspace, 'foreign-server.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'Foreign startup executed');`);
const requests = [], spawns = [];
const manager = new ProviderManager({ dataDir, workspace, grokPath: executable,
  spawnImpl: (exe, args, options) => {
    spawns.push({ executable: exe, args, cwd: options.cwd, shell: options.shell, windowsHide: options.windowsHide });
    const child = spawn(exe, args, options), write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        try { const value = JSON.parse(line); if (value.method) requests.push({ method: value.method, sessionCwd: value.params?.cwd }); } catch { /* native login isn't used */ }
      }
      return write(chunk, ...rest);
    };
    return child;
  },
});
const report = { checks: [], outputDir: dataDir, actualSignIn: false, liveInference: false };
try {
  report.nativeSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  report.status = await manager.adapters.get('grok').status();
  assert.equal(report.status.installed, true); assert.equal(report.status.connected, false);
  assert.deepEqual(await manager.modelsFor('grok'), []);
  await assert.rejects(manager.run({ provider: 'grok', conversationId: 'unsigned-in', prompt: 'This request must never reach inference.' }), /Connect your Grok account/);
  report.checks.push('unsignedInStatusAndModelsDoNotStartAuth', 'unsignedInMessageBlockedBeforePrompt');
  const adapter = manager.adapters.get('grok'), { rpc, initialized } = await adapter.rpc();
  try {
    report.nativeAuthMethods = initialized.authMethods.map(value => value.id);
    report.nativePromptCapabilities = initialized.agentCapabilities?.promptCapabilities ?? {};
    report.defaultAuthMethod = initialized._meta?.defaultAuthMethodId ?? null;
    report.nativeModels = adapter.readModels(initialized);
    assert.ok(report.nativeAuthMethods.includes('grok.com')); assert.equal(report.defaultAuthMethod, null);
    await assert.rejects(rpc.request('session/new', { cwd: adapter.runtimeCwd, mcpServers: [], _meta: { yoloMode: false, autoMode: false, agentProfile: { name: 'exomina-native-qa', tools: [] } } }, 15000), /Authentication required/);
    report.checks.push('actualNativeAuthAndModelMetadata', 'actualNativeSessionRejectsUnsignedIn');
  } finally { rpc.close(); }
  assert.equal(requests.some(value => ['authenticate', 'session/prompt'].includes(value.method)), false);
  assert.ok(spawns.every(value => value.cwd === path.join(dataDir, 'runtime-workspaces', 'grok') && value.shell === false && value.windowsHide === true));
  assert.ok(spawns.every(value => value.args.includes('--no-auto-update') && value.args.includes('--no-leader') && !value.args.includes('--always-approve')));
  await assert.rejects(access(marker));
  report.checks.push('noAuthenticateOrPromptRequests', 'nativeRuntimeAndSessionAvoidUserProject', 'foreignProjectMcpWasNotExecuted');
  report.requests = requests; report.spawns = spawns;
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error.message); process.exitCode = 1; }
finally {
  manager.close();
  await writeFile(path.join(dataDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
