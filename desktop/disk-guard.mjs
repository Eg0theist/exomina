// Keeps Exomina's own disposable files bounded and refuses large work that would
// fill the drive. Chats, notes, sign-ins and project files are never removed here,
// and saving a chat is never refused: losing a reply is worse than a full disk.
import {statfs as nativeStatfs,readdir,lstat,rm} from 'node:fs/promises';
import path from 'node:path';

const GIB=1024**3,MIB=1024**2,DAY=24*60*60*1000;
export const DISK_LOW_BYTES=5*GIB;
export const DISK_CRITICAL_BYTES=GIB;
/** Free space to leave behind after a download or install. */
export const DOWNLOAD_RESERVE_BYTES=2*GIB;
/** A small write only needs enough room not to truncate the file it replaces. */
export const WRITE_RESERVE_BYTES=128*MIB;
export const TEMP_MAX_AGE_DAYS=7;
export const BACKUP_MAX_AGE_DAYS=90;
export const BACKUP_MIN_AGE_DAYS=7;
export const BACKUP_MAX_BYTES=GIB;
const WALK_LIMIT=200000;
// Live diagnostics written into the temp folder; rewritten in place, never stale work.
const TEMP_KEEP=new Set(['startup-timing.json','chat-scroll-incidents.json']);
const BACKUP_NAME=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bak$/i;

export function formatBytes(bytes){
 if(!Number.isFinite(bytes))return 'unknown';
 if(bytes>=GIB)return (bytes/GIB).toFixed(1)+' GB';
 if(bytes>=MIB)return Math.round(bytes/MIB)+' MB';
 return Math.max(1,Math.round(bytes/1024))+' KB';
}

/** Free space for the volume holding a path; null when the system cannot say. */
export async function freeSpace(location,{statfs=nativeStatfs}={}){
 try{
  // A destination may not exist yet; its nearest existing parent has the answer.
  let info,current=path.resolve(location);
  for(;;){
   try{info=await statfs(current);break;}
   catch(error){const parent=path.dirname(current);if(error?.code!=='ENOENT'||parent===current)throw error;current=parent;}
  }
  const freeBytes=Number(info.bavail)*Number(info.bsize),totalBytes=Number(info.blocks)*Number(info.bsize);
  return Number.isFinite(freeBytes)&&freeBytes>=0?{freeBytes,totalBytes}:null;
 }catch{return null;}
}

export function diskLevel(freeBytes){
 if(!Number.isFinite(freeBytes))return 'unknown';
 return freeBytes<DISK_CRITICAL_BYTES?'critical':freeBytes<DISK_LOW_BYTES?'low':'ok';
}

/** Refuse before starting. An unreadable volume must not block the app, so it passes. */
export async function assertDiskSpace(location,bytesNeeded,{label='This action',reserve=DOWNLOAD_RESERVE_BYTES,statfs=nativeStatfs}={}){
 const space=await freeSpace(location,{statfs});
 if(!space)return null;
 const required=Math.max(0,Number(bytesNeeded)||0)+reserve;
 if(space.freeBytes<required)throw Object.assign(Error(`${label} needs about ${formatBytes(required)} of free disk space, but only ${formatBytes(space.freeBytes)} is available. Free up some space and try again. Nothing was changed.`),{code:'DISK_SPACE'});
 return space;
}

// Windows copies keep the source's modified date, so a file made today can look
// years old. Whichever of created or modified is later is when it last mattered.
export const lastActivity=info=>Math.max(info.mtimeMs,info.birthtimeMs||0);

async function measure(entry,info,budget,activity=lastActivity){
 // Links are measured and removed as links, never followed out of the folder.
 let bytes=info.isFile()?info.size:0,newest=activity(info),complete=true;
 if(!info.isDirectory()||info.isSymbolicLink())return {bytes,newest,complete};
 let children;
 try{children=await readdir(entry,{withFileTypes:false});}catch{return {bytes,newest,complete:false};}
 for(const name of children){
  if(--budget.left<0)return {bytes,newest,complete:false};
  const child=path.join(entry,name);let childInfo;
  try{childInfo=await lstat(child);}catch{complete=false;continue;}
  const inner=await measure(child,childInfo,budget,activity);
  bytes+=inner.bytes;newest=Math.max(newest,inner.newest);complete&&=inner.complete;
 }
 return {bytes,newest,complete};
}

export async function folderBytes(location,budget={left:WALK_LIMIT}){
 const info=await lstat(location).catch(()=>null);
 if(!info)return {bytes:0,complete:true};
 const {bytes,complete}=await measure(location,info,budget);
 return {bytes,complete};
}

/** Removes top-level temp entries nothing has touched for the age limit. Files
 * still held open by a running process fail to delete and are simply kept. */
export async function pruneTemporaryFiles(folder,{maxAgeDays=TEMP_MAX_AGE_DAYS,now=Date.now(),activity=lastActivity}={}){
 const result={removed:0,bytes:0,kept:0};
 const cutoff=now-maxAgeDays*DAY;
 let names;try{names=await readdir(folder);}catch{return result;}
 for(const name of names){
  if(TEMP_KEEP.has(name)){result.kept++;continue;}
  const entry=path.join(folder,name),info=await lstat(entry).catch(()=>null);
  if(!info){continue;}
  const {bytes,newest,complete}=await measure(entry,info,{left:WALK_LIMIT},activity);
  // An unmeasurable entry could hide recent work, so its age is unknown.
  if(!complete||newest>=cutoff){result.kept++;continue;}
  try{await rm(entry,{recursive:true,force:true,maxRetries:0});result.removed++;result.bytes+=bytes;}catch{result.kept++;}
 }
 return result;
}

/** Overwrite backups expire with age, then oldest first above the size cap. The
 * most recent week always stays: those are the backups someone may still want. */
export async function pruneFileBackups(folder,{maxAgeDays=BACKUP_MAX_AGE_DAYS,minAgeDays=BACKUP_MIN_AGE_DAYS,maxBytes=BACKUP_MAX_BYTES,now=Date.now(),activity=lastActivity}={}){
 const result={removed:0,bytes:0,kept:0};
 let names;try{names=await readdir(folder);}catch{return result;}
 const files=[];
 for(const name of names){
  if(!BACKUP_NAME.test(name))continue;
  const entry=path.join(folder,name),info=await lstat(entry).catch(()=>null);
  if(info?.isFile())files.push({entry,size:info.size,at:activity(info)});
 }
 files.sort((a,b)=>a.at-b.at);
 let total=files.reduce((sum,file)=>sum+file.size,0);
 for(const file of files){
  const expired=file.at<now-maxAgeDays*DAY,excess=total>maxBytes&&file.at<now-minAgeDays*DAY;
  if(!expired&&!excess){result.kept++;continue;}
  try{await rm(file.entry,{force:true});result.removed++;result.bytes+=file.size;total-=file.size;}catch{result.kept++;}
 }
 return result;
}

const USAGE_FOLDERS=[
 ['chat-memory','Chat memory and search'],['assets','Images and attachments'],['ghidra-workspaces','Reverse-engineering projects'],
 ['browser-data','Built-in browser'],['managed-tools','Updated tools'],['decision-models','Local helper models'],
 ['runtime-tmp','Temporary files',true],['file-backups','Overwritten-file backups',true],
];

export class DiskGuard{
 constructor({dataDir,accountsDir=dataDir,workspace,getWorkspace=()=>workspace,temporaryInUse=()=>false,emit=()=>{},statfs=nativeStatfs,log=()=>{},now=()=>Date.now()}){
  Object.assign(this,{dataDir,accountsDir,getWorkspace,temporaryInUse,emit,statfs,log,now});
  this.lastCleanup=null;this.level=null;this.timers=[];this.cleaning=null;
 }
 async status(){
  const locations=[this.dataDir,this.getWorkspace()].filter(Boolean),volumes=new Map();
  for(const location of locations){
   const space=await freeSpace(location,{statfs:this.statfs});if(!space)continue;
   const key=path.parse(path.resolve(location)).root.toLowerCase()||location;
   if(!volumes.has(key))volumes.set(key,{root:path.parse(path.resolve(location)).root,...space,level:diskLevel(space.freeBytes)});
  }
  const list=[...volumes.values()],freeBytes=list.length?Math.min(...list.map(volume=>volume.freeBytes)):null;
  return {level:freeBytes==null?'unknown':diskLevel(freeBytes),freeBytes,volumes:list,lastCleanup:this.lastCleanup};
 }
 async usage(){
  const budget={left:WALK_LIMIT},folders=[];
  for(const[name,label,disposable]of USAGE_FOLDERS){
   const measured=await folderBytes(path.join(this.dataDir,name),budget);
   folders.push({name,label,disposable:disposable===true,...measured});
  }
  folders.sort((a,b)=>b.bytes-a.bytes);
  return {folders,complete:folders.every(folder=>folder.complete)};
 }
 /** Only disposable files: temp folders and expired overwrite backups. */
 cleanup(){
  this.cleaning??=this.runCleanup().finally(()=>{this.cleaning=null;});
  return this.cleaning;
 }
 async runCleanup(){
  const now=this.now(),temporaryRoots=[...new Set([this.dataDir,this.accountsDir].map(root=>path.join(root,'runtime-tmp')))];
  const totals={removed:0,bytes:0,kept:0};
  const add=part=>{totals.removed+=part.removed;totals.bytes+=part.bytes;totals.kept+=part.kept;};
  // A long-running terminal can depend on an old temp file it never modifies.
  const temporarySkipped=this.temporaryInUse()===true;
  if(!temporarySkipped)for(const folder of temporaryRoots)add(await pruneTemporaryFiles(folder,{now}));
  add(await pruneFileBackups(path.join(this.dataDir,'file-backups'),{now}));
  this.lastCleanup={...totals,temporarySkipped,at:new Date(now).toISOString()};
  if(totals.removed)this.log(`Removed ${totals.removed} disposable items (${formatBytes(totals.bytes)}).`);
  return this.lastCleanup;
 }
 async check(){
  const status=await this.status();
  // Announce worsening only, so a nearly full drive does not nag every interval.
  const rank={unknown:0,ok:0,low:1,critical:2},worse=rank[status.level]>rank[this.level||'ok'];
  this.level=status.level;
  if(worse)this.emit({type:'disk.changed',disk:status,message:status.level==='critical'?`Your drive is almost full (${formatBytes(status.freeBytes)} free). Exomina may fail to save new work until you free up space.`:`Your drive is getting full (${formatBytes(status.freeBytes)} free). See Settings → Memory & privacy → Disk space.`});
  return status;
 }
 /** First pass waits until startup has settled, then runs on long intervals. */
 start({cleanupDelayMs=2*60*1000,cleanupEveryMs=DAY,checkEveryMs=15*60*1000,checkDelayMs=20*1000}={}){
  const guard=task=>()=>task().catch(error=>this.log('Disk check failed: '+error.message));
  const schedule=(timer)=>{timer.unref?.();this.timers.push(timer);};
  schedule(setTimeout(guard(()=>this.cleanup()),cleanupDelayMs));
  schedule(setInterval(guard(()=>this.cleanup()),cleanupEveryMs));
  // Delayed so the window exists to show the warning.
  schedule(setTimeout(guard(()=>this.check()),checkDelayMs));
  schedule(setInterval(guard(()=>this.check()),checkEveryMs));
 }
 stop(){for(const timer of this.timers)clearTimeout(timer);this.timers=[];}
}
