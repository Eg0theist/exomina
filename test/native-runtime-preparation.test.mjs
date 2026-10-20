import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdtemp,rm,chmod,mkdir} from 'node:fs/promises';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {grokRuntimeTarget, verifyGrokPackage, verifyGrokBinary} from '../scripts/grok-runtime-config.mjs';
import {bundledGrokPaths, bundledPythonPath, bundledCuaPath} from '../desktop/runtime-targets.mjs';
import {ComputerTools} from '../desktop/computer-tools.mjs';
import {WindowsVoice} from '../desktop/voice.mjs';
import {nativeVendorTargets,validateNativeArchiveEntries} from '../scripts/native-vendor-config.mjs';
import {assertNativeBuildHost} from '../scripts/native-package-preflight.mjs';
import {nativeMarkerDirectories,crossPlatformConfig,markNativeDistribution,sandboxedAppRun} from '../scripts/cross-platform-config.mjs';

test('all official native Grok targets are pinned as optional and preparation rejects wrong targets or bytes',async()=>{
  const metadata=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
  const hashes=new Set();
  for(const platform of ['win32','darwin','linux'])for(const arch of ['x64','arm64']){
    const target=grokRuntimeTarget(platform,arch);
    assert.equal(metadata.optionalDependencies[target.package],target.version);
    assert.equal(metadata.dependencies[target.package],undefined);
    assert.equal(lock.packages[`node_modules/${target.package}`].optional,true);
    assert.match(target.sha256,/^[a-f0-9]{64}$/);hashes.add(target.sha256);
    const manifest={name:target.package,version:target.version,os:[platform],cpu:[arch]};
    verifyGrokPackage(manifest,target);
    for(const wrong of [{name:'unofficial-package'},{version:'0.0.0'},{os:['freebsd']},{cpu:['ia32']}]){
      assert.throws(()=>verifyGrokPackage({...manifest,...wrong},target),/pinned target/);
    }
    assert.throws(()=>verifyGrokBinary(Buffer.from('unverified artifact'),target),/verified distribution/);
    assert.equal(bundledGrokPaths('/app',{platform,arch,pathApi:path.posix}).length,1);
  }
  assert.equal(hashes.size,6);
  assert.throws(()=>grokRuntimeTarget('linux','ia32'),/No verified/);
  assert.deepEqual(bundledGrokPaths('/app',{platform:'linux',arch:'ia32',pathApi:path.posix}),[]);
});

test('native runtime locations follow verified standalone and Cua archive layouts',()=>{
  for(const platform of ['darwin','linux']){
    const options={platform,pathApi:path.posix};
    assert.equal(bundledPythonPath('/app',options),'/app/vendor/python/bin/python3');
    assert.equal(bundledCuaPath('/app',options),platform==='darwin'?'/app/vendor/cua-driver/CuaDriver.app/Contents/MacOS/cua-driver':'/app/vendor/cua-driver/cua-driver');
  }
  const options={platform:'win32',pathApi:path.win32};
  assert.equal(bundledPythonPath('C:\\app',options),'C:\\app\\vendor\\python\\python.exe');
  assert.equal(bundledCuaPath('C:\\app',options),'C:\\app\\vendor\\cua-driver\\cua-driver.exe');
  assert.throws(()=>bundledPythonPath('/app',{platform:'freebsd'}),/unavailable/);
  assert.throws(()=>bundledCuaPath('/app',{platform:'freebsd'}),/unavailable/);
});

test('native vendor preparation requires pinned archives and rejects unsafe or wrong-root paths',()=>{
  for(const platform of ['darwin','linux'])for(const arch of ['x64','arm64'])for(const target of nativeVendorTargets(platform,arch)){
    assert.match(target.url,/^https:\/\/github\.com\/(astral-sh\/python-build-standalone|trycua\/cua)\/releases\/download\//);
    assert.match(target.sha256,/^[a-f0-9]{64}$/);
    const executable=target.prefix+'/'+target.executable;
    validateNativeArchiveEntries([target.prefix+'/',executable],target);
    for(const invalid of ['/etc/passwd',target.prefix+'/../escape','different-root/bin/reader',target.prefix+'/C:\\escape']){
      assert.throws(()=>validateNativeArchiveEntries([executable,invalid],target),/unsafe path|unexpected root/);
    }
    assert.throws(()=>validateNativeArchiveEntries([target.prefix+'/LICENSE'],target),/expected executable/);
  }
  assert.throws(()=>nativeVendorTargets('linux','ia32'),/No verified/);
});

test('native packages contain target-matched program trees and correct beta marker locations',()=>{
  for(const platform of ['darwin','linux'])for(const arch of ['x64','arm64']){
    assertNativeBuildHost(platform,arch,{hostPlatform:platform,hostArch:arch});
    assert.throws(()=>assertNativeBuildHost(platform,arch,{hostPlatform:'win32',hostArch:arch}),/broken installer/);
    assert.throws(()=>assertNativeBuildHost(platform,arch,{hostPlatform:platform,hostArch:arch==='x64'?'arm64':'x64'}),/broken installer/);
    const config=crossPlatformConfig(platform,{arch});
    assert.deepEqual((platform==='darwin'?config.mac:config.linux).target.flatMap(item=>item.arch),[arch,arch]);
    assert.ok(!config.files.includes('!vendor/python/**'));
    assert.ok(!config.files.includes('!vendor/cua-driver/**/*.node'));
    assert.equal(config.publish,null);assert.equal(typeof config.afterPack,'function');
    if(platform==='linux')assert.deepEqual(config.appImage.executableArgs,[]);
  }
  const context={appOutDir:'/native/output',packager:{appInfo:{productFilename:'Exomina Beta'}}};
  assert.deepEqual(nativeMarkerDirectories({...context,electronPlatformName:'darwin'}),[path.join('/native/output','Exomina Beta.app','Contents','Resources')]);
  assert.deepEqual(nativeMarkerDirectories({...context,electronPlatformName:'linux'}),['/native/output']);
  assert.throws(()=>nativeMarkerDirectories({...context,electronPlatformName:'win32'}),/macOS or Linux/);
});

test('native builder configurations validate after the actual package.json merge',async()=>{
 const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 // Builder logging writes directly to its saved stdout stream. Keep it outside
 // Node 22's binary test-runner message pipe; schema failures still fail here.
 const environment={...process.env};delete environment.NODE_TEST_CONTEXT;
 const checked=await promisify(execFile)(process.execPath,[path.join(projectRoot,'scripts','validate-native-config.mjs')],{cwd:projectRoot,env:environment,timeout:15000});
 const configs=JSON.parse(checked.stdout.trim().split(/\r?\n/).at(-1));
 assert.equal(configs.length,8);
 for(const config of configs){
  assert.equal(config.electronDist,null,'Windows Electron path must not survive builder deep merge.');
  assert.equal(config.win,null);assert.equal(config.nsis,null);
  if(config.platform==='linux'){assert.equal(config.debPackageName,'exomina-beta');assert.deepEqual(config.formats,config.ciOnly?['deb']:['AppImage','deb']);}
  else{assert.equal(config.macIdentity,'-');assert.deepEqual(config.formats,config.ciOnly?['dmg']:['dmg','zip']);}
 }
 const entitlements=await readFile(new URL('../build/entitlements.mac.plist',import.meta.url),'utf8');
 assert.match(entitlements,/<key>com\.apple\.security\.cs\.disable-library-validation<\/key><true\/>/);
});

test('native afterPack overrides the builder sandbox bypass and survives its staging copy',async()=>{
 const fixture=await mkdtemp(path.join(os.tmpdir(),'exomina-sandbox-launcher-'));
 const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(fixture));
 assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
 try{
  const app=path.join(fixture,'app'),stage=path.join(fixture,'stage');
  await mkdir(app);await mkdir(stage);await writeFile(path.join(stage,'AppRun'),'exec electron --no-sandbox\n');
  await markNativeDistribution({electronPlatformName:'linux',appOutDir:app,packager:{appInfo:{version:'0.0.0'}}});
  const {copyDir}=createRequire(import.meta.url)('builder-util');await copyDir(app,stage);
  assert.equal(await readFile(path.join(stage,'AppRun'),'utf8'),sandboxedAppRun);
  assert.equal(JSON.parse(await readFile(path.join(stage,'exomina.distribution.json'),'utf8')).manualUpdates,true);
  if(process.platform!=='win32'){
   const executable=path.join(stage,'exomina-beta');
   await writeFile(executable,'#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');await chmod(executable,0o755);
   const result=await promisify(execFile)(path.join(stage,'AppRun'),['--sample','two words']);
   assert.equal(result.stdout,'--sample\ntwo words\n');
   for(const flag of ['--no-sandbox','--no-sandbox=true','--disable-setuid-sandbox']){
    await assert.rejects(promisify(execFile)(path.join(stage,'AppRun'),[flag]),error=>error.code===1&&error.stdout===''&&/requires the Chromium sandbox/.test(error.stderr));
   }
  }
 }finally{await rm(fixture,{recursive:true,force:true});}
});

test('Unix never advertises or runs Windows desktop helpers and distinguishes local speech from Realtime',async()=>{
  for(const platform of ['darwin','linux']){
    let approvals=0;
    const computer=new ComputerTools({dataDir:'synthetic',platform,getSettings:()=>({desktopEnabled:true}),approve:async()=>{approvals++;return true;}});
    assert.ok(computer.definitions.every(tool=>!tool.name.startsWith('desktop_')));
    assert.ok(computer.definitions.some(tool=>tool.name==='browser_open'));
    const result=await computer.call('desktop_screenshot',{},'synthetic');
    assert.equal(result.isError,true);assert.match(result.content[0].text,/approved Cua Driver/);assert.equal(approvals,0);
    const voice=new WindowsVoice({platform,spawnImpl:()=>{throw Error('must not spawn Windows helper');}});
    const status=await voice.status();assert.equal(status.available,false);assert.match(status.error,/Realtime voice/);voice.close();
  }
  assert.equal(new ComputerTools({dataDir:'synthetic',platform:'win32'}).definitions.filter(tool=>tool.name.startsWith('desktop_')).length,4);
});
