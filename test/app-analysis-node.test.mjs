import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdir,mkdtemp,writeFile,readFile,rm,link,symlink,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {analysisNodeExecutable,ANALYSIS_NODE_VERSION,ANALYSIS_NODE_SHA256,ANALYSIS_NODE_LICENSE_SHA256} from '../desktop/app-analysis-node.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const win64=process.platform==='win32'&&process.arch==='x64';
const official=fileURLToPath(new URL('../vendor/analysis-node/',import.meta.url));
const validManifest=()=>({schemaVersion:1,version:ANALYSIS_NODE_VERSION,platform:'win32',architecture:'x64',executable:'node.exe',executableSha256:ANALYSIS_NODE_SHA256,license:'LICENSE',licenseSha256:ANALYSIS_NODE_LICENSE_SHA256});
async function fixture(t,{manifest=validManifest(),binary=Buffer.from('Inert invalid synthetic runtime; never execute'),license='Synthetic license'}={}){
  const root=await mkdtemp(path.join(tmpdir(),'exomina-native-node-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await Promise.all([writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest)),writeFile(path.join(root,'node.exe'),binary),writeFile(path.join(root,'LICENSE'),license)]);return root;
}
async function probe(executable){
  return new Promise((resolve,reject)=>{const child=spawn(executable,['-e',"console.log(JSON.stringify({version:process.version,arch:process.arch,platform:process.platform,napi:process.versions.napi}))"],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolve(JSON.parse(output)):reject(Error(errors||`Exit ${code}`)));});
}

test('official pinned analysis runtime is independently verified and executes as real Node',{skip:!win64},async()=>{
  const executable=await analysisNodeExecutable();assert.equal(executable,path.join(official,'node.exe'));assert.equal(sha(await readFile(executable)),ANALYSIS_NODE_SHA256);
  const observed=await probe(executable);assert.equal(observed.version,'v'+ANALYSIS_NODE_VERSION);assert.equal(observed.platform,'win32');assert.equal(observed.arch,'x64');assert.ok(Number(observed.napi)>=8);
});
test('runtime manifest identity changes are rejected before a binary is read',{skip:!win64},async t=>{
  for(const patch of [{schemaVersion:2},{version:'24.13.1'},{platform:'linux'},{architecture:'arm64'},{executable:'other.exe'},{executableSha256:'b'.repeat(64)},{license:'../LICENSE'},{licenseSha256:'b'.repeat(64)}]){
    const root=await fixture(t,{manifest:{...validManifest(),...patch}});await rm(path.join(root,'node.exe'));await assert.rejects(analysisNodeExecutable(root),/manifest does not match/);
  }
});
test('tampered executable content cannot be selected for native analysis',{skip:!win64},async t=>{
  const root=await fixture(t);await assert.rejects(analysisNodeExecutable(root),/checksum does not match/);
});
test('oversized and hard-linked runtime binaries fail before hashing or launch',{skip:!win64},async t=>{
  const root=await fixture(t),file=path.join(root,'node.exe'),handle=await open(file,'w');try{await handle.truncate(128*1024*1024+1);}finally{await handle.close();}
  await assert.rejects(analysisNodeExecutable(root),/runtime file is invalid/);
  await writeFile(file,'Inert invalid synthetic runtime; never execute');await link(file,path.join(root,'linked-copy.exe'));await assert.rejects(analysisNodeExecutable(root),/runtime file is invalid/);
});
test('runtime manifest and binary links are refused even inside a synthetic directory',{skip:!win64},async t=>{
  const root=await fixture(t),target=path.join(root,'outside.json');await writeFile(target,JSON.stringify(validManifest()));await rm(path.join(root,'manifest.json'));await symlink(target,path.join(root,'manifest.json'),'file');await assert.rejects(analysisNodeExecutable(root),/runtime file is invalid/);
  await rm(path.join(root,'manifest.json'));await writeFile(path.join(root,'manifest.json'),JSON.stringify(validManifest()));await rm(path.join(root,'node.exe'));await symlink(target,path.join(root,'node.exe'),'file');await assert.rejects(analysisNodeExecutable(root),/runtime file is invalid/);
});
test('native runtime directory aliases are refused before its manifest is read',{skip:!win64},async t=>{
  const root=await fixture(t),holder=await mkdtemp(path.join(tmpdir(),'exomina-native-node-alias-'));t.after(()=>rm(holder,{recursive:true,force:true}));const alias=path.join(holder,'aliased-runtime');await symlink(root,alias,'junction');await assert.rejects(analysisNodeExecutable(alias),/cannot follow links or aliases/);
});
test('manifest hard links are refused before runtime metadata can be trusted',{skip:!win64},async t=>{
  const root=await fixture(t);await link(path.join(root,'manifest.json'),path.join(root,'linked-manifest.json'));await assert.rejects(analysisNodeExecutable(root),/runtime file is invalid/);
});
