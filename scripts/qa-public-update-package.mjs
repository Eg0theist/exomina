// Publisher command and real downloader/extractor, using synthetic program files only.
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {PublicUpdates,normalizeRelease} from '../desktop/public-updates.mjs';
const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-public-update-package-')),build=path.join(output,'synthetic-build'),artifacts=path.join(output,'artifacts');
const stamp={id:'synthetic-publisher-build',version:'0.4.1',builtAt:'2026-10-07T12:00:00.000Z'};
for(const[file,content]of Object.entries({'Exomina.exe':'SYNTHETIC EXE: NEVER EXECUTED','exomina.build.json':JSON.stringify(stamp),'resources/app.asar':'SYNTHETIC ASAR','resources/app.asar.unpacked/scripts/install-windows.ps1':'SYNTHETIC INSTALLER','resources/app.asar.unpacked/desktop/update-runner.ps1':'SYNTHETIC RUNNER'})){await mkdir(path.dirname(path.join(build,file)),{recursive:true});await writeFile(path.join(build,file),content);}
const report={output,scope:'Actual publisher ZIP/manifest command and streamed localhost download with real Windows extraction; synthetic program payload, no installer execution or public publication.'};let server,updates;
try{
 await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'scripts/create-public-update.mjs'),'--base-url','https://publisher.example.invalid/releases/0.4.1/','--build',build,'--output',artifacts],{windowsHide:true,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',chunk=>{error+=chunk;});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(error||`Publisher exited ${code}`)));});
 const manifest=JSON.parse(await readFile(path.join(artifacts,'latest.json'),'utf8'));normalizeRelease(manifest,'https://publisher.example.invalid/latest.json');
 const archive=await readFile(path.join(artifacts,path.basename(new URL(manifest.windows.x64.url).pathname)));
 server=http.createServer((req,res)=>{if(req.url==='/latest.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(manifest));}else{res.setHeader('Content-Type','application/zip');res.end(archive);}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;manifest.windows.x64.url=base+'/package.zip';
 updates=new PublicUpdates({stateDir:path.join(output,'download-cache'),allowLoopback:true});await updates.check({feedUrl:base+'/latest.json',installed:{id:'synthetic-older-build',version:'0.4.0',builtAt:'2026-10-06T12:00:00.000Z'}});
 const ready=await updates.ready(base+'/latest.json');assert.equal(ready.release.id,stamp.id);assert.equal(await readFile(path.join(ready.buildPath,'Exomina.exe'),'utf8'),'SYNTHETIC EXE: NEVER EXECUTED');report.checks={generatedManifest:true,generatedZipBytes:archive.length,matchingHashAndSize:true,realExtraction:true,buildIdentity:true,noProgramExecuted:true};report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{updates?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
