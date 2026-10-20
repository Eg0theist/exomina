import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {assertLinuxQaSocketLength} from '../scripts/native-qa-paths.mjs';

test('native Linux fixture reserves singleton socket space and counts UTF-8 bytes',()=>{
 const options={pathApi:path.posix};
 const result=assertLinuxQaSocketLength('/home/runner/work/exomina/exomina/.runtime-work/p-abcdef',options);
 assert.ok(result.candidateBytes<108);assert.equal(result.maximumExclusive,108);
 assert.throws(()=>assertLinuxQaSocketLength('/home/runner/work/exomina/exomina/.runtime-work/temp/exomina-native-desktop-profile-abcdef',options),/too long for Chromium sockets/);
 const unicode='/qa/'+'é'.repeat(35);
 assert.ok((unicode+'/data/runtime-tmp/scoped_dirXXXXXX/SingletonSocket').length<108);
 assert.throws(()=>assertLinuxQaSocketLength(unicode,options),/too long for Chromium sockets/);
});
