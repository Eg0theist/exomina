import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grokRuntimeTarget, verifyGrokPackage, verifyGrokBinary } from './grok-runtime-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = grokRuntimeTarget();
const { version } = runtime;
const source = path.join(root, 'node_modules', ...runtime.package.split('/'));
const target = path.join(root, 'vendor', 'grok');
const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
verifyGrokPackage(manifest, runtime);
const binary = brotliDecompressSync(await readFile(path.join(source, 'bin', runtime.binary + '.br')));
const sha256 = verifyGrokBinary(binary, runtime);
await mkdir(target, { recursive: true });
const executable = path.join(target, runtime.binary);
await writeFile(executable, binary);
if (runtime.platform !== 'win32') await chmod(executable, 0o755);
await copyFile(path.join(source, 'THIRD_PARTY_NOTICES.md'), path.join(target, 'THIRD_PARTY_NOTICES.md'));
await copyFile(path.join(root, 'vendor', 'licenses', 'APACHE-2.0.txt'), path.join(target, 'APACHE-2.0.txt'));
await writeFile(path.join(target, 'provenance.json'), JSON.stringify({
  package: runtime.package, version, platform: runtime.platform, arch: runtime.arch, license: manifest.license,
  source: `https://www.npmjs.com/package/${runtime.package}/v/${version}`,
  sha256, transformation: 'Brotli decompression only; official executable bytes are unchanged.',
  installation: 'Bundled directly. The npm launcher and its home-directory postinstall are not run.',
}, null, 2) + '\n');
console.log(`Prepared official Grok ${version}; verified SHA-256 ${sha256}.`);
