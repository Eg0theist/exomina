// Creates uploadable program files and their update feed. Does not publish anything.
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateUrl, normalizeRelease } from '../desktop/public-updates.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2);
const option=name=>{const index=args.indexOf(name);return index<0?null:args[index+1];};
if(args.includes('--help')||!option('--base-url')){console.log('npm run release:update -- --base-url https://your-release-host/path/ [--notes-file release-notes.txt] [--build packaged-folder] [--output artifact-folder]\nSet build/update-channel.json feedUrl before packaging. Upload the resulting ZIP and latest.json to that host.');if(!args.includes('--help'))process.exitCode=1;}else{
 const build=option('--build')?path.resolve(option('--build')):path.join(root,'release/win-unpacked'),stamp=JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8'));
 const base=updateUrl(option('--base-url')),filename=`Exomina-${stamp.version}-${stamp.id.slice(0,8)}-windows-x64.zip`,output=option('--output')?path.resolve(option('--output')):path.join(root,'release/public'),archive=path.join(output,filename);
 const url=new URL(filename,base.endsWith('/')?base:base+'/').href;
 await mkdir(output,{recursive:true});
 await new Promise((resolve,reject)=>{const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',path.join(root,'scripts/create-update.ps1')],{windowsHide:true,env:{...process.env,EXOMINA_RELEASE_BUILD:build,EXOMINA_RELEASE_ZIP:archive},stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',chunk=>{error=(error+chunk).slice(-2000);});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Release archive failed: '+error)));});
 const hash=createHash('sha256');for await(const chunk of createReadStream(archive))hash.update(chunk);
 const manifest={format:1,...stamp,notes:option('--notes-file')?(await readFile(path.resolve(option('--notes-file')),'utf8')).slice(0,10000):'',windows:{x64:{url,size:(await stat(archive)).size,sha256:hash.digest('hex')}}};
 normalizeRelease(manifest,new URL('latest.json',url).href);
 const feed=path.join(output,'latest.json');await writeFile(feed,JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({archive,feed,bytes:manifest.windows.x64.size,sha256:manifest.windows.x64.sha256},null,2));
}
