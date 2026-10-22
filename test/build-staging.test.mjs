import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat,rm,rmdir,symlink,link,rename,unlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {finished} from 'node:stream/promises';
import {createPackage} from '@electron/asar';
import {stagingPaths,stageBuild,recoverStaging,inspectPackage,withStagingLock,assertPackageIdle} from '../scripts/stage-build.mjs';
import {packageLocal} from '../scripts/package-local.mjs';

const idle=async()=>{};
async function fixture(t){
  const home=await mkdtemp(path.join(os.tmpdir(),'exomina-staging-')),root=path.join(home,'Source');
  t.after(async()=>{assert.equal(path.dirname(home),os.tmpdir());assert.ok(path.basename(home).startsWith('exomina-staging-'));await rm(home,{recursive:true,force:true});});
  await mkdir(root);const p=stagingPaths(root);await mkdir(p.work,{recursive:true});
  await mkdir(path.join(home,'App'));await writeFile(path.join(home,'App','keep'),'installed');
  await mkdir(path.join(home,'App.previous-current'));await writeFile(path.join(home,'App.previous-current','keep'),'rollback');
  const make=async(dir,revision,{padding=0}={})=>{
    const build={id:'synthetic-build-'+revision,version:'0.5.0-beta.'+revision,builtAt:new Date(1700000000000+revision*1000).toISOString()};
    await mkdir(path.join(dir,'resources','app.asar.unpacked','desktop'),{recursive:true});
    const input=path.join(home,'asar-input-'+revision);await mkdir(input);
    if(padding)await writeFile(path.join(input,'a-padding.bin'),Buffer.alloc(padding,revision));
    await writeFile(path.join(input,'package.json'),JSON.stringify({version:build.version}));
    // The pinned ASAR API resolves with its output stream before the final
    // buffered write finishes. Inventory only a completed fixture archive.
    const archive=await createPackage(input,path.join(dir,'resources','app.asar'));await finished(archive);
    await writeFile(path.join(dir,'Exomina.exe'),'synthetic executable '+revision);await writeFile(path.join(dir,'exomina.build.json'),JSON.stringify(build));
    await writeFile(path.join(dir,'resources','app.asar.unpacked','desktop','app-version.json'),JSON.stringify({version:build.version}));
    return build;
  };
  const protectedUnchanged=async()=>{for(const [folder,value] of [['App','installed'],['App.previous-current','rollback']])assert.equal(await readFile(path.join(home,folder,'keep'),'utf8'),value);};
  return {home,root,p,make,protectedUnchanged};
}
const present=file=>lstat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});

test('promotion reads fresh archive headers after package paths are replaced',async t=>{
  const f=await fixture(t);await f.make(f.p.stage,1);
  // Offset zero happened to work for all original one-file archive fixtures.
  // Real releases change archive header sizes and packed-file offsets.
  for(const [revision,padding] of [[2,4096],[3,8192]]){
    const next=await f.make(f.p.candidate,revision,{padding});
    await inspectPackage(f.p.stage); // Prime the old pathname's ASAR cache.
    const result=await stageBuild({root:f.root,expectedId:next.id,idle});
    assert.equal(result.build.id,next.id);
    assert.equal((await inspectPackage(f.p.stage)).build.version,next.version);
    await f.protectedUnchanged();
  }
});

test('successive promotions retain exactly one stage and remove superseded bytes',async t=>{
  const f=await fixture(t);await f.make(f.p.stage,1);
  for(const revision of [2,3,4]){
    const build=await f.make(f.p.candidate,revision),seen=[];
    const result=await stageBuild({root:f.root,expectedId:build.id,idle,verify:async dir=>seen.push(dir)});
    assert.deepEqual(seen,[f.p.candidate,f.p.stage]);assert.equal(result.cleanup.status,'removed');assert.ok(result.cleanup.bytes>0);
    assert.equal((await inspectPackage(f.p.stage)).build.id,build.id);
    assert.equal(await present(f.p.candidate),false);assert.equal(await present(f.p.previous),false);assert.equal(await present(f.p.journal),false);
    assert.deepEqual((await readdir(f.p.work)).sort(),['candidate']);await f.protectedUnchanged();
  }
});
test('an invalid candidate never displaces the current stage',async t=>{
  const f=await fixture(t),old=await f.make(f.p.stage,1);await f.make(f.p.candidate,2);
  await writeFile(path.join(f.p.candidate,'resources','app.asar.unpacked','desktop','app-version.json'),'{"version":"wrong"}');
  await assert.rejects(stageBuild({root:f.root,idle}),/versions/);assert.equal((await inspectPackage(f.p.stage)).build.id,old.id);assert.equal(await present(f.p.journal),false);await f.protectedUnchanged();
});
test('post-promotion verification failure restores the stage and preserves candidate',async t=>{
  const f=await fixture(t),old=await f.make(f.p.stage,1),next=await f.make(f.p.candidate,2);
  await assert.rejects(stageBuild({root:f.root,idle,verify:async dir=>{if(dir===f.p.stage)throw Error('synthetic verification failure');}}),/synthetic verification/);
  assert.equal((await inspectPackage(f.p.stage)).build.id,old.id);assert.equal((await inspectPackage(f.p.candidate)).build.id,next.id);assert.equal(await present(f.p.journal),false);await f.protectedUnchanged();
});
test('first stage succeeds without a previous package',async t=>{
  const f=await fixture(t),next=await f.make(f.p.candidate,1);const result=await stageBuild({root:f.root,idle});assert.equal(result.build.id,next.id);assert.equal(result.cleanup.bytes,0);await f.protectedUnchanged();
});
test('cleanup defers safely, blocks another promotion, and resumes from a remaining subset',async t=>{
  const f=await fixture(t);await f.make(f.p.stage,1);const next=await f.make(f.p.candidate,2);
  const result=await stageBuild({root:f.root,idle:async dir=>{if(dir===f.p.previous)throw Error('synthetic locked file');}});
  assert.equal(result.cleanup.status,'deferred');assert.equal((await inspectPackage(f.p.stage)).build.id,next.id);
  await assert.rejects(stageBuild({root:f.root,idle}),/unfinished staging transaction/);
  await unlink(path.join(f.p.previous,'Exomina.exe')); // Simulate a partially completed deletion.
  assert.equal((await recoverStaging({root:f.root,idle})).cleanup.status,'removed');assert.equal(await present(f.p.previous),false);assert.equal(await present(f.p.journal),false);await f.protectedUnchanged();
});
test('changed and unexpected previous files are retained during cleanup recovery',async t=>{
  const f=await fixture(t);await f.make(f.p.stage,1);await f.make(f.p.candidate,2);
  await stageBuild({root:f.root,idle:async dir=>{if(dir===f.p.previous)throw Error('defer');}});
  await writeFile(path.join(f.p.previous,'personal.txt'),'keep');
  const result=await recoverStaging({root:f.root,idle});assert.equal(result.cleanup.status,'deferred');assert.equal(await readFile(path.join(f.p.previous,'personal.txt'),'utf8'),'keep');assert.equal(await present(path.join(f.p.previous,'Exomina.exe')),true);
});
test('a crash during an uncommitted swap restores old stage without deleting either input',async t=>{
  const f=await fixture(t);await f.make(f.p.stage,1);await f.make(f.p.candidate,2);
  const previous=await inspectPackage(f.p.stage),next=await inspectPackage(f.p.candidate);
  await writeFile(f.p.journal,JSON.stringify({schema:1,phase:'prepared',candidate:f.p.candidate,previous,next}));await rename(f.p.stage,f.p.previous);await rename(f.p.candidate,f.p.stage);
  assert.equal((await recoverStaging({root:f.root,idle})).status,'restored');assert.equal((await inspectPackage(f.p.stage)).build.id,previous.build.id);assert.equal((await inspectPackage(f.p.candidate)).build.id,next.build.id);await f.protectedUnchanged();
});
test('external paths, unexpected directories and hard links are refused before mutations',async t=>{
  const f=await fixture(t);await f.make(f.p.stage,1);const outside=path.join(f.home,'App','candidate','win-unpacked');await f.make(outside,2);
  await assert.rejects(stageBuild({root:f.root,candidate:outside,idle}),/Candidate must/);
  await f.make(f.p.candidate,3);await mkdir(path.join(f.p.candidate,'Private'));await assert.rejects(stageBuild({root:f.root,idle}),/Unexpected package directory/);await rmdir(path.join(f.p.candidate,'Private'));
  await link(path.join(f.p.stage,'Exomina.exe'),path.join(f.p.candidate,'linked.exe'));await assert.rejects(stageBuild({root:f.root,idle}),/Linked package/);await f.protectedUnchanged();
});
test('linked staging ancestors and recovery paths outside Workspace are refused',async t=>{
  const f=await fixture(t);await f.make(f.p.stage,1);await f.make(f.p.candidate,2);
  const next=await inspectPackage(f.p.candidate);await writeFile(f.p.journal,JSON.stringify({schema:1,phase:'prepared',candidate:path.join(f.home,'App','missing'),next,previous:await inspectPackage(f.p.stage)}));
  await assert.rejects(recoverStaging({root:f.root,idle}),/Candidate must/);await unlink(f.p.journal);
  const alternate=path.join(f.home,'linked-source');await symlink(f.root,alternate,process.platform==='win32'?'junction':'dir');await assert.rejects(withStagingLock(alternate,async()=>{}),/Linked source/);await f.protectedUnchanged();
});
test('the staging lock rejects concurrent writers and remains owned by its holder',async t=>{
  const f=await fixture(t);
  await withStagingLock(f.root,async()=>{await assert.rejects(withStagingLock(f.root,async()=>assert.fail()),/Another build/);assert.equal(await present(f.p.lock),true);});assert.equal(await present(f.p.lock),false);
});
test('package orchestration uses the fixed candidate and leaves current stage on build failure',async t=>{
  const f=await fixture(t);await f.make(f.p.stage,1);const calls=[];
  await packageLocal({root:f.root,prepare:async(root,options)=>{assert.equal(root,f.root);assert.deepEqual(options,{advance:false});return '0.5.0-beta.2';},run:async(root,args)=>{calls.push(args);if(args[0].includes('electron-builder'))await f.make(f.p.candidate,2);},stage:options=>stageBuild({...options,idle})});
  assert.ok(calls.find(args=>args[0].includes('electron-builder')).includes('--config.directories.output='+path.dirname(f.p.candidate)));assert.equal((await inspectPackage(f.p.stage)).build.id,'synthetic-build-2');
  await assert.rejects(packageLocal({root:f.root,prepare:async()=> '0.5.0-beta.3',run:async(root,args)=>{if(args[0].includes('electron-builder')){await f.make(f.p.candidate,3);throw Error('synthetic build failure');}}}),/synthetic build failure/);
  assert.equal((await inspectPackage(f.p.stage)).build.id,'synthetic-build-2');await assert.rejects(packageLocal({root:f.root,prepare:async()=>assert.fail('version must not advance')}),/previous build transaction/);await f.protectedUnchanged();
});
test('Windows process check detects a package script in use',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);await f.make(f.p.candidate,1);const script=path.join(f.p.candidate,'resources','hold.mjs');await writeFile(script,"console.log('ready');setInterval(()=>{},1000);");
  const child=spawn(process.execPath,[script],{windowsHide:true,stdio:['ignore','pipe','ignore']});t.after(()=>child.kill());await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);});
  await assert.rejects(assertPackageIdle(f.p.candidate),/in use|process state/);child.kill();await new Promise(resolve=>child.once('exit',resolve));
});
