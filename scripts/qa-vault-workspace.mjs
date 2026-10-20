import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {WindowsVault} from '../desktop/vault.mjs';
import {createProtectedQaProfile} from './qa-profile.mjs';

const fixture=await createProtectedQaProfile('workspace-capabilities'),vault=new WindowsVault();
const {thumbprint}=JSON.parse(await readFile(fixture.profile+'.setup/recovery-backup.json','utf8'));
const workspace=path.join(fixture.profile,'workspace'),capabilityFile=path.join(fixture.profile,'cap_sid');
await mkdir(workspace);await writeFile(path.join(workspace,'test.txt'),'Synthetic workspace file.');
const sid='S-1-5-21-102938475-564738291-123456789-1001',unknown='S-1-5-21-102938475-564738291-123456789-1002';
const key=workspace.replaceAll('\\','/').toLowerCase();
await writeFile(capabilityFile,JSON.stringify({workspace_by_cwd:{[key]:sid},writable_root_by_path:{}}));
const proof={recoveryThumbprint:thumbprint,capabilityFile};
const literal=v=>"'"+v.replaceAll("'","''")+"'";
function ps(command){return new Promise((resolve,reject)=>{const p=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security');"+command],{windowsHide:true,stdio:['ignore','pipe','pipe']});let error='';p.stderr.on('data',d=>error+=d);p.on('error',reject);p.on('close',c=>c?reject(Error(error)):resolve());});}
async function rule(file,sid,rights,remove=false){await ps(`$a=Get-Acl -LiteralPath ${literal(file)};$r=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('${sid}'),'${rights}','Allow');$a.${remove?'RemoveAccessRuleSpecific':'AddAccessRule'}($r);Set-Acl -LiteralPath ${literal(file)} -AclObject $a`);}
try{
  await rule(workspace,sid,'Modify, Synchronize');
  await assert.rejects(vault.verifyStartup(workspace,proof),/root is not protected/);
  assert.equal((await vault.verifyWorkspace(workspace,proof)).restrictedAccess,true);
  assert.equal((await vault.verifyWorkspace(workspace,{...proof,full:true})).restrictedAccess,true);
  await writeFile(capabilityFile,JSON.stringify({workspace_by_cwd:{[key+'/other']:sid}}));
  await assert.rejects(vault.verifyWorkspace(workspace,proof),/Workspace protection failed/);
  await writeFile(capabilityFile,JSON.stringify({workspace_by_cwd:{[key]:sid}}));
  await rule(workspace,unknown,'Read');
  await assert.rejects(vault.verifyWorkspace(workspace,proof),/Workspace protection failed/);
  await rule(workspace,unknown,'Read',true);
  await rule(workspace,sid,'Modify, Synchronize',true);await rule(workspace,sid,'FullControl');
  await assert.rejects(vault.verifyWorkspace(workspace,proof),/Workspace protection failed/);
  await rule(workspace,sid,'FullControl',true);await rule(workspace,sid,'Modify, Synchronize');
  await rule(capabilityFile,'S-1-1-0','Read');
  await assert.rejects(vault.verifyWorkspace(workspace,proof),/metadata could not be verified/);
  await rule(capabilityFile,'S-1-1-0','Read',true);
  await ps(`[IO.File]::Decrypt(${literal(capabilityFile)})`);
  await assert.rejects(vault.verifyWorkspace(workspace,proof),/metadata could not be verified/);
  await ps(`[IO.File]::Encrypt(${literal(capabilityFile)})`);
  assert.equal((await vault.verifyWorkspace(workspace,proof)).encrypted,true);
  await rule(workspace,sid,'Modify, Synchronize',true);await fixture.verify();
  const result={syntheticOnly:true,exactWorkspaceCapabilityAccepted:true,recursiveWorkspaceAuditPassed:true,privateVaultStillRejectsCapability:true,otherWorkspaceRejected:true,unknownSidRejected:true,fullControlRejected:true,exposedMetadataRejected:true,plaintextMetadataRejected:true};
  await writeFile(path.join(fixture.output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{vault.close();}
