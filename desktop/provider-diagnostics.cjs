// Preloaded into Windows providers without changing their official files.
// An outer hidden process does not hide consoles started inside the runtime.
// Keep background children hidden by default and preserve explicit GUI opens.
const cp = require('node:child_process');
const {promisify} = require('node:util');
const original = cp.exec;
const execute = promisify(original);
const executeFile = promisify(cp.execFile);
const diagnostic = /^%windir%\\(?:System32|sysnative)\\REG\.exe QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography \/v MachineGuid$/i;
// This is the machine-ID helper in the pinned Claude 2.1.289 distribution.
// Requiring its caller as well as its exact command keeps ordinary tools,
// including a user's own registry command, on the original execution path.
const detectorCaller = /\bB:[\\/]~BUN[\\/]root[\\/]chunk-8enjdnr4\.js:\d+:\d+/;

function hiddenOptions(options) {
  if (options != null && (typeof options !== 'object' || Array.isArray(options))) return options;
  return {...options, windowsHide: options?.windowsHide ?? true};
}
function commandCall(call, receiver, args) {
  const values = [...args];
  if (typeof values[1] === 'function') values.splice(1, 0, hiddenOptions());
  else values[1] = hiddenOptions(values[1]);
  return Reflect.apply(call, receiver, values);
}
function fileCall(call, receiver, args) {
  const values = [...args];
  const index = Array.isArray(values[1]) ? 2 : 1;
  if (typeof values[index] === 'function') values.splice(index, 0, hiddenOptions());
  else values[index] = hiddenOptions(values[index]);
  return Reflect.apply(call, receiver, values);
}

function exec(...args) { return commandCall(original, this, args); }
exec[promisify.custom] = function(command, ...args) {
  if (process.platform === 'win32' && typeof command === 'string' && diagnostic.test(command) && detectorCaller.test(new Error().stack || '')) {
    return Promise.resolve({stdout: '', stderr: ''});
  }
  return commandCall(execute, this, [command, ...args]);
};
if (process.platform === 'win32') {
  cp.exec = exec;
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    const call = cp[name];
    cp[name] = function(...args) { return fileCall(call, this, args); };
  }
  cp.execFile[promisify.custom] = function(...args) { return fileCall(executeFile, this, args); };
  const callSync = cp.execSync;
  cp.execSync = function(...args) { return commandCall(callSync, this, args); };
  // Node ESM providers import child_process by name. Bun's compiled Claude
  // accesses the same CommonJS object and does not implement this Node method.
  if (!process.versions.bun) require('node:module').syncBuiltinESMExports();
}
