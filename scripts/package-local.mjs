// Build in one fixed candidate slot; the last good update remains available.
import {spawn} from 'node:child_process';
import {lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {preparePackageVersion,recordPackageVersion} from './package-version.mjs';
import {withStagingLock,stageBuild} from './stage-build.mjs';

export async function packageLocal({root=path.resolve(import.meta.dirname,'..'),keepVersion=false,run=runNode,prepare=preparePackageVersion,record=recordPackageVersion,stage=stageBuild}={}){
  return withStagingLock(root,async p=>{
    for(const file of [p.journal,p.previous,p.candidate]){
      if(await lstat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('A previous build transaction remains at '+file+'. Inspect/recover it before packaging; no new package was created.');
    }
    const version=await prepare(root,{keepVersion});console.log('Packaging Exomina '+version);
    await run(root,['node_modules/vite/bin/vite.js','build']);
    for(const script of ['prepare-taskbar-icon.mjs','prepare-windows-interop.mjs','prepare-grok-runtime.mjs','prepare-analysis-node.mjs','prepare-muse-runtime.mjs'])await run(root,['scripts/'+script]);
    await run(root,['node_modules/electron-builder/cli.js','--win','dir','--config.directories.output='+path.dirname(p.candidate)]);
    await run(root,['scripts/stamp-build.mjs','--build-dir',p.candidate]);
    // Never replace the last good stage with a build tested only on a fresh
    // profile. This check launches the exact candidate with retained encrypted
    // data and legacy runtime entries; failures leave that candidate withheld.
    await run(root,['scripts/qa-update-candidate.mjs',p.candidate]);
    // A fresh-profile launch cannot catch a candidate exiting because its own
    // update supervisor is still alive. Qualify the installed handoff as well.
    await run(root,['scripts/qa-update-handoff.mjs',p.candidate]);
    const result=await stage({root,candidate:p.candidate,locked:true});
    await record(root,result.build);
    return result;
  });
}
async function runNode(root,args){
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true,shell:false});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(args[0]+' failed ('+code+').')));});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length>1||args.length===1&&args[0]!=='--keep-version')throw Error('Use package-local.mjs [--keep-version].');
  packageLocal({keepVersion:args.includes('--keep-version')}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
