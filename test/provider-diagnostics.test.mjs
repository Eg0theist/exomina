import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const providerDir = process.env.EXOMINA_DIAGNOSTIC_MODULE_DIR || path.join(root, 'desktop');
const { subscriptionEnvironment } = await import(pathToFileURL(path.join(providerDir, 'providers.mjs')).href);
const { CLAUDE_USAGE_ARGS, claudeUsageEnvironment } = await import(pathToFileURL(path.join(providerDir, 'provider-usage.mjs')).href);
const nativeRuntime = process.env.EXOMINA_DIAGNOSTIC_NATIVE_RUNTIME || path.join(root, 'node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe');
const compiler = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
const available = process.platform === 'win32' && fs.existsSync(nativeRuntime) && fs.existsSync(compiler);
const registryCommand = '%windir%\\System32\\REG.exe QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid';
const bunPath = value => value.replaceAll('\\', '/').replace(/([\s"'\\])/g, '\\$1');

function mockPreload(platform = 'win32') {
  const calls = [], child = { fixture: 'original-child' }, result = Buffer.from('original-sync-result');
  const cp = {};
  for (const name of ['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync', 'fork']) {
    cp[name] = function(...args) {
      calls.push({ name, args, receiver: this });
      const callback = args.at(-1);
      if (typeof callback === 'function') callback(null, 'original-stdout', 'original-stderr');
      return name.endsWith('Sync') ? result : child;
    };
    if (name === 'exec' || name === 'execFile') {
      cp[name][promisify.custom] = function(...args) {
        calls.push({ name: `${name}:promise`, args, receiver: this });
        const promise = Promise.resolve({ stdout: 'original-stdout', stderr: 'original-stderr' });
        promise.child = child;
        return promise;
      };
    }
  }
  let esmSyncs = 0;
  const sandbox = {
    require(name) {
      if (name === 'node:child_process') return cp;
      if (name === 'node:util') return { promisify };
      if (name === 'node:module') return { syncBuiltinESMExports() { esmSyncs++; } };
      throw new Error(`Unexpected preload dependency: ${name}`);
    },
    process: { platform, versions: {} }, Error, Reflect, Promise,
  };
  vm.runInNewContext(fs.readFileSync(path.join(providerDir, 'provider-diagnostics.cjs'), 'utf8'), sandbox, { filename: 'trusted-provider-preload.cjs' });
  return { cp, calls, child, result, esmSyncs };
}

test('provider child-process defaults hide all background API variants and preserve options', () => {
  const { cp, calls, child, result, esmSyncs } = mockPreload();
  assert.equal(esmSyncs, 1, 'Node named child_process exports must receive the wrappers');
  for (const name of ['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync', 'fork']) {
    const isCommand = name === 'exec' || name === 'execSync';
    const argv = ['literal argument', 'second'];
    const controller = new AbortController();
    const options = { cwd: 'synthetic-cwd', env: { SYNTHETIC_VALUE: 'preserved' }, encoding: 'buffer', signal: controller.signal, input: Buffer.from('preserved-input') };
    for (const flag of ['omitted', true, false, null]) {
      const input = { ...options };
      if (flag !== 'omitted') input.windowsHide = flag;
      const before = { ...input };
      const output = isCommand ? cp[name]('synthetic-command', input) : cp[name]('synthetic-file', argv, input);
      assert.equal(output, name.endsWith('Sync') ? result : child, `${name} keeps the original result`);
      const call = calls.at(-1), received = call.args[isCommand ? 1 : 2];
      assert.equal(received.windowsHide, flag === false ? false : true, `${name}, windowsHide=${flag}`);
      for (const key of Object.keys(options)) assert.equal(received[key], options[key], `${name} preserves ${key}`);
      assert.deepEqual(input, before, `${name} must not mutate options`);
      if (!isCommand) assert.equal(call.args[1], argv, `${name} preserves argument array`);
    }
    cp[name]('synthetic-file');
    const args = calls.at(-1).args;
    assert.equal(args.find(value => value && typeof value === 'object' && !Array.isArray(value)).windowsHide, true, `${name} omitted options`);
    if (!isCommand) {
      cp[name]('synthetic-file', { ...options });
      assert.equal(calls.at(-1).args.find(value => value && typeof value === 'object' && !Array.isArray(value)).windowsHide, true, `${name} options-only signature`);
    }
  }
});

test('provider exec callback overloads retain callback identity and both output streams', () => {
  const { cp, calls, child } = mockPreload();
  const cases = [
    ['exec', ['synthetic-command']],
    ['exec', ['synthetic-command', { cwd: 'synthetic-cwd' }]],
    ['execFile', ['synthetic-file']],
    ['execFile', ['synthetic-file', ['literal']]],
    ['execFile', ['synthetic-file', { cwd: 'synthetic-cwd' }]],
    ['execFile', ['synthetic-file', ['literal'], { cwd: 'synthetic-cwd' }]],
  ];
  for (const [name, prefix] of cases) {
    let output;
    const callback = (...args) => { output = args; };
    assert.equal(cp[name](...prefix, callback), child);
    assert.equal(calls.at(-1).args.at(-1), callback, `${name} callback identity`);
    assert.deepEqual(output, [null, 'original-stdout', 'original-stderr']);
    assert.equal(calls.at(-1).args.find(value => value && typeof value === 'object' && !Array.isArray(value)).windowsHide, true);
  }
});

test('provider promisified exec and execFile retain streams, child handles and hidden defaults', async () => {
  const { cp, calls, child } = mockPreload();
  for (const name of ['exec', 'execFile']) {
    const options = { cwd: 'synthetic-cwd', windowsHide: null, encoding: 'buffer' };
    const run = promisify(cp[name]);
    const promise = name === 'exec' ? run('synthetic-command', options) : run('synthetic-file', ['literal'], options);
    assert.equal(promise.child, child, `${name} promised child handle`);
    assert.deepEqual(await promise, { stdout: 'original-stdout', stderr: 'original-stderr' });
    const received = calls.at(-1).args.find(value => value && typeof value === 'object' && !Array.isArray(value));
    assert.equal(received.windowsHide, true); assert.equal(received.cwd, options.cwd); assert.equal(received.encoding, options.encoding);
    assert.equal(options.windowsHide, null);
  }
});

test('native Claude suppresses only its optional MachineGuid detector and keeps ordinary shell calls', { skip: !available, timeout: 25000 }, async () => {
  const knownWorkspace = 'C:/Program Files/Exomina/Workspace';
  const base = process.env.EXOMINA_DIAGNOSTIC_PROBE_DIR || (fs.existsSync(knownWorkspace) ? knownWorkspace : path.join(root, '.verification'));
  const probeRoot = path.join(base, `provider-diagnostics-native-${randomUUID()}`);
  fs.mkdirSync(probeRoot, { recursive: true });
  const windows = path.join(probeRoot, 'synthetic-windows');
  const shim = path.join(probeRoot, 'cmd.exe');
  const fakeHome = path.join(probeRoot, 'compile-home');
  const common = {
    SystemRoot: 'C:/Windows', SystemDrive: 'C:', OS: 'Windows_NT',
    PROCESSOR_ARCHITECTURE: 'AMD64', NUMBER_OF_PROCESSORS: '1', ProgramFiles: 'C:/Program Files',
    PATH: `${probeRoot};C:/Program Files/Git/cmd`, ComSpec: shim, windir: windows,
    HOME: fakeHome, USERPROFILE: fakeHome, APPDATA: path.join(fakeHome, 'AppData/Roaming'), LOCALAPPDATA: path.join(fakeHome, 'AppData/Local'),
    TEMP: path.join(probeRoot, 'compile-temp'), TMP: path.join(probeRoot, 'compile-temp'), USERNAME: 'synthetic-diagnostic-user',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const dir of [fakeHome, common.APPDATA, common.LOCALAPPDATA, common.TEMP, path.join(windows, 'System32'), path.join(windows, 'sysnative')]) fs.mkdirSync(dir, { recursive: true });
  execFileSync(compiler, ['/nologo', '/target:winexe', `/out:${shim}`, path.join(root, 'test/fixtures/provider-diagnostic-shell.cs')], { env: { ...common, windir: 'C:/Windows' }, cwd: probeRoot, windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  const shimBytes = fs.readFileSync(shim), peOffset = shimBytes.readUInt32LE(0x3c);
  assert.equal(shimBytes.readUInt16LE(peOffset + 4 + 20 + 68), 2, 'Synthetic shell must be a GUI PE that cannot create a console');
  assert.equal(execFileSync(shim, ['exomina-diagnostic-sentinel'], { env: common, cwd: probeRoot, windowsHide: true, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), 'synthetic-shell-forwarded');
  fs.copyFileSync(shim, path.join(windows, 'System32/REG.exe'));
  fs.copyFileSync(shim, path.join(windows, 'sysnative/cmd.exe'));

  function environment(name, baseline = false) {
    const data = path.join(probeRoot, name), home = path.join(data, 'home');
    for (const relative of ['home', 'home/AppData/Roaming', 'home/AppData/Local', 'runtime-tmp', 'claude-home', 'unrelated-cwd']) fs.mkdirSync(path.join(data, relative), { recursive: true });
    const env = claudeUsageEnvironment(subscriptionEnvironment('claude', data, { ...common, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local') }));
    if (baseline) delete env.BUN_OPTIONS;
    env.EXOMINA_DIAGNOSTIC_SHELL_LOG = path.join(data, 'shell.log');
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = path.join(data, 'claude-home');
    env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = path.join(data, 'empty-managed.json');
    env.CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION = '1';
    env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    fs.writeFileSync(env.CLAUDE_CODE_MANAGED_SETTINGS_PATH, '{}');
    return { env, cwd: path.join(data, 'unrelated-cwd'), data };
  }
  const records = [];
  async function initialize(name, baseline = false, selfTest = false) {
    const setup = environment(name, baseline), requestId = `synthetic-${name}`;
    if (selfTest) {
      setup.env.EXOMINA_DIAGNOSTIC_FORWARDING_FILE = path.join(setup.data, 'forwarding.json');
      const fixture = path.join(setup.data, 'forwarding.cjs');
      // Each synthetic process writes the same bounded log. Keep these checks
      // sequential; log contention is unrelated to child-process API behavior.
      fs.writeFileSync(fixture, `const cp=require('node:child_process');const {promisify}=require('node:util');const fs=require('node:fs');const run=promisify(cp.exec);(async()=>{const sentinel=await run('exomina-diagnostic-sentinel');const direct=await new Promise((resolve,reject)=>cp.exec(${JSON.stringify(registryCommand)},(e,stdout)=>e?reject(e):resolve({stdout})));const promised=await run(${JSON.stringify(registryCommand)});fs.writeFileSync(process.env.EXOMINA_DIAGNOSTIC_FORWARDING_FILE,JSON.stringify({sentinel:sentinel.stdout.trim(),direct:direct.stdout.includes('synthetic-machine-id'),promised:promised.stdout.includes('synthetic-machine-id')}));})();`);
      setup.env.BUN_OPTIONS += ` --preload ${bunPath(fixture)}`;
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(nativeRuntime, CLAUDE_USAGE_ARGS, { env: setup.env, cwd: setup.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '', stderr = '', success = false, ending = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${name}: isolated native initialization timed out`)); }, 8000);
      child.stdin.on('error', () => {});
      child.stderr.on('data', data => { stderr = (stderr + data).slice(0, 2000); });
      child.stdout.on('data', data => {
        buffer += data;
        if (buffer.length > 2 * 1024 * 1024) { child.kill(); reject(new Error('Oversized native initialization')); return; }
        let line;
        while ((line = buffer.indexOf('\n')) >= 0) {
          const text = buffer.slice(0, line); buffer = buffer.slice(line + 1);
          let message; try { message = JSON.parse(text); } catch { continue; }
          if (message.type === 'control_response' && message.response?.request_id === requestId) {
            success = message.response.subtype === 'success';
            if (!ending) { ending = true; setTimeout(() => child.stdin.end(), 500); }
          }
        }
      });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        const shellLog = fs.existsSync(setup.env.EXOMINA_DIAGNOSTIC_SHELL_LOG) ? fs.readFileSync(setup.env.EXOMINA_DIAGNOSTIC_SHELL_LOG, 'utf8') : '';
        const result = { name, code, success, registryCommands: shellLog.split('\n').filter(line => line.includes('/v MachineGuid')).length, sentinelCommands: shellLog.split('\n').filter(line => line.includes('exomina-diagnostic-sentinel')).length, stderr };
        if (selfTest && fs.existsSync(setup.env.EXOMINA_DIAGNOSTIC_FORWARDING_FILE)) result.forwarding = JSON.parse(fs.readFileSync(setup.env.EXOMINA_DIAGNOSTIC_FORWARDING_FILE, 'utf8'));
        records.push(result); fs.writeFileSync(path.join(probeRoot, 'report.json'), JSON.stringify(records, null, 2));
        resolve(result);
      });
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', hooks: null } }) + '\n');
    });
  }
  const baseline = await initialize('flags-only-baseline', true);
  assert.equal(baseline.code, 0); assert.equal(baseline.success, true);
  assert.equal(baseline.registryCommands, 1, 'The real native detector must reproduce through the fake shell');
  const patched = await initialize('final-host-preload');
  assert.equal(patched.code, 0); assert.equal(patched.success, true);
  assert.equal(patched.registryCommands, 0, 'The optional detector must not start its registry shell');
  const forwarding = await initialize('ordinary-command-forwarding', false, true);
  assert.equal(forwarding.code, 0); assert.equal(forwarding.success, true);
  assert.equal(forwarding.registryCommands, 2, 'Both ordinary identical commands must execute through the fake shell');
  assert.equal(forwarding.sentinelCommands, 1);
  assert.deepEqual(forwarding.forwarding, { sentinel: 'synthetic-shell-forwarded', direct: true, promised: true });
});
