// A new local update advances the patch. Asset builds, failed attempts and
// unchanged rebuilds keep their selected version; minor milestones are explicit.
// An explicit per-build keepVersion also permits revisions of the same release.
import {readFile,writeFile,lstat,mkdir,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {sourceTree,treeHash,plainPath} from '../desktop/update-source.mjs';
import {compareVersions} from '../desktop/public-updates.mjs';
import {prepareVersion,nextBuildVersion} from './prepare-version.mjs';

const statePath=root=>path.join(root,'release','package-version.json');
async function optionalJson(file){
  await plainPath(file);
  const info=await lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!info)return null;
  if(!info.isFile()||info.nlink>1||info.size>64000)throw Error('Invalid package version metadata: '+file);
  return JSON.parse(await readFile(file,'utf8'));
}
export async function packageSourceHash(root){
  const files=await sourceTree(root);
  files.delete('desktop/app-version.json');
  for(const file of ['package.json','package-lock.json']){
    if(!files.has(file))continue;
    const value=JSON.parse(files.get(file).toString('utf8'));
    delete value.version;
    if(file==='package-lock.json'&&value.packages?.[''])delete value.packages[''].version;
    files.set(file,Buffer.from(JSON.stringify(value)));
  }
  return treeHash(files);
}
async function versionState(root){
  const state=await optionalJson(statePath(root));
  if(state&&(state.format!==1||!/^\w[\w.-]*$/.test(state.version||'')||!/^[a-f0-9]{64}$/.test(state.sourceHash||'')))throw Error('Invalid package version history. Inspect release/package-version.json before packaging.');
  if(state)nextBuildVersion(state.version);
  return state;
}
export async function preparePackageVersion(root,{keepVersion=false}={}){
  if(typeof keepVersion!=='boolean')throw Error('keepVersion must be a boolean.');
  const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  nextBuildVersion(manifest.version);
  const state=await versionState(root),versions=[];
  // Only program stamps are read. No updater state or user profile is needed.
  for(const file of [path.join(root,'release','win-unpacked','exomina.build.json'),path.join(root,'..','App','exomina.build.json')]){
    const stamp=await optionalJson(file);
    if(stamp?.version){nextBuildVersion(stamp.version);versions.push(stamp.version);}
  }
  if(state)versions.push(state.version);
  const latest=versions.sort(compareVersions).at(-1);
  let version=manifest.version;
  if(keepVersion&&latest&&compareVersions(version,latest)<0)throw Error('Cannot keep version '+version+' below the latest package version '+latest+'. Select that version or a newer one before packaging.');
  if(!keepVersion&&latest&&compareVersions(version,latest)<=0){
    const unchanged=state?.version===version&&latest===version&&state.sourceHash===await packageSourceHash(root);
    version=unchanged?version:nextBuildVersion(latest);
  }
  return prepareVersion(root,{setVersion:version});
}
export async function recordPackageVersion(root,build){
  const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  if(build?.version!==version)throw Error('The staged package version differs from Source.');
  const target=statePath(root),temporary=target+'.version-'+randomUUID();
  await plainPath(target);await mkdir(path.dirname(target),{recursive:true});
  const state={format:1,version,sourceHash:await packageSourceHash(root),buildId:build.id,stagedAt:new Date().toISOString()};
  try{await writeFile(temporary,JSON.stringify(state,null,2)+'\n',{encoding:'utf8',flag:'wx'});await rename(temporary,target);}
  finally{await unlink(temporary).catch(()=>{});}
  return state;
}
