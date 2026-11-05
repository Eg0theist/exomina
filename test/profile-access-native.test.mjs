import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,lstat,realpath,readdir,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WindowsProfileAccess} from '../desktop/profile-access.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareWindowsQaOwner} from '../scripts/native-qa-windows-owner.mjs';

test('native Windows profile access accepts a fresh ordinary directory before app startup',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const owner=await prepareWindowsQaOwner();
  t.diagnostic(JSON.stringify({windowsQaProcessOwner:owner}));
  assert.equal(owner.ownerAfter,'current-user');assert.equal(owner.parentOwnerUnchanged,true);assert.equal(owner.identityUnchanged,true);
  const temporary=await realpath(os.tmpdir());
  const root=await mkdtemp(path.join(temporary,'exomina-profile-native-'));
  const access=new WindowsProfileAccess();
  t.after(async()=>{
    access.close();
    assert.equal(path.dirname(await realpath(root)),temporary,'Remove only the fresh fixture inside its explicit temporary root.');
    assert.equal((await lstat(root)).isSymbolicLink(),false);
    for(const entry of await readdir(root,{withFileTypes:true})){
      assert.ok(['child.txt','grandchild.txt'].includes(entry.name),'Remove only the synthetic files created by this probe.');
      assert.equal(entry.isFile(),true);
    }
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
  await writeFile(path.join(root,'child.txt'),'Synthetic child file.','utf8');
  await promisify(execFile)(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1], 'Synthetic grandchild file.', 'utf8')",path.join(root,'grandchild.txt')],{windowsHide:true,timeout:10000});
  assert.equal((await access.inspect(root)).entries,3,'The child and grandchild must inherit the ordinary user owner.');
  const prepared=await access.prepare(root);
  assert.equal(prepared.restrictedAccess,true);assert.equal(prepared.anyEncrypted,false);
  const verified=await access.verify(root);
  assert.equal(verified.restrictedAccess,true);assert.equal(verified.anyEncrypted,false);assert.equal(verified.entries,3);
  assert.equal(await readFile(path.join(root,'child.txt'),'utf8'),'Synthetic child file.');
  assert.equal(await readFile(path.join(root,'grandchild.txt'),'utf8'),'Synthetic grandchild file.');
});

test('Chromium sandbox grants are accepted only inside its own profile folders',{skip:process.platform!=='win32',timeout:60000},async t=>{
  await prepareWindowsQaOwner();
  const run=promisify(execFile),temporary=await realpath(os.tmpdir()),root=await mkdtemp(path.join(temporary,'exomina-profile-chromium-')),access=new WindowsProfileAccess();
  t.after(async()=>{access.close();assert.equal(path.dirname(await realpath(root)),temporary);await rm(root,{recursive:true,force:true});});
  if((await access.inspect(root)).anyEncrypted===true)await run(path.join(process.env.SystemRoot,'System32','cipher.exe'),['/d',root],{windowsHide:true});
  const icacls=path.join(process.env.SystemRoot,'System32','icacls.exe');
  const capability='S-1-15-3-1024-395641907-2340533657-1796656376-1949871151-3167452726-3934347287-2361051074-3061173417';
  const network=path.join(root,'browser-data','Network'),elsewhere=path.join(root,'other');
  await mkdir(network,{recursive:true});await mkdir(elsewhere);await writeFile(path.join(network,'cookies'),'x');
  assert.equal((await access.prepare(root)).restrictedAccess,true);
  for(const folder of [network,elsewhere])await run(icacls,[folder,'/grant','*'+capability+':(OI)(CI)(M)'],{windowsHide:true});
  // Outside Chromium's profile the same grant is unexpected, so verifying refuses it.
  await assert.rejects(access.verify(root),/could not be confirmed/);
  // Preparing removes it there and leaves Chromium's own grant, which then verifies.
  assert.equal((await access.prepare(root)).restrictedAccess,true);
  assert.equal((await access.verify(root)).restrictedAccess,true);
  const granted=async folder=>(await run(icacls,[folder],{windowsHide:true})).stdout.includes(capability);
  assert.equal(await granted(network),true);assert.equal(await granted(elsewhere),false);
  // Any other identity inside Chromium's profile is still refused.
  await run(icacls,[network,'/grant','*S-1-1-0:(R)'],{windowsHide:true});
  await assert.rejects(access.verify(root),/could not be confirmed/);
});
