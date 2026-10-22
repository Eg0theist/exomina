import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,lstat,realpath,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WindowsProfileAccess} from '../desktop/profile-access.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('native Windows profile access accepts a fresh ordinary directory before app startup',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const temporary=await realpath(os.tmpdir());
  const root=await mkdtemp(path.join(temporary,'exomina-profile-native-'));
  const access=new WindowsProfileAccess();
  t.after(async()=>{
    access.close();
    assert.equal(path.dirname(await realpath(root)),temporary,'Remove only the fresh fixture inside its explicit temporary root.');
    assert.equal((await lstat(root)).isSymbolicLink(),false);
    assert.deepEqual(await readdir(root),[],'This native access probe must create no account or app content.');
    await rm(root,{recursive:true,force:true});
  });
  assert.deepEqual(await readdir(root),[]);
  let inspected=await access.inspect(root);
  // Development TEMP may inherit EFS. Model an ordinary profile by decrypting
  // only this verified empty fixture, as native app startup QA already does.
  if(inspected.anyEncrypted){
    assert.equal(path.dirname(await realpath(root)),temporary);assert.equal((await lstat(root)).isSymbolicLink(),false);assert.deepEqual(await readdir(root),[]);
    await promisify(execFile)(path.join(process.env.SystemRoot,'System32','cipher.exe'),['/d',root],{windowsHide:true,timeout:10000});
    inspected=await access.inspect(root);
  }
  assert.equal(inspected.anyEncrypted,false,'The fresh ordinary profile fixture must start unencrypted.');
  assert.equal(inspected.entries,1);
  const prepared=await access.prepare(root);
  assert.equal(prepared.restrictedAccess,true);assert.equal(prepared.anyEncrypted,false);
  const verified=await access.verify(root);
  assert.equal(verified.restrictedAccess,true);assert.equal(verified.anyEncrypted,false);assert.equal(verified.entries,1);
});
