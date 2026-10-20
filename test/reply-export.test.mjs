import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReplyExport, replyExportInfo, REPLY_EXPORT_LIMITS } from '../desktop/reply-export.mjs';
import { saveReplyExport } from '../desktop/reply-export-files.mjs';

const python = process.platform === 'win32' ? fileURLToPath(new URL('../vendor/python/python.exe', import.meta.url)) : 'python3';
const checker = fileURLToPath(new URL('./reply-export-check.py', import.meta.url));
const sample = '# Budget & plan\n\nA **clear** reply with *emphasis*, `literal_code` and [a source](https://example.com/a?q=1&b=2).\n\n> A quoted line\n> A second line\n\n1. First\n2. Second\n\n```html\n<script>alert("text only")</script>\n```\n\n| Item | Value |\n| --- | --- |\n| Amount | 42 |\n| Formula | =1+1 |\n| Identifier | 00123 |\n| Long ID | 9007199254740993 |\n| Unicode | Grüße 日本語 🦊 |\n| Pipe | a\\|b |\n| Literal escape | `_x0041_` |\n\n# Budget & plan\n\n| Name | Value | Extra |\n| --- | --- | --- |\n| Empty end | 1 | |\n| Extra data | -3.5 | retained |\n';
const decode = bytes => new TextDecoder().decode(bytes);
async function fixture(t) {
  const parent = path.resolve(tmpdir()), root = await mkdtemp(path.join(parent, 'exomina-reply-export-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('Office packages open with Python ZIP/XML readers and preserve literal values', async t => {
  const root = await fixture(t);
  for (const format of ['docx','xlsx']) {
    const result = createReplyExport({ text: sample, format });
    await writeFile(path.join(root, result.filename), result.bytes);
  }
  await writeFile(path.join(root, 'names.xlsx'), createReplyExport({ format: 'xlsx', text: '# History\n\n| A | B |\n| --- | --- |\n| value | |\n\n# ' + 'a'.repeat(30) + "'bc\n\n| A | B |\n| --- | --- |\n| value | 1 |" }).bytes);
  const result = spawnSync(python, ['-I', checker, root], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.zipCrcValid, true); assert.equal(report.allXmlValid, true);
  assert.equal(report.wordHeadings, 2); assert.equal(report.wordTables, 2);
  assert.deepEqual(report.sheetNames, ['Budget & plan', 'Budget & plan (2)']);
  assert.equal(report.literalFormulas, true); assert.equal(report.numericCells, true);
  assert.equal(report.unicodeAndIdentifiers, true); assert.equal(report.noExternalRelationships, true);
});

test('text and Markdown exports contain only the chosen reply', () => {
  assert.equal(decode(createReplyExport({ text: '## Title\n\n**Hello** [source](https://example.com).', format: 'md' }).bytes), '## Title\n\n**Hello** [source](https://example.com).');
  assert.equal(decode(createReplyExport({ text: '## Title\n\n**Hello** [source](https://example.com).', format: 'txt' }).bytes), 'Title\n\nHello source (https://example.com).\n');
  assert.equal(replyExportInfo('```text\n| Looks | like a table |\n| --- | --- |\n```').tables, 0);
  assert.equal(replyExportInfo(sample).tables, 2);
  assert.equal(decode(createReplyExport({ text: '**a *b* c** and ``a`b``', format: 'txt' }).bytes), 'a b c and a`b\n');
});

test('exports reject oversized input, unsupported formats and invalid spreadsheet cells', () => {
  assert.throws(() => createReplyExport({ text: 'hello', format: 'exe' }), /Choose Word/);
  assert.throws(() => createReplyExport({ text: ' ', format: 'docx' }), /containing text/);
  assert.throws(() => createReplyExport({ text: 'x'.repeat(REPLY_EXPORT_LIMITS.maxCharacters + 1), format: 'docx' }), /too large/);
  assert.throws(() => createReplyExport({ text: 'No table here.', format: 'xlsx' }), /needs a table/);
  assert.throws(() => createReplyExport({ text: '| A | B |\n| --- | --- |\n| ' + 'x'.repeat(32768) + ' | value |', format: 'xlsx' }), /32,767/);
});

test('save cancellation, private paths, extensions and links never replace the destination', async t => {
  const root = await fixture(t), destination = path.join(root, 'existing.docx');
  await writeFile(destination, 'original', 'utf8');
  const input = { text: sample, format: 'docx' }, chooseFile = async () => ({ canceled: false, filePath: destination });
  assert.deepEqual(await saveReplyExport(input, { chooseFile: async () => ({ canceled: true }), excludePrivate: () => { throw Error('Must not run after cancellation'); } }), { path: null });
  await assert.rejects(saveReplyExport(input, { chooseFile, excludePrivate: async () => { throw Error('Private path'); } }), /Private path/);
  await writeFile(path.join(root, 'wrong.exe.docx'), 'keep this file', 'utf8');
  await assert.rejects(saveReplyExport(input, { chooseFile: async () => ({ filePath: path.join(root, 'wrong.exe') }), excludePrivate: async () => {} }), /completed filename already exists/);
  await assert.rejects(saveReplyExport(input, { chooseFile: async () => ({ filePath: path.join(root, 'stream.txt:hidden.docx') }), excludePrivate: async () => {} }), /reserved characters/);
  const folder = path.join(root, 'folder.docx'); await mkdir(folder);
  await assert.rejects(saveReplyExport(input, { chooseFile: async () => ({ filePath: folder }), excludePrivate: async () => {} }), /regular file/);
  assert.equal(await readFile(destination, 'utf8'), 'original');
  const link = path.join(root, 'linked.docx');
  try { await symlink(destination, link, 'file'); }
  catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error; }
  if ((await readdir(root)).includes('linked.docx')) await assert.rejects(saveReplyExport(input, { chooseFile: async () => ({ filePath: link }), excludePrivate: async () => {} }), /regular file/);
  assert.equal((await readdir(root)).some(name => name.startsWith('.exomina-export-')), false);
});

test('native saves replace only the confirmed filename and allow dotted basenames', async t => {
  const root = await fixture(t), destination = path.join(root, 'reply.txt');
  await writeFile(destination, 'old', 'utf8');
  const seen = [];
  const chooseFile = async options => { assert.equal(options.filters[0].extensions[0], 'txt'); assert.ok(options.properties.includes('showOverwriteConfirmation')); return { canceled: false, filePath: destination }; };
  const saved = await saveReplyExport({ text: '# New\n\nGrüße 🦊', format: 'txt' }, { chooseFile, excludePrivate: async value => { seen.push(value); } });
  assert.equal(saved.path, destination); assert.equal(await readFile(destination, 'utf8'), 'New\n\nGrüße 🦊\n');
  assert.deepEqual(seen, [root, destination]);
  assert.deepEqual(await readdir(root), ['reply.txt']);
  await assert.rejects(saveReplyExport({ text: 'Do not overwrite', format: 'txt' }, { chooseFile: async () => ({ filePath: path.join(root, 'reply') }), excludePrivate: async () => {} }), /completed filename already exists/);
  assert.equal(await readFile(destination, 'utf8'), 'New\n\nGrüße 🦊\n');
  const dotted = await saveReplyExport({ text: 'Version 3', format: 'txt' }, { chooseFile: async () => ({ filePath: path.join(root, 'Q3.final') }), excludePrivate: async () => {} });
  assert.equal(dotted.path, path.join(root, 'Q3.final.txt'));
  assert.equal(await readFile(dotted.path, 'utf8'), 'Version 3\n');
});

test('locked Windows destinations keep their contents and get a readable error', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), destination = path.join(root, 'locked.txt'); await writeFile(destination, 'keep me', 'utf8');
  const child = spawn(python, ['-I', fileURLToPath(new URL('./reply-export-lock.py', import.meta.url)), destination], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Lock helper timeout')), 5000); child.once('error', reject); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); });
    await assert.rejects(saveReplyExport({ text: 'new content', format: 'txt' }, { chooseFile: async () => ({ filePath: destination }), excludePrivate: async () => {} }), /Close it in the app/);
    assert.equal(await readFile(destination, 'utf8'), 'keep me'); assert.deepEqual(await readdir(root), ['locked.txt']);
  } finally { child.stdin.end('\n'); await new Promise(resolve => child.once('close', resolve)); }
});
