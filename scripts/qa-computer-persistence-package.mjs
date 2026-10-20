import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { extractFile } from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'release', 'win-unpacked'), archive = path.join(build, 'resources', 'app.asar'), unpacked = archive + '.unpacked';
const installed = path.resolve(root, '../App/resources/app.asar.unpacked');
const output = path.resolve(root, '../Workspace/computer-use-persistence-20261010'); await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { build: JSON.parse(await readFile(path.join(build, 'exomina.build.json'), 'utf8')), archiveSha256: hash(await readFile(archive)), checks: {}, files: [], limitations: ['Installation into the running personal app remains pending until restart and Windows administrator approval.'] };
const changes = new Set(['main.mjs', 'external-mcp.mjs', 'computer-connection.mjs']);
async function files(directory, relative = '') {
  const names = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'Package audit must not follow links.');
    const name = path.join(relative, entry.name);
    if (entry.isDirectory() && entry.name !== '__pycache__') names.push(...await files(directory, name));
    else if (entry.isFile() && !entry.name.endsWith('.pyc')) names.push(name);
  }
  return names;
}
for (const directory of ['desktop', 'dist']) for (const file of await files(path.join(root, directory))) {
  const relative = path.join(directory, file), source = await readFile(path.join(root, relative));
  const packaged = directory === 'desktop' ? await readFile(path.join(unpacked, relative)) : extractFile(archive, relative);
  assert.ok(source.equals(packaged), relative + ' does not match Source.');
  if (directory === 'desktop' && !changes.has(file)) assert.ok(packaged.equals(await readFile(path.join(installed, directory, file))), relative + ' changed outside the computer-use implementation.');
  report.files.push({ file: relative.replaceAll('\\', '/'), bytes: source.length, sha256: hash(source) });
}
report.checks.hostAndRendererMatchSource = true; report.checks.unrelatedHostAndUpdaterModulesMatchInstalled = true;
assert.ok(extractFile(archive, 'README.md').equals(await readFile(path.join(root, 'README.md')))); report.checks.readmeMatchesSource = true;
for (const file of ['scripts/install-windows.ps1', 'vendor/cua-driver/cua-driver.exe']) {
  const packaged = await readFile(path.join(unpacked, file));
  assert.ok(packaged.equals(await readFile(path.join(root, file)))); assert.ok(packaged.equals(await readFile(path.join(installed, file))));
  report.files.push({ file, bytes: packaged.length, sha256: hash(packaged) });
}
report.checks.installerAndDriverUnchanged = true;
const policy = await import(pathToFileURL(path.join(unpacked, 'desktop/permissions.mjs')).href);
assert.equal(policy.codexPolicy('full').approvalPolicy, 'on-request'); assert.equal(policy.codexPolicy('full').sandbox, 'danger-full-access'); report.checks.nativePermissionMappingUnchanged = true;
const qa = JSON.parse(await readFile(path.join(output, 'packaged-qa.json'), 'utf8'));
assert.equal(qa.passed, true); assert.equal(qa.archive.sha256, report.archiveSha256); assert.equal(qa.archive.build.id, report.build.id);
report.checks.exactPackagePassedRestartConnectionAndPermissionChecks = qa.checks;
report.passed = true; await writeFile(path.join(output, 'package-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, build: report.build, files: report.files.length, behaviorChecks: Object.keys(qa.checks).length, report: path.join(output, 'package-verification.json') }));
