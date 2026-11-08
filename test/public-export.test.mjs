import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {mergePublicJson,publicPathAllowed,reconcilePublicBase,applyPublicTemplate,inspectPublicTree} from '../scripts/public-export.mjs';

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
 for(const relative of ['desktop/main.mjs','scripts/package-cross-platform.mjs','scripts/release-windows.mjs','docs/release-notes.md','docs/de/index.html','build/entitlements.mac.plist','LICENSE','.gitattributes'])assert.equal(publicPathAllowed(relative),true,relative);
 for(const relative of ['accounts/key.json','desktop/accounts/key.json','data/chats.json','node_modules/tool/index.js','scripts/.env','scripts/signing.pem','scripts/output/key.json','src/assets/theme-art/a.png','../desktop/main.mjs','release-linux/app','unknown-root.txt'])assert.equal(publicPathAllowed(relative),false,relative);
});

test('public exports refuse environment secrets, database sidecars and case variants in every source root',()=>{
 for(const file of ['cloud/server.env','cloud/production.env.local','scripts/.ENV','docs/a.sqlite-wal','public/a.sqlite3-shm','test/fixtures/a.db-journal','src/assets/THEME-ART/a.png','src/assets/VOICE-PREVIEWS/a.wav','desktop/windows-interop/Vault.dll'])assert.equal(publicPathAllowed(file),false,file);
 for(const file of ['cloud/server.env.example','cloud/.env.example','test/fixtures/source.mjs'])assert.equal(publicPathAllowed(file),true,file);
});

test('template copying uses the privacy policy, and final inspection catches private paths reintroduced later',async()=>temporary(async directory=>{
 const root=await fixture(directory,'source',{'scripts/public-template/package-overlay.json':'{}','scripts/public-template/README.md':'Synthetic public text','scripts/public-template/.github/server.env':'SYNTHETIC_PRIVATE_CANARY','scripts/public-template/scripts/cache.db-wal':'SYNTHETIC_PRIVATE_CANARY'}),output=path.join(directory,'output');
 await mkdir(output);await applyPublicTemplate(root,output);
 await assert.rejects(access(path.join(output,'.github/server.env')),{code:'ENOENT'});await assert.rejects(access(path.join(output,'scripts/cache.db-wal')),{code:'ENOENT'});
 assert.equal((await inspectPublicTree(output)).contentScanRequired,true);
 await writeFile(path.join(output,'scripts','server.env'),'SYNTHETIC_PRIVATE_CANARY');await assert.rejects(inspectPublicTree(output),/Private or linked file/);
}));

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
 assert.match(await readFile(path.join(output,'WORKFLOWS.txt'),'utf8'),/Scheduled report workflow pilot/);
 assert.deepEqual(await readFile(path.join(output,'build/release-notes.txt')),await readFile(path.join(root,'build/release-notes.txt')),'Public build keeps the reviewed current release notes');
 for(const file of ['workflow-journal.mjs','workflow-delivery.mjs','scoped-tool-discovery.mjs'])await access(path.join(output,'desktop',file));
 assert.equal(pkg.license,'Apache-2.0');assert.match(await readFile(path.join(output,'LICENSE'),'utf8'),/Apache License/);
 assert.match(await readFile(path.join(output,'NOTICE'),'utf8'),/Victor Taelin/);
 assert.ok(pkg.build.files.includes('!desktop/agent-spending.mjs'));
 assert.doesNotMatch(await readFile(path.join(output,'desktop/main.mjs'),'utf8'),/SPENDING_TOOLS|spending_preview|case 'spending\./);
 assert.doesNotMatch(await readFile(path.join(output,'src/App.jsx'),'utf8'),/AgentSpending/);
 assert.match(pkg.scripts['package:mac'],/package-cross-platform/);assert.match(pkg.scripts['package:linux'],/package-cross-platform/);
 assert.equal(pkg.dependencies['@xai-official/grok-win32-x64'],undefined);assert.equal(Object.keys(pkg.optionalDependencies).filter(name=>name.startsWith('@xai-official/grok-')).length,6);
 assert.deepEqual(lock.packages[''].optionalDependencies,pkg.optionalDependencies);assert.deepEqual(lock.packages[''].dependencies,pkg.dependencies);
 for(const name of Object.keys(pkg.optionalDependencies).filter(name=>name.startsWith('@xai-official/grok-')))assert.equal(lock.packages[`node_modules/${name}`].optional,true);
 for(const relative of ['scripts/check-changes.mjs','scripts/public-export.mjs','scripts/public-template/LICENSE','scripts/private-beta-installer-config.mjs','scripts/package-cross-platform.mjs','scripts/native-package-preflight.mjs','scripts/qa-native-install.mjs','scripts/package-version.mjs','scripts/qa-tool-update-archive.ps1','scripts/qa-installer-locks.ps1','build/entitlements.mac.plist','docs/index.html','.github/workflows/native-packages.yml'])await access(path.join(output,relative));
 const security=await readFile(path.join(output,'.github/workflows/security.yml'),'utf8');assert.match(security,/pull_request:/);assert.match(security,/npm audit --audit-level=low/);assert.match(security,/github\/codeql-action\/analyze@/);
 assert.match(await readFile(path.join(output,'.gitattributes'),'utf8'),/vendor\/analysis-node\/\*\* -text/);
 // Native acceptance must retain the latest sign-in/protection gates and all
 // helpers they invoke. A successful export used to silently restore an older
 // entrypoint from the template, weakening the public install checks.
 for(const script of ['package-dependencies.mjs','qa-native-install.mjs','qa-connector-forms.mjs','qa-connection-signin.mjs','qa-startup-protection-failure.mjs','qa-public-upgrade.mjs','qa-efs-upgrade-compat.mjs'])assert.deepEqual(await readFile(path.join(output,'scripts',script)),await readFile(path.join(root,'scripts',script)),script);
 const nativeInstall=await readFile(path.join(output,'scripts/qa-native-install.mjs'),'utf8');assert.match(nativeInstall,/protectionRefusal/);assert.match(nativeInstall,/qa-connection-signin\.mjs/);
 assert.match(await readFile(path.join(output,'scripts/prepare-beta-release.mjs'),'utf8'),/replaceAll\('Alex','Alex'\)/);
 for(const command of Object.values(pkg.scripts))for(const match of command.matchAll(/node scripts\/([^\s]+)/g))await access(path.join(output,'scripts',match[1]));
 // Packaging invokes these gates by name rather than importing them. A valid
 // entry point alone used to conceal the omitted startup and handover checks.
 const packaging=await readFile(path.join(output,'scripts/package-local.mjs'),'utf8');
 for(const match of packaging.matchAll(/['"]([\w-]+\.mjs)['"]/g))await access(path.join(output,'scripts',match[1]));
 // Check literal local imports from every exported top-level script without
 // executing installers or touching a profile. Missing QA helpers must stop
 // source qualification before a native build is submitted.
 for(const entry of await readdir(path.join(output,'scripts'))){
  if(!entry.endsWith('.mjs'))continue;
  const script=path.join(output,'scripts',entry),text=await readFile(script,'utf8');
  for(const match of text.matchAll(/^\s*(?:import|export)\b[^\r\n]*?\bfrom\s*['"](\.[^'"\r\n]+\.[mc]?js)['"]/gm))await access(path.resolve(path.dirname(script),match[1]));
 }
 for(const entry of await readdir(path.join(output,'test'))){
  if(!entry.endsWith('.test.mjs'))continue;
  const text=await readFile(path.join(output,'test',entry),'utf8');
  for(const match of text.matchAll(/['"]\.\.\/scripts\/([\w.-]+\.(?:mjs|ps1))['"]/g))await access(path.join(output,'scripts',match[1]));
 }
 for(const name of ['Delivery','Installation'])await access(path.join(output,'test/fixtures/protocol-models',name+'.tla'));
 // Fixture neutralization must preserve actual case-folding and single-word
 // vocabulary semantics, including nested corpus/evaluator inputs.
 const dictationEnv={...process.env};delete dictationEnv.NODE_TEST_CONTEXT;
 const dictation=await run(process.execPath,['--test','--test-reporter=tap','--test-name-pattern=project vocabulary|WER counts',path.join(output,'test/dictation.test.mjs'),path.join(output,'test/dictation-evaluation.test.mjs')],{cwd:output,env:dictationEnv,encoding:'utf8',timeout:30000,maxBuffer:65536});assert.match(dictation.stdout,/pass 2/);
 const neutralCorpus=JSON.parse(await readFile(path.join(output,'test/fixtures/dictation-evaluation-corpus.json'),'utf8'));assert.ok(neutralCorpus.cases.find(row=>row.id==='en-name-negation').protected.names.includes('Hamburg'));
 assert.match(await readFile(path.join(output,'scripts/evaluate-dictation.mjs'),'utf8'),/vocabulary:\['Exomina','Hamburg'/);
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
