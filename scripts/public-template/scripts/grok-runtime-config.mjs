import {createHash} from 'node:crypto';

export const GROK_VERSION = '1.0.46';

// SHA-256 hashes of the decompressed executables in the pinned official npm
// platform packages. Preparation never runs the package launcher/postinstall.
const TARGETS = Object.freeze({
  'win32-x64': '47ad7fbc51767b8b301714111a1e452acc2c89912c08be260e1779a383302a4c',
  'win32-arm64': 'eac68ce1ac69d7a5a571deb51bade6c675206de81960e6a2cc40515d76a67532',
  'darwin-x64': '5bfc1251b1a7307b9366d0cb5a1fd3f2563b5b319df49f9a9b09b4efe557fea8',
  'darwin-arm64': 'e8daa302364c9c3b6a5546d511cfbd1ab5e5d407a9b04282f660665ea405f9f3',
  'linux-x64': '41626a53292324140b92556b9d42ff5542e3dcd04aff85eafb8689dd4adb44fc',
  'linux-arm64': '45b0943e736f00a249b9cf02af2be9e0749d97c09a6f55cfcf3029a1a836f23e',
});

export function grokRuntimeTarget(platform = process.platform, arch = process.arch) {
  const sha256 = TARGETS[`${platform}-${arch}`];
  if (!sha256) throw new Error(`No verified Grok runtime for ${platform}/${arch}.`);
  return Object.freeze({
    package: `@xai-official/grok-${platform}-${arch}`,
    platform, arch, version: GROK_VERSION, sha256,
    binary: platform === 'win32' ? 'grok.exe' : 'grok',
  });
}

export function verifyGrokPackage(manifest, target) {
  if (manifest.name !== target.package || manifest.version !== target.version ||
      !manifest.os?.includes(target.platform) || !manifest.cpu?.includes(target.arch)) {
    throw new Error('Grok runtime package does not match the pinned target.');
  }
}

export function verifyGrokBinary(binary, target) {
  const sha256 = createHash('sha256').update(binary).digest('hex');
  if (sha256 !== target.sha256) throw new Error('Grok runtime binary does not match the verified distribution.');
  return sha256;
}
