import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {crossPlatformConfig} from '../scripts/cross-platform-config.mjs';

const require=createRequire(import.meta.url),builderRequire=createRequire(require.resolve('app-builder-lib/package.json')),{load}=builderRequire('js-yaml');

test('macOS PR packages retain ad-hoc signing and strict installed verification',async()=>{
 const root=new URL('../',import.meta.url),source=await readFile(new URL('.github/workflows/native-packages.yml',root),'utf8');
 const template=await readFile(new URL('scripts/public-template/.github/workflows/native-packages.yml',root),'utf8');
 assert.equal(source.replaceAll('\r\n','\n'),template.replaceAll('\r\n','\n'));
 const job=load(source).jobs['native-package'],step=job.steps.find(item=>item.id==='build_native');
 assert.equal(step.env.CSC_FOR_PULL_REQUEST,"${{ matrix.platform == 'darwin' && github.event_name == 'pull_request' && 'true' || 'false' }}");
 assert.equal(job.env.CSC_IDENTITY_AUTO_DISCOVERY,'false');
 for(const arch of ['arm64','x64'])assert.equal(crossPlatformConfig('darwin',{arch,ciOnly:true}).mac.identity,'-');
 const installer=await readFile(new URL('scripts/qa-native-install.mjs',root),'utf8');
 assert.match(installer,/\['--verify','--deep','--strict','--verbose=2',installedApp\]/);
 const env={...process.env,GITHUB_BASE_REF:'main',CSC_IDENTITY_AUTO_DISCOVERY:'false'};delete env.NODE_TEST_CONTEXT;
 // Exercise the installed builder's PR decision on every host; native codesign
 // and installed launch are verified separately by the macOS runners.
 const script="Object.defineProperty(process,'platform',{value:'darwin'}); const {isSignAllowed}=require('app-builder-lib/out/codeSign/macCodeSign.js'); delete process.env.CSC_FOR_PULL_REQUEST; if(isSignAllowed(false))process.exit(1); process.env.CSC_FOR_PULL_REQUEST='true'; if(!isSignAllowed(false))process.exit(1); console.log('PR ad-hoc signing enabled');";
 const result=await promisify(execFile)(process.execPath,['-e',script],{cwd:root,env,timeout:15000});assert.match(result.stdout,/PR ad-hoc signing enabled/);
});
