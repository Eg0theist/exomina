// Prefetch through Electron's own checksum validator, then install exactly once.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fetchRuntimeBytes} from './runtime-download.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function prepareElectron({project=root,env=process.env,downloadArtifactImpl,installImpl,fetchImpl,wait,log}={}){
 if(env.ELECTRON_SKIP_BINARY_DOWNLOAD)throw Error('ELECTRON_SKIP_BINARY_DOWNLOAD is set; explicit Electron preparation was not authorized.');
 const packageFile=path.join(project,'node_modules/electron/package.json'),require=createRequire(packageFile),pkg=JSON.parse(await readFile(path.join(project,'package.json'),'utf8')),electron=JSON.parse(await readFile(packageFile,'utf8'));
 if(pkg.devDependencies?.electron!==electron.version)throw Error('Installed Electron does not match the exact package pin.');
 const checksums=JSON.parse(await readFile(path.join(path.dirname(packageFile),'checksums.json'),'utf8'));if(!Object.keys(checksums).length)throw Error('Pinned Electron checksums are missing.');
 const api=downloadArtifactImpl?{downloadArtifact:downloadArtifactImpl,getHostArch:()=>process.arch}:await import(pathToFileURL(require.resolve('@electron/get')).href);
 const platform=env.ELECTRON_INSTALL_PLATFORM||env.npm_config_platform||process.platform,arch=env.ELECTRON_INSTALL_ARCH||env.npm_config_arch||api.getHostArch();
 const cacheRoot=path.join(project,'.runtime-work/electron-cache'),tempDirectory=path.join(project,'.runtime-work/temp');await mkdir(cacheRoot,{recursive:true,mode:0o700});await mkdir(tempDirectory,{recursive:true,mode:0o700});
 await api.downloadArtifact({version:electron.version,artifactName:'electron',platform,arch,cacheRoot,tempDirectory,checksums,downloader:{download:async(url,target)=>{const bytes=await fetchRuntimeBytes(url,{label:`Electron ${electron.version} ${platform}/${arch}`,fetchImpl,wait,log});await writeFile(target,bytes);}}});
 const script=path.join(path.dirname(packageFile),'install.js'),childEnv={...env,electron_config_cache:cacheRoot,ELECTRON_INSTALL_PLATFORM:platform,ELECTRON_INSTALL_ARCH:arch,force_no_cache:'false',electron_use_remote_checksums:'',npm_config_electron_use_remote_checksums:''};
 if(installImpl)await installImpl({script,cwd:project,env:childEnv});
 else{const result=await promisify(execFile)(process.execPath,[script],{cwd:project,env:childEnv,windowsHide:true,timeout:120000,maxBuffer:1024*1024});if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);}
 return {version:electron.version,platform,arch,checksumVerification:true,installerInvocations:1};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))prepareElectron().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
