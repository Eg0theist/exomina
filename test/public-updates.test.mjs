import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {PublicUpdates,normalizeRelease,compareVersions,releaseIsNewer,updateUrl} from '../desktop/public-updates.mjs';
import {Updater} from '../desktop/updates.mjs';

const installed={id:'installed-old-build',version:'0.4.0',builtAt:'2026-10-06T12:00:00.000Z'};
const next={id:'published-new-build',version:'0.4.1',builtAt:'2026-10-07T12:00:00.000Z'};
function zip(entries){
 const blocks=[],central=[];let offset=0;
 for(const entry of entries){
  const name=Buffer.from(entry.name),data=Buffer.from(entry.data||'');let crc=0xffffffff;
  for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  blocks.push(local,name,data);
  const head=Buffer.alloc(46);head.writeUInt32LE(0x02014b50);head.writeUInt16LE(0x314,4);head.writeUInt16LE(20,6);head.writeUInt16LE(0x800,8);head.writeUInt32LE(crc,16);head.writeUInt32LE(data.length,20);head.writeUInt32LE(data.length,24);head.writeUInt16LE(name.length,28);head.writeUInt32LE(entry.attributes||0,38);head.writeUInt32LE(offset,42);central.push(head,name);offset+=local.length+name.length+data.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...blocks,directory,end]);
}
const program=stamp=>zip([
 {name:'Exomina.exe',data:'SYNTHETIC PROGRAM: NOT EXECUTABLE'},
 {name:'exomina.build.json',data:JSON.stringify(stamp)},
 {name:'resources/app.asar',data:'Synthetic program archive'},
 {name:'resources/app.asar.unpacked/scripts/install-windows.ps1',data:'Synthetic installer: never executed'},
 {name:'resources/app.asar.unpacked/desktop/update-runner.ps1',data:'Synthetic runner: never executed'},
]);
async function directory(t){const dir=await mkdtemp(path.join(tmpdir(),'exomina-public-update-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});});return dir;}
async function fixture(t,{stamp=next,archive=program(stamp)}={}){
 const dir=await directory(t),stateDir=path.join(dir,'updates');let manifest,slow=false;
 const server=http.createServer((req,res)=>{
  if(req.url==='/latest.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(manifest));}
  else if(req.url==='/package.zip'){
   res.setHeader('Content-Length',archive.length);res.setHeader('Content-Type','application/zip');
   if(!slow)res.end(archive);else{let at=0;const timer=setInterval(()=>{if(at>=archive.length){clearInterval(timer);res.end();return;}res.write(archive.subarray(at,at+32));at+=32;},50);res.on('close',()=>clearInterval(timer));}
  }else{res.statusCode=404;res.end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`,feedUrl=base+'/latest.json';
 manifest={format:1,...stamp,notes:'Synthetic release notes',windows:{x64:{url:base+'/package.zip',size:archive.length,sha256:createHash('sha256').update(archive).digest('hex')}}};
 return{dir,stateDir,feedUrl,manifest,slow:()=>{slow=true;},archive};
}
test('release URLs require HTTPS and reject credentials or insecure redirects',async()=>{
 assert.throws(()=>updateUrl('http://example.com/latest.json'),/HTTPS/);assert.throws(()=>updateUrl('https://name:secret@example.com/latest.json'),/credentials/);
 assert.throws(()=>updateUrl('file:///C:/update.zip'),/HTTPS/);assert.throws(()=>updateUrl('javascript:alert(1)'),/HTTPS/);
 const publicUpdates=new PublicUpdates({stateDir:tmpdir(),fetchImpl:async()=>new Response(null,{status:302,headers:{location:'http://example.com/package.zip'}})});
 await assert.rejects(publicUpdates.request('https://example.com/latest.json',AbortSignal.timeout(1000)),/HTTPS/);
});
test('public release ordering rejects downgrades and distinguishes prereleases',()=>{
 assert.equal(compareVersions('0.4.1','0.4.0'),1);assert.equal(compareVersions('0.4.1','0.4.1-beta.2'),1);assert.equal(compareVersions('0.4.1-beta.10','0.4.1-beta.2'),1);
 assert.equal(releaseIsNewer(next,installed),true);assert.equal(releaseIsNewer(installed,next),false);assert.equal(releaseIsNewer({...next,id:installed.id},installed),false);
 assert.equal(releaseIsNewer({...installed,id:'same-version-new-id',builtAt:next.builtAt},installed),true);
});
test('a release must include a bounded size and a hash for Windows x64',()=>{
 const value={format:1,...next,windows:{x64:{url:'package.zip',size:123,sha256:'a'.repeat(64)}}};
 assert.equal(normalizeRelease(value,'https://example.com/releases/latest.json').asset.url,'https://example.com/releases/package.zip');
 assert.throws(()=>normalizeRelease({...value,windows:{x64:{...value.windows.x64,sha256:'unverified'}}},'https://example.com/latest.json'),/verifiable/);
 assert.throws(()=>normalizeRelease({...value,id:'../../outside'},'https://example.com/latest.json'),/valid Exomina/);
});
test('check-only mode finds the release without downloading or staging it',async t=>{
 const f=await fixture(t),updates=new PublicUpdates({stateDir:f.stateDir,allowLoopback:true});
 await updates.check({feedUrl:f.feedUrl,installed,download:false});assert.equal(updates.progress.phase,'available');assert.equal(await updates.ready(f.feedUrl),null);assert.equal(updates.release.version,'0.4.1');
});
test('unsigned feeds cannot download even with matching feed-supplied hashes',async t=>{
 const f=await fixture(t),requests=[],updates=new PublicUpdates({stateDir:f.stateDir,allowLoopback:true,fetchImpl:(url,options)=>{requests.push(url);return fetch(url,options);},extractImpl:()=>assert.fail('Unauthenticated package extracted')});
 await assert.rejects(updates.check({feedUrl:f.feedUrl,installed}),/publisher authentication/);
 assert.deepEqual(requests,[f.feedUrl]);assert.equal(updates.progress.phase,'error');assert.equal(await updates.ready(f.feedUrl),null);
 assert.ok(!(await readdir(f.stateDir)).includes('downloads'));
});

test('updater default checks discover releases while preserving the automatic-download preference',async t=>{
 const f=await fixture(t),appDir=path.join(f.dir,'App'),resourcesDir=path.join(appDir,'resources');
 await mkdir(path.join(resourcesDir,'app.asar.unpacked/scripts'),{recursive:true});await mkdir(path.join(resourcesDir,'app.asar.unpacked/desktop'),{recursive:true});
 await writeFile(path.join(appDir,'exomina.build.json'),JSON.stringify(installed));await writeFile(path.join(resourcesDir,'app.asar.unpacked/scripts/install-windows.ps1'),'Synthetic installed installer');await writeFile(path.join(resourcesDir,'app.asar.unpacked/desktop/update-runner.ps1'),'Synthetic installed runner');
 const updater=new Updater({packaged:true,appDir,resourcesDir,home:f.dir,stateDir:f.stateDir,exePath:path.join(appDir,'Exomina.exe'),allowLoopback:true,spawnImpl:()=>assert.fail('Discovery started a process')});t.after(()=>updater.close());
 await updater.init({feedUrl:f.feedUrl,automatic:true});const status=await updater.check();
 assert.equal(updater.automatic,true);assert.equal(status.remote.release.id,next.id);assert.equal(status.remote.downloadSupported,false);assert.equal(status.remote.progress.phase,'available');assert.equal(status.available,false);
 await assert.rejects(updater.check({download:true}),/publisher authentication/);
});

test('feed-supplied publisher and signature claims cannot enable downloads',async t=>{
 const f=await fixture(t),updates=new PublicUpdates({stateDir:f.stateDir,allowLoopback:true});
 Object.assign(f.manifest,{signature:'claimed-signature',publicKey:'feed-controlled-key',publisher:'claimed-publisher'});
 await assert.rejects(updates.check({feedUrl:f.feedUrl,installed}),/publisher authentication/);
 f.manifest.windows.x64.sha256='0'.repeat(64);
 await assert.rejects(updates.check({feedUrl:f.feedUrl,installed}),/publisher authentication/);
 assert.equal(await updates.ready(f.feedUrl),null);
});

test('direct download rejects before fetching, extracting or creating any file',async t=>{
 const dir=await directory(t),updates=new PublicUpdates({stateDir:path.join(dir,'updates'),allowLoopback:true,fetchImpl:()=>assert.fail('Unauthenticated download fetched'),extractImpl:()=>assert.fail('Unauthenticated package extracted')});
 await assert.rejects(updates.download(next,'http://127.0.0.1/latest.json',AbortSignal.timeout(1000)),/publisher authentication/);
 assert.deepEqual(await readdir(dir),[]);
});

test('preexisting and modified unsigned ready records cannot launch after restart',async t=>{
 const f=await fixture(t),appDir=path.join(f.dir,'App'),resourcesDir=path.join(appDir,'resources'),buildPath=path.join(f.stateDir,'downloads','old-release','build');
 await mkdir(path.join(resourcesDir,'app.asar.unpacked/scripts'),{recursive:true});await mkdir(path.join(resourcesDir,'app.asar.unpacked/desktop'),{recursive:true});
 await writeFile(path.join(appDir,'exomina.build.json'),JSON.stringify(installed));await writeFile(path.join(resourcesDir,'app.asar.unpacked/scripts/install-windows.ps1'),'Synthetic installed installer');await writeFile(path.join(resourcesDir,'app.asar.unpacked/desktop/update-runner.ps1'),'Synthetic installed runner');
 await mkdir(buildPath,{recursive:true});await writeFile(path.join(buildPath,'exomina.build.json'),JSON.stringify(next));
 await writeFile(path.join(f.stateDir,'public-ready.json'),JSON.stringify({feedUrl:f.feedUrl,release:normalizeRelease(f.manifest,f.feedUrl,{allowLoopback:true}),buildPath}));
 for(const contents of ['SYNTHETIC PROGRAM: NOT EXECUTABLE','MODIFIED SYNTHETIC PROGRAM']){
  await writeFile(path.join(buildPath,'Exomina.exe'),contents);
  const updater=new Updater({packaged:true,appDir,resourcesDir,home:f.dir,stateDir:f.stateDir,exePath:path.join(appDir,'Exomina.exe'),allowLoopback:true,spawnImpl:()=>assert.fail('Unsigned downloaded EXE executed')});t.after(()=>updater.close());
  await updater.init({feedUrl:f.feedUrl});assert.equal(await updater.public.ready(f.feedUrl),null);
  const status=await updater.status();assert.equal(status.available,false);assert.equal(status.remote.downloadSupported,false);assert.match(status.remote.reason,/publisher authentication/);
  await assert.rejects(updater.launch(),/No downloaded or locally packaged update/);
 }
});

test('the real extractor rejects traversal, private data, alternate streams and links',{skip:process.platform!=='win32'},async t=>{
 const dir=await directory(t),updates=new PublicUpdates({stateDir:dir});
 for(const[at,entry]of[{name:'../outside.txt'},{name:'Private/accounts/file.txt'},{name:'file.txt:secret'},{name:'link',attributes:0xa1ff0000}].entries()){
  const archive=path.join(dir,`unsafe-${at}.zip`),target=path.join(dir,`target-${at}`);await writeFile(archive,zip([{...entry,data:'Untrusted archive content'}]));await mkdir(target);
  await assert.rejects(updates.extract(archive,target,AbortSignal.timeout(15000)),/Could not prepare/);assert.deepEqual(await readdir(target),[]);
 }
});
