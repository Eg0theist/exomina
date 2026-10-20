import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readExportFile, EXPORT_LIMITS } from '../desktop/export-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.EXOMINA_TEST_PYTHON || (process.platform === 'win32' ? path.join(root, 'vendor/python/python.exe') : 'python3');
const fixtureWriter = `
import json, sys, zipfile, stat, struct
value=json.loads(sys.stdin.buffer.read().decode('utf-8'))
with zipfile.ZipFile(value['path'],'w') as archive:
 for item in value['entries']:
  info=zipfile.ZipInfo(item['name'])
  info.compress_type=zipfile.ZIP_DEFLATED if item.get('compress',True) else zipfile.ZIP_STORED
  if item.get('symlink'):
   info.create_system=3
   info.external_attr=(stat.S_IFLNK | 0o777) << 16
  content=bytes(item['bytes']) if 'bytes' in item else item.get('text','').encode('utf-8')
  archive.writestr(info,content)
if value.get('encrypted') or value.get('zip64') or value.get('corrupt'):
 data=bytearray(open(value['path'],'rb').read())
 if value.get('encrypted'):
  for signature,offset in [(b'PK\\x03\\x04',6),(b'PK\\x01\\x02',8)]:
   start=0
   while True:
    pos=data.find(signature,start)
    if pos < 0: break
    flags=struct.unpack_from('<H',data,pos+offset)[0]
    struct.pack_into('<H',data,pos+offset,flags | 1)
    start=pos+len(signature)
 if value.get('corrupt'):
  marker=value['corrupt'].encode('utf-8')
  pos=data.find(marker)
  assert pos>=0
  data[pos] ^= 1
 if value.get('zip64'):
  end=len(data)-22
  _,disk,cd_disk,count_disk,count,size,offset,comment=struct.unpack_from('<4s4H2LH',data,end)
  record=struct.pack('<4sQ2H2L4Q',b'PK\\x06\\x06',44,45,45,0,0,count,count,size,offset)
  locator=struct.pack('<4sLQL',b'PK\\x06\\x07',0,end,1)
  footer=struct.pack('<4s4H2LH',b'PK\\x05\\x06',0,0,65535,65535,0xffffffff,0xffffffff,0)
  data=data[:end]+record+locator+footer
 open(value['path'],'wb').write(data)
`;

async function makeZip(dir, entries, options = {}) {
  const file = path.join(dir, `${options.name || 'export'}.zip`);
  await new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-c', fixtureWriter], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Synthetic ZIP creation failed: ${stderr}`)));
    child.stdin.end(JSON.stringify({ ...options, path: file, entries }));
  });
  return file;
}

async function withFixture(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-export-test-'));
  try { await run(dir); }
  finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('exomina-export-test-'));
    await rm(dir, { recursive: true, force: true });
  }
}

test('plain JSON, text, and Markdown preserve raw UTF-8 and do not read profile JSON', async () => withFixture(async dir => {
  const text = '\ufeffSynthetic ä 中文\r\nraw {value}\n';
  for (const extension of ['json', 'txt', 'md']) {
    const file = path.join(dir, `context.${extension}`);
    await writeFile(file, text);
    const read = await readExportFile(file);
    assert.deepEqual(read.inputs, [{ source: `context.${extension}`, text }]);
    assert.equal(read.bytes, Buffer.byteLength(text));
  }
  await assert.rejects(readExportFile(path.join(dir, 'users.json')), /Account\/profile/);
  const invalid = path.join(dir, 'broken.txt');
  await writeFile(invalid, Buffer.from([0xc3, 0x28]));
  await assert.rejects(readExportFile(invalid), /UTF-8/);
}));

test('official-style ZIP selects context files and skips profile/binary entries without extraction', async () => withFixture(async dir => {
  const entries = [
    { name: 'export/conversations.json', text: '[{"title":"Synthetic chat","mapping":{}}]' },
    { name: 'export/conversations-001.json', text: '[]' },
    { name: 'export/conversations_part_2.json', text: '[]' },
    { name: 'export/projects.json', text: '[{"name":"Synthetic project"}]' },
    { name: 'export/saved_memories.json', text: '["Synthetic memory ä 中文"]' },
    { name: 'export/user_model_memory.json', text: '{"memory":"Synthetic"}' },
    { name: 'export/custom_instructions.md', text: 'Synthetic instructions\n' },
    { name: 'export/users.json', text: 'PROFILE CONTENT MUST NOT BE READ' },
    { name: 'export/avatar.png', text: 'BROKEN_BINARY_CONTENT', compress: false },
    { name: 'export/chat.html', text: '<p>Duplicate rendered conversations</p>' },
  ];
  const file = await makeZip(dir, entries, { corrupt: 'BROKEN_BINARY_CONTENT' });
  const before = await readdir(dir);
  const read = await readExportFile(file, { python });
  assert.equal(read.inputs.length, 7);
  assert.deepEqual(read.inputs.map(input => input.text), entries.slice(0, 7).map(entry => entry.text));
  assert.equal(read.bytes, entries.slice(0, 7).reduce((total, entry) => total + Buffer.byteLength(entry.text), 0));
  assert.ok(read.warnings.some(value => /1 binary/.test(value)));
  assert.ok(read.warnings.some(value => /1 account\/profile/.test(value)));
  assert.ok(read.warnings.some(value => /1 unrecognized/.test(value)));
  assert.deepEqual(await readdir(dir), before, 'ZIP members must not be extracted to disk.');
}));

test('ZIP64 metadata is supported without needing a multi-gigabyte fixture', async () => withFixture(async dir => {
  const file = await makeZip(dir, [{ name: 'conversations.json', text: '["Synthetic ZIP64"]' }], { zip64: true });
  const read = await readExportFile(file, { python });
  assert.equal(read.inputs[0].text, '["Synthetic ZIP64"]');
}));

test('new OpenAI wrapper reads only the nested conversation bundle and skips Sites metadata', async () => withFixture(async dir => {
  const { readFile } = await import('node:fs/promises');
  const text = '[{"id":"chat","title":"Synthetic nested chat","mapping":{}}]';
  const inner = await makeZip(dir, [
    { name: 'conversations-000.json', text },
    { name: 'sites/projects/project-0001/project.json', text: 'PRIVATE_SITES_METADATA_MUST_NOT_BE_READ' },
    { name: 'user.json', text: 'PRIVATE_PROFILE_MUST_NOT_BE_READ' },
  ], { name: 'inner' });
  const outer = await makeZip(dir, [
    { name: 'User Online Activity/Conversations__synthetic-chatgpt-0001.zip', bytes: [...await readFile(inner)] },
    { name: 'User Online Activity/Files__synthetic-files-0001.zip', text: 'CORRUPTED_IGNORED_FILES', compress: false },
    { name: 'User Online Activity/personalinfo__synthetic-personal-info-0001.zip', text: 'PRIVATE_PROFILE_MUST_NOT_BE_READ' },
    { name: 'Financial/Invoice Items.csv', text: 'PRIVATE_FINANCIAL_MUST_NOT_BE_READ' },
    { name: 'User Online Activity/Authentications__user_authentications-1.csv', text: 'PRIVATE_AUTH_MUST_NOT_BE_READ' },
  ], { name: 'wrapper', corrupt: 'CORRUPTED_IGNORED_FILES' });
  const before = await readdir(dir);
  const result = await readExportFile(outer, { python });
  assert.equal(result.inputs.length, 1);
  assert.equal(result.inputs[0].text, text);
  assert.match(result.inputs[0].source, /Conversations__synthetic-chatgpt-0001\.zip!\/conversations-000\.json$/);
  assert.ok(result.warnings.some(w => w.includes('Opened 1 nested')));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.deepEqual(await readdir(dir), before);
}));

test('nested conversation bundles retain aggregate limits and reject deeper or unsafe archives', async () => withFixture(async dir => {
  const { readFile } = await import('node:fs/promises');
  const inner = await makeZip(dir, [{ name: 'conversations-000.json', text: 'a'.repeat(40) }, { name: 'conversations-001.json', text: 'b'.repeat(40) }], { name: 'inner' });
  const bytes = [...await readFile(inner)];
  const wrapper = await makeZip(dir, [{ name: 'Conversations.zip', bytes }], { name: 'wrapper' });
  await assert.rejects(readExportFile(wrapper, { python, maxNestedZipBytes: 32 }), /Nested conversation ZIPs/);
  await assert.rejects(readExportFile(wrapper, { python, maxTotalBytes: 64 }), /Combined context/);
  await assert.rejects(readExportFile(wrapper, { python, maxEntries: 2 }), /Combined ZIPs contain too many/);
  const deep = await makeZip(dir, [{ name: 'Conversations.zip', bytes: [...await readFile(wrapper)] }], { name: 'deep' });
  await assert.rejects(readExportFile(deep, { python }), /more than one level/);
  const unsafe = await makeZip(dir, [{ name: '../Conversations.zip', bytes }], { name: 'unsafe-wrapper' });
  await assert.rejects(readExportFile(unsafe, { python }), /unsafe.*traversal/);
  const unsafeInner = await makeZip(dir, [{ name: '../conversations.json', text: '[]' }], { name: 'unsafe-inner' });
  const unsafeNested = await makeZip(dir, [{ name: 'Conversations.zip', bytes: [...await readFile(unsafeInner)] }], { name: 'unsafe-nested' });
  await assert.rejects(readExportFile(unsafeNested, { python }), /unsafe.*traversal/);
  const corrupt = await makeZip(dir, [{ name: 'Conversations.zip', text: 'PRIVATE_CORRUPT_NESTED_ZIP' }], { name: 'corrupt-inner' });
  await assert.rejects(readExportFile(corrupt, { python }), error => /ZIP|export/.test(error.message) && !error.message.includes('PRIVATE_'));
}));

test('Claude split ZIPs recognize project UUID files and preserve artifact sources as inert text', async () => withFixture(async dir => {
  const id = '11111111-2222-4333-8444-555555555555';
  const project = JSON.stringify({ uuid: id, name: 'Synthetic project', prompt_template: 'Synthetic instruction', docs: [{ filename: 'notes.md', content: 'Synthetic notes' }] });
  const projectFile = await makeZip(dir, [{ name: `projects/${id}.json`, text: project }], { name: 'projects-000' });
  assert.deepEqual((await readExportFile(projectFile, { python })).inputs, [{ source: `projects/${id}.json`, text: project }]);
  for (const folder of ['artifacts', 'frames']) {
    const prefix = `${folder}/${id}`;
    const entries = [
      { name: `${prefix}/${folder === 'frames' ? 'frame' : 'artifact'}.json`, text: JSON.stringify({ id, kind: 'app', versions: [{ id: 'v1', title: 'Synthetic artifact' }] }) },
      { name: `${prefix}/comments.json`, text: '[{"text":"Synthetic review"}]' },
      { name: `${prefix}/page.md`, text: '# Synthetic artifact\n' },
      { name: `${prefix}/versions/v1/index.html`, text: '<script>throw new Error("MUST NEVER EXECUTE")</script><p>Raw synthetic source</p>' },
      { name: `${prefix}/versions/v1/assets/app.js`, text: 'throw new Error("MUST NEVER EXECUTE");' },
      { name: `${prefix}/versions/v1/assets/app.css`, text: 'body { color: #abcdef; }' },
      { name: `${prefix}/versions/v1/assets/icon.svg`, text: '<svg xmlns="http://www.w3.org/2000/svg"><script>MUST_NEVER_EXECUTE()</script></svg>' },
      { name: `${prefix}/versions/v1/search-index.json`, text: '[{"u":"/","t":"Synthetic title","d":"Synthetic source","k":"page","x":""}]' },
      { name: `${prefix}/versions/v1-manifest.json`, text: '{"files":[{"original_path":"index.html","exported_as":"index.html","size_bytes":42}]}' },
      { name: `${prefix}/versions/v1/assets/font.woff2`, text: 'CORRUPTED_IGNORED_FONT', compress: false },
      { name: 'unrelated/index.html', text: 'UNRELATED_TEXT_NOT_IMPORTED' },
    ];
    const file = await makeZip(dir, entries, { name: folder, corrupt: 'CORRUPTED_IGNORED_FONT' });
    const before = await readdir(dir);
    const read = await readExportFile(file, { python });
    assert.deepEqual(read.inputs, entries.slice(0, 9).map(({ name, text }) => ({ source: name, text })));
    assert.ok(read.warnings.some(value => /1 binary/.test(value)));
    assert.ok(read.warnings.some(value => /1 unrecognized/.test(value)));
    assert.deepEqual(await readdir(dir), before);
  }
  const unmarked = await makeZip(dir, [{ name: `artifacts/${id}/versions/v1/index.html`, text: 'Unmarked artifact must not be selected.' }], { name: 'unmarked' });
  await assert.rejects(readExportFile(unmarked, { python }), /No supported conversation/);
  const unsafe = await makeZip(dir, [{ name: `artifacts/${id}/artifact.json`, text: '{}' }, { name: `artifacts/${id}/versions/../../../escape.js`, text: 'Synthetic unsafe path' }], { name: 'unsafe-artifact' });
  await assert.rejects(readExportFile(unsafe, { python }), /unsafe.*traversal/);
}));

test('streaming preserves multibyte characters, raw newlines, and directory-style shards across chunk boundaries', async () => withFixture(async dir => {
  const text = 'x'.repeat(65535) + '中🙂\r\n' + 'y'.repeat(65535) + 'ä\n';
  const file = await makeZip(dir, [{ name: 'export/conversations/001.json', text }, { name: 'export/conversations/part-2.json', text: '[]' }]);
  const read = await readExportFile(file, { python });
  assert.equal(read.inputs[0].text, text);
  assert.equal(read.inputs[1].text, '[]');
  assert.equal(read.bytes, Buffer.byteLength(text) + 2);
}));

test('selected traversal, absolute paths, and symlink entries are rejected before import', async () => withFixture(async dir => {
  for (const [index, entry] of [
    { name: '../conversations.json', text: '[]' },
    { name: 'nested/../../memories.json', text: '[]' },
    { name: '/conversations.json', text: '[]' },
    { name: 'C:\\conversations.json', text: '[]' },
    { name: 'conversations.json', text: '../../secret', symlink: true },
  ].entries()) {
    const file = await makeZip(dir, [entry], { name: `unsafe-${index}` });
    await assert.rejects(readExportFile(file, { python }), /unsafe|symbolic link/);
  }
}));

test('encrypted selected entries and duplicate context paths fail clearly', async () => withFixture(async dir => {
  const encrypted = await makeZip(dir, [{ name: 'conversations.json', text: '[]' }], { name: 'encrypted', encrypted: true });
  await assert.rejects(readExportFile(encrypted, { python }), /encrypted/);
  const duplicate = await makeZip(dir, [{ name: 'memories.json', text: '[]' }, { name: 'MEMORIES.JSON', text: '[]' }], { name: 'duplicate' });
  await assert.rejects(readExportFile(duplicate, { python }), /duplicate context filenames/);
}));

test('per-file, total, entry-count, directory-size, and compression-ratio bounds are enforced', async () => withFixture(async dir => {
  const file = await makeZip(dir, [{ name: 'conversations.json', text: 'a'.repeat(40) }, { name: 'memories.json', text: 'b'.repeat(40) }]);
  await assert.rejects(readExportFile(file, { python, maxFileBytes: 32 }), /per-file/);
  await assert.rejects(readExportFile(file, { python, maxTotalBytes: 64 }), /Combined context/);
  await assert.rejects(readExportFile(file, { python, maxEntries: 1 }), /too many entries/);
  await assert.rejects(readExportFile(file, { python, maxCentralDirectoryBytes: 1 }), /directory is too large/);
  const bomb = await makeZip(dir, [{ name: 'conversations.json', text: 'a'.repeat(10000) }], { name: 'bomb' });
  await assert.rejects(readExportFile(bomb, { python, maxCompressionRatio: 5, ratioCheckMinBytes: 100 }), /suspicious compression ratio/);
  const largeIgnoredAsset = await makeZip(dir, [{ name: 'conversations.json', text: '[]' }, { name: 'image.png', text: 'a'.repeat(10000) }], { name: 'ignored-asset' });
  assert.equal((await readExportFile(largeIgnoredAsset, { python, maxFileBytes: 32, maxTotalBytes: 32, maxCompressionRatio: 5, ratioCheckMinBytes: 100 })).inputs.length, 1);
  const plain = path.join(dir, 'large.txt'); await writeFile(plain, 'a'.repeat(65));
  await assert.rejects(readExportFile(plain, { maxFileBytes: 64 }), /size limit/);
  await assert.rejects(readExportFile(plain, { maxFileBytes: EXPORT_LIMITS.maxFileBytes + 1 }), /Invalid export reader limit/);
}));

test('unsupported ZIPs, corrupt text, and invalid UTF-8 fail without leaking content', async () => withFixture(async dir => {
  const unknown = await makeZip(dir, [{ name: 'unrelated.json', text: '[]' }, { name: 'users.json', text: '[]' }], { name: 'unknown' });
  await assert.rejects(readExportFile(unknown, { python }), /No supported conversation/);
  const invalid = await makeZip(dir, [{ name: 'conversations.json', bytes: [0xc3, 0x28] }], { name: 'invalid-utf8' });
  await assert.rejects(readExportFile(invalid, { python }), /UTF-8/);
  const corrupt = await makeZip(dir, [{ name: 'conversations.json', text: 'PRIVATE_SYNTHETIC_MARKER', compress: false }], { name: 'corrupt', corrupt: 'PRIVATE_SYNTHETIC_MARKER' });
  await assert.rejects(readExportFile(corrupt, { python }), error => /damaged|inconsistent/.test(error.message) && !error.message.includes('PRIVATE_SYNTHETIC_MARKER'));
}));
