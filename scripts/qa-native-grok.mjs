// Program capability probe only: no sign-in, model call or existing profile.
import {mkdtemp,mkdir,stat,chmod} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {bundledGrokPaths} from '../desktop/runtime-targets.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [executable]=bundledGrokPaths(root);
if(!executable)throw Error('No prepared Grok runtime for this platform.');
await stat(executable);
const profile=await mkdtemp(path.join(os.tmpdir(),'exomina-native-program-probe-'));
if(process.platform!=='win32')await chmod(profile,0o700);
const environment={...process.env,HOME:profile,USERPROFILE:profile,APPDATA:profile,LOCALAPPDATA:profile,
  XDG_CONFIG_HOME:path.join(profile,'config'),XDG_DATA_HOME:path.join(profile,'data'),XDG_CACHE_HOME:path.join(profile,'cache'),
  TEMP:profile,TMP:profile,TMPDIR:profile};
for(const key of Object.keys(environment)){
  if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key))delete environment[key];
}
await mkdir(environment.XDG_CONFIG_HOME,{recursive:true});
const result=await promisify(execFile)(executable,['--version'],{cwd:profile,env:environment,windowsHide:true,timeout:15000,maxBuffer:16384});
if(!/\b1\.0\.46\b/.test(result.stdout))throw Error('Prepared Grok did not report the pinned version.');
console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:'1.0.46',nativeExecutable:true,isolatedProfile:true,authenticated:false}));
// Leave only this synthetic program-probe directory for runner cleanup. This
// script deliberately never deletes an inferred account/profile location.
