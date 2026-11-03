import {readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Pin the verified-code-signing authority from the reviewed bundle, together
// with the exact verified publisher below. Leaf certificates rotate frequently.
export const CUA_SIGNING_AUTHORITY_KEY='7bbaedfb4685271c838a410dc3dd16391bca1a525ac143f2f4b8729b92aa86d4';
const PUBLISHER='CN="Cua AI, Inc.", O="Cua AI, Inc.", L=San Francisco, S=California, C=US';
const ALLOWED=new Set(['cua-driver.exe','cua-driver-uia.exe','cua-cursor-theme.exe','cua_driver_sdk.dll','cua_driver_node_runtime.node','cua_driver_abi.h','LICENSE.md','LICENSE.txt','README.md']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function inspectSignature(file){
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const script="$s=Get-AuthenticodeSignature -LiteralPath $env:EXOMINA_TOOL_SIGNED_FILE; if(!$s.SignerCertificate){throw 'No code-signing certificate'}; $chain=New-Object Security.Cryptography.X509Certificates.X509Chain; $chain.ChainPolicy.VerificationFlags='IgnoreNotTimeValid'; $chain.ChainPolicy.RevocationMode='NoCheck'; if(!$chain.Build($s.SignerCertificate)){throw 'Untrusted signing chain'}; $authority=@($chain.ChainElements|Where-Object {$_.Certificate.Subject -eq 'CN=Microsoft ID Verified Code Signing PCA 2021, O=Microsoft Corporation, C=US'}); $h=[Security.Cryptography.SHA256]::Create(); try{$key=([BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.GetPublicKey()))).Replace('-','').ToLowerInvariant(); $authorityKey=if($authority.Count -eq 1){([BitConverter]::ToString($h.ComputeHash($authority[0].Certificate.GetPublicKey()))).Replace('-','').ToLowerInvariant()}else{''}}finally{$h.Dispose();$chain.Dispose()}; $eku=$s.SignerCertificate.Extensions|Where-Object {$_.Oid.Value -eq '2.5.29.37'}; $coding=@($eku.EnhancedKeyUsages|Where-Object {$_.Value -eq '1.3.6.1.5.5.7.3.3'}).Count -gt 0; [pscustomobject]@{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject;keySha256=$key;authorityKeySha256=$authorityKey;codeSigning=$coding}|ConvertTo-Json -Compress";
  const {stdout}=await promisify(execFile)(executable,['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,EXOMINA_TOOL_SIGNED_FILE:file},windowsHide:true,timeout:60000,maxBuffer:100000,encoding:'utf8'});
  return JSON.parse(stdout);
}
export function assertPublisher(value){
  if(value?.status!=='Valid'||value.subject!==PUBLISHER||value.authorityKeySha256!==CUA_SIGNING_AUTHORITY_KEY||value.codeSigning!==true)throw Error('The driver publisher key or identity is not approved by this Exomina release. The installed version was kept.');
}
export async function inspectDriverPackage(root,verifySignature=inspectSignature){
  const files=[];
  async function walk(directory,depth=0){
    if(depth>1)throw Error('Unexpected tool archive directory.');
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name),info=await lstat(file);
      if(info.isSymbolicLink()||info.isFile()&&info.nlink!==1)throw Error('Tool directory contains a linked file.');
      if(info.isDirectory()){if(entry.name.endsWith('.local')||entry.name.startsWith('.'))throw Error('Unexpected tool archive directory.');await walk(file,depth+1);}
      else if(info.isFile()&&ALLOWED.has(entry.name))files.push({file,name:entry.name,bytes:info.size});
      else throw Error('Unexpected file in tool archive: '+entry.name);
    }
  }
  await walk(root);const executables=files.filter(file=>file.name==='cua-driver.exe');
  if(executables.length!==1)throw Error('The archive does not contain one unambiguous driver executable.');
  const executable=executables[0].file,directory=path.dirname(executable),manifest=[];
  for(const file of files.sort((a,b)=>a.name.localeCompare(b.name))){
    if(path.dirname(file.file)!==directory)throw Error('Tool archive files are not in one program directory.');
    if(/\.(exe|dll|node)$/i.test(file.name))assertPublisher(await verifySignature(file.file));
    manifest.push({file:file.name,bytes:file.bytes,sha256:hash(await readFile(file.file))});
  }
  return {executable,directory,files:manifest};
}
export async function verifyManagedDriver(config,settings){
  const managed=settings.managedCua;if(!managed||path.resolve(config.command).toLowerCase()!==path.resolve(managed.command).toLowerCase())return;
  const actual=await inspectDriverPackage(path.dirname(config.command));
  if(!Array.isArray(managed.files)||JSON.stringify(actual.files)!==JSON.stringify(managed.files))throw Error('The managed computer driver changed on disk. Use the previous version in Tools or reinstall it.');
}
