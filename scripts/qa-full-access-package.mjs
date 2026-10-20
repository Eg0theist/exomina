import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { extractFile } from '@electron/asar';

// Reads only public source/package files and the explicit verification reports.
// No application launch, user profile, account store or cleanup operation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.resolve(root, '../Workspace/codex-full-access-20261010');
const build = path.resolve(process.argv[2] || path.join(work, 'stage/win-unpacked'));
const archive = path.join(build, 'resources/app.asar');
const unpacked = archive + '.unpacked';
const staged = path.join(work, 'stage/win-unpacked');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { build: JSON.parse(await readFile(path.join(build, 'exomina.build.json'), 'utf8')), buildPath: build, files: [], checks: {}, limitations: [] };
await mkdir(work, { recursive: true });

async function filesIn(directory, relative = '') {
  const rows = [];
  for (const item of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    assert.equal(item.isSymbolicLink(), false, 'Source artifact traversal must not follow links.');
    const name = path.join(relative, item.name);
    if (item.isDirectory()) rows.push(...await filesIn(directory, name));
    else if (item.isFile()) rows.push(name);
  }
  return rows;
}

for (const directory of ['desktop', 'dist']) {
  for (const file of await filesIn(path.join(root, directory))) {
    // electron-builder excludes Python bytecode caches from the application.
    if (directory === 'desktop' && (file.split(path.sep).includes('__pycache__') || file.endsWith('.pyc'))) continue;
    const relative = path.join(directory, file), source = await readFile(path.join(root, relative));
    const packaged = directory === 'desktop' ? await readFile(path.join(unpacked, relative)) : extractFile(archive, relative);
    assert.ok(source.equals(packaged), `${relative} differs from the final source.`);
    report.files.push({ file: relative.replaceAll('\\', '/'), sha256: hash(source), bytes: source.length });
  }
}
for (const file of ['README.md', 'package.json', 'scripts/install-windows.ps1']) {
  const bytes = await readFile(path.join(root, file));
  const packaged = extractFile(archive, path.normalize(file));
  if (file === 'package.json') {
    // The builder removes build scripts/dev dependencies from runtime metadata.
    const source = JSON.parse(bytes), runtime = JSON.parse(packaged);
    for (const field of ['name', 'version', 'private', 'description', 'author', 'type', 'main', 'dependencies']) assert.deepEqual(runtime[field], source[field], `Runtime ${field} differs from source.`);
  } else assert.ok(bytes.equals(packaged), `${file} differs from source.`);
  report.files.push({ file, sha256: hash(packaged), bytes: packaged.length });
}
for (const file of ['scripts/install-windows.ps1', 'desktop/updates.mjs', 'desktop/update-runner.ps1', 'desktop/update-launcher.cjs', 'desktop/app-paths.mjs']) {
  const installed = await readFile(path.resolve(root, '../App/resources/app.asar.unpacked', file));
  assert.ok(installed.equals(await readFile(path.join(unpacked, file))), `${file} changed from the installed, verified updater.`);
}
report.checks.updaterAndInstallerMatchInstalledBaseline = true;
const { codexPolicy } = await import(pathToFileURL(path.join(unpacked, 'desktop/permissions.mjs')).href);
assert.equal(codexPolicy('full').sandbox, 'danger-full-access');
assert.equal(codexPolicy('full').approvalPolicy, 'on-request');
assert.equal(codexPolicy('read-only').approvalPolicy, 'never');
report.checks.fullAndReadOnlyPolicies = true;
for (const [file, key] of [
  [path.join(work, 'native-packaged-result.json'), 'native'],
  [path.resolve(root, '../Workspace/native-approval-verification/packaged-native-approvals-qa.json'), 'hostAndUi'],
]) {
  const evidence = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(evidence.passed, true, `${key} verification has not passed.`);
  if (key === 'native') assert.equal(evidence.build.id, report.build.id);
  else {
    // After promotion, confirm the archive is byte-identical to the one used
    // by the hidden production-host/renderer verification.
    assert.equal(hash(await readFile(evidence.runtimeRoot)), hash(await readFile(archive)));
  }
  report.checks[key] = { report: file, checkCount: Object.keys(evidence.checks).length, passed: evidence.passed };
}
const logBytes = await readFile(path.join(work, 'tests-final.log'));
const log = logBytes.toString(logBytes[0] === 255 && logBytes[1] === 254 ? 'utf16le' : 'utf8');
assert.ok(/tests 785/.test(log), 'Final suite count must be 785.');
assert.ok(/pass 785/.test(log), 'All final tests must pass.');
assert.ok(/fail 0/.test(log), 'Final test failures must be zero.');
report.checks.nodeTests = { passed: 785, failed: 0 };
for (const file of ['Exomina.exe', 'resources/app.asar', 'resources/app.asar.unpacked/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe']) {
  const bytes = await readFile(path.join(build, file));
  assert.equal(hash(bytes), hash(await readFile(path.join(staged, file))), `${file} differs from the verified stage.`);
  report.files.push({ file, sha256: hash(bytes), bytes: bytes.length });
}
report.limitations = [
  'Packaged host/UI use synthetic native requests; no real risky command or cleanup was executed.',
  'The signed-out native probe verifies fresh policy acceptance. Metadata-only threads have no rollout, so real resumed effective policy remains a live check.',
  'Installation and a new native turn are required. The current running session still uses approvals never.',
];
report.passed = true; report.completedAt = new Date().toISOString();
const output = path.join(work, path.resolve(build) === path.resolve(root, 'release/win-unpacked') ? 'published-package-verification.json' : 'stage-package-verification.json');
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, build: report.build, filesVerified: report.files.length, output }));
