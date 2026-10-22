// QA process context only. Production profile ownership rules remain unchanged.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

let preparation;
export function prepareWindowsQaOwner(){
  if(process.platform!=='win32')return Promise.resolve(null);
  return preparation||=(async()=>{
    const script=fileURLToPath(new URL('./native-qa-windows-owner.ps1',import.meta.url));
    const environment={...process.env};
    for(const key of Object.keys(environment))if(key.toLowerCase()==='psmodulepath')delete environment[key];
    return new Promise((resolve,reject)=>{
      const child=spawn(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:environment});
      let stdout='',stderr='',failure;
      const timer=setTimeout(()=>{failure=Error('The dedicated Windows QA process owner preparation timed out.');child.kill();},30000);
      child.stdout.on('data',bytes=>{stdout+=bytes.toString();if(stdout.length>16000){failure=Error('Windows QA owner preparation exceeded its output bound.');child.kill();}});
      child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-4000);});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{
        clearTimeout(timer);
        if(failure)return reject(failure);
        if(code!==0)return reject(Error(stderr||'The dedicated Windows QA process owner preparation failed.'));
        try{
          const result=JSON.parse(stdout);
          if(result.processId!==process.pid||result.ownerAfter!=='current-user'||result.identityUnchanged!==true||result.parentOwnerUnchanged!==true)throw Error('Windows QA owner preparation did not verify its process scope.');
          resolve(result);
        }catch(error){reject(error);}
      });
      child.stdin.on('error',error=>{failure=error;child.kill();});
      child.stdin.end(JSON.stringify({processId:process.pid,parentProcessId:process.ppid,executable:process.execPath}));
    });
  })();
}
