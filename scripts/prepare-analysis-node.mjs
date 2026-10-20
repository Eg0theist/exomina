// Pin a dedicated official Node.js runtime for REA's Windows native addon.
// Electron's RUN_AS_NODE mode cannot safely host that addon in this build.
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ANALYSIS_NODE_RUNTIME = Object.freeze({
  schemaVersion: 1,
  name: 'Node.js',
  version: '24.13.0',
  platform: 'win32',
  architecture: 'x64',
  executable: 'node.exe',
  sha256: 'd14ba95cdce1ef7dc9ad3ac74949ca5db38b27378ee30f30a23cf26f9e875a11',
  executableSha256: 'd14ba95cdce1ef7dc9ad3ac74949ca5db38b27378ee30f30a23cf26f9e875a11',
  license: 'LICENSE',
  licenseSha256: 'b4c7840e841ab8f14543646bd941d01a459fb0f8ce1249244341b2a63272ca79',
  archive: 'node-v24.13.0-win-x64.zip',
  archiveSha256: 'ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88',
  source: 'https://nodejs.org/dist/v24.13.0/node-v24.13.0-win-x64.zip',
  checksums: 'https://nodejs.org/dist/v24.13.0/SHASUMS256.txt',
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const maxArchiveBytes = 64 * 1024 * 1024;

async function ensureDirectory(directory) {
  const ancestors = []; let current = path.resolve(directory);
  for (;;) { ancestors.push(current); const parent = path.dirname(current); if (parent === current) break; current = parent; }
  for (const ancestor of ancestors.reverse()) {
    try { const metadata = await lstat(ancestor); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error('Runtime preparation directories cannot follow links: ' + ancestor); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(directory, { recursive: true });
}

async function regularFile(file, maxBytes) {
  let metadata;
  try { metadata = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > maxBytes) throw Error('Runtime preparation requires bounded regular files without links: ' + file);
  const bytes = await readFile(file);
  if (bytes.length !== metadata.size) throw Error('Runtime preparation input changed: ' + file);
  return bytes;
}

// Read exactly two named files from the already checksum-verified official ZIP.
// Archive names never become output paths, and no archive member is executed.
function archiveMembers(bytes) {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw Error('Unsupported official Node ZIP directory.');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  if (count > 20000 || offset + centralSize !== end) throw Error('Invalid official Node ZIP bounds.');
  const wanted = new Map(['node.exe', 'LICENSE'].map(name => [`node-v${ANALYSIS_NODE_RUNTIME.version}-win-x64/${name}`, name]));
  const output = new Map();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw Error('Invalid official Node ZIP member.');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42), next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw Error('Official Node ZIP member exceeds its directory.');
    const memberName = bytes.toString('utf8', offset + 46, offset + 46 + nameLength), name = wanted.get(memberName);
    if (name) {
      if (output.has(name) || (flags & 1) || expanded > 100 * 1024 * 1024 || localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw Error('Invalid official Node runtime member.');
      const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28);
      if (bytes.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength) !== memberName) throw Error('Official Node ZIP member identity disagrees.');
      const start = localOffset + 30 + localNameLength + localExtraLength;
      if (start + compressed > offset) throw Error('Official Node runtime member overlaps its directory.');
      const content = method === 0 ? Buffer.from(bytes.subarray(start, start + compressed)) : method === 8 ? inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: 100 * 1024 * 1024 }) : null;
      if (!content || content.length !== expanded) throw Error('Invalid official Node runtime decompression.');
      output.set(name, content);
    }
    offset = next;
  }
  if (offset !== end || output.size !== wanted.size) throw Error('Official Node runtime members are missing.');
  return output;
}

async function immutableWrite(file, bytes) {
  const existing = await regularFile(file, Math.max(bytes.length, 1024 * 1024));
  if (existing) { if (!existing.equals(bytes)) throw Error('Prepared Node runtime file differs from its pinned distribution: ' + file); return; }
  await writeFile(file, bytes, { flag: 'wx' });
}

export async function prepareAnalysisNode({ target = path.join(root, 'vendor', 'analysis-node'), archiveFile = path.join(root, '.verification', 'analysis-node', ANALYSIS_NODE_RUNTIME.archive) } = {}) {
  await ensureDirectory(target);
  const expected = new Map([['node.exe', ANALYSIS_NODE_RUNTIME.sha256], ['LICENSE', ANALYSIS_NODE_RUNTIME.licenseSha256]]);
  let complete = true;
  for (const [name, expectedHash] of expected) {
    const existing = await regularFile(path.join(target, name), name === 'node.exe' ? 100 * 1024 * 1024 : 1024 * 1024);
    if (!existing) complete = false;
    else if (hash(existing) !== expectedHash) throw Error('Prepared Node ' + name + ' checksum differs from the pinned official distribution.');
  }
  if (!complete) {
    let archive = await regularFile(archiveFile, maxArchiveBytes);
    if (!archive) {
      const response = await fetch(ANALYSIS_NODE_RUNTIME.source, { signal: AbortSignal.timeout(120000) });
      if (!response.ok || (Number(response.headers.get('content-length')) > maxArchiveBytes)) throw Error('Official Node runtime download failed or exceeded its size limit.');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > maxArchiveBytes) throw Error('Official Node runtime download exceeded its size limit.'); chunks.push(chunk); }
      archive = Buffer.concat(chunks, size);
      if (hash(archive) !== ANALYSIS_NODE_RUNTIME.archiveSha256) throw Error('Official Node archive checksum mismatch.');
      await ensureDirectory(path.dirname(archiveFile));
      await immutableWrite(archiveFile, archive);
    }
    if (hash(archive) !== ANALYSIS_NODE_RUNTIME.archiveSha256) throw Error('Official Node archive checksum mismatch.');
    const members = archiveMembers(archive);
    for (const [name, expectedHash] of expected) if (hash(members.get(name)) !== expectedHash) throw Error('Official Node ' + name + ' checksum mismatch.');
    for (const [name, bytes] of members) await immutableWrite(path.join(target, name), bytes);
  }
  const manifest = Buffer.from(JSON.stringify(ANALYSIS_NODE_RUNTIME, null, 2) + '\n');
  const provenance = Buffer.from(JSON.stringify({ ...ANALYSIS_NODE_RUNTIME, purpose: 'Dedicated local static application-analysis worker runtime; REA native controls remain enabled.', transformation: 'Only node.exe and LICENSE are extracted; official executable bytes are unchanged. npm and global installations are not included.', licenseTerms: 'Node.js MIT terms and bundled third-party notices are retained in LICENSE.' }, null, 2) + '\n');
  await immutableWrite(path.join(target, 'manifest.json'), manifest);
  await immutableWrite(path.join(target, 'provenance.json'), provenance);
  return ANALYSIS_NODE_RUNTIME;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await prepareAnalysisNode();
  console.log(`Prepared official Node.js ${manifest.version} for application analysis; verified SHA-256 ${manifest.sha256}.`);
}
