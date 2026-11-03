import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {preparePackageVersion,recordPackageVersion,packageSourceHash} from '../scripts/package-version.mjs';
import {packageLocal} from '../scripts/package-local.mjs';
import {prepareVersion} from '../scripts/prepare-version.mjs';
import {buildIdentity} from '../src/build-label.js';

async function fixture(t){
  const home=await mkdtemp(path.join(os.tmpdir(),'exomina-patch-')),root=path.join(home,'Source'),stage=path.join(root,'release','win-unpacked');
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(path.join(root,'desktop'),{recursive:true});await mkdir(stage,{recursive:true});await mkdir(path.join(home,'App'));
  await writeFile(path.join(root,'package.json'),JSON.stringify({name:'synthetic',version:'0.6.1'}),'utf8');
  await writeFile(path.join(root,'package-lock.json'),JSON.stringify({version:'0.6.1',packages:{'':{version:'0.6.1'},'node_modules/fixture':{version:'1.0.0'}}}),'utf8');
  await writeFile(path.join(root,'desktop','main.mjs'),'// first implementation','utf8');
  await writeFile(path.join(home,'App','exomina.build.json'),JSON.stringify({id:'installed-build',version:'0.6.1'}),'utf8');
  const publish=async version=>{
    const build={id:'synthetic-'+version,version};
    await writeFile(path.join(stage,'exomina.build.json'),JSON.stringify(build),'utf8');
    return recordPackageVersion(root,build);
  };
  return {home,root,publish};
}

test('automatic updates advance once, failed retries and unchanged rebuilds keep the version',async t=>{
  const f=await fixture(t);
  assert.equal(await preparePackageVersion(f.root),'0.6.2');
  // Simulate a failed build before a successful stage is recorded.
  assert.equal(await preparePackageVersion(f.root),'0.6.2');
  await f.publish('0.6.2');
  assert.equal(await preparePackageVersion(f.root),'0.6.2');
  await writeFile(path.join(f.root,'desktop','main.mjs'),'// changed implementation','utf8');
  assert.equal(await preparePackageVersion(f.root),'0.6.3');
  assert.equal(await preparePackageVersion(f.root),'0.6.3');
  await f.publish('0.6.3');
  const manifest=JSON.parse(await readFile(path.join(f.root,'package.json'),'utf8')),lock=JSON.parse(await readFile(path.join(f.root,'package-lock.json'),'utf8'));
  assert.equal(manifest.version,'0.6.3');assert.equal(lock.version,'0.6.3');assert.equal(lock.packages[''].version,'0.6.3');
  assert.equal(lock.packages['node_modules/fixture'].version,'1.0.0');
});

test('asset builds do not consume patches, deliberate minor releases retain their selection',async t=>{
  const f=await fixture(t);
  assert.equal(await prepareVersion(f.root),'0.6.1');
  assert.equal(await prepareVersion(f.root),'0.6.1');
  assert.equal(await preparePackageVersion(f.root),'0.6.2');await f.publish('0.6.2');
  assert.equal(await prepareVersion(f.root,{release:'minor'}),'0.7.0');
  assert.equal(await preparePackageVersion(f.root),'0.7.0');await f.publish('0.7.0');
  assert.equal(await preparePackageVersion(f.root),'0.7.0');
  await writeFile(path.join(f.root,'desktop','main.mjs'),'// next fix','utf8');
  assert.equal(await preparePackageVersion(f.root),'0.7.1');
});

test('explicit keep-version preserves a release for changed source without disabling later automatic patches',async t=>{
  const f=await fixture(t);
  await prepareVersion(f.root,{setVersion:'0.7.0'});await f.publish('0.7.0');
  assert.equal(await preparePackageVersion(f.root,{keepVersion:true}),'0.7.0');
  await writeFile(path.join(f.root,'desktop','main.mjs'),'// revised same release','utf8');
  assert.equal(await preparePackageVersion(f.root,{keepVersion:true}),'0.7.0');
  const manifest=JSON.parse(await readFile(path.join(f.root,'package.json'),'utf8'));
  const lock=JSON.parse(await readFile(path.join(f.root,'package-lock.json'),'utf8'));
  const metadata=JSON.parse(await readFile(path.join(f.root,'desktop','app-version.json'),'utf8'));
  assert.equal(manifest.version,'0.7.0');assert.equal(lock.version,'0.7.0');
  assert.equal(lock.packages[''].version,'0.7.0');assert.equal(metadata.version,'0.7.0');
  await f.publish('0.7.0');
  await writeFile(path.join(f.root,'desktop','main.mjs'),'// later default build','utf8');
  assert.equal(await preparePackageVersion(f.root),'0.7.1');
});

test('explicit keep-version refuses a downgrade against installed, staged and retained history versions',async t=>{
  for(const authority of ['installed','staged','history'])await t.test(authority,async t=>{
    const f=await fixture(t);
    if(authority==='history'){
      await prepareVersion(f.root,{setVersion:'0.7.1'});await f.publish('0.7.1');
      await rm(path.join(f.root,'release','win-unpacked'),{recursive:true});
    }else{
      const stamp=authority==='installed'?path.join(f.home,'App','exomina.build.json'):path.join(f.root,'release','win-unpacked','exomina.build.json');
      await writeFile(stamp,JSON.stringify({id:'newer-'+authority,version:'0.7.1'}),'utf8');
    }
    await prepareVersion(f.root,{setVersion:'0.7.0'});
    const files=['package.json','package-lock.json','desktop/app-version.json'];
    const before=await Promise.all(files.map(file=>readFile(path.join(f.root,file),'utf8')));
    await assert.rejects(preparePackageVersion(f.root,{keepVersion:true}),/Cannot keep version 0\.7\.0 below the latest package version 0\.7\.1/);
    assert.deepEqual(await Promise.all(files.map(file=>readFile(path.join(f.root,file),'utf8'))),before);
  });
});

test('local packaging forwards the explicit version choice before invoking build commands',async t=>{
  const f=await fixture(t),calls=[];
  for(const keepVersion of [false,true]){
    await assert.rejects(packageLocal({root:f.root,keepVersion,
      prepare:async(root,options)=>{assert.equal(root,f.root);calls.push(options);return '0.7.0';},
      run:async()=>{throw Error('synthetic stop before building');}
    }),/synthetic stop before building/);
  }
  assert.deepEqual(calls,[{keepVersion:false},{keepVersion:true}]);
});

test('version history prevents reusing published versions after stage cleanup or source rollback',async t=>{
  const f=await fixture(t);await preparePackageVersion(f.root);await f.publish('0.6.2');
  await rm(path.join(f.root,'release','win-unpacked'),{recursive:true});
  await prepareVersion(f.root,{setVersion:'0.6.1'});
  assert.equal(await preparePackageVersion(f.root),'0.6.3');
  await assert.rejects(recordPackageVersion(f.root,{id:'wrong',version:'0.6.2'}),/differs from Source/);
});

test('source identity ignores version synchronization but includes code and dependency changes',async t=>{
  const f=await fixture(t),first=await packageSourceHash(f.root);
  await prepareVersion(f.root,{setVersion:'0.7.0'});assert.equal(await packageSourceHash(f.root),first);
  const lock=JSON.parse(await readFile(path.join(f.root,'package-lock.json'),'utf8'));lock.packages['node_modules/fixture'].version='1.0.1';
  await writeFile(path.join(f.root,'package-lock.json'),JSON.stringify(lock),'utf8');
  assert.notEqual(await packageSourceHash(f.root),first);
});

test('a newer installed version wins over an older local stage and corrupt history fails closed',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.home,'App','exomina.build.json'),JSON.stringify({id:'newer-install',version:'0.6.8'}),'utf8');
  assert.equal(await preparePackageVersion(f.root),'0.6.9');
  await writeFile(path.join(f.root,'release','package-version.json'),'{"format":1,"version":"0.6.9"}','utf8');
  await assert.rejects(preparePackageVersion(f.root),/Invalid package version history/);
});

test('build labels retain full versions and distinguish otherwise equal versions',()=>{
  assert.equal(buildIdentity({version:'0.6.2',id:'12345678-abcd'}),'0.6.2 · 12345678');
  assert.equal(buildIdentity({version:'0.7.0-rc.2',id:'87654321-abcd'}),'0.7.0-rc.2 · 87654321');
  assert.equal(buildIdentity({version:'0.6.2'}),'0.6.2');
  assert.equal(buildIdentity({version:'0.6.2',id:'../invalid/id'}),'0.6.2');
});
