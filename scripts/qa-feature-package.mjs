// Exact shipped code and worker executable, using fresh synthetic targets only.
import { readFile, writeFile, mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractFile } from '@electron/asar';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'release', 'win-unpacked');
const unpacked = path.join(build, 'resources', 'app.asar.unpacked');
const archive = path.join(build, 'resources', 'app.asar');
const output = await mkdtemp(path.resolve(root, '../Workspace/qa-feature-package-'));
const stamp = JSON.parse(await readFile(path.join(build, 'exomina.build.json'), 'utf8'));
const prior = JSON.parse(await readFile(path.resolve(root, '../Workspace/rea-packaged-worker-verification/report.json'), 'utf8'));
const critical = [...new Set([...prior.checks.map(check => check.file), 'desktop/providers.mjs', 'desktop/usage.mjs', 'desktop/usage-resets.mjs'])];
const report = { build: stamp, output, syntheticOnly: true, checks: [], operations: [], errors: [] };
let analysis;
try {
  for (const file of critical) {
    const source = await readFile(path.join(root, file)), packaged = await readFile(path.join(unpacked, file));
    assert.ok(source.equals(packaged), `${file} differs from source`);
    const sha256 = createHash('sha256').update(source).digest('hex');
    const original = prior.checks.find(check => check.file === file);
    const sameAsOriginal = original?.sha256 === sha256;
    if (original && file !== 'desktop/main.mjs') assert.equal(sameAsOriginal, true, `${file} changed since original feature verification`);
    report.checks.push({ file, sha256, sameAsOriginal: original ? sameAsOriginal : null });
  }
  const html = await readFile(path.join(root, 'dist', 'index.html'));
  assert.ok(html.equals(extractFile(archive, path.normalize('dist/index.html'))));
  const assets = [...html.toString('utf8').matchAll(/(?:src|href)="\.\/([^"?#]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.ok(assets.length >= 2);
  for (const file of assets) assert.ok((await readFile(path.join(root, 'dist', file))).equals(extractFile(archive, path.normalize(path.join('dist', file)))));
  report.rendererMatches = true;
  assert.equal(JSON.parse(await readFile(path.join(unpacked, 'node_modules/rea-agents/package.json'), 'utf8')).version, '6.1.0');
  const target = path.join(output, 'synthetic-app'), dataDir = path.join(output, 'synthetic-profile');
  await mkdir(target); await mkdir(dataDir);
  await writeFile(path.join(target, 'main.js'), 'export function search(query) { return query.toLowerCase().split(" "); }');
  await copyFile(path.resolve(root, '../Workspace/rea-packaged-worker-verification/synthetic-app/SyntheticManaged.dll'), path.join(target, 'SyntheticManaged.dll'));
  const { AppAnalysis } = await import(pathToFileURL(path.join(unpacked, 'desktop', 'app-analysis.mjs')).href);
  const chat = { id: 'synthetic-feature-package' };
  analysis = new AppAnalysis({ dataDir, getChat: id => id === chat.id ? chat : null, save: async () => {}, approve: async () => true, workspaceTools: { privateDirs: [], excludePrivate: async file => { assert.ok(path.relative(output, file).startsWith('synthetic-app'), 'only synthetic target access is permitted'); } }, nodeExecutable: path.join(build, 'Exomina.exe') });
  await analysis.select(chat.id, target);
  for (const operation of ['javascript', 'managed', 'managed-members', 'managed-native', 'inventory']) {
    const result = JSON.parse((await analysis.run(chat.id, chat.analysisTarget, operation)).content[0].text);
    assert.equal(result.status, 'completed'); assert.equal(result.failures, 0);
    assert.equal(result.analyzedFiles, operation === 'inventory' ? 0 : 1);
    report.operations.push({ operation, analyzedFiles: result.analyzedFiles, failures: result.failures });
  }
  report.exactPackagedExecutableUsedAsWorker = true; report.passed = true;
} catch (error) {
  report.errors.push(error.stack); process.exitCode = 1;
} finally {
  await analysis?.close();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed === true, build: stamp, output, filesVerified: report.checks.length, operations: report.operations, errors: report.errors }));
}
