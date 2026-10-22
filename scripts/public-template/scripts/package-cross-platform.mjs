import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {crossPlatformConfig,nativePackageFormats} from './cross-platform-config.mjs';
import {assertNativeBuildHost,verifyProfileCapability,nativePackagePreflight} from './native-package-preflight.mjs';
import {validateNativeConfig} from './validate-native-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const requested=process.argv[2],arch=process.arch,ciOnly=process.argv.includes('--ci-installers');
try{
 assertNativeBuildHost(requested,arch);
 await verifyProfileCapability(root);
 await validateNativeConfig(requested,arch,{ciOnly});
 if(!process.argv.includes('--preflight-only')){
  for(const script of ['prepare-native-vendor.mjs','prepare-grok-runtime.mjs','qa-native-grok.mjs','qa-native-vendor.mjs']){
   const result=await promisify(execFile)(process.execPath,[path.join(root,'scripts',script)],{cwd:root,env:process.env,timeout:300000,maxBuffer:65536});
   process.stdout.write(result.stdout);
  }
 }
 const checked=await nativePackagePreflight(root,{platform:requested,arch});
 if(process.argv.includes('--preflight-only'))console.log(JSON.stringify(checked));
 else {
  const {prepareVersion}=await import('./prepare-version.mjs');await prepareVersion(root);
  const built=await promisify(execFile)(process.execPath,[path.join(root,'node_modules','vite','bin','vite.js'),'build'],{cwd:root,timeout:120000,maxBuffer:65536});process.stdout.write(built.stdout);
  const {build,Platform,Arch}=await import('electron-builder');
  const target=requested==='darwin'?Platform.MAC:Platform.LINUX;
  const formats=process.argv.includes('--dir')?['dir']:nativePackageFormats(requested,{ciOnly});
  const files=await build({projectDir:root,targets:target.createTarget(formats,Arch[arch]),config:crossPlatformConfig(requested,{arch,ciOnly}),publish:'never'});
  console.log(JSON.stringify({platform:requested,arch,artifacts:files,qualification:'Native package created; exact packaged desktop startup and install checks are still required before sharing.'}));
 }
}catch(error){
 console.error(`Native package preflight failed: ${error.message}`);
 console.error('No qualified installer was produced. Native startup and installation checks are required before sharing.');
 // Builder cleanup can reset exitCode after a failed native rebuild. A failed
 // package must stop CI before any installer qualification or upload can run.
 process.exit(2);
}
