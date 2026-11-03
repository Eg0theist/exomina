import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('actual Windows archive extractor accepts valid files and refuses unsafe paths and links',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'exomina-archive-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {stdout}=await promisify(execFile)(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/qa-tool-update-archive.ps1'),'-CaseRoot',root],{windowsHide:true,timeout:30000,encoding:'utf8'});
 const result=JSON.parse(stdout);assert.equal(result.length,8);assert.equal(result.filter(row=>row.accepted).length,1);assert.equal(result.find(row=>row.accepted).id,'valid');
});
