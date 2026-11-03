import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Check before creating profile files. Changing the default owner would also
// change ownership of objects created outside the profile by descendants.
export async function assertWindowsProfileOwner({platform=process.platform,launch=spawn}={}){
  if(platform!=='win32')return {status:'not-required'};
  const script=fileURLToPath(new URL('./profile-owner.ps1',import.meta.url)).replace(`app.asar${path.sep}`,`app.asar.unpacked${path.sep}`);
  const environment={...process.env};
  for(const key of Object.keys(environment))if(key.toLowerCase()==='psmodulepath')delete environment[key];
  return new Promise((resolve,reject)=>{
    const child=launch(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:environment});
    let stdout='',failed,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{failed=Error('Windows profile owner inspection timed out. No profile was opened.');child.kill();},15000);
    child.stdout.on('data',bytes=>{stdout+=bytes.toString();if(stdout.length>4000){failed=Error('Windows profile owner inspection exceeded its output limit.');child.kill();}});
    child.stderr.resume();
    child.once('error',()=>finish(Error('Windows profile owner inspection could not start. Open Exomina normally and preserve existing profile files.')));
    child.once('close',code=>{
      if(failed)return finish(failed);
      if(code!==0)return finish(Error('Windows profile ownership could not be checked. Open Exomina normally and preserve existing profile files.'));
      try{
        const value=JSON.parse(stdout);
        if(!['current-user','administrators','other'].includes(value?.owner)||typeof value.elevated!=='boolean')throw Error();
        if(value.owner==='administrators')return finish(Object.assign(Error('Windows would create Exomina profile files owned by Administrators. Open Exomina normally, without “Run as administrator”. Existing profile files were not changed.'),{code:'WINDOWS_PROFILE_OWNER_UNSAFE'}));
        if(value.owner!=='current-user')return finish(Error('Windows would create Exomina profile files for a different owner. Open Exomina normally and preserve existing profile files.'));
        finish(null,value);
      }catch{finish(Error('Windows profile owner inspection could not be verified. No profile was opened.'));}
    });
  });
}
