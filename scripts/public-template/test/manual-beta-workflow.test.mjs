import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const require=createRequire(import.meta.url);
// Resolve through the installed, pinned builder that declares these dependencies.
const builderRequire=createRequire(require.resolve('app-builder-lib/package.json'));
const {load:parse}=builderRequire('js-yaml');
const {minimatch}=builderRequire('minimatch');
const root=new URL('../',import.meta.url);
const workflow=async name=>parse(await readFile(new URL(`.github/workflows/${name}.yml`,root),'utf8'));

test('manual qualification skips documentation while retaining package inputs',async()=>{
 const paths=(await workflow('manual-beta-release')).on.pull_request.paths;
 const qualifies=file=>paths.reduce((matches,pattern)=>pattern.startsWith('!')
  ? matches&&!minimatch(file,pattern.slice(1),{dot:true})
  : matches||minimatch(file,pattern,{dot:true}),false);
 for(const file of ['README.md','docs/index.html','scripts/PREPACKAGED-BUILD.md','scripts/public-template/README.md','scripts/public-template/docs/de/index.html','scripts/beta-docs/START-HERE.txt'])assert.equal(qualifies(file),false,file);
 for(const file of ['desktop/main.mjs','src/App.jsx','public/icon.png','cloud/server.mjs','scripts/qa-native-install.mjs','scripts/public-template/scripts/package-cross-platform.mjs','scripts/public-template/package-overlay.json','.github/workflows/native-packages.yml','index.html','remote.html','vite.config.mjs','package.json','package-lock.json'])assert.equal(qualifies(file),true,file);
 assert.equal(['README.md','desktop/main.mjs'].some(qualifies),true,'A documentation change cannot suppress a package change.');
});

test('manual PR qualification remains read-only and cannot publish',async()=>{
 const manual=await workflow('manual-beta-release'),native=await workflow('native-packages');
 assert.equal(manual.permissions.contents,'read');assert.equal(native.permissions.contents,'read');
 assert.match(manual.jobs.publish.if,/github\.event_name == 'workflow_dispatch'/);
 assert.match(manual.jobs.publish.if,/github\.ref_name == github\.event\.repository\.default_branch/);
 assert.equal(manual.jobs.native.secrets,undefined);
 for(const name of ['manual-beta-release','native-packages']){
  const contents=await readFile(new URL(`.github/workflows/${name}.yml`,root),'utf8');
  assert.equal(Object.hasOwn(parse(contents).on,'pull_request_target'),false);
  assert.doesNotMatch(contents,/\b(?:CSC_(?:LINK|KEY_PASSWORD|INSTALLER_LINK|INSTALLER_KEY_PASSWORD)|APPLE_[A-Z_]+)\b|\bsecrets[.:]/,'Manual PR qualification cannot receive signing secrets.');
 }
});

test('public export workflow templates retain the same qualification policy',async()=>{
 for(const name of ['manual-beta-release','native-packages']){
  const template=parse(await readFile(new URL(`scripts/public-template/.github/workflows/${name}.yml`,root),'utf8'));
  assert.deepEqual(template,await workflow(name),name);
 }
});

test('macOS PR builds retain ad-hoc signing and strict installed verification',async()=>{
 const native=await workflow('native-packages'),job=native.jobs['native-package'];
 const step=job.steps.find(item=>item.id==='build_native');
 assert.equal(step.env.CSC_FOR_PULL_REQUEST,"${{ matrix.platform == 'darwin' && github.event_name == 'pull_request' && 'true' || 'false' }}");
 assert.equal(job.env.CSC_IDENTITY_AUTO_DISCOVERY,'false');
 const {crossPlatformConfig}=await import('../scripts/cross-platform-config.mjs');
 for(const arch of ['arm64','x64'])assert.equal(crossPlatformConfig('darwin',{arch,ciOnly:true}).mac.identity,'-');
 const installer=await readFile(new URL('scripts/qa-native-install.mjs',root),'utf8');
 assert.match(installer,/\['--verify','--deep','--strict','--verbose=2',installedApp\]/);
 const env={...process.env,GITHUB_BASE_REF:'main',CSC_FOR_PULL_REQUEST:'true',CSC_IDENTITY_AUTO_DISCOVERY:'false'};
 delete env.NODE_TEST_CONTEXT;
 const script=`Object.defineProperty(process,'platform',{value:'darwin'}); const {isSignAllowed}=require('app-builder-lib/out/codeSign/macCodeSign.js'); delete process.env.CSC_FOR_PULL_REQUEST; const skipped=!isSignAllowed(false); process.env.CSC_FOR_PULL_REQUEST='true'; if(!skipped||!isSignAllowed(false))process.exit(1); console.log('PR signing gate reproduced and corrected; native codesign execution still required.');`;
 const result=await promisify(execFile)(process.execPath,['-e',script],{cwd:root,env,timeout:15000});
 assert.match(result.stdout,/PR signing gate reproduced and corrected/);
});
