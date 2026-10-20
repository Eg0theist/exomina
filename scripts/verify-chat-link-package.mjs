import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'release/win-unpacked'), archive = path.join(build, 'resources/app.asar');
const output = path.resolve(process.env.EXOMINA_QA_REPORT_DIR || path.resolve(root, '../Workspace/file-explorer-links-20261012'));
const prior = JSON.parse(await readFile(path.resolve(root, '../Workspace/ghidra-sidebar-followups-20261011/package-parity.json'), 'utf8'));
const renderer = (await readFile(path.join(root, 'dist/index.html'))).toString();
const rendererAssets = [...renderer.matchAll(/(?:src|href)="\.\/([^"?#]+\.(?:js|css))"/g)].map(match => 'dist/' + match[1]);
assert.ok(rendererAssets.length >= 2);
const files = [...new Set([...prior.checks.map(check => check.path).filter(file => !file.startsWith('dist/assets/index-')), ...rendererAssets, 'desktop/chat-link-open.mjs', 'desktop/chat-file-menu.mjs', 'desktop/chat-links.mjs'])];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { scope: 'Source bytes compared with the exact update archive and unpacked desktop files. Previous integration files retained. No personal data.', checks: [] };
for (const file of files) {
  const source = await readFile(path.join(root, file)), packaged = extractFile(archive, path.normalize(file));
  assert.ok(source.equals(packaged), `${file} differs in the archive.`);
  if (file.startsWith('desktop/') || file.startsWith('vendor/') || file === 'scripts/install-windows.ps1') {
    assert.ok(source.equals(await readFile(path.join(build, 'resources/app.asar.unpacked', file))), `${file} differs in unpacked files.`);
  }
  report.checks.push({ path: file, sha256: hash(source), matches: true });
}
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const stamp = JSON.parse(await readFile(path.join(build, 'exomina.build.json'), 'utf8'));
const packagedManifest = JSON.parse(extractFile(archive, 'package.json'));
const metadata = JSON.parse(extractFile(archive, path.normalize('desktop/app-version.json')));
assert.equal(manifest.version, lock.version); assert.equal(manifest.version, lock.packages[''].version);
assert.equal(manifest.version, stamp.version); assert.equal(manifest.version, packagedManifest.version); assert.equal(manifest.version, metadata.version);
report.build = stamp; report.versionConsistency = true; report.rendererAssets = rendererAssets;
report.passed = true;
await writeFile(path.join(output, 'package-parity.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, checkedFiles: report.checks.length, build: stamp }));
