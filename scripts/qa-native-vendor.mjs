// Native program and synthetic importer probes, without real accounts or input.
import {mkdtemp,mkdir,chmod,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {bundledPythonPath,bundledCuaPath} from '../desktop/runtime-targets.mjs';
import {readExportFile} from '../desktop/export-files.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const profile=await mkdtemp(path.join(os.tmpdir(),'exomina-native-vendor-probe-'));
if(process.platform!=='win32')await chmod(profile,0o700);
const environment={...process.env,HOME:profile,USERPROFILE:profile,APPDATA:profile,LOCALAPPDATA:profile,
 XDG_CONFIG_HOME:path.join(profile,'config'),XDG_DATA_HOME:path.join(profile,'data'),XDG_CACHE_HOME:path.join(profile,'cache'),
 TEMP:profile,TMP:profile,TMPDIR:profile};
for(const key of Object.keys(environment))if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key))delete environment[key];
await mkdir(environment.XDG_CONFIG_HOME,{recursive:true});
const run=(command,args)=>promisify(execFile)(command,args,{cwd:profile,env:environment,windowsHide:true,timeout:15000,maxBuffer:16384});
const python=bundledPythonPath(root),cua=bundledCuaPath(root);
for(const directory of [path.join(root,'vendor','python'),path.join(root,'vendor','python','bin'),path.join(root,'vendor','python','lib'),path.join(root,'vendor','cua-driver')]){
 const info=await stat(directory);if((info.mode&0o005)!==0o005)throw Error('Bundled program directories are not accessible to ordinary installed users.');
}
for(const file of [python,cua,path.join(root,'vendor','python','lib','python3.13','LICENSE.txt'),path.join(root,'vendor','cua-driver','skills','cua-driver','SKILL.md'),path.join(root,'vendor','cua-driver','skills','cua-driver',process.platform==='darwin'?'MACOS.md':'LINUX.md')]){
 const info=await stat(file);if(!(info.mode&0o004))throw Error('Bundled program files are not readable to ordinary installed users.');
}
const version=await run(python,['-I','--version']);
if(!/^Python 3\.13\.17\b/.test(version.stdout))throw Error('Native Python did not report its pinned version.');
const archive=path.join(profile,'synthetic-export.zip');
await run(python,['-I','-c','import sys, zipfile, zlib, bz2, sqlite3\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as archive:\n archive.writestr("conversations.json","[{\\"synthetic\\":true}]")',archive]);
const imported=await readExportFile(archive);
if(imported.inputs.length!==1||imported.inputs[0].text!=='[{"synthetic":true}]')throw Error('The bundled native importer did not read the synthetic ZIP correctly.');
const driver=await run(cua,['--version']);
if(!/\b0\.33\.4\b/.test(driver.stdout))throw Error('Native Cua did not report its pinned version.');
console.log(JSON.stringify({platform:process.platform,arch:process.arch,python:'3.13.17',cua:'0.33.4',syntheticZipImport:true,publicProgramPermissions:true,bundledSkillRetained:true,isolatedProfile:true,desktopPermissionTested:false}));
