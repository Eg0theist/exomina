// Fetches pinned public program artifacts, never sign-ins or desktop recordings.
import {readFile,writeFile,mkdir,stat,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const arguments_=process.argv.slice(2);
if(arguments_.some(argument=>argument!=='--python-only'))throw Error('Only --python-only is supported.');
const pythonOnly=arguments_.includes('--python-only');
const programs=[
 {dir:'python',probe:'python.exe',url:'https://www.python.org/ftp/python/3.13.7/python-3.13.7-embed-amd64.zip',hash:'f6cca216a359be84797cabb54149ce5e062afb16cc7567eb7fc51cacb2d86b65'},
 {dir:'cua-driver',probe:'cua-driver.exe',url:'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.33.4/cua-driver-rs-0.33.4-windows-x86_64-binary.zip',hash:'93f658ac02080ac1fac709f88f79ba38980ce77b816725ec2a0128aeba1811f5'},
];
for(const item of programs.filter(item=>!pythonOnly||item.dir==='python')){
 const target=path.join(root,'vendor',item.dir);try{await stat(path.join(target,item.probe));console.log('Using prepared '+item.dir+' runtime.');continue;}catch{}
 if(process.platform!=='win32')throw Error('Windows runtime preparation requires Windows.');
 const response=await fetch(item.url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('Official runtime download failed: '+response.status);
 const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==item.hash)throw Error('Official '+item.dir+' archive checksum mismatch.');
 await mkdir(target,{recursive:true});const archive=path.join(target,'.official-runtime.zip');await writeFile(archive,bytes);
 // Hash verification happens before extraction. ZIP entries must stay inside target.
 const script=`Add-Type -AssemblyName System.IO.Compression.FileSystem\n$zip=[IO.Compression.ZipFile]::OpenRead($env:EXOMINA_VENDOR_ZIP)\ntry { foreach($entry in $zip.Entries) { $name=$entry.FullName.Replace('/','\\'); if($name.Contains(':') -or [IO.Path]::IsPathRooted($name) -or $name.Split('\\').Contains('..')) { throw 'Invalid official archive path' }; $out=[IO.Path]::GetFullPath([IO.Path]::Combine($env:EXOMINA_VENDOR_TARGET,$name)); if(-not $out.StartsWith($env:EXOMINA_VENDOR_TARGET+'\\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path outside runtime' }; if($entry.Name) { $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($out)); [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$out,$true) } } } finally { $zip.Dispose() }`;
 const helper=path.join(target,'.extract-runtime.ps1');await writeFile(helper,script);
 try {await new Promise((resolve,reject)=>{const child=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{windowsHide:true,env:{...process.env,EXOMINA_VENDOR_ZIP:archive,EXOMINA_VENDOR_TARGET:target},stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Runtime extraction failed.')));});}
 finally {await rm(archive,{force:true});await rm(helper,{force:true});}
 await stat(path.join(target,item.probe));console.log('Verified and prepared '+item.dir+' runtime.');
}
