import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,utimes,readdir,rm,symlink,readFile,stat,copyFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {assertDiskSpace,diskLevel,freeSpace,formatBytes,pruneTemporaryFiles,pruneFileBackups,DiskGuard,DISK_LOW_BYTES,DISK_CRITICAL_BYTES,DOWNLOAD_RESERVE_BYTES} from '../desktop/disk-guard.mjs';

const DAY=86400000,NOW=Date.parse('2026-11-05T12:00:00Z');
// Fixtures can only backdate modified times, so age tests judge by those alone.
const activity=info=>info.mtimeMs;
const statfsWith=free=>async()=>({bavail:free,bsize:1,blocks:free*2});
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'exomina-disk-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function aged(file,days,content='x'){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content);const at=new Date(NOW-days*DAY);await utimes(file,at,at);}
const ageDir=(dir,days)=>{const at=new Date(NOW-days*DAY);return utimes(dir,at,at);};

test('levels and the refusal message report concrete sizes',async()=>{
 assert.equal(diskLevel(DISK_LOW_BYTES),'ok');assert.equal(diskLevel(DISK_LOW_BYTES-1),'low');assert.equal(diskLevel(DISK_CRITICAL_BYTES-1),'critical');assert.equal(diskLevel(undefined),'unknown');
 assert.equal(formatBytes(1.5*1024**3),'1.5 GB');
 await assert.rejects(assertDiskSpace('x',1024**3,{label:'Downloading this update',statfs:statfsWith(1024**3)}),error=>{
  assert.equal(error.code,'DISK_SPACE');assert.match(error.message,/^Downloading this update needs about 3\.0 GB of free disk space, but only 1\.0 GB is available\..*Nothing was changed\.$/);return true;});
});
test('the reserve is enforced at its exact boundary',async()=>{
 await assertDiskSpace('x',100,{statfs:statfsWith(100+DOWNLOAD_RESERVE_BYTES)});
 await assert.rejects(assertDiskSpace('x',100,{statfs:statfsWith(99+DOWNLOAD_RESERVE_BYTES)}),{code:'DISK_SPACE'});
});
test('an unreadable volume never blocks work',async()=>{
 const statfs=async()=>{throw Object.assign(Error('unsupported'),{code:'ENOSYS'});};
 assert.equal(await freeSpace('x',{statfs}),null);assert.equal(await assertDiskSpace('x',1e15,{statfs}),null);
});
test('a destination that does not exist yet is checked on its nearest existing parent',async()=>{
 const seen=[];const statfs=async location=>{seen.push(location);if(location.endsWith('new'))throw Object.assign(Error('missing'),{code:'ENOENT'});return {bavail:1,bsize:1,blocks:2};};
 await assert.rejects(assertDiskSpace(path.join('base','new','new'),1,{statfs}),{code:'DISK_SPACE'});assert.equal(seen.length,3);
});
test('temp files stay while a terminal or command runs, and backups still expire',async t=>{
 const root=await fixture(t);await aged(path.join(root,'runtime-tmp','old.tmp'),30);const backup=randomUUID()+'.bak';await aged(path.join(root,'file-backups',backup),30);
 const later=()=>Date.now()+200*DAY;
 const busy=await new DiskGuard({dataDir:root,temporaryInUse:()=>true,now:later}).cleanup();
 assert.equal(busy.temporarySkipped,true);assert.equal(busy.removed,1);assert.deepEqual(await readdir(path.join(root,'runtime-tmp')),['old.tmp']);
 const idle=await new DiskGuard({dataDir:root,now:later}).cleanup();assert.equal(idle.temporarySkipped,false);assert.deepEqual(await readdir(path.join(root,'runtime-tmp')),[]);
});
test('the real volume reports a usable answer',async t=>{
 const space=await freeSpace(await fixture(t));assert.ok(space.freeBytes>0&&space.totalBytes>=space.freeBytes);
});

test('old temp entries go; recent ones, diagnostics and anything recently touched inside stay',async t=>{
 const root=await fixture(t);
 await aged(path.join(root,'old-bundle','deep','a.js'),30,'12345');await ageDir(path.join(root,'old-bundle','deep'),30);await ageDir(path.join(root,'old-bundle'),30);
 await aged(path.join(root,'old-file.tmp'),8);
 await aged(path.join(root,'fresh-file.tmp'),1);
 await aged(path.join(root,'old-dir-fresh-child','old.txt'),30);await aged(path.join(root,'old-dir-fresh-child','new.txt'),1);await ageDir(path.join(root,'old-dir-fresh-child'),30);
 await aged(path.join(root,'startup-timing.json'),400);
 const result=await pruneTemporaryFiles(root,{now:NOW,activity});
 assert.deepEqual((await readdir(root)).sort(),['fresh-file.tmp','old-dir-fresh-child','startup-timing.json']);
 assert.equal(result.removed,2);assert.equal(result.bytes,6);assert.equal(result.kept,3);
});
test('a link in temp is removed as a link and its target survives',async t=>{
 const root=await fixture(t),temporary=path.join(root,'tmp'),precious=path.join(root,'project');
 await mkdir(temporary);await aged(path.join(precious,'keep.txt'),30,'keep');
 const link=path.join(temporary,'link');await symlink(precious,link,process.platform==='win32'?'junction':'dir');
 const at=new Date(NOW-30*DAY);await utimes(temporary,at,at);
 // lstat on a fresh link reports now, so simulate a later cleanup pass.
 await pruneTemporaryFiles(temporary,{now:Date.now()+30*DAY});
 assert.deepEqual(await readdir(temporary),[]);assert.equal(await readFile(path.join(precious,'keep.txt'),'utf8'),'keep');
});
test('a missing temp folder is simply nothing to do',async t=>{
 assert.deepEqual(await pruneTemporaryFiles(path.join(await fixture(t),'absent')),{removed:0,bytes:0,kept:0});
});

test('backups expire with age, ignore unknown files and stay under the cap oldest first',async t=>{
 const root=await fixture(t),name=()=>randomUUID()+'.bak';
 const expired=name(),middle=name(),recent=name(),other='notes.txt';
 await aged(path.join(root,expired),91,'aaaa');await aged(path.join(root,middle),30,'bbbb');await aged(path.join(root,recent),1,'cccc');await aged(path.join(root,other),999,'dddd');
 let result=await pruneFileBackups(root,{now:NOW,maxBytes:1024,activity});
 assert.equal(result.removed,1);assert.deepEqual((await readdir(root)).sort(),[middle,recent,other].sort());
 // Over the cap: older go first, but the most recent week is always retained.
 result=await pruneFileBackups(root,{now:NOW,maxBytes:2,activity});
 assert.equal(result.removed,1);assert.deepEqual((await readdir(root)).sort(),[recent,other].sort());
});

test('a backup just made of an old file is not mistaken for an old backup',async t=>{
 const root=await fixture(t),source=path.join(root,'old-source.txt'),backups=path.join(root,'backups'),name=randomUUID()+'.bak';
 await aged(source,400,'precious');await mkdir(backups);await copyFile(source,path.join(backups,name));
 const result=await pruneFileBackups(backups,{now:Date.now()});
 assert.equal(result.removed,0);assert.deepEqual(await readdir(backups),[name]);
});
test('cleanup covers both temp roots, never profile data, and concurrent calls share one pass',async t=>{
 const root=await fixture(t),dataDir=path.join(root,'data'),accountsDir=path.join(root,'accounts');
 await aged(path.join(dataDir,'runtime-tmp','old.tmp'),30);await aged(path.join(accountsDir,'runtime-tmp','old.tmp'),30);
 await aged(path.join(dataDir,'state.json'),900);await aged(path.join(dataDir,'chat-memory','tree.db'),900);await aged(path.join(accountsDir,'codex-home','auth.json'),900);
 const guard=new DiskGuard({dataDir,accountsDir,now:()=>Date.now()+30*DAY});
 const[a,b]=await Promise.all([guard.cleanup(),guard.cleanup()]);assert.equal(a,b);assert.equal(a.removed,2);
 for(const kept of ['data/state.json','data/chat-memory/tree.db','accounts/codex-home/auth.json'])await stat(path.join(root,kept));
 assert.deepEqual(await readdir(path.join(dataDir,'runtime-tmp')),[]);
 assert.equal((await guard.status()).lastCleanup.removed,2);
});
test('usage reports folders largest first and flags disposable ones',async t=>{
 const root=await fixture(t);
 await aged(path.join(root,'chat-memory','a'),1,'x'.repeat(100));await aged(path.join(root,'runtime-tmp','b'),1,'x'.repeat(10));
 const usage=await new DiskGuard({dataDir:root}).usage();
 assert.equal(usage.folders[0].name,'chat-memory');assert.equal(usage.folders[0].bytes,100);assert.equal(usage.folders[0].disposable,false);
 assert.equal(usage.folders.find(folder=>folder.name==='runtime-tmp').disposable,true);assert.equal(usage.complete,true);
});
test('warnings fire only when the level worsens',async t=>{
 const root=await fixture(t),events=[];let free=DISK_LOW_BYTES*2;
 const guard=new DiskGuard({dataDir:root,emit:event=>events.push(event),statfs:async()=>({bavail:free,bsize:1,blocks:free})});
 await guard.check();assert.equal(events.length,0);
 free=DISK_LOW_BYTES-1;await guard.check();await guard.check();assert.equal(events.length,1);assert.match(events[0].message,/getting full/);
 free=DISK_CRITICAL_BYTES-1;await guard.check();assert.equal(events.length,2);assert.match(events[1].message,/almost full/);
 free=DISK_LOW_BYTES*2;await guard.check();free=DISK_LOW_BYTES-1;await guard.check();assert.equal(events.length,3);
});
test('status takes the tighter of the data and project volumes and survives a null workspace',async t=>{
 const root=await fixture(t),guard=new DiskGuard({dataDir:root,getWorkspace:()=>null,statfs:statfsWith(DISK_LOW_BYTES-1)});
 const status=await guard.status();assert.equal(status.level,'low');assert.equal(status.freeBytes,DISK_LOW_BYTES-1);assert.equal(status.volumes.length,1);
});
