import path from 'node:path';
/** Quote paths as data in a human-inspectable launcher for an isolated restore. */
export function libraryRestoreLauncher({target,workspace,executable,platform=process.platform}){
  const profile=path.join(target,'Profile'),accounts=path.join(target,'Accounts');
  if(platform==='win32'){
    const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
    return {name:'Open restored Exomina.ps1',mode:0o600,text:`$env:EXOMINA_DATA_DIR=${quote(profile)}\n$env:EXOMINA_ACCOUNTS_DIR=${quote(accounts)}\n$env:EXOMINA_WORKSPACE_DIR=${quote(workspace)}\nStart-Process -FilePath ${quote(executable)} -WindowStyle Normal\n`};
  }
  if(!['darwin','linux'].includes(platform))throw Error('Library restore launchers support Windows, macOS and Linux.');
  const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
  return {name:platform==='darwin'?'Open restored Exomina.command':'Open restored Exomina.sh',mode:0o700,text:`#!/bin/sh\nexport EXOMINA_DATA_DIR=${quote(profile)}\nexport EXOMINA_ACCOUNTS_DIR=${quote(accounts)}\nexport EXOMINA_WORKSPACE_DIR=${quote(workspace)}\nexec ${quote(executable)} "$@"\n`};
}
