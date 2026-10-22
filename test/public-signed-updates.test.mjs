import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PublicUpdates} from '../desktop/public-updates.mjs';
import {Updater} from '../desktop/updates.mjs';
import {signReleaseEnvelope} from '../desktop/update-auth.mjs';
import {verifyPackageInventory,packagePath} from '../desktop/update-package.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),key=generateKeyPairSync('ed25519'),otherKey=generateKeyPairSync('ed25519');
const trust={channel:'stable',trustedKeys:{release:key.publicKey.export({type:'spki',format:'pem'})}};
const installed={id:'installed-test-build',version:'0.4.0',builtAt:'2026-01-01T00:00:00.000Z'};
function zip(entries){
 const blocks=[],central=[];let offset=0;
 for(const entry of entries){const name=Buffer.from(entry.name),data=Buffer.from(entry.data);let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);blocks.push(local,name,data);
  const head=Buffer.alloc(46);head.writeUInt32LE(0x02014b50);head.writeUInt16LE(0x314,4);head.writeUInt16LE(20,6);head.writeUInt16LE(0x800,8);head.writeUInt32LE(crc,16);head.writeUInt32LE(data.length,20);head.writeUInt32LE(data.length,24);head.writeUInt16LE(name.length,28);head.writeUInt32LE(offset,42);central.push(head,name);offset+=local.length+name.length+data.length;
 }const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...blocks,directory,end]);
}
async function fixture(t){
 const dir=await mkdtemp(path.join(tmpdir(),'exomina-signed-update-')),stateDir=path.join(dir,'updates'),requests=[],now=Date.now();
 t.after(async()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});});
 const stamp={id:'signed-release-build',version:'0.5.0',builtAt:new Date(now-3600000).toISOString()},entries=[
  {name:'Exomina.exe',data:'SYNTHETIC SIGNED PROGRAM: NEVER EXECUTED'},
  {name:'exomina.build.json',data:JSON.stringify(stamp)},
  {name:'resources/app.asar',data:'Synthetic archive bytes'},
  {name:'resources/app.asar.unpacked/scripts/install-windows.ps1',data:'Synthetic installer: never executed'},
  {name:'resources/app.asar.unpacked/desktop/update-runner.ps1',data:'Synthetic runner: never executed'},
 ];
 const inventory=JSON.stringify({format:1,buildId:stamp.id,files:entries.map(entry=>({path:entry.name,size:Buffer.byteLength(entry.data),sha256:digest(entry.data)}))});entries.push({name:'exomina.release-integrity.json',data:inventory});const archive=zip(entries);let envelope;
 const server=http.createServer((req,res)=>{requests.push(req.url);if(req.url==='/latest.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(envelope));}else if(req.url==='/package.zip'){res.setHeader('Content-Length',archive.length);res.end(archive);}else{res.statusCode=404;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`,feedUrl=base+'/latest.json',payload={format:2,channel:'stable',...stamp,publishedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+86400000).toISOString(),notes:'Synthetic signed release',windows:{x64:{url:base+'/package.zip',size:archive.length,sha256:digest(archive),inventorySha256:digest(inventory)}}};
 envelope=signReleaseEnvelope(payload,{keyId:'release',privateKey:key.privateKey});
 return{dir,stateDir,feedUrl,stamp,payload,requests,archive,inventory,entries,get envelope(){return envelope;},set envelope(value){envelope=value;},updates:()=>new PublicUpdates({stateDir,allowLoopback:true,trust})};
}

test('signed real ZIP downloads, verifies all bytes, survives restart and yields installer receipt',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),updates=f.updates();await updates.check({feedUrl:f.feedUrl,installed});const ready=await updates.ready(f.feedUrl);
 assert.equal(ready.release.id,f.stamp.id);assert.equal(updates.progress.phase,'ready');assert.deepEqual(f.requests,['/latest.json','/package.zip']);
 const receipt=await readFile(ready.receipt);assert.equal(digest(receipt),ready.receiptHash);assert.ok(JSON.parse(receipt).files.some(entry=>entry.path==='exomina.release-integrity.json'));
 const restored=f.updates();await restored.init();assert.equal((await restored.ready(f.feedUrl)).release.id,f.stamp.id);
});
test('unsigned, tampered and wrong-key envelopes never request a program ZIP',async t=>{
 const f=await fixture(t),valid=f.envelope,updates=f.updates();
 for(const envelope of[f.payload,{...valid,payload:Buffer.from(JSON.stringify({...f.payload,version:'9.0.0'})).toString('base64')},signReleaseEnvelope(f.payload,{keyId:'release',privateKey:otherKey.privateKey})]){
  f.envelope=envelope;await assert.rejects(updates.check({feedUrl:f.feedUrl,installed}),/signature|trusted/);
 }
 assert.equal(f.requests.filter(value=>value==='/package.zip').length,0);assert.equal(await updates.ready(f.feedUrl),null);
});
test('authenticated archive requires the signed inventory hash and exact extracted file inventory',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t);f.envelope=signReleaseEnvelope({...f.payload,windows:{x64:{...f.payload.windows.x64,inventorySha256:'0'.repeat(64)}}},{keyId:'release',privateKey:key.privateKey});
 const updates=f.updates();await assert.rejects(updates.check({feedUrl:f.feedUrl,installed}),/inventory.*authentication/);assert.equal(await updates.ready(f.feedUrl),null);
});
test('cached program modifications or extra files are rejected with no unsigned receipt trust',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),updates=f.updates();await updates.check({feedUrl:f.feedUrl,installed});let ready=await updates.ready(f.feedUrl);
 await writeFile(path.join(ready.buildPath,'Exomina.exe'),'MODIFIED PROGRAM');assert.equal(await updates.ready(f.feedUrl),null);
 const restored=f.updates();await restored.init();assert.equal(await restored.ready(f.feedUrl),null);
 await writeFile(path.join(ready.buildPath,'Exomina.exe'),f.entries.find(entry=>entry.name==='Exomina.exe').data);await writeFile(path.join(ready.buildPath,'extra.exe'),'EXTRA PROGRAM');assert.equal(await updates.ready(f.feedUrl),null);
});
test('public apply revalidates before spawning and passes authenticated receipt to existing installer',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),appDir=path.join(f.dir,'App'),resourcesDir=path.join(appDir,'resources'),channelFile=path.join(f.dir,'channel.json'),calls=[];
 await mkdir(path.join(resourcesDir,'app.asar.unpacked/scripts'),{recursive:true});await mkdir(path.join(resourcesDir,'app.asar.unpacked/desktop'),{recursive:true});
 await writeFile(path.join(appDir,'exomina.build.json'),JSON.stringify(installed));await writeFile(path.join(resourcesDir,'app.asar.unpacked/scripts/install-windows.ps1'),'Synthetic installed installer');await writeFile(path.join(resourcesDir,'app.asar.unpacked/desktop/update-runner.ps1'),'Synthetic installed runner');await writeFile(channelFile,JSON.stringify({format:2,feedUrl:f.feedUrl,...trust}));
 const updater=new Updater({packaged:true,appDir,resourcesDir,home:f.dir,stateDir:f.stateDir,exePath:path.join(appDir,'Exomina.exe'),channelFile,allowLoopback:true,readyTimeoutMs:1000,isProcessAlive:()=>true,spawnImpl:(command,args,options)=>{
  if(!options.detached)return spawn(command,args,options);
  calls.push({command,args,options});const child=new EventEmitter();child.pid=12345;child.unref=()=>{};child.kill=()=>{};writeFile(path.join(f.stateDir,'update-ready.json'),JSON.stringify({attemptId:args[args.indexOf('-AttemptId')+1],pid:child.pid}));return child;
 }});t.after(()=>updater.close());await updater.init({automatic:true});await updater.check();const status=await updater.status();assert.equal(status.remote.downloadSupported,true);assert.equal(status.source,'public');
 const exe=path.join(status.buildPath,'Exomina.exe'),original=await readFile(exe);await writeFile(exe,'MODIFIED BEFORE APPLY');await assert.rejects(updater.launch(),/authenticate/);assert.equal(calls.length,0);
 await writeFile(exe,original);await updater.public.ready(f.feedUrl);await updater.launch();assert.equal(calls.length,1);const args=calls[0].args,receipt=args[args.indexOf('-ExpectedManifest')+1],hash=args[args.indexOf('-ExpectedManifestHash')+1];assert.ok(receipt.endsWith('.json'));assert.equal(digest(await readFile(receipt)),hash);
});
test('package paths reject streams, traversal, Windows aliases and private content',()=>{
 for(const value of['../escape','a/../b','file:stream','CON.txt','folder/name.','Private/file','Source/main.js','a\\b','A?B'])assert.throws(()=>packagePath(value));assert.equal(packagePath('resources/app.asar'),'resources/app.asar');
});

test('hard links outside the update tree invalidate an authenticated package',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),updates=f.updates();await updates.check({feedUrl:f.feedUrl,installed});const ready=await updates.ready(f.feedUrl);
 await link(path.join(ready.buildPath,'Exomina.exe'),path.join(f.dir,'outside-hardlink'));
 await assert.rejects(verifyPackageInventory(ready.buildPath,{inventorySha256:f.payload.windows.x64.inventorySha256,buildId:f.stamp.id}),/Linked/);assert.equal(await updates.ready(f.feedUrl),null);
});

test('EFS inheritance is cleared only on the fresh empty extraction destination',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),archive=path.join(f.dir,'efs-test.zip'),target=path.join(f.dir,'efs-target');await writeFile(archive,f.archive);await mkdir(target);
 await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','[IO.File]::Encrypt($env:EXOMINA_QA_EFS_TARGET)'],{windowsHide:true,env:{...process.env,EXOMINA_QA_EFS_TARGET:target}});
 const updates=f.updates();await updates.extract(archive,target,AbortSignal.timeout(15000));await updates.verifyPlain(target);
 await verifyPackageInventory(target,{inventorySha256:f.payload.windows.x64.inventorySha256,buildId:f.stamp.id});
});

test('an EFS-encrypted cached program is refused even when its plaintext hash matches',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),updates=f.updates();await updates.check({feedUrl:f.feedUrl,installed});const ready=await updates.ready(f.feedUrl),exe=path.join(ready.buildPath,'Exomina.exe');
 await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','[IO.File]::Encrypt($env:EXOMINA_QA_EFS_TARGET)'],{windowsHide:true,env:{...process.env,EXOMINA_QA_EFS_TARGET:exe}});
 assert.equal(digest(await readFile(exe)),digest(f.entries.find(entry=>entry.name==='Exomina.exe').data));assert.equal(await updates.ready(f.feedUrl),null);
});
