import test from 'node:test';
import assert from 'node:assert/strict';
import {betaInstallerPathLimits,betaInstallerPathRejections,betaInstallerPathInclude} from '../scripts/beta-installer-path-limits.mjs';

test('shipping file depth determines safe install and atomic temporary roots',()=>{
  const limits=betaInstallerPathLimits(['x'.repeat(179)]);
  assert.equal(limits.maxInstallRootChars,75);assert.equal(limits.maxTempRootChars,51);
  assert.equal(75+1+179,limits.nativePathChars);
  assert.equal(51+limits.tempSuffixChars+1+179,limits.nativePathChars);
  assert.ok(limits.nativePathChars<260,'The native buffer retains a safety margin.');
});
test('install-root boundary accepts 75 characters and refuses 76',()=>{
  const limits=betaInstallerPathLimits(['x'.repeat(179)]);
  assert.deepEqual(betaInstallerPathRejections({installRoot:'x'.repeat(75)},limits),[]);
  assert.deepEqual(betaInstallerPathRejections({installRoot:'x'.repeat(76)},limits),['installRoot']);
});
test('temporary-root boundary accepts 51 and refuses 52 including actual plugin growth',()=>{
  const limits=betaInstallerPathLimits(['x'.repeat(179)]);
  assert.deepEqual(betaInstallerPathRejections({tempRoot:'x'.repeat(51),atomicTempRoot:'x'.repeat(75)},limits),[]);
  assert.deepEqual(betaInstallerPathRejections({tempRoot:'x'.repeat(52),atomicTempRoot:'x'.repeat(76)},limits),['tempRoot','atomicTempRoot']);
});
test('directory enumeration and UTF-16 characters are counted in the native limit',()=>{
  const limits=betaInstallerPathLimits([{relative:'directory',type:'directory'},'a/😀.md']);
  assert.equal(limits.longestRelativePath,'directory\\*.*');assert.equal(limits.longestRelativePathChars,13);
  const utf16=betaInstallerPathLimits(['😀'.repeat(90)]);assert.equal(utf16.longestRelativePathChars,180);
});
test('future shipping depth adjusts limits and unsafe program paths are refused',()=>{
  assert.equal(betaInstallerPathLimits(['x'.repeat(180)]).maxTempRootChars,50);
  for(const entries of [[],['C:\\private'],['../private'],['x'.repeat(255)]])assert.throws(()=>betaInstallerPathLimits(entries));
});
test('generated include contains only public relative paths and calculated limits',()=>{
  const include=betaInstallerPathInclude(betaInstallerPathLimits(['x'.repeat(179)]));
  assert.match(include,/BETA_MAX_INSTALL_ROOT_CHARS 75/);assert.match(include,/BETA_MAX_TEMP_ROOT_CHARS 51/);
  assert.match(include,/BETA_MAX_ATOMIC_TEMP_ROOT_CHARS 75/);assert.doesNotMatch(include,/Users|accounts|report\.json/);
});
