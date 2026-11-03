import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,access,rm} from 'node:fs/promises';
import {removeChatAnalysisData,chatAnalysisFolder} from '../desktop/app-analysis-cleanup.mjs';

async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'exo-detach-'));t.after(()=>rm(root,{recursive:true,force:true}));const folder=chatAnalysisFolder(root,'ghidra-workspaces','one');await mkdir(path.join(folder,'binary'),{recursive:true});await writeFile(path.join(folder,'binary','Exomina.gpr'),'project');await writeFile(path.join(folder,'binary','checkpoint.gzf'),'checkpoint');return {root,folder};}

test('partial filesystem deletion only damages a detached folder and next explicit delete retries it',async t=>{
 const f=await fixture(t);let committed=false,pending;
 await assert.rejects(removeChatAnalysisData(f.root,'ghidra-workspaces','one',{folder:f.folder,onDetached:async value=>{await assert.rejects(access(f.folder),/ENOENT/);pending=value.pending;committed=true;},remove:async folder=>{assert.equal(committed,true);await rm(path.join(folder,'binary','Exomina.gpr'));throw Error('Simulated locked Windows file');}}),error=>error.analysisDetached===true&&error.cleanupDirectory===pending[0]&&/retry/.test(error.message));
 await assert.rejects(access(f.folder),/ENOENT/);assert.equal(await readFile(path.join(pending[0],'binary','checkpoint.gzf'),'utf8'),'checkpoint');
 const other=chatAnalysisFolder(f.root,'ghidra-workspaces','two');await mkdir(other);await writeFile(path.join(other,'keep'),'other chat');
 const result=await removeChatAnalysisData(f.root,'ghidra-workspaces','one',{folder:f.folder,onDetached:async value=>{assert.deepEqual(value.pending,pending);}});
 assert.equal(result.deleted,true);await assert.rejects(access(pending[0]),/ENOENT/);assert.equal(await readFile(path.join(other,'keep'),'utf8'),'other chat');
});

test('failed metadata commit restores the intact folder before any recursive removal',async t=>{
 const f=await fixture(t);let removed=false;
 await assert.rejects(removeChatAnalysisData(f.root,'ghidra-workspaces','one',{folder:f.folder,onDetached:async()=>{throw Error('Save failed');},remove:async()=>{removed=true;}}),error=>error.analysisDetached===false&&/Save failed/.test(error.message));
 assert.equal(removed,false);assert.equal(await readFile(path.join(f.folder,'binary','Exomina.gpr'),'utf8'),'project');assert.equal((await readdir(path.dirname(f.folder))).filter(name=>name.includes('.deleting-')).length,0);
});

test('external Ghidra locks and mismatched owner paths are refused before detaching',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.folder,'binary','Exomina.lock~'),'external lock');
 await assert.rejects(removeChatAnalysisData(f.root,'ghidra-workspaces','one',{folder:f.folder}),/open|lock/);assert.equal(await readFile(path.join(f.folder,'binary','Exomina.gpr'),'utf8'),'project');
 await assert.rejects(removeChatAnalysisData(f.root,'ghidra-workspaces','one',{folder:path.dirname(f.folder)}),/escaped/);
});

test('ordinary lockfiles in copied inspection sources do not block report cleanup',async t=>{
 const f=await fixture(t),folder=chatAnalysisFolder(f.root,'app-analysis','one');await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'Cargo.lock'),'package lock');await writeFile(path.join(folder,'Exomina.lock'),'copied source, not a Ghidra project');
 assert.equal((await removeChatAnalysisData(f.root,'app-analysis','one',{folder})).deleted,true);await assert.rejects(access(folder),/ENOENT/);assert.equal(await readFile(path.join(f.folder,'binary','Exomina.gpr'),'utf8'),'project');
});
