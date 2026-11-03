import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createPackageWithOptions} from '@electron/asar';
import {runtimeDependencies,verifyPackageDependencies,beforePack} from '../scripts/package-dependencies.mjs';

async function fixture(t){
 const home=await mkdtemp(path.join(os.tmpdir(),'exomina-dependency-check-'));
 assert.equal(path.dirname(home),path.resolve(os.tmpdir()));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const root=path.join(home,'source'),packed=path.join(home,'input'),archive=path.join(home,'app.asar');
 for(const folder of [root,packed])await mkdir(path.join(folder,'node_modules'),{recursive:true});
 const json=(file,value)=>writeFile(file,JSON.stringify(value),'utf8');
 await json(path.join(root,'package.json'),{dependencies:{provider:'1.0.0'}});
 async function module(folder,name,metadata,files={}){
  const directory=path.join(folder,'node_modules',name);await mkdir(directory,{recursive:true});
  await json(path.join(directory,'package.json'),{name,version:'1.0.0',...metadata});
  for(const [name,content] of Object.entries(files)){await mkdir(path.dirname(path.join(directory,name)),{recursive:true});await writeFile(path.join(directory,name),content,'utf8');}
 }
 for(const folder of [root,packed]){
  await module(folder,'provider',{main:'index.js',dependencies:{transitive:'1.0.0'},optionalDependencies:{unavailable:'1.0.0'}},{'index.js':'export const ready=true;'});
  await module(folder,'transitive',{main:'index.js'},{'index.js':'module.exports={};','native/addon.node':'synthetic native bytes'});
 }
 async function pack(){await createPackageWithOptions(packed,archive,{unpackDir:'node_modules'});}
 return {home,root,packed,archive,module,pack};
}

test('a complete archive verifies production dependencies, entries and native bytes',async t=>{
 const f=await fixture(t);await f.pack();
 assert.deepEqual(await verifyPackageDependencies(f.root,f.archive),{passed:true,packages:2,entrypoints:2,nativeFiles:1});
});
test('the linked node_modules regression is rejected without changing its target',async t=>{
 const f=await fixture(t),linked=path.join(f.home,'linked');await mkdir(linked);
 await writeFile(path.join(linked,'package.json'),'{"dependencies":{}}','utf8');
 await symlink(path.join(f.root,'node_modules'),path.join(linked,'node_modules'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(runtimeDependencies(linked),/local, regular node_modules/);
 assert.ok((await readFile(path.join(f.root,'node_modules','provider','package.json'),'utf8')).includes('provider'));
});
test('a missing transitive package fails even when the top-level package is present',async t=>{
 const f=await fixture(t);await rm(path.join(f.packed,'node_modules','transitive'),{recursive:true});await f.pack();
 await assert.rejects(verifyPackageDependencies(f.root,f.archive),/missing:.*node_modules\/transitive\/package.json/);
});
test('an omitted native binary fails even when every package manifest remains',async t=>{
 const f=await fixture(t);await unlink(path.join(f.packed,'node_modules','transitive','native','addon.node'));await f.pack();
 await assert.rejects(verifyPackageDependencies(f.root,f.archive),/missing:.*addon.node/);
});
test('a missing unpacked file is caught even when its ASAR header is present',async t=>{
 const f=await fixture(t);await f.pack();
 await unlink(path.join(f.archive+'.unpacked','node_modules','provider','index.js'));
 await assert.rejects(verifyPackageDependencies(f.root,f.archive),/bytes are missing:.*provider\/index.js/);
});
test('an altered native binary is rejected',async t=>{
 const f=await fixture(t);await f.pack();
 await writeFile(path.join(f.archive+'.unpacked','node_modules','transitive','native','addon.node'),'different bytes','utf8');
 await assert.rejects(verifyPackageDependencies(f.root,f.archive),/bytes differ:.*addon.node/);
});
test('explicit distribution exclusions do not exempt other dependencies',async t=>{
 const f=await fixture(t);await rm(path.join(f.packed,'node_modules','provider'),{recursive:true});await f.pack();
 assert.equal((await verifyPackageDependencies(f.root,f.archive,{exclude:['provider']})).packages,0);
 await assert.rejects(verifyPackageDependencies(f.root,f.archive),/provider\/package.json/);
});
test('a junction below a package scope is rejected',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.root,'package.json'),'{"dependencies":{"@scope/linked":"1"}}','utf8');
 await mkdir(path.join(f.root,'node_modules','@scope'));
 await symlink(path.join(f.root,'node_modules','provider'),path.join(f.root,'node_modules','@scope','linked'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(runtimeDependencies(f.root),/Linked dependency directories/);
});
test('valid builder hoisting preserves dependency resolution',async t=>{
 const f=await fixture(t);
 await f.module(path.join(f.root,'node_modules','provider'),'nested',{main:'index.js'},{'index.js':'module.exports=true;'});
 const file=path.join(f.root,'node_modules','provider','package.json'),metadata=JSON.parse(await readFile(file,'utf8'));
 metadata.dependencies.nested='1.0.0';await writeFile(file,JSON.stringify(metadata),'utf8');
 await f.module(f.packed,'nested',{main:'index.js'},{'index.js':'module.exports=true;'});
 await f.pack();assert.equal((await verifyPackageDependencies(f.root,f.archive)).packages,3);
});
test('exports-only entries and wasm assets cannot disappear from the package',async t=>{
 const f=await fixture(t);
 for(const folder of [f.root,f.packed])await f.module(folder,'provider',{exports:{'.':{types:'./types.d.ts',import:'./entry.mjs'}},dependencies:{transitive:'1.0.0'}},{'entry.mjs':'export const ready=true;','engine.wasm':'synthetic wasm'});
 await unlink(path.join(f.packed,'node_modules','provider','entry.mjs'));await f.pack();
 await assert.rejects(verifyPackageDependencies(f.root,f.archive),/missing:.*entry.mjs/);
});
test('every resolved copy is checked when multiple parents share a dependency',async t=>{
 const f=await fixture(t);
 const metadata=JSON.parse(await readFile(path.join(f.root,'package.json'),'utf8'));metadata.dependencies.consumer='1.0.0';
 await writeFile(path.join(f.root,'package.json'),JSON.stringify(metadata),'utf8');
 for(const folder of [f.root,f.packed])await f.module(folder,'consumer',{dependencies:{transitive:'1.0.0'}});
 await f.module(path.join(f.packed,'node_modules','consumer'),'transitive',{main:'index.js'});
 await f.pack();await assert.rejects(verifyPackageDependencies(f.root,f.archive),/missing:.*consumer\/node_modules\/transitive\/index.js/);
});
test('builder target architecture is used even when it differs from the host',async t=>{
 const f=await fixture(t),file=path.join(f.root,'node_modules','provider','package.json');
 const metadata=JSON.parse(await readFile(file,'utf8'));metadata.cpu=['arm64'];metadata.os='win32';
 await writeFile(file,JSON.stringify(metadata),'utf8');
 await beforePack({arch:3,electronPlatformName:'win32',packager:{projectDir:path.join(f.home,'unused'),appDir:f.root}});
});
