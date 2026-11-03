import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
test('Windows update automatically restores a failed startup and refuses unsafe recovery inputs',{skip:process.platform!=='win32',timeout:45000},async()=>{
  const base=fileURLToPath(new URL('../../Workspace/.exomina-qa-temp/',import.meta.url));await mkdir(base,{recursive:true});
  const output=await mkdtemp(path.join(base,'update-recovery-')),env={...process.env};
  for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
  await promisify(execFile)(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../scripts/qa-update-recovery.ps1',import.meta.url)),'-Output',output,'-Installer',fileURLToPath(new URL('../scripts/install-windows.ps1',import.meta.url)),'-NodeExe',process.execPath],{env,windowsHide:true,timeout:40000});
  const report=JSON.parse(await readFile(path.join(output,'recovery-result.json'),'utf8'));
  assert.equal(report.passed,true,report.error);assert.equal(Object.keys(report.checks).length,14);assert.ok(Object.values(report.checks).every(value=>value===true));
});
