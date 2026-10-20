import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile,unlink,link,symlink,access} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {WindowsVault} from '../desktop/vault.mjs';
import {createProtectedQaProfile} from './qa-profile.mjs';

// Real EFS and native-metadata regression checks, entirely within a fresh
// synthetic profile. No personal profile, backup, password, or private key.
const fixture=await createProtectedQaProfile('vault-native');
const helper=process.argv[2]?path.resolve(process.argv[2]):fileURLToPath(new URL('../desktop/vault-windows.ps1',import.meta.url));
const source=await readFile(helper,'utf8'),vault=new WindowsVault({scriptPath:helper});
const nativeSource=await readFile(path.join(path.dirname(helper),'windows-interop','Vault.cs'),'utf8');
async function instrumentedHelper(label,native){
 const directory=path.join(fixture.output,label),assembly=path.join(directory,'windows-interop');await mkdir(assembly,{recursive:true});
 const cs=path.join(assembly,'Vault.cs');await writeFile(cs,native,'utf8');
 const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
 await promisify(execFile)(compiler,['/nologo','/target:library','/out:'+path.join(assembly,'Vault.dll'),cs],{windowsHide:true});
 const script=path.join(directory,'vault-windows.ps1');await writeFile(script,source,'utf8');return new WindowsVault({scriptPath:script});
}
const record=JSON.parse(await readFile(fixture.profile+'.setup/recovery-backup.json','utf8'));
const proof={recoveryThumbprint:record.thumbprint};
const executable=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const literal=value=>"'"+value.replaceAll("'","''")+"'";
function ps(command){return new Promise((resolve,reject)=>{const child=spawn(executable,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security');"+command],{windowsHide:true,stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);child.on('close',code=>code?reject(Error(error)):resolve());});}
const file=path.join(fixture.profile,'synthetic-file.txt');await writeFile(file,'Synthetic verifier fixture.');
const baseline=await vault.verify(fixture.profile,proof);assert.equal(baseline.restrictedAccess,true);
const rule=(sid,rights,type)=>`[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('${sid}'),[Security.AccessControl.FileSystemRights]::${rights},[Security.AccessControl.AccessControlType]::${type})`;
await ps(`$acl=Get-Acl -LiteralPath ${literal(file)};$acl.AddAccessRule(${rule('S-1-1-0','ExecuteFile','Deny')});Set-Acl -LiteralPath ${literal(file)} -AclObject $acl`);
assert.equal((await vault.verify(fixture.profile,proof)).restrictedAccess,true);
await ps(`$acl=Get-Acl -LiteralPath ${literal(file)};$acl.AddAccessRule(${rule('S-1-1-0','Read','Allow')});Set-Acl -LiteralPath ${literal(file)} -AclObject $acl`);
assert.equal((await vault.preflight(fixture.profile)).restrictedAccess,false);
await assert.rejects(vault.verify(fixture.profile,proof),/not fully protected/);
await ps(`$acl=Get-Acl -LiteralPath ${literal(file)};$acl.RemoveAccessRuleSpecific(${rule('S-1-1-0','Read','Allow')});Set-Acl -LiteralPath ${literal(file)} -AclObject $acl`);

// NULL DACL must not pass an empty-rule enumeration. Restore the exact original
// descriptor afterward; the containing directory remains private throughout.
const aclCopy=path.join(fixture.output,'synthetic-descriptor.txt');
await ps(`[IO.File]::WriteAllText(${literal(aclCopy)},(Get-Acl -LiteralPath ${literal(file)}).Sddl);Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class QaNullAcl{[DllImport("advapi32.dll",CharSet=CharSet.Unicode)]public static extern uint SetNamedSecurityInfo(string path,uint type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);}';if([QaNullAcl]::SetNamedSecurityInfo(${literal(file)},1,4,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero)-ne 0){throw 'Synthetic NULL DACL setup failed'}`);
assert.equal((await vault.preflight(fixture.profile)).restrictedAccess,false);
await ps(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class QaRestoreAcl{[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl,uint revision,out IntPtr descriptor,out uint length);[DllImport("advapi32.dll",SetLastError=true)]static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);[DllImport("advapi32.dll",CharSet=CharSet.Unicode)]static extern uint SetNamedSecurityInfo(string path,uint type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);[DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr value);public static void Restore(string path,string sddl){IntPtr descriptor;uint length;if(!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl,1,out descriptor,out length))throw new Exception("Synthetic ACL conversion failed");try{bool present,defaulted;IntPtr dacl;if(!GetSecurityDescriptorDacl(descriptor,out present,out dacl,out defaulted)||!present||dacl==IntPtr.Zero)throw new Exception("Synthetic saved DACL invalid");if(SetNamedSecurityInfo(path,1,4,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero)!=0)throw new Exception("Synthetic ACL restoration failed");}finally{LocalFree(descriptor);}}}';[QaRestoreAcl]::Restore(${literal(file)},[IO.File]::ReadAllText(${literal(aclCopy)}))`);

await assert.rejects(vault.verify(fixture.profile,{recoveryThumbprint:'0'.repeat(40)}),/different recovery certificate/);
const plain=path.join(fixture.profile,'synthetic-plaintext.txt');await writeFile(plain,'Synthetic plaintext.');await ps(`[IO.File]::Decrypt(${literal(plain)})`);
assert.equal((await vault.preflight(fixture.profile)).unencryptedEntries,1);await assert.rejects(vault.verify(fixture.profile,proof),/not fully protected/);await unlink(plain);
const hidden=path.join(fixture.profile,'synthetic-hidden-empty');await writeFile(hidden,'');await ps(`[IO.File]::Decrypt(${literal(hidden)});[IO.File]::SetAttributes(${literal(hidden)},[IO.FileAttributes]::Hidden)`);
assert.equal((await vault.verify(fixture.profile,proof)).emptyUnencryptedFiles,1);
const ads=path.join(fixture.profile,'synthetic-ads');await writeFile(ads,'');await ps(`Set-Content -LiteralPath ${literal(ads)} -Stream 'synthetic-payload' -Value 'Synthetic stream bytes' -NoNewline;[IO.File]::Decrypt(${literal(ads)})`);
assert.equal((await vault.preflight(fixture.profile)).unencryptedEntries,1);await assert.rejects(vault.verify(fixture.profile,proof),/not fully protected/);await unlink(ads);

const hard=path.join(fixture.profile,'synthetic-hardlink');await link(file,hard);await assert.rejects(vault.verify(fixture.profile,proof),/hard-linked/);await unlink(hard);
const outside=path.join(fixture.output,'synthetic-outside');await mkdir(outside);const junction=path.join(fixture.profile,'synthetic-junction');await symlink(outside,junction,'junction');await assert.rejects(vault.preflight(fixture.profile),/symbolic link|junction|placeholder/);await unlink(junction);
const deep=path.join(fixture.profile,'a'.repeat(70),'b'.repeat(70),'c'.repeat(70));await mkdir(deep,{recursive:true});const long=path.join(deep,'synthetic-longpath.txt');await writeFile(long,'Synthetic long path.');assert.ok(long.length>260);await vault.verify(fixture.profile,proof);assert.equal(await readFile(long,'utf8'),'Synthetic long path.');

// Deterministic own-fixture mutation after enumeration verifies both native
// not-found propagation and full-audit retries, without relying on timing.
const vanishing=path.join(fixture.profile,'synthetic-vanishing.txt');
const injected=nativeSource.replace('using(var handle=Open(item.Path))','if(item.Path.EndsWith("synthetic-vanishing.txt",System.StringComparison.Ordinal))System.IO.File.Delete(item.Path);using(var handle=Open(item.Path))');assert.notEqual(injected,nativeSource);
const instrumented=await instrumentedHelper('synthetic-disappearance',injected);await writeFile(vanishing,'Synthetic disappearing file.');
let missing;try{await instrumented.request('verify',fixture.profile,proof);}catch(error){missing=error;}
assert.equal(missing?.diagnostic?.category,'FileNotFoundException');await assert.rejects(access(vanishing));
await writeFile(vanishing,'Synthetic disappearing file.');assert.equal((await instrumented.verify(fixture.profile,proof)).encrypted,true);await assert.rejects(access(vanishing));

const changed=path.join(fixture.profile,'synthetic-type-change');await writeFile(changed,'Synthetic prior file.');
const changing=nativeSource.replace('using(var handle=Open(item.Path))','if(item.Path.EndsWith("synthetic-type-change",System.StringComparison.Ordinal)){System.IO.File.Delete(item.Path);System.IO.Directory.CreateDirectory(item.Path);}using(var handle=Open(item.Path))');assert.notEqual(changing,nativeSource);
const changingVault=await instrumentedHelper('synthetic-type-change',changing);await assert.rejects(changingVault.verify(fixture.profile,proof),/changed type/);
const final=await vault.verify(fixture.profile,proof);
const report={syntheticOnly:true,profile:fixture.profile,denyAccepted:true,unauthorizedAllowRejected:true,nullDaclRejected:true,wrongRecipientRejected:true,plaintextRejected:true,hiddenEmptyAccepted:true,nonemptyAdsRejected:true,hardlinkRejected:true,junctionRejected:true,longPathCharacters:long.length,disappearanceCategory:missing.diagnostic.category,wholeAuditRetryPassed:true,typeReplacementRejected:true,baseline,final};
await writeFile(path.join(fixture.output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
