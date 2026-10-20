import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractFile, listPackage } from '@electron/asar';
import assert from 'node:assert/strict';

const root = process.cwd(), build = path.join(root, 'release/win-unpacked');
const archive = path.join(build, 'resources/app.asar'), unpacked = archive + '.unpacked';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const checked = [];
async function compare(dir, relative) {
  for (const entry of await readdir(path.join(dir, relative), { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    const file = path.join(relative, entry.name);
    if (file.replaceAll('\\', '/').startsWith('desktop/antigravity-browser')) continue;
    if (entry.isDirectory()) { await compare(dir, file); continue; }
    assert.equal(entry.isFile(), true);
    const source = await readFile(path.join(dir, file));
    const packed = file.startsWith('desktop') ? await readFile(path.join(unpacked, file)) : extractFile(archive, file);
    assert.equal(digest(packed), digest(source), file + ' differs in package'); checked.push(file);
  }
}
await compare(root, 'desktop'); await compare(root, 'dist');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const stamp = JSON.parse(await readFile(path.join(build, 'exomina.build.json'), 'utf8'));
assert.equal(JSON.parse(extractFile(archive, 'package.json')).version, version); assert.equal(stamp.version, version);
for (const file of listPackage(archive)) assert.ok(!/\/(?:accounts|synthetic-helper-profile|qa-[^/]+)(?:\/|$)/i.test(file.replaceAll('\\', '/')), 'Unexpected profile in package: ' + file);
const report = { passed: true, version, buildId: stamp.id, desktopAndRendererFiles: checked.length, files: checked };
await writeFile(path.resolve('../Workspace/continuity-followups-20261016/package-verification.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ passed: true, version, buildId: stamp.id, desktopAndRendererFiles: checked.length }));
