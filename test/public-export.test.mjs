import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {mergePublicJson,publicPathAllowed,reconcilePublicBase} from '../scripts/public-export.mjs';

const run=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function temporary(task){
 const directory=await mkdtemp(path.join(os.tmpdir(),'exomina-export-test-'));
 try{return await task(directory);}finally{await rm(directory,{recursive:true,force:true});}
}
async function fixture(directory,name,files){
 const target=path.join(directory,name);await mkdir(target);
 for(const [relative,text] of Object.entries(files)){await mkdir(path.dirname(path.join(target,relative)),{recursive:true});await writeFile(path.join(target,relative),text,'utf8');}
 return target;
}

test('public path policy allows source and docs while excluding credential and output paths',()=>{
 for(const relative of ['desktop/main.mjs','scripts/package-cross-platform.mjs','scripts/release-windows.mjs','docs/release-notes.md','docs/de/index.html','build/entitlements.mac.plist','LICENSE'])assert.equal(publicPathAllowed(relative),true,relative);
 for(const relative of ['accounts/key.json','desktop/accounts/key.json','data/chats.json','node_modules/tool/index.js','scripts/.env','scripts/signing.pem','scripts/output/key.json','src/assets/theme-art/a.png','../desktop/main.mjs','release-linux/app','unknown-root.txt'])assert.equal(publicPathAllowed(relative),false,relative);
});

test('public package reconciliation preserves newer dependencies and native scripts',()=>{
 const merged=mergePublicJson({version:'0.5.0',dependencies:{electron:'44.5.1'},scripts:{build:'vite build'},files:['app','old']},
  {version:'0.6.0',dependencies:{electron:'44.9.3',worker:'1'},scripts:{build:'vite build',security:'check'},files:['app','worker']},
  {version:'0.5.0',dependencies:{electron:'44.5.1'},scripts:{build:'vite build',mac:'package mac'},files:['app','old','LICENSE']});
 assert.equal(merged.version,'0.6.0');assert.equal(merged.dependencies.electron,'44.9.3');
 assert.deepEqual(merged.scripts,{build:'vite build',security:'check',mac:'package mac'});assert.deepEqual(merged.files,['app','worker','LICENSE']);
 assert.throws(()=>mergePublicJson({version:'0.5'},{version:'0.6'},{version:'0.7'}),/conflict.*version/);
});

test('public application reconciliation combines independent source and platform changes',async()=>temporary(async directory=>{
 const original=Array.from({length:20},(_,index)=>`line ${index}`).join('\n')+'\n';
 const ancestor=await fixture(directory,'ancestor',{'desktop/module.mjs':original,'desktop/remove.mjs':'old\n'});
 const theirs=await fixture(directory,'public',{'desktop/module.mjs':original.replace('line 18','native platform'),'desktop/runtime-targets.mjs':'native target\n','docs/index.html':'public site\n','accounts/secret':'synthetic excluded\n'});
 const output=await fixture(directory,'output',{'desktop/module.mjs':original.replace('line 1\n','new worker\n'),'desktop/remove.mjs':'old\n'});
 const result=await reconcilePublicBase(output,theirs,ancestor);
 const actual=await readFile(path.join(output,'desktop/module.mjs'),'utf8');assert.match(actual,/new worker/);assert.match(actual,/native platform/);
 assert.equal(await readFile(path.join(output,'desktop/runtime-targets.mjs'),'utf8'),'native target\n');
 assert.equal(await readFile(path.join(output,'docs/index.html'),'utf8'),'public site\n');
 await assert.rejects(access(path.join(output,'desktop/remove.mjs')),{code:'ENOENT'});await assert.rejects(access(path.join(output,'accounts')),{code:'ENOENT'});
 assert.equal(result.conflicts.length,0);assert.ok(result.changed.includes('desktop/module.mjs'));
}));

test('conflicting platform replay fails before applying any planned file changes',async()=>temporary(async directory=>{
 const ancestor=await fixture(directory,'ancestor',{'desktop/module.mjs':'base\n'});
 const theirs=await fixture(directory,'public',{'desktop/new.mjs':'new\n','desktop/module.mjs':'public\n'});
 const output=await fixture(directory,'output',{'desktop/module.mjs':'source\n'});
 await assert.rejects(reconcilePublicBase(output,theirs,ancestor),/requires review.*\n.*desktop\/module/s);
 assert.equal(await readFile(path.join(output,'desktop/module.mjs'),'utf8'),'source\n');await assert.rejects(access(path.join(output,'desktop/new.mjs')),{code:'ENOENT'});
}));

test('public export includes build and test inputs, Apache notices and platform commands',async()=>temporary(async directory=>{
 const output=path.join(directory,'public');
 const result=await run(process.execPath,[path.join(root,'scripts/prepare-beta-release.mjs'),'--public','--output',output],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:65536});
 const receipt=JSON.parse(result.stdout),pkg=JSON.parse(await readFile(path.join(output,'package.json'),'utf8')),lock=JSON.parse(await readFile(path.join(output,'package-lock.json'),'utf8'));
 assert.equal(receipt.profile,'public');assert.equal(pkg.version,JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version);
 assert.equal(pkg.license,'Apache-2.0');assert.match(await readFile(path.join(output,'LICENSE'),'utf8'),/Apache License/);
 assert.match(await readFile(path.join(output,'NOTICE'),'utf8'),/Victor Taelin/);
 assert.ok(pkg.build.files.includes('!desktop/agent-spending.mjs'));
 assert.doesNotMatch(await readFile(path.join(output,'desktop/main.mjs'),'utf8'),/SPENDING_TOOLS|spending_preview|case 'spending\./);
 assert.doesNotMatch(await readFile(path.join(output,'src/App.jsx'),'utf8'),/AgentSpending/);
 assert.match(pkg.scripts['package:mac'],/package-cross-platform/);assert.match(pkg.scripts['package:linux'],/package-cross-platform/);
 assert.equal(pkg.dependencies['@xai-official/grok-win32-x64'],undefined);assert.equal(Object.keys(pkg.optionalDependencies).filter(name=>name.startsWith('@xai-official/grok-')).length,6);
 assert.deepEqual(lock.packages[''].optionalDependencies,pkg.optionalDependencies);assert.deepEqual(lock.packages[''].dependencies,pkg.dependencies);
 for(const name of Object.keys(pkg.optionalDependencies).filter(name=>name.startsWith('@xai-official/grok-')))assert.equal(lock.packages[`node_modules/${name}`].optional,true);
 for(const relative of ['scripts/check-changes.mjs','scripts/public-export.mjs','scripts/public-template/LICENSE','scripts/private-beta-installer-config.mjs','scripts/package-cross-platform.mjs','scripts/native-package-preflight.mjs','scripts/qa-native-install.mjs','build/entitlements.mac.plist','docs/index.html','.github/workflows/native-packages.yml'])await access(path.join(output,relative));
 for(const command of Object.values(pkg.scripts))for(const match of command.matchAll(/node scripts\/([^\s]+)/g))await access(path.join(output,'scripts',match[1]));
 await assert.rejects(access(path.join(output,'PRIVATE-BETA.md')),{code:'ENOENT'});
 for(const relative of ['data','Private','accounts','node_modules','release','scripts/beta-docs'])await assert.rejects(access(path.join(output,relative)),{code:'ENOENT'});
 // Exercise the previously omitted verifier from the generated tree itself.
 const {verificationPlan}=await import(pathToFileURL(path.join(output,'scripts/check-changes.mjs')).href);
 assert.equal((await verificationPlan(output,['desktop/main.mjs'])).mode,'full');
}));

test('public reconciliation options require an explicit common ancestor before creating output',async()=>temporary(async directory=>{
 const output=path.join(directory,'public');
 await assert.rejects(run(process.execPath,[path.join(root,'scripts/prepare-beta-release.mjs'),'--public','--public-base',directory,'--output',output],{cwd:root,encoding:'utf8'}),error=>/both --public-base and --public-base-ancestor/.test(error.stderr));
 await assert.rejects(access(output),{code:'ENOENT'});
}));

test('public beta export retains public documentation, licence and native scripts',async context=>{
 const sourcePackage=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
 if(sourcePackage.license!=='Apache-2.0'){context.skip('This contract runs in the Apache-2.0 public source tree.');return;}
 await temporary(async directory=>{
  const output=path.join(directory,'beta');
  const result=await run(process.execPath,[path.join(root,'scripts/prepare-beta-release.mjs'),'--beta','--output',output],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:65536});
  assert.equal(JSON.parse(result.stdout).profile,'beta');
  const pkg=JSON.parse(await readFile(path.join(output,'package.json'),'utf8'));
  assert.equal(pkg.license,'Apache-2.0');assert.equal(pkg.version,sourcePackage.version);
  assert.match(pkg.scripts['package:mac'],/package-cross-platform/);assert.match(pkg.scripts['package:linux'],/package-cross-platform/);
  assert.match(await readFile(path.join(output,'desktop/distribution.mjs'),'utf8'),/DISTRIBUTION_PROFILE="beta"/);
  for(const relative of ['README.md','LICENSE','NOTICE','BETA.md','docs/index.html','scripts/package-cross-platform.mjs','scripts/prepare-grok-runtime.mjs'])assert.deepEqual(await readFile(path.join(output,relative)),await readFile(path.join(root,relative)),relative);
  for(const relative of ['PRIVATE-BETA.md','scripts/beta-docs'])await assert.rejects(access(path.join(output,relative)),{code:'ENOENT'});
 });
});
