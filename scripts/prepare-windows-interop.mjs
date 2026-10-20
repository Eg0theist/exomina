// Compile reviewed Windows interop at BUILD time. The application only loads DLLs.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(project,'desktop','windows-interop');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const targets=['Vault','Desktop','Speech','Busy','Scan'];
export async function prepareWindowsInterop(){
 const framework=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');
 const compiler=path.join(framework,'csc.exe');await stat(compiler);
 const previous=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8').catch(()=>'{}'));
 const manifest={format:1,purpose:'Build-time Windows interop; no runtime compiler',files:[]};
 for(const name of targets){
  const source=path.join(directory,name+'.cs'),output=path.join(directory,name+'.dll'),sourceSha256=hash(await readFile(source));
  const old=previous.files?.find(row=>row.name===name);
  let outputBytes=await readFile(output).catch(()=>null);
  if(!old||old.sourceSha256!==sourceSha256||!outputBytes||hash(outputBytes)!==old.sha256){
   const args=['/nologo','/target:library','/optimize+','/debug-','/out:'+output,source];
   if(name==='Speech')args.push('/reference:'+path.join(framework,'WPF','System.Speech.dll'));
   await promisify(execFile)(compiler,args,{windowsHide:true,encoding:'utf8',timeout:60000});
   outputBytes=await readFile(output);
  }
  manifest.files.push({name,file:name+'.dll',source:name+'.cs',sourceSha256,sha256:hash(outputBytes)});
 }
 await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
 return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await prepareWindowsInterop(),null,2));
