import path from 'node:path';

const CODEX_TARGETS = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
};

// Matches the pinned official @openai/codex loader's platform package names.
// Selecting a path never asserts that the native file was bundled or verified.
export function codexRuntimePaths(root, { platform = process.platform, arch = process.arch, pathApi = path } = {}) {
  const target = CODEX_TARGETS[`${platform}-${arch}`];
  if (!target) return [];
  const binary = platform === 'win32' ? 'codex.exe' : 'codex';
  const base = pathApi.join(root, 'node_modules', '@openai', `codex-${platform}-${arch}`, 'vendor', target);
  return [pathApi.join(base, 'bin', binary), pathApi.join(base, 'codex', binary)];
}

export function bundledGrokPaths(root, { platform = process.platform, arch = process.arch, pathApi = path } = {}) {
  if (!CODEX_TARGETS[`${platform}-${arch}`]) return [];
  const binary = platform === 'win32' ? 'grok.exe' : 'grok';
  // Every npm platform package holds a compressed .br artifact. Only the
  // checksum-verified preparation step creates an executable in vendor.
  return [pathApi.join(root, 'vendor', 'grok', binary)];
}

export function bundledCuaPath(root, { platform = process.platform, pathApi = path } = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error('Cua Driver is unavailable on this operating system.');
  if (platform === 'darwin') return pathApi.join(root, 'vendor', 'cua-driver', 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver');
  return pathApi.join(root, 'vendor', 'cua-driver', platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
}

export function bundledPythonPath(root, { platform = process.platform, pathApi = path } = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error('The export reader is unavailable on this operating system.');
  return platform === 'win32'
    ? pathApi.join(root, 'vendor', 'python', 'python.exe')
    : pathApi.join(root, 'vendor', 'python', 'bin', 'python3');
}
