import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VoiceSamples, clearWav, installedApps } from '../desktop/voice-samples.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** A synthetic mono PCM16 recording: a voice-like mix of tones, never a real provider recording. */
function wav(seconds = 0.5, sampleRate = 48000, seed = 1) {
  const count = Math.floor(seconds * sampleRate), bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(36 + count * 2, 4); bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36, 'ascii'); bytes.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) {
    const t = index / sampleRate;
    const value = 0.25 * Math.sin(2 * Math.PI * 180 * seed * t) + 0.18 * Math.sin(2 * Math.PI * 2400 * t) + 0.06 * Math.sin(2 * Math.PI * 7000 * t);
    bytes.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return bytes;
}
const codexName = (voice, bytes) => `${voice}.en.${sha(bytes).slice(0, 8)}-0123456789ab.wav`;
const mp3 = (extra = 1200) => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(extra, 7)]);

async function workspace(t) {
  const parent = path.resolve(tmpdir()), root = await mkdtemp(path.join(parent, 'exomina-voice-samples-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(parent + path.sep)); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function fakeCodex(root, voices) {
  const dir = path.join(root, 'codex', 'app', 'resources', 'app.asar', 'webview', 'assets');
  await mkdir(dir, { recursive: true });
  for (const [voice, bytes] of Object.entries(voices)) await writeFile(path.join(dir, codexName(voice, bytes)), bytes);
  return { app: 'Codex', version: '1.2.3', root: path.join(root, 'codex') };
}
async function fakeClaude(root, names) {
  const dir = path.join(root, 'claude', 'app', 'resources', 'ion-dist', 'audio', 'voice', 'selection');
  await mkdir(dir, { recursive: true });
  for (const name of names) await writeFile(path.join(dir, name + '.mp3'), mp3());
  return { app: 'Claude', version: '4.5.6', root: path.join(root, 'claude') };
}
const sampler = (root, apps) => new VoiceSamples({ dir: path.join(root, 'data', 'voice-samples'), findApps: async () => apps, now: () => new Date('2026-10-08T12:00:00Z') });

test('Clear sound keeps length and format, stays below the ceiling and is deterministic', () => {
  const original = wav(), first = clearWav(original), second = clearWav(original);
  assert.equal(first.length, original.length);
  assert.deepEqual(first.subarray(0, 44), original.subarray(0, 44));
  assert.ok(first.equals(second));
  assert.ok(!first.equals(original));
  let peak = 0;
  for (let offset = 44; offset < first.length; offset += 2) peak = Math.max(peak, Math.abs(first.readInt16LE(offset)));
  assert.ok(peak / 32768 <= Math.pow(10, -1.2 / 20) + 1 / 32768);
});

test('Clear sound refuses recordings it cannot process safely', () => {
  assert.throws(() => clearWav(Buffer.from('not a recording')), /WAV/);
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  assert.throws(() => clearWav(stereo), /Unsupported/);
  const silent = wav(); silent.fill(0, 44);
  assert.throws(() => clearWav(silent), /Silent/);
});

test('importing copies verified recordings from the user\u2019s apps and builds Clear versions locally', async t => {
  const root = await workspace(t);
  const cove = wav(0.4, 48000, 1), maple = wav(0.4, 48000, 2);
  const samples = sampler(root, [await fakeCodex(root, { cove, maple }), await fakeClaude(root, ['airy', 'buttery'])]);
  assert.equal((await samples.status()).imported, false);
  const result = await samples.import();
  assert.equal(result.changed, true);
  assert.deepEqual(result.found, { chatgpt: 2, claude: 2 });
  assert.deepEqual(result.chatgpt.sort(), ['cove', 'maple']);
  assert.deepEqual(result.claude.sort(), ['airy', 'buttery']);
  assert.equal(result.clear, true);
  assert.deepEqual(result.sources, [{ app: 'Codex', version: '1.2.3' }, { app: 'Claude', version: '4.5.6' }]);
  const original = await samples.read('cove', 'original'), clear = await samples.read('cove', 'clear');
  assert.equal(original.type, 'audio/wav');
  assert.ok(Buffer.from(original.data, 'base64').equals(cove), 'the original is copied unchanged');
  assert.ok(Buffer.from(clear.data, 'base64').equals(clearWav(cove)));
  const claude = await samples.read('claude:airy');
  assert.equal(claude.type, 'audio/mpeg');
  assert.ok(Buffer.from(claude.data, 'base64').equals(mp3()));
  assert.deepEqual((await readdir(path.join(root, 'data'))).sort(), ['voice-samples'], 'no staging folder remains');
  assert.equal(await samples.read('arbor'), null);
});

test('recordings that fail their hash, format or size checks are skipped and counted', async t => {
  const root = await workspace(t);
  const good = wav(0.3, 48000, 1);
  const app = await fakeCodex(root, { cove: good });
  const dir = path.join(app.root, 'app', 'resources', 'app.asar', 'webview', 'assets');
  const tampered = Buffer.from(wav(0.3, 48000, 2)); const tamperedName = codexName('maple', tampered); tampered[100] ^= 0xff;
  await writeFile(path.join(dir, tamperedName), tampered);
  await writeFile(path.join(dir, codexName('vale', Buffer.from('RIFFnope'))), Buffer.from('RIFFnope'));
  await writeFile(path.join(dir, 'Bad_Name.en.deadbeef-0123456789ab.wav'), good);
  await writeFile(path.join(dir, 'readme.txt'), 'x');
  const claude = await fakeClaude(root, ['airy']);
  const claudeDir = path.join(claude.root, 'app', 'resources', 'ion-dist', 'audio', 'voice', 'selection');
  await writeFile(path.join(claudeDir, 'tiny.mp3'), Buffer.from('ID3'));
  await writeFile(path.join(claudeDir, 'fake.mp3'), Buffer.alloc(2000, 1));
  const result = await sampler(root, [app, claude]).import();
  assert.deepEqual(result.chatgpt, ['cove']);
  assert.deepEqual(result.claude, ['airy']);
  assert.equal(result.rejected, 4);
});

test('when nothing is found the existing previews are kept and the user is told why', async t => {
  const root = await workspace(t);
  const first = sampler(root, [await fakeCodex(root, { cove: wav() })]);
  await first.import();
  const empty = new VoiceSamples({ dir: path.join(root, 'data', 'voice-samples'), findApps: async () => [] });
  const result = await empty.import();
  assert.equal(result.changed, false);
  assert.match(result.message, /could not find/);
  assert.equal(result.imported, true);
  assert.deepEqual(result.chatgpt, ['cove']);
  assert.ok(await empty.read('cove', 'clear'));
  const chosen = await empty.import({ folder: path.join(root, 'nothing-here') });
  assert.equal(chosen.changed, false);
  assert.match(chosen.message, /in that folder/);
});

test('a folder chosen by the user works for both apps, and an app folder itself can be chosen', async t => {
  const root = await workspace(t);
  const codex = await fakeCodex(root, { cove: wav() }), claude = await fakeClaude(root, ['mellow']);
  const samples = sampler(root, []);
  const fromCodex = await samples.import({ folder: codex.root });
  assert.deepEqual(fromCodex.chatgpt, ['cove']);
  const assets = path.join(codex.root, 'app', 'resources', 'app.asar', 'webview', 'assets');
  assert.deepEqual((await samples.import({ folder: path.join(codex.root, 'app', 'resources', 'app.asar') })).chatgpt, ['cove']);
  assert.deepEqual((await samples.import({ folder: path.join(assets, '..') })).chatgpt, ['cove']);
  const fromClaude = await samples.import({ folder: claude.root });
  assert.deepEqual(fromClaude.claude, ['mellow']);
  assert.deepEqual(fromClaude.chatgpt, [], 'a new import replaces the previous set');
});

test('reading validates the id, the stored path and the stored hash', async t => {
  const root = await workspace(t);
  const samples = sampler(root, [await fakeCodex(root, { cove: wav() })]);
  await samples.import();
  for (const bad of ['', '../cove', 'cove/../x', 'COVE', 'claude:', 'a'.repeat(40), 7, null]) await assert.rejects(() => samples.read(bad), /Invalid voice sample/);
  const file = path.join(root, 'data', 'voice-samples', 'chatgpt', 'cove.wav');
  const bytes = await readFile(file); bytes[200] ^= 1; await writeFile(file, bytes);
  await assert.rejects(() => samples.read('cove', 'original'), /changed/);
  const manifestFile = path.join(root, 'data', 'voice-samples', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.clips.cove.original.file = '../../../secret.txt';
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(() => samples.read('cove', 'original'), /invalid/);
  await writeFile(manifestFile, '{ not json');
  assert.equal((await samples.status()).imported, false);
});

test('removing deletes the copies and a second import request shares the first', async t => {
  const root = await workspace(t);
  const samples = sampler(root, [await fakeCodex(root, { cove: wav() })]);
  const [one, two] = [samples.import(), samples.import()];
  assert.equal(one, two);
  await one;
  assert.equal((await samples.status()).imported, true);
  const removed = await samples.remove();
  assert.equal(removed.imported, false);
  assert.deepEqual(await readdir(path.join(root, 'data')), []);
});

test('app discovery accepts only the two known packages in the Windows apps folder', async () => {
  const output = [
    'OpenAI.Codex|26.1002.7124.0|C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1002.7124.0_x64__abc',
    'Claude|2.26454.0.0|C:\\Program Files\\WindowsApps\\Claude_2.26454.0.0_x64__def',
    'Evil.App|1.0|C:\\Program Files\\WindowsApps\\Evil',
    'Claude|1.0|D:\\somewhere\\else',
    'Claude|1.0; calc|C:\\Program Files\\WindowsApps\\Claude_x',
    'Claude|1.0|relative\\WindowsApps\\Claude',
    ''
  ].join('\r\n');
  const calls = [];
  const apps = await installedApps({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: async (file, args) => { calls.push([file, args]); return output; } });
  assert.deepEqual(apps.map(item => [item.app, item.version]), [['Codex', '26.1002.7124.0'], ['Claude', '2.26454.0.0']]);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /powershell\.exe$/);
  assert.ok(calls[0][1].includes('-NoProfile'));
  assert.deepEqual(await installedApps({ platform: 'win32', run: async () => { throw Error('missing'); } }), []);
  assert.deepEqual(await installedApps({ platform: 'linux' }), []);
  const mac = await installedApps({ platform: 'darwin', home: '/Users/example' });
  assert.ok(mac.some(item => item.root.endsWith('Claude.app')) && mac.some(item => item.root.endsWith('Codex.app')));
});
