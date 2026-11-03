// Inspect the actual inherited creator. No token or fixture normalization.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,lstat,readdir,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertWindowsProfileOwner} from '../desktop/profile-owner.mjs';
assert.equal(process.platform,'win32');
const run=promisify(execFile),powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const script=fileURLToPath(new URL('../desktop/profile-owner.ps1',import.meta.url));
const temporary=await realpath(os.tmpdir()),root=await mkdtemp(path.join(temporary,'exomina-owner-guard-'));
const read=async()=>JSON.parse((await run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,encoding:'utf8',timeout:10000})).stdout);
const report={};
try{
  report.before=await read();
  try{report.result=await assertWindowsProfileOwner();report.accepted=true;assert.equal(report.before.owner,'current-user');}
  catch(error){assert.equal(report.before.owner,'administrators');assert.equal(error.code,'WINDOWS_PROFILE_OWNER_UNSAFE');report.elevatedRefused=true;report.message=error.message;}
  report.after=await read();assert.deepEqual(report.after,report.before);report.ownerUnchanged=true;
  assert.deepEqual(await readdir(root),[]);report.futureDirectoryAbsent=true;
  console.log(JSON.stringify(report));
}finally{
  assert.equal(path.dirname(await realpath(root)),temporary);assert.equal((await lstat(root)).isSymbolicLink(),false);assert.deepEqual(await readdir(root),[]);
  await rm(root,{recursive:true,force:true});
}
