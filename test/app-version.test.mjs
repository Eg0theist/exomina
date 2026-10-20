import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {nextBuildVersion,prepareVersion} from '../scripts/prepare-version.mjs';
import {compareVersions} from '../desktop/public-updates.mjs';

async function fixture(t,version='0.5.0-beta.4') {
  const root = await mkdtemp(path.join(os.tmpdir(),'exomina-version-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'desktop'));
  await writeFile(path.join(root,'package.json'),JSON.stringify({name:'synthetic',version,scripts:{prepackage:'synthetic'}}));
  await writeFile(path.join(root,'package-lock.json'),JSON.stringify({name:'synthetic',version,lockfileVersion:3,packages:{'':{name:'synthetic',version},'node_modules/synthetic':{version:'2.0.0'}}}));
  return root;
}

test('packaging advances beta revisions and stable patches with semantic ordering', () => {
  for (const [version,next] of [['0.5.0-beta.4','0.5.0-beta.5'],['0.5.0-beta.9','0.5.0-beta.10'],['1.2.3','1.2.4'],['0.5.0-rc','0.5.0-rc.1']]) {
    assert.equal(nextBuildVersion(version),next);
    assert.ok(compareVersions(next,version)>0);
  }
  for (const version of ['0.5','0.5.0-beta.01','0.5.0+metadata','-1.2.3','1.2.9007199254740991']) assert.throws(() => nextBuildVersion(version));
});

test('renderer builds keep the version and packaged builds synchronize all manifests', async t => {
  const root=await fixture(t);
  assert.equal(await prepareVersion(root),'0.5.0-beta.4');
  assert.equal(await prepareVersion(root),'0.5.0-beta.4');
  assert.equal(await prepareVersion(root,{advance:true}),'0.5.0-beta.5');
  const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
  assert.equal(manifest.version,'0.5.0-beta.5');
  assert.equal(manifest.scripts.prepackage,'synthetic');
  assert.equal(lock.version,manifest.version);assert.equal(lock.packages[''].version,manifest.version);
  assert.equal(lock.packages['node_modules/synthetic'].version,'2.0.0');
  assert.equal(JSON.parse(await readFile(path.join(root,'desktop','app-version.json'),'utf8')).version,manifest.version);
  assert.equal(await prepareVersion(root,{advance:true}),'0.5.0-beta.6');
  assert.ok(!(await readdir(root)).some(file => file.includes('.version-')||file.endsWith('.lock')));
});

test('a concurrent version writer fails closed without changing the manifests', async t => {
  const root=await fixture(t),manifest=await readFile(path.join(root,'package.json'),'utf8');
  await writeFile(path.join(root,'.exomina-version.lock'),'synthetic active writer');
  await assert.rejects(prepareVersion(root,{advance:true}),/already running/);
  assert.equal(await readFile(path.join(root,'package.json'),'utf8'),manifest);
  assert.equal(await readFile(path.join(root,'.exomina-version.lock'),'utf8'),'synthetic active writer');
});

test('failed metadata publication rolls manifest changes back and releases the lock', async t => {
  const root=await fixture(t),manifest=await readFile(path.join(root,'package.json'),'utf8'),lock=await readFile(path.join(root,'package-lock.json'),'utf8');
  await rm(path.join(root,'desktop'),{recursive:true});
  await assert.rejects(prepareVersion(root,{advance:true}));
  assert.equal(await readFile(path.join(root,'package.json'),'utf8'),manifest);
  assert.equal(await readFile(path.join(root,'package-lock.json'),'utf8'),lock);
  assert.ok(!(await readdir(root)).includes('.exomina-version.lock'));
});
