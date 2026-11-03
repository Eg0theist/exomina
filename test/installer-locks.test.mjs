import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

test('actual Windows installer releases inherited cwd and handles native directory locks safely',{skip:process.platform!=='win32',timeout:60000},async()=>{
  const output=await mkdtemp(path.join(tmpdir(),'exomina-installer-locks-'));
  const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
  await promisify(execFile)(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-File',fileURLToPath(new URL('../scripts/qa-installer-locks.ps1',import.meta.url)),'-Output',output],{windowsHide:true,timeout:55000,env});
  const report=JSON.parse(await readFile(path.join(output,'installer-locks.json'),'utf8'));
  assert.equal(report.failure,undefined);
  for(const key of ['inheritedAppWorkingDirectoryReleased','actualInstallVerified','previousProgramPreserved','dataFoldersUntouched','transientLockRecovered','lastingLockBoundedAndPreserved','occupiedDestinationRejected','secondMoveLockRollsBack'])assert.equal(report[key],true,key);
});
