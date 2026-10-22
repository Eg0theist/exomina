import {readFile,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {codexRuntimePaths,bundledGrokPaths,bundledPythonPath,bundledCuaPath} from '../desktop/runtime-targets.mjs';
import {nativeVendorTargets} from './native-vendor-config.mjs';
import {grokRuntimeTarget} from './grok-runtime-config.mjs';

export function assertNativeBuildHost(platform,arch,{hostPlatform=process.platform,hostArch=process.arch}={}) {
  if(!['darwin','linux'].includes(platform)||!['x64','arm64'].includes(arch))throw Error('Choose a supported native macOS/Linux target.');
  if(platform!==hostPlatform||arch!==hostArch)throw Error('Native packaging requires a matching operating system and architecture; preparing host runtimes for another target would produce a broken installer.');
}

export async function verifyProfileCapability(root) {
  const module=path.join(root,'desktop','profile-storage.mjs');
  let capability;try{capability=await import(pathToFileURL(module).href);}catch{throw Error('Standard per-user profile storage is not integrated in this checkout.');}
  if(typeof capability.ProfileStorage!=='function'||typeof capability.initializeProfileStorage!=='function')throw Error('The standard profile adapter does not expose the required startup contract.');
  const main=await readFile(path.join(root,'desktop','main.mjs'),'utf8');
  if(!/from\s*['"]\.\/profile-storage\.mjs['"]/.test(main))throw Error('The desktop startup does not use the standard profile adapter.');
}

export async function nativePackagePreflight(root,{platform=process.platform,arch=process.arch}={}) {
  assertNativeBuildHost(platform,arch);
  await verifyProfileCapability(root);
  const manifests=[];
  for(const target of nativeVendorTargets(platform,arch)){
    const manifest=JSON.parse(await readFile(path.join(root,'vendor',target.dir,'provenance.json'),'utf8'));
    if(manifest.version!==target.version||manifest.platform!==platform||manifest.arch!==arch||manifest.archiveSha256!==target.sha256)throw Error('Native vendor provenance does not match the package target.');
    manifests.push(target.dir);
  }
  const grok=grokRuntimeTarget(platform,arch);
  const manifest=JSON.parse(await readFile(path.join(root,'vendor','grok','provenance.json'),'utf8'));
  if(manifest.package!==grok.package||manifest.version!==grok.version||manifest.platform!==platform||manifest.arch!==arch||manifest.sha256!==grok.sha256)throw Error('Grok provenance does not match the package target.');
  const required=[bundledGrokPaths(root,{platform,arch})[0],bundledPythonPath(root,{platform}),bundledCuaPath(root,{platform})];
  for(const executable of required)await access(executable,constants.X_OK);
  const codex=codexRuntimePaths(root,{platform,arch});let found=false;
  for(const executable of codex){try{await access(executable,constants.X_OK);found=true;break;}catch{}}
  if(!found)throw Error('The pinned native Codex runtime is missing.');
  await access(path.join(root,'vendor','python','lib','python3.13','LICENSE.txt'));
  await access(path.join(root,'vendor','cua-driver','LICENSE'));
  await access(path.join(root,'vendor','cua-driver','THIRD_PARTY_NOTICES.md'));
  await access(path.join(root,'vendor','cua-driver','skills','cua-driver','SKILL.md'));
  await access(path.join(root,'vendor','cua-driver','skills','cua-driver',platform==='darwin'?'MACOS.md':'LINUX.md'));
  return {platform,arch,standardProfileIntegrated:true,preparedVendors:[...manifests,'grok'],nativeRuntimeFilesPresent:true};
}
