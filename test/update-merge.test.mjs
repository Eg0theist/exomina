import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {snapshotSource,readSnapshot,sourceTree,treeHash,sourcePath} from '../desktop/update-source.mjs';
import {UpdateMerge,mergeFile} from '../desktop/update-merge.mjs';
import {runProcess} from '../desktop/update-merge.mjs';

const A={id:'official-old',version:'1.0.0'},B={id:'official-new',version:'1.1.0'};
async function fixture(t){
  const home=await mkdtemp(path.join(tmpdir(),'exomina-merge-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const source=path.join(home,'Source'),appDir=path.join(home,'App'),incoming=path.join(home,'incoming'),stateDir=path.join(home,'state');
  const put=async(root,file,text)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);};
  await put(source,'package.json','{"name":"fixture","version":"1.0.0"}');await put(source,'desktop/main.mjs','const a=1;\nconst b=1;\nconst c=1;\n');
  await snapshotSource(source,path.join(appDir,'exomina-source'),A);
  await put(source,'desktop/main.mjs','const a=2;\nconst b=1;\nconst c=1;\n');
  await cp(source,path.join(home,'next-source'),{recursive:true});await put(path.join(home,'next-source'),'desktop/main.mjs','const a=1;\nconst b=1;\nconst c=2;\n');
  await snapshotSource(path.join(home,'next-source'),path.join(incoming,'exomina-source'),B);
  const merge=new UpdateMerge({home,appDir,stateDir});const current={installed:A,staged:B,buildPath:incoming,source:'public'};
  return {home,source,appDir,incoming,merge,current,put};
}
test('three-way preparation combines independent edits and never changes the live source',async t=>{
  const f=await fixture(t);assert.equal((await f.merge.inspect(f.current)).required,true);
  const plan=await f.merge.prepare(f.current);assert.equal(plan.conflicts.length,0);assert.equal(plan.phase,'prepared');
  assert.equal(await readFile(path.join(plan.workspace,'desktop/main.mjs'),'utf8'),'const a=2;\nconst b=1;\nconst c=2;\n');
  assert.equal(await readFile(path.join(f.source,'desktop/main.mjs'),'utf8'),'const a=2;\nconst b=1;\nconst c=1;\n');
  await assert.rejects(f.merge.approvedBuild(f.current),/verify/);
});
test('overlap, binary, add/add and edit/delete are explicit conflicts',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'exomina-diff-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const versions of [['a\n','b\n','c\n'],['a\0','b\0','c\0'],[undefined,'b','c'],['a','b',undefined]]){
    const r=await mergeFile(...versions.map(v=>v===undefined?undefined:Buffer.from(v)),{directory:dir});assert.equal(r.conflict,true);
  }
  assert.equal((await mergeFile(Buffer.from('a'),Buffer.from('a'),undefined)).bytes,undefined);
});
test('missing baseline and tampered source manifest cannot authorize a global replacement',async t=>{
  const f=await fixture(t);await rm(path.join(f.appDir,'exomina-source'),{recursive:true});assert.equal((await f.merge.inspect(f.current)).phase,'baseline-missing');
  await assert.rejects(f.merge.prepare(f.current));
  await f.put(path.join(f.incoming,'exomina-source','files'),'desktop/main.mjs','tampered');await assert.rejects(readSnapshot(path.join(f.incoming,'exomina-source')),/integrity/);
});
test('source traversal, private data and Windows aliases are refused',()=>{
  for(const file of ['../package.json','src/../../secret','src/a:stream','src/NUL.js','src/a.','accounts/token.json','src/.env','desktop/data/state.db'])assert.throws(()=>sourcePath(file));
});
test('verification receipts gate install and tampering invalidates them',async t=>{
  const f=await fixture(t),plan=await f.merge.prepare(f.current);let fail=false;
  f.merge.run=async(_command,_args,options)=>{
    await f.put(path.dirname(plan.workspace),'checks.json',JSON.stringify({checks:['dependencies','tests','package'].map(name=>({name,passed:!fail}))}));
    await f.put(plan.buildPath,'Exomina.exe','fixture');await f.put(plan.buildPath,'exomina.build.json',JSON.stringify({id:'custom-built',version:B.version,officialId:B.id,customized:true}));
    await cp(path.join(f.incoming,'exomina-source'),path.join(plan.buildPath,'exomina-source'),{recursive:true});return {code:fail?1:0,stdout:'checks',stderr:''};
  };
  fail=true;await assert.rejects(f.merge.verify(),/did not pass/);await assert.rejects(f.merge.approvedBuild(f.current),/verify/);
  fail=false;const checked=await f.merge.verify();assert.equal(checked.phase,'verified');assert.equal((await f.merge.approvedBuild(f.current)).staged.id,'custom-built');
  await f.put(plan.buildPath,'Exomina.exe','modified after checks');await assert.rejects(f.merge.approvedBuild(f.current),/changed/);
});
test('checked source promotion preserves the complete old tree and refuses subsequent source changes',async t=>{
  const f=await fixture(t),plan=await f.merge.prepare(f.current);await f.put(f.source,'personal-notes.txt','preserve me');
  plan.phase='verified';plan.package={id:'custom-built'};plan.verifiedHash=treeHash(await sourceTree(plan.workspace));plan.fullSourceHash=await f.merge.packageHash(plan.workspace);await f.merge.save(plan);
  const committed=await f.merge.commitInstalled(plan.package);assert.equal(committed.phase,'committed');assert.equal(await readFile(path.join(committed.sourceBackup,'personal-notes.txt'),'utf8'),'preserve me');
  assert.equal(await readFile(path.join(f.source,'desktop/main.mjs'),'utf8'),'const a=2;\nconst b=1;\nconst c=2;\n');
});
test('large UTF-8 merge capture is complete and overflow refuses success',async()=>{
  const expected='ä💡'.repeat(800000),script='process.stdout.write('+JSON.stringify('ä💡')+'.repeat(800000))';
  const result=await runProcess(process.execPath,['-e',script],{outputLimit:8*1024**2,truncate:false});assert.equal(result.stdout,expected);
  await assert.rejects(runProcess(process.execPath,['-e',script],{outputLimit:1000,truncate:false}),/capture limit/);
});
test('interrupted promotion resumes and source changes leave the original copy in place',async t=>{
  const f=await fixture(t),plan=await f.merge.prepare(f.current);plan.phase='promoting';plan.package={id:'custom-built'};plan.verifiedHash=treeHash(await sourceTree(plan.workspace));plan.fullSourceHash=await f.merge.packageHash(plan.workspace);await f.merge.save(plan);
  const {rename}=await import('node:fs/promises');await rename(f.source,path.join(f.home,'Source.previous-'+plan.id));assert.equal((await f.merge.commitInstalled(plan.package)).phase,'committed');
});
test('unchanged app.asar passes the installed-program check inside Electron',async t=>{
  const electron=path.resolve('node_modules/electron/dist/electron.exe');if(!await readFile(electron).then(()=>true,()=>false))return t.skip('Electron runtime not installed');
  const f=await fixture(t),{createPackage}=await import('@electron/asar');await f.put(f.home,'asar-input/main.js','module.exports=1;');
  await mkdir(path.join(f.appDir,'resources'),{recursive:true});await createPackage(path.join(f.home,'asar-input'),path.join(f.appDir,'resources','app.asar'));
  const {createHash}=await import('node:crypto'),files=[];
  for(const rel of ['resources/app.asar','exomina-source/manifest.json'])try{const bytes=await readFile(path.join(f.appDir,rel));files.push({path:rel.replaceAll('/','\\'),length:bytes.length,sha256:createHash('sha256').update(bytes).digest('base64')});}catch{}
  const {readdir}=await import('node:fs/promises');for(const name of await readdir(path.join(f.appDir,'exomina-source'),{recursive:true,withFileTypes:true}))if(name.isFile()){const rel=path.relative(f.appDir,path.join(name.parentPath,name.name));if(!files.some(x=>x.path===rel)){const bytes=await readFile(path.join(f.appDir,rel));files.push({path:rel,length:bytes.length,sha256:createHash('sha256').update(bytes).digest('base64')});}}
  await f.put(f.appDir,'exomina.program.json',JSON.stringify({schema:1,buildId:A.id,files}));
  const script='const {UpdateMerge}=await import('+JSON.stringify(new URL('../desktop/update-merge.mjs',import.meta.url).href)+');await new UpdateMerge({home:'+JSON.stringify(f.home)+',appDir:'+JSON.stringify(f.appDir)+',stateDir:'+JSON.stringify(path.join(f.home,'state'))+'}).assertProgramUnmodified({id:'+JSON.stringify(A.id)+'});console.log("ok")';
  const result=await runProcess(electron,['--input-type=module','-e',script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},outputLimit:1e6,truncate:true});
  assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/ok/);
});
test('installed program edits cannot be overwritten through the local-build route',async t=>{
  const f=await fixture(t);await f.put(f.appDir,'exomina.program.json',JSON.stringify({schema:1,buildId:A.id,files:[]}));await assert.rejects(f.merge.assertProgramUnmodified(A),/Unrecognized files/);
});

test('program receipts ignore only the regular package-root Chromium log',async t=>{
  const f=await fixture(t);
  await f.put(f.incoming,'DEBUG.LOG','runtime output');
  await f.put(f.incoming,'resources/debug.log','release asset');
  await f.put(f.incoming,'diagnostics.log','another release asset');
  const inventory=await f.merge.programTree(f.incoming),before=await f.merge.packageHash(f.incoming);
  assert.ok(!inventory.some(file=>file.path.toLowerCase()==='debug.log'));
  assert.ok(inventory.some(file=>file.path==='resources/debug.log'));
  assert.ok(inventory.some(file=>file.path==='diagnostics.log'));
  await f.put(f.incoming,'DEBUG.LOG','runtime output changed after approval');
  assert.equal(await f.merge.packageHash(f.incoming),before);
  await f.put(f.incoming,'resources/debug.log','changed release asset');
  assert.notEqual(await f.merge.packageHash(f.incoming),before);
});

test('runtime log exemption does not permit linked files or hide a directory',async t=>{
  const f=await fixture(t);
  await f.put(f.home,'outside-log','outside package');
  await link(path.join(f.home,'outside-log'),path.join(f.incoming,'debug.log'));
  await assert.rejects(f.merge.programTree(f.incoming),/Linked build files/);
  await rm(path.join(f.incoming,'debug.log'));
  await f.put(f.incoming,'debug.log/program.mjs','real program asset');
  assert.ok((await f.merge.programTree(f.incoming)).some(file=>file.path==='debug.log/program.mjs'));
});

test('legacy installed runtime-log entries allow log changes while program edits stay blocked',async t=>{
  const f=await fixture(t);
  await f.put(f.appDir,'Exomina.exe','unchanged program');
  const inventory=await f.merge.programTree(f.appDir);
  const files=inventory.map(file=>({path:file.path,length:file.size,sha256:Buffer.from(file.sha256,'hex').toString('base64')}));
  files.push({path:'DEBUG.LOG',length:1,sha256:Buffer.alloc(32).toString('base64')});
  await f.put(f.appDir,'exomina.program.json',JSON.stringify({schema:1,buildId:A.id,files}));
  await f.put(f.appDir,'debug.log','new mutable runtime log');
  await f.merge.assertProgramUnmodified(A);
  await f.put(f.appDir,'Exomina.exe','modified program');
  await assert.rejects(f.merge.assertProgramUnmodified(A),/Installed program files have been customized: Exomina.exe/);
  await f.put(f.appDir,'Exomina.exe','unchanged program');
  await f.put(f.appDir,'another.log','unrecognized file');
  await assert.rejects(f.merge.assertProgramUnmodified(A),/Unrecognized files/);
});
