import path from 'node:path';

// Windows paths compare without case. Keep case on Unix, including macOS:
// APFS may be case-sensitive, and a path boundary must not widen by guessing.
export function normalizedPath(value, { platform = process.platform, pathApi = path } = {}) {
  const resolved = pathApi.resolve(value);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function pathsEqual(a, b, options) {
  return normalizedPath(a, options) === normalizedPath(b, options);
}

export function pathWithin(root, candidate, options = {}) {
  const p = options.pathApi || path;
  const parent = normalizedPath(root, options), target = normalizedPath(candidate, options);
  return target === parent || target.startsWith(parent.endsWith(p.sep) ? parent : parent + p.sep);
}
