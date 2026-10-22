// Build in one fixed candidate slot; the last good update remains available.
import {spawn} from 'node:child_process';
import {lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareVersion} from './prepare-version.mjs';
import {withStagingLock,stageBuild} from './stage-build.mjs';

export async function packageLocal({root=path.resolve(import.meta.dirname,'..'),run=runNode,prepare=prepareVersion,stage=stageBuild}={}){
  return withStagingLock(root,async p=>{
    for(const file of [p.journal,p.previous,p.candidate]){
      if(await lstat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('A previous build transaction remains at '+file+'. Inspect/recover it before packaging; no new package was created.');
    }
    const version=await prepare(root,{advance:false});console.log('Packaging Exomina '+version);
    await run(root,['node_modules/vite/bin/vite.js','build']);
    for(const script of ['prepare-taskbar-icon.mjs','prepare-windows-interop.mjs','prepare-grok-runtime.mjs','prepare-analysis-node.mjs','prepare-muse-runtime.mjs'])await run(root,['scripts/'+script]);
    await run(root,['node_modules/electron-builder/cli.js','--win','dir','--config.directories.output='+path.dirname(p.candidate)]);
    await run(root,['scripts/stamp-build.mjs','--build-dir',p.candidate]);
    return stage({root,candidate:p.candidate,locked:true});
  });
}
async function runNode(root,args){
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true,shell:false});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(args[0]+' failed ('+code+').')));});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length>2)throw Error('package-local.mjs takes no arguments.');
  packageLocal().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
