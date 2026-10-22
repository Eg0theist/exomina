import test from 'node:test';
import assert from 'node:assert/strict';
import {Updater} from '../desktop/updates.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {UpdateMerge,runProcess} from '../desktop/update-merge.mjs';

test('private beta updates never launch the legacy Program Files updater',async()=>{
 const updater=new Updater({packaged:true,appDir:'synthetic-beta',home:'synthetic-home',manualUpdates:true,repositoryUrl:'https://github.com/example/exomina',spawnImpl:()=>{throw Error('Must not launch a legacy updater.');}});
 const status=await updater.status();assert.equal(status.supported,false);assert.equal(status.manualUpdates,true);assert.match(status.reason,/latest installer/);assert.equal(status.repositoryUrl,'https://github.com/example/exomina');
 await assert.rejects(()=>updater.launch(),/latest installer/);updater.close();
 const hostile=new Updater({packaged:true,manualUpdates:true,repositoryUrl:'https://github.com.evil.example/example/exomina'});assert.equal((await hostile.status()).repositoryUrl,'');hostile.close();
});
test('manual beta installer refuses changed program files and missing legacy baseline',async t=>{
 const app=await mkdtemp(path.join(tmpdir(),'exomina-beta-guard-'));t.after(()=>rm(app,{recursive:true,force:true}));
 await mkdir(path.join(app,'resources'));await writeFile(path.join(app,'Exomina.exe'),'synthetic never executed');await writeFile(path.join(app,'exomina.build.json'),JSON.stringify({id:'synthetic-beta'}));
 const check=()=>runProcess('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',path.resolve('scripts/verify-beta-update.ps1'),'-App',app]);
 assert.notEqual((await check()).code,0);
 const files=await new UpdateMerge({}).programTree(app);await writeFile(path.join(app,'exomina.release-integrity.json'),JSON.stringify({format:1,buildId:'synthetic-beta',files}));const verified=await check();assert.equal(verified.code,0,verified.stdout+'\n'+verified.stderr);
 await writeFile(path.join(app,'Uninstall Exomina.exe'),'Synthetic installer-generated uninstaller, never executed');
 await writeFile(path.join(app,'debug.log'),'Synthetic Chromium log');assert.equal((await check()).code,0);
 await mkdir(path.join(app,'added'));await writeFile(path.join(app,'added','debug.log'),'An unexpected nested file');assert.notEqual((await check()).code,0);
 await rm(path.join(app,'added'),{recursive:true});
 await writeFile(path.join(app,'Exomina.exe'),'changed after release');const refused=await check();assert.notEqual(refused.code,0);assert.match(refused.stdout,/Customized beta file/);
});
