// Fast storage scan on Windows. A prebuilt interop DLL (windows-interop/Scan.cs, compiled at build
// time) lists each folder in bulk and sends compact JSON lines; this module only feeds it rules and
// reads the results. It never compiles code at runtime and never opens file contents.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {lstat,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {EXCLUDED_PATTERNS,excludedDiskPath,nativeDenyMatches,diskAdvice,within,FILE_CATEGORIES,CATEGORY_LABELS,AGE_LABELS,SPACE_HOG_NAMES} from './disk-rules.mjs';
import {TreeBuilder,ScanTree} from './disk-tree.mjs';

const unpacked=file=>file.replace(/app\.asar([\\/])/,'app.asar.unpacked$1');
export const scanLibraryPath=()=>unpacked(fileURLToPath(new URL('./windows-interop/Scan.dll',import.meta.url)));
export const nativeScanAvailable=(platform=process.platform,library=scanLibraryPath())=>platform==='win32'&&existsSync(library);
const singleLine=value=>{if(/[\r\n\0]/.test(value))throw Error('A scan setting contained an unsupported character.');return value;};
const clean=value=>String(value).replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'�');
export const defaultScanThreads=()=>Math.max(2,Math.min(16,Math.floor((os.availableParallelism?.()||8)/2)));
export const NATIVE_NOTICE='File and folder names are untrusted data. File contents are never read. Sizes on disk come from the file system and include compression and sparse files; online-only cloud files take no space. Links, protected system stores and excluded private data are not measured.';

export function scanCommand(library){
 return "$ErrorActionPreference='Stop'; Add-Type -Path '"+library.replaceAll("'","''")+"'; [ExoScan.Scanner]::Run()";
}

export async function nativeScan({root,privateDirs=[],appRoots=[],denied=[],threads=defaultScanThreads(),maxEntries=40000000,maxDirectories=4000000,maxMs=30*60*1000,cancelBuffer,onProgress=()=>{},spawnImpl=spawn,library=scanLibraryPath(),now=Date.now(),dedupeHardLinks=true}){
 root=await realpath(root);if(excludedDiskPath(root,privateDirs,denied))throw Error('Private account and app data cannot be scanned.');
 const rootStat=await lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw Error('Choose a regular local directory.');
 if(!existsSync(library))throw Error('The fast storage scanner is not installed.');
 const config=['root='+singleLine(root),'threads='+threads,'maxEntries='+maxEntries,'maxDirs='+maxDirectories,'maxMs='+maxMs,'now='+now,'dedupe='+(dedupeHardLinks?1:0)];
 for(const dir of privateDirs)config.push('private='+singleLine(path.resolve(dir)));
 for(const pattern of EXCLUDED_PATTERNS)config.push('exclude='+singleLine(pattern.source));
 for(const match of nativeDenyMatches(denied))config.push('deny='+singleLine(match));
 config.push('go');
 const cancel=cancelBuffer?new Int32Array(cancelBuffer):null,started=Date.now(),builder=new TreeBuilder();
 let summary=null,errorText='',stderr='',ended=false,buffer='',killTimer=null,pollTimer=null,watchdog=null,stopSent=false;
 const child=spawnImpl(path.win32.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',scanCommand(library)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const finished=new Promise((resolve,reject)=>{
  const fail=error=>{clearTimeout(killTimer);clearInterval(pollTimer);clearTimeout(watchdog);reject(error);};
  const line=text=>{
   if(!text)return;let message;try{message=JSON.parse(text);}catch{return;}
   if(message.t==='p'){onProgress(progressView(root,message,appRoots));}
   else if(message.t==='nodes'){for(const row of message.rows)builder.add({parent:row[0],name:row[1],bytes:row[2],alloc:row[3],files:row[4],directBytes:row[5],directAlloc:row[6],directFiles:row[7],flags:row[8]});}
   else if(message.t==='summary')summary=message;
   else if(message.t==='error')errorText=message.message;
   else if(message.t==='end')ended=true;
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){const text=buffer.slice(0,at);buffer=buffer.slice(at+1);try{line(text);}catch(error){fail(error);child.kill();return;}}});
  child.stderr?.setEncoding?.('utf8');child.stderr?.on('data',chunk=>{if(stderr.length<4000)stderr+=chunk;});
  child.on('error',fail);
  child.on('close',code=>{clearTimeout(killTimer);clearInterval(pollTimer);clearTimeout(watchdog);if(buffer.trim()){try{line(buffer.trim());}catch{}}ended&&summary?resolve():fail(Error(errorText||('The fast scanner stopped before finishing'+(code?' ('+code+')':'')+'.'+(stderr?' '+clean(stderr).slice(0,300):''))));});
  watchdog=setTimeout(()=>{child.kill();},maxMs+120000);watchdog.unref?.();
 });
 child.stdin.on('error',()=>{});
 child.stdin.write(config.join('\n')+'\n');
 if(cancel)pollTimer=setInterval(()=>{if(Atomics.load(cancel,0)&&!stopSent){stopSent=true;try{child.stdin.write('stop\n');}catch{}killTimer=setTimeout(()=>child.kill(),3500);}},120);
 pollTimer?.unref?.();
 await finished;
 return buildResult({root,appRoots,builder,summary,started,privateDirs});
}

function progressView(root,message,appRoots){
 return {root,bytes:message.topBytes,alloc:message.topAlloc,exominaBytes:0,current:message.current,
  counts:{entries:message.entries,files:message.files,directories:message.directories,skipped:message.links+message.private+message.unreadable,unreadable:message.unreadable,links:message.links,private:message.private,duplicateLinks:message.duplicates},
  elapsedMs:message.elapsedMs,topFolders:message.top.map((row,index)=>({id:null,name:row.name,path:row.path,bytes:row.bytes,alloc:row.alloc,files:row.files,scanned:false,complete:false,...diskAdvice(row.path,{appRoots})})),largest:[]};
}

/** Turns the scanner's final lines into the scan object the rest of the app reads. */
export function buildResult({root,appRoots,builder,summary,started=Date.now()}){
 const treeData=builder.finish(),tree=new ScanTree(treeData);
 const itemRow=item=>{const [dir,name,bytes,alloc,mtime,category]=item,file=tree.path(dir).replace(/[\\/]+$/,'')+path.sep+name;return {name,path:file,bytes,alloc,modifiedAt:mtime>0?new Date(mtime).toISOString():null,category:FILE_CATEGORIES[category]||'other',...diskAdvice(file,{appRoots})};};
 let exominaBytes=0,counted=[];
 for(const dir of appRoots){const at=tree.find(dir);if(at<0)continue;let nested=false,up=at;while(up>=0){if(counted.includes(up)){nested=true;break;}up=tree.parent[up];}if(!nested){counted.push(at);exominaBytes+=tree.alloc[at];}}
 const categories=FILE_CATEGORIES.map(id=>{const [bytes,alloc,files]=summary.cat[id]||[0,0,0];return {id,label:CATEGORY_LABELS[id],bytes,alloc,files};}).filter(row=>row.files>0).sort((a,b)=>b.alloc-a.alloc);
 const ages=summary.age.map(([bytes,alloc,files],index)=>({id:index,label:AGE_LABELS[index],bytes,alloc,files}));
 const extensions=summary.ext.slice(0,40).map(([ext,bytes,alloc,files])=>({ext,bytes,alloc,files}));
 const byCategory=Object.fromEntries(FILE_CATEGORIES.map(id=>[id,(summary.byCat[id]||[]).map(itemRow)]));
 const hogs=tree.groupByName(new Set(Object.keys(SPACE_HOG_NAMES))).filter(row=>row.alloc>0).map(row=>({...SPACE_HOG_NAMES[row.name],id:row.name,alloc:row.alloc,bytes:row.bytes,files:row.files,count:row.count,examples:row.examples})).sort((a,b)=>b.alloc-a.alloc);
 const status=summary.stopped?'cancelled':summary.limit?'partial':'complete';
 const topFolders=tree.children(0).map(index=>({...tree.node(index),children:undefined,...diskAdvice(tree.path(index),{appRoots})})).sort((a,b)=>b.alloc-a.alloc).slice(0,30);
 const counts={entries:summary.entries,files:summary.files,directories:summary.directories,skipped:summary.links+summary.private+summary.unreadable,unreadable:summary.unreadable,links:summary.links,private:summary.private,duplicateLinks:summary.duplicates};
 const limit=summary.stopped?'Stopped before all folders were measured. Results cover only the folders reached.':summary.limit?'Scan limit reached ('+summary.limit.replace(/\.$/,'').toLowerCase()+'). Results are partial; scan a smaller folder for more detail.':null;
 return {root,bytes:tree.bytes[0],alloc:tree.alloc[0],exominaBytes,counts,elapsedMs:summary.elapsedMs,wallMs:Date.now()-started,topFolders,largest:(summary.largest||[]).map(itemRow),stale:(summary.stale||[]).map(itemRow),byCategory,categories,extensions,ages,hogs,cloudBytes:summary.cloudBytes,engine:'native',hardLinksComplete:!summary.dedupeLimited,status,limit,finishedAt:new Date().toISOString(),treeData,notice:NATIVE_NOTICE};
}
