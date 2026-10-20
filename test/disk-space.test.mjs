import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,link,symlink,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {DiskSpace,scanDirectory,diskAdvice,excludedDiskPath,listDiskDrives} from '../desktop/disk-space.mjs';
import {diskLayout} from '../src/disk-layout.js';
async function fixture(t){
 const fixtureRoot=path.resolve('../Workspace/disk-space-20261019/fixtures');await mkdir(fixtureRoot,{recursive:true});
 const root=await mkdtemp(path.join(fixtureRoot,'exomina-disk-test-'));assert.equal(path.dirname(root),fixtureRoot);
 t.after(async()=>{assert.ok(path.basename(root).startsWith('exomina-disk-test-'));await rm(root,{recursive:true,force:true});});
 await mkdir(path.join(root,'folder','Cache'),{recursive:true});await mkdir(path.join(root,'private'));await mkdir(path.join(root,'accounts'));
 await writeFile(path.join(root,'root.bin'),Buffer.alloc(20));await writeFile(path.join(root,'folder','a.bin'),Buffer.alloc(40));await writeFile(path.join(root,'folder','Cache','cache.bin'),Buffer.alloc(30));await writeFile(path.join(root,'private','secret.bin'),Buffer.alloc(999));await writeFile(path.join(root,'accounts','token'),Buffer.alloc(999));
 return root;
}
const fakeDrive=root=>[{id:'fixture',root,label:'Synthetic drive',total:10000,used:5000,free:5000}];
const workerMock=()=>{const worker=new EventEmitter();worker.terminate=async()=>0;return worker;};
test('scan accounts for logical sizes once, aggregates folders and excludes private stores and junctions',async t=>{
 const root=await fixture(t);await link(path.join(root,'root.bin'),path.join(root,'hardlink.bin'));await symlink(path.join(root,'folder'),path.join(root,'linked'),'junction');
 const snapshots=[];const result=await scanDirectory({root,privateDirs:[path.join(root,'private')],appRoots:[path.join(root,'folder')],onProgress:value=>snapshots.push(value)});
 assert.equal(result.status,'complete');assert.equal(result.bytes,90);assert.equal(result.exominaBytes,70);assert.equal(result.counts.files,3);assert.equal(result.counts.duplicateLinks,1);assert.equal(result.counts.private,2);assert.equal(result.counts.links,1);
 assert.equal(result.nodes.find(row=>row.name==='folder').bytes,70);assert.equal(result.nodes[0].directBytes,20);assert.equal(result.largest[0].bytes,40);
 assert.ok(!JSON.stringify(result).includes('secret.bin'));assert.ok(snapshots.length>0);assert.equal(await readFile(path.join(root,'accounts','token'),'utf8'),'\0'.repeat(999));
});
test('limits and cancellation return explicitly partial results',async t=>{
 const root=await fixture(t);const buffer=new SharedArrayBuffer(4);Atomics.store(new Int32Array(buffer),0,1);
 assert.equal((await scanDirectory({root,cancelBuffer:buffer})).status,'cancelled');
 const result=await scanDirectory({root,maxEntries:1});assert.equal(result.status,'partial');assert.match(result.limit,/partial/);
});
test('deny paths exclude metadata before descent and private roots refuse',async t=>{
 const root=await fixture(t),denied=path.join(root,'folder');
 const result=await scanDirectory({root,privateDirs:[path.join(root,'private')],denied:[denied]});
 assert.equal(result.bytes,20);assert.ok(!JSON.stringify(result).includes('cache.bin'));
 await assert.rejects(scanDirectory({root:path.join(root,'accounts')}),/cannot be scanned/);
 assert.equal(excludedDiskPath('C:\\Users\\Me\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default'),true);
 assert.equal(excludedDiskPath('C:\\Program Files\\Exomina\\Private\\data'),true);
});
test('heuristics preserve core OS and installed applications, and never call caches automatically safe',()=>{
 assert.equal(diskAdvice('C:\\Windows\\WinSxS\\a.dll').kind,'keep');assert.equal(diskAdvice('C:\\pagefile.sys').kind,'keep');assert.equal(diskAdvice('C:\\Program Files\\App\\main.exe').kind,'keep');
 assert.equal(diskAdvice('D:\\Photos\\family.jpg').kind,'review');const cache=diskAdvice('C:\\Users\\Me\\AppData\\Local\\App\\Cache');assert.equal(cache.kind,'candidate');assert.match(cache.reason,/do not prove safety/);
});
test('scan results are chat scoped, paginated, filtered by current denies, and require explicit approval',async t=>{
 const root=await fixture(t),worker=workerMock();let approvals=0,denied=false;
 const service=new DiskSpace({enumerate:async()=>fakeDrive(root),workerFactory:()=>worker,approve:async request=>{approvals++;assert.equal(request.requireConfirmation,true);return true;},allowed:(_tool,file)=>!denied||!file.includes('folder')});t.after(()=>service.close());
 const started=await service.call('disk_scan',{drive:'fixture'},'chat-a');assert.equal(approvals,1);
 worker.emit('message',{type:'done',value:await scanDirectory({root,privateDirs:[path.join(root,'private')]})});
 assert.throws(()=>service.read({id:started.id},'chat-b'),/not been shared/);assert.equal(service.list('chat-b').length,0);
 let view=await service.call('disk_read',{id:started.id,limit:1},'chat-a');assert.equal(view.rows.length,1);const folder=view.rows[0];assert.equal(folder.name,'folder');view=service.read({id:started.id,node:folder.id},'chat-a');assert.equal(view.folder.name,'folder');assert.equal(view.ancestors.length,2);
 denied=true;assert.throws(()=>service.read({id:started.id,node:folder.id},'chat-a'),/blocked/);assert.deepEqual(service.read({id:started.id},'chat-a').rows.filter(row=>row.kind!=='files-here'),[]);
 service.share(started.id,'chat-b');assert.equal(service.list('chat-b').length,1);
});
test('declined scan cannot launch a worker, and direct starts serialize concurrent calls',async t=>{
 const root=await fixture(t);let launched=0;const service=new DiskSpace({enumerate:async()=>fakeDrive(root),workerFactory:()=>{launched++;return workerMock();}});t.after(()=>service.close());
 await assert.rejects(service.call('disk_scan',{drive:'fixture'},'chat-a'),/declined/);assert.equal(launched,0);
 const first=service.start('fixture');await assert.rejects(service.start('fixture'),/already running/);await first;assert.equal(launched,1);
});
test('real background worker finishes with bounded metadata and can be closed',async t=>{
 const root=await fixture(t),service=new DiskSpace({enumerate:async()=>fakeDrive(root),privateDirs:[path.join(root,'private')]});t.after(()=>service.close());
 const ended=new Promise((resolve,reject)=>{service.emit=event=>{if(event.status==='error')reject(Error(service.get(event.id).error));if(event.status==='complete')resolve(event.id);};});
 const scan=await service.start('fixture'),id=await ended;assert.equal(id,scan.id);assert.equal(service.read({id},null,{local:true}).bytes,90);assert.equal(service.running,false);
});
test('drive enumeration parses Windows JSON through a fixed hidden command',async()=>{
 let launch;const drives=await listDiskDrives({platform:'win32',spawnImpl:(exe,args,options)=>{launch={exe,args,options};const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{};queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify([{id:'C:',root:'C:\\',driveType:3,total:100,free:25},{id:'Z:',root:'Z:\\',driveType:4,total:200,free:5}])));child.emit('close',0);});return child;}});
 assert.equal(drives[0].used,75);assert.equal(drives.length,1);assert.equal(launch.options.windowsHide,true);assert.equal(launch.args.at(-2),'-Command');assert.ok(!launch.args.includes('-EncodedCommand'));assert.ok(!launch.args.includes('Bypass'));
});
test('area partition occupies the full map without overlap',()=>{
 const tiles=diskLayout([{id:'a',bytes:50},{id:'b',bytes:30},{id:'c',bytes:20}]);assert.equal(tiles.length,3);
 for(const tile of tiles)assert.ok(Math.abs(tile.w*tile.h/100-tile.bytes)<.001);
 for(let a=0;a<tiles.length;a++)for(let b=a+1;b<tiles.length;b++){const x=tiles[a],y=tiles[b];assert.ok(x.x+x.w<=y.x+.001||y.x+y.w<=x.x+.001||x.y+x.h<=y.y+.001||y.y+y.h<=x.y+.001);}
 assert.deepEqual(diskLayout([]),[]);
});
test('missing chat scope cannot read local scans or their summaries',async()=>{
 const service=new DiskSpace();await assert.rejects(service.call('disk_status',{},undefined),/saved chat/);
 assert.throws(()=>service.list(),/saved chat/);assert.throws(()=>service.read({id:'missing'}),/saved chat/);await service.close();
});
test('final largest files retain pagination and unfinished subtrees are explicitly marked',async t=>{
 const root=await fixture(t);for(let index=0;index<55;index++)await writeFile(path.join(root,'file-'+index),Buffer.alloc(index+1));
 const result=await scanDirectory({root,privateDirs:[path.join(root,'private')]});assert.equal(result.largest.length,58);assert.ok(result.nodes[0].complete);
 const partial=await scanDirectory({root,maxEntries:1});assert.equal(partial.nodes[0].complete,false);assert.equal(partial.status,'partial');
});
test('advice keeps installed caches and personally named temp folders out of cleanup candidates',()=>{
 assert.equal(diskAdvice('C:\\Program Files\\Product\\cache\\data').kind,'keep');
 assert.equal(diskAdvice('C:\\Users\\Me\\Documents\\temp\\thesis.docx').kind,'review');
 assert.equal(diskAdvice('C:\\Windows.old').kind,'keep');
 for(const file of ['C:\\Users\\Me\\.kube\\config','C:\\Users\\Me\\AppData\\Local\\Microsoft\\Outlook\\me@example.org.ost','C:\\Users\\Me\\passwords.kdbx'])assert.ok(excludedDiskPath(file));
});
test('changing deny rules invalidates old model reads including aggregate sizes',async t=>{
 const root=await fixture(t),worker=workerMock();let rules=[];
 const service=new DiskSpace({enumerate:async()=>fakeDrive(root),workerFactory:()=>worker,getDenyRules:()=>rules});t.after(()=>service.close());
 const scan=await service.start('fixture',{conversationId:'chat'});worker.emit('message',{type:'done',value:await scanDirectory({root})});
 rules=[{effect:'deny',tool:'disk_read',match:path.join(root,'folder')}];assert.throws(()=>service.read({id:scan.id},'chat'),/rules changed/);assert.deepEqual(service.list('chat'),[]);
});
// ---- fast scanner ----
import {nativeScan,nativeScanAvailable,scanCommand} from '../desktop/disk-native.mjs';
import {nativeDenyMatches} from '../desktop/disk-rules.mjs';
import {ScanTree,treeFromNodes} from '../desktop/disk-tree.mjs';
const native=nativeScanAvailable()?test:test.skip;
const named=(tree,name)=>{for(let i=0;i<tree.size;i++)if(tree.name(i)===name)return i;return -1;};
native('fast scanner agrees with the compatibility walker on sizes, links, hard links and exclusions',async t=>{
 const root=await fixture(t);await link(path.join(root,'root.bin'),path.join(root,'hardlink.bin'));await symlink(path.join(root,'folder'),path.join(root,'linked'),'junction');
 const options={root,privateDirs:[path.join(root,'private')],appRoots:[path.join(root,'folder')]};
 const slow=await scanDirectory(options),fast=await nativeScan(options),tree=new ScanTree(fast.treeData);
 assert.equal(fast.status,'complete');assert.equal(fast.bytes,slow.bytes);assert.equal(fast.counts.files,slow.counts.files);assert.equal(fast.counts.directories,slow.counts.directories);
 assert.equal(fast.counts.duplicateLinks,slow.counts.duplicateLinks);assert.equal(fast.counts.links,slow.counts.links);assert.equal(fast.counts.private,slow.counts.private);
 assert.equal(tree.bytes[named(tree,'folder')],70);assert.equal(tree.directBytes[0],20);assert.ok(tree.alloc[0]>=0);
 assert.ok(!JSON.stringify(fast).includes('secret.bin')&&!JSON.stringify(fast).includes('token'));
 assert.equal(tree.find(path.join(root,'folder','Cache')),named(tree,'Cache'));assert.equal(tree.find(path.join(root,'nothing')),-1);
 assert.equal(await readFile(path.join(root,'accounts','token'),'utf8'),'\0'.repeat(999));
});
native('fast scanner applies the same prefix and wildcard deny rules before measuring',async t=>{
 const root=await fixture(t);
 for(const rule of [{effect:'deny',tool:'disk_read',match:path.join(root,'folder')},{effect:'deny',tool:'disk_*',match:'*\\cache\\*'}]){
  const slow=await scanDirectory({root,denied:[rule]}),fast=await nativeScan({root,denied:[rule]});
  assert.equal(fast.bytes,slow.bytes,JSON.stringify(rule));assert.equal(fast.counts.files,slow.counts.files);
  assert.ok(!JSON.stringify(fast).includes('cache.bin'));
 }
 assert.deepEqual(nativeDenyMatches([{effect:'deny',tool:'disk_read',match:'C:\\x'},{effect:'deny',tool:'browser_*',match:'C:\\y'},{effect:'deny',tool:'disk_scan'},'D:\\z']),['C:\\x','*','D:\\z']);
});
native('fast scanner reports size on disk, file types, ages and cleanup leads from one scan',async t=>{
 const root=await fixture(t);await mkdir(path.join(root,'app','node_modules','pkg'),{recursive:true});
 await writeFile(path.join(root,'movie.mp4'),Buffer.alloc(300000));await writeFile(path.join(root,'app','node_modules','pkg','index.js'),Buffer.alloc(70000));
 const result=await nativeScan({root,appRoots:[]}),types=Object.fromEntries(result.categories.map(row=>[row.id,row]));
 assert.ok(result.alloc>=300000+70000,'allocated space is measured');assert.equal(types.video.files,1);assert.ok(types.video.alloc>=300000);assert.equal(types.code.files,1);
 assert.equal(result.largest[0].name,'movie.mp4');assert.equal(result.largest[0].category,'video');assert.equal(result.byCategory.video.length,1);
 assert.equal(result.ages[0].files,result.counts.files,'files created just now are all in the newest bucket');assert.equal(result.stale.length,0);
 assert.equal(result.hogs[0].id,'node_modules');assert.ok(result.hogs[0].alloc>=70000);assert.ok(result.extensions.some(row=>row.ext==='mp4'));
});
native('overview gives an AI one compact, permission-filtered view of a finished scan',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'folder','big.iso'),Buffer.alloc(200000));
 const worker=workerMock();
 const service=new DiskSpace({enumerate:async()=>fakeDrive(root),workerFactory:()=>worker});t.after(()=>service.close());
 const scan=await service.start('fixture',{conversationId:'chat'});worker.emit('message',{type:'done',value:await nativeScan({root,privateDirs:[path.join(root,'private')]})});
 const view=service.read({id:scan.id,view:'overview'},'chat'),overview=view.overview;
 assert.equal(view.view,'overview');assert.ok(overview.measured.alloc>=200000);assert.ok(overview.biggestFolders.some(row=>row.path.endsWith('folder')));assert.equal(overview.largestFiles[0].name,'big.iso');assert.equal(overview.measured.engine,'native');
 assert.equal(service.read({id:scan.id,view:'files',category:'disks'},'chat').rows[0].name,'big.iso');assert.equal(service.read({id:scan.id,view:'types'},'chat').rows[0].ext,'iso');
 assert.throws(()=>service.read({id:scan.id,view:'nonsense'},'chat'),/valid view/);
 const top=service.read({id:scan.id},'chat');assert.ok(top.rows.some(row=>row.kind==='files-here'&&row.files===1),'loose files are listed beside folders');
});
native('fast scanner can be stopped and returns what it measured',async()=>{
 const buffer=new SharedArrayBuffer(4),cancel=new Int32Array(buffer),started=Date.now();let measured=0;
 // PowerShell can take longer than 300 ms to start under the full parallel suite.
 // Request cancellation after actual work, so this checks retained measurements.
 const fallback=setTimeout(()=>Atomics.store(cancel,0,1),15000);
 try{
  const result=await nativeScan({root:path.join(process.env.SystemRoot||'C:\\Windows','WinSxS'),cancelBuffer:buffer,maxMs:20000,onProgress:value=>{if(value.counts.entries>0){measured=value.counts.entries;Atomics.store(cancel,0,1);}}});
  assert.ok(['cancelled','complete'].includes(result.status));assert.ok(Date.now()-started<30000);assert.ok(result.counts.entries>0);assert.ok(result.counts.entries>=measured);
 }finally{clearTimeout(fallback);}
});
test('fast scanner is a prebuilt DLL loaded without compiling code at runtime',async()=>{
 const command=scanCommand("C:\\Apps\\it's\\Scan.dll");assert.match(command,/Add-Type -Path 'C:\\Apps\\it''s\\Scan\.dll'/);assert.doesNotMatch(command,/TypeDefinition|MemberDefinition|csc\.exe|EncodedCommand/);
 const source=await readFile(new URL('../desktop/disk-native.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/csc\.exe|TypeDefinition|-EncodedCommand|ExecutionPolicy/);
});
test('compact folder tree answers path, child and name-group questions',()=>{
 const tree=new ScanTree(treeFromNodes([{parent:null,name:'C:\\',bytes:30,directBytes:0,files:3,directFiles:0,scanned:true,complete:true},{parent:'0',name:'node_modules',bytes:20,directBytes:5,files:2,directFiles:1,scanned:true,complete:true},{parent:'1',name:'node_modules',bytes:15,directBytes:15,files:1,directFiles:1,scanned:true,complete:true},{parent:'0',name:'Docs',bytes:10,directBytes:10,files:1,directFiles:1,scanned:true,complete:false}]));
 assert.equal(tree.path(2),'C:\\node_modules\\node_modules');assert.deepEqual(tree.children(0),[1,3]);assert.equal(tree.find('c:/NODE_MODULES/node_modules'),2);assert.equal(tree.complete(3),false);
 const groups=tree.groupByName(new Set(['node_modules']));assert.equal(groups.length,1);assert.equal(groups[0].count,1,'nested copies are not counted twice');assert.equal(groups[0].bytes,20);
});
native('the scanner and the JavaScript rules agree on which paths are private, using the real .NET regex engine',async()=>{
 const {EXCLUDED_PATTERNS,normalized}=await import('../desktop/disk-rules.mjs');
 const samples=['C:\\Users\\Me\\.ssh\\id_rsa','C:\\Users\\Me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies','C:\\Users\\Me\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x.default\\cookies.sqlite','C:\\Program Files\\Exomina\\Private\\accounts\\a','C:\\$Recycle.Bin\\S-1\\x','C:\\System Volume Information\\x','C:\\Users\\Me\\.env.local','C:\\Users\\Me\\project\\.env','C:\\Users\\Me\\passwords.KDBX','C:\\Users\\Me\\mail\\Me@Example.OST','C:\\Users\\Me\\AppData\\Roaming\\Signal\\db','C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Protect\\S-1','C:\\Users\\Me\\AppData\\Local\\Chromium\\x','C:\\Users\\Me\\.config\\gcloud\\creds','C:\\Users\\Me\\Documents\\Vault Notes\\a.txt','C:\\Users\\Me\\Documents\\vault\\a.txt','C:\\Games\\Steam\\steamapps\\common\\x.pak','C:\\Users\\Me\\Pictures\\holiday.jpg','C:\\Windows\\System32\\drivers\\etc\\hosts','D:\\Dropbox\\accounts\\bank.xlsx','D:\\Medien\\Äpfel und Öl\\ä.key','C:\\Users\\Me\\.envelope\\x','C:\\Users\\Me\\signal-notes.txt'];
 const expected=samples.map(file=>{const p=normalized(file);return EXCLUDED_PATTERNS.some(pattern=>pattern.test(p));});
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const script="$p=ConvertFrom-Json $env:EXO_PATTERNS; $s=ConvertFrom-Json $env:EXO_SAMPLES; $rx=@($p | ForEach-Object { New-Object System.Text.RegularExpressions.Regex($_,[System.Text.RegularExpressions.RegexOptions]'IgnoreCase,CultureInvariant') }); $out=@($s | ForEach-Object { $n=$_.Replace('\\','/').ToLowerInvariant().TrimEnd('/'); $hit=$false; foreach($r in $rx){ if($r.IsMatch($n)){ $hit=$true } }; $hit }); ConvertTo-Json -Compress -InputObject $out";
 const {stdout}=await promisify(execFile)(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',env:{...process.env,EXO_PATTERNS:JSON.stringify(EXCLUDED_PATTERNS.map(pattern=>pattern.source)),EXO_SAMPLES:JSON.stringify(samples)}});
 assert.deepEqual(JSON.parse(stdout),expected);assert.ok(expected.filter(Boolean).length>=12&&expected.filter(value=>!value).length>=5,'the sample set covers both outcomes');
});
native('hard links are counted once on NTFS and every time when deduplication is switched off',async t=>{
 const root=await fixture(t);await link(path.join(root,'root.bin'),path.join(root,'hardlink.bin'));
 const on=await nativeScan({root,privateDirs:[path.join(root,'private')]}),off=await nativeScan({root,privateDirs:[path.join(root,'private')],dedupeHardLinks:false});
 assert.equal(on.counts.duplicateLinks,1);assert.equal(off.counts.duplicateLinks,0);assert.equal(off.bytes,on.bytes+20);
});
native('the scanner refuses a private root even if the caller forgot to check',async t=>{
 const root=await fixture(t);const {spawn}=await import('node:child_process');
 const {scanLibraryPath}=await import('../desktop/disk-native.mjs');
 const child=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',scanCommand(scanLibraryPath())],{windowsHide:true,stdio:['pipe','pipe','ignore']});
 let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;});
 child.stdin.write(['root='+path.join(root,'accounts'),'private='+path.join(root,'accounts'),'go',''].join('\n'));
 await new Promise(resolve=>child.on('close',resolve));assert.match(output,/cannot be scanned/);assert.ok(!output.includes('"nodes"'));
});
