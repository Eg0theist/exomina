import {lstat,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {excludedDiskPath,diskAdvice,within,normalized} from './disk-rules.mjs';

/** Folders that hold a person's own data or the user profile itself. Their contents can be removed item by item; the folder is never removed whole. */
const WHOLE_FOLDER_REFUSED=/^[a-z]:\/users(?:\/[^/]+(?:\/(?:desktop|documents|pictures|music|videos|downloads|saved games|contacts|favorites|links|searches|3d objects|onedrive[^/]*|appdata(?:\/(?:local|roaming|locallow))?))?)?$/;
/** Exomina keeps chat attachments and recovery data in dot-folders next to the work. */
const EXOMINA_STATE=/(?:^|\/)\.exomina[^/]*(?:\/|$)/;
const SYNCED=/\/(?:onedrive[^/]*|dropbox|google drive|googledrive|icloud drive|iclouddrive|mega|sync)(?:\/|$)/;
export const MAX_DELETE_ITEMS=40;

/** Finds the folder node for an absolute path by walking names down from the scan root (the root node's own name may be short). */
function findNode(tree,root,target){
 const base=normalized(root),wanted=normalized(target);
 if(wanted===base)return 0;if(!wanted.startsWith(base+'/'))return -1;
 let at=0;
 for(const part of wanted.slice(base.length+1).split('/').filter(Boolean)){
  let next=-1;for(let i=tree.childStart[at];i<tree.childStart[at+1];i++){const child=tree.childIds[i];if(tree.name(child).toLowerCase()===part){next=child;break;}}
  if(next<0)return -1;at=next;
 }
 return at;
}

/**
 * Decides whether one path from a finished scan may be deleted. The same checks run when the
 * user confirms, when the AI proposes and again immediately before each deletion.
 */
export async function checkDeletable(file,{scan,privateDirs=[],protectedDirs=[],protectedTrees=[],appRoots=[],denied=[],canDelete=()=>true}){
 const refuse=(reason,extra={})=>({ok:false,path:String(file??'').slice(0,500),reason,...extra});
 if(typeof file!=='string'||!file||file.length>1024||/[\x00-\x1f]/.test(file))return refuse('Not a valid path.');
 if(!path.win32.isAbsolute(file)&&!path.isAbsolute(file))return refuse('Use a full path from the scan.');
 if(/^[a-z]:/i.test(file)?file.slice(2).includes(':'):file.includes(':'))return refuse('Alternate data streams and device paths are not supported.');
 const target=path.resolve(file),slashed=normalized(target);
 if(!scan?.root||!scan.tree)return refuse('This scan has no folder detail to check against. Scan again.');
 if(!within(scan.root,target)||normalized(scan.root)===slashed)return refuse('Outside the scanned area, or the scan root itself.');
 if(path.parse(target).root===target||/^[a-z]:$/.test(slashed))return refuse('Drive roots cannot be deleted.');
 if(WHOLE_FOLDER_REFUSED.test(slashed))return refuse('This is a user profile or personal library folder. Delete items inside it instead.');
 if(EXOMINA_STATE.test(slashed))return refuse('Exomina keeps chat attachments and recovery data here.');
 if(excludedDiskPath(target,privateDirs,denied))return refuse('Private account data and anything blocked by your permission rules cannot be deleted from here.');
 for(const dir of protectedDirs)if(dir&&within(target,dir))return refuse('This contains the running Exomina program or its private data.');
 for(const dir of protectedTrees)if(dir&&within(dir,target))return refuse('This is part of the running Exomina program or a staged update.');
 if(!canDelete(target))return refuse('Deleting this location is blocked by your permission rules or permission level.');
 const advice=diskAdvice(target,{appRoots});
 if(advice.kind==='keep')return refuse(advice.label+': '+advice.reason,{method:advice.method});
 let stat;try{stat=await lstat(target,{bigint:true});}catch(error){return refuse(error.code==='ENOENT'?'It no longer exists.':'It cannot be read: '+(error.code||'error'));}
 if(stat.isSymbolicLink())return refuse('Links and junctions are not deleted from here.');
 if(!stat.isDirectory()&&!stat.isFile())return refuse('Only regular files and folders can be deleted.');
 try{if(normalized(await realpath(target))!==slashed)return refuse('It is reached through a link, so its real location differs.');}catch{return refuse('It cannot be resolved.');}
 const identity=stat.dev.toString()+':'+stat.ino.toString();
 const tree=scan.tree,folder=stat.isDirectory();
 const node=findNode(tree,scan.root,folder?target:path.dirname(target));
 if(node<0)return refuse('It was not measured by this scan. Scan the area containing it first.');
 const alloc=folder?tree.alloc[node]:Number(stat.size),bytes=folder?tree.bytes[node]:Number(stat.size);
 return {ok:true,identity,path:target,name:path.basename(target),kind:folder?'folder':'file',alloc,bytes,files:folder?tree.files[node]:1,advice:advice.label,adviceKind:advice.kind,synced:SYNCED.test(slashed),complete:folder?tree.complete(node):true};
}

/** Checks a batch, drops items nested inside another selected item and separates the refused ones. */
export async function planDeletion(items,context){
 const accepted=[],refused=[],seen=new Set();
 for(const item of (Array.isArray(items)?items:[]).slice(0,MAX_DELETE_ITEMS)){
  const file=typeof item==='string'?item:item?.path,key=typeof file==='string'?normalized(file):'';
  if(key&&seen.has(key))continue;if(key)seen.add(key);
  const result=await checkDeletable(file,context);
  if(result.ok)accepted.push({...result,reason:typeof item==='object'&&typeof item.reason==='string'?item.reason.slice(0,300):''});else refused.push(result);
 }
 accepted.sort((a,b)=>normalized(a.path).length-normalized(b.path).length);
 const kept=[];
 for(const item of accepted){
  const parent=kept.find(other=>other.kind==='folder'&&within(other.path,item.path));
  if(parent){parent.includes=(parent.includes||0)+1;continue;}
  kept.push(item);
 }
 kept.sort((a,b)=>b.alloc-a.alloc);
 return {items:kept,refused,overflow:Array.isArray(items)&&items.length>MAX_DELETE_ITEMS?items.length-MAX_DELETE_ITEMS:0};
}

/** Human-readable list for approval cards and confirmations. */
export function describeDeletion(plan,{method='recycle',bytes=value=>String(value)}={}){
 const lines=plan.items.map((item,index)=>`${index+1}. ${item.path}\n   ${item.kind==='folder'?'Folder':'File'}, ${bytes(item.alloc)} on disk${item.files>1?`, ${item.files.toLocaleString('en')} files`:''} · ${item.advice}${item.synced?' · SYNCED FOLDER: deleting may also remove it from the cloud and your other devices':''}${item.complete===false?' · only partly measured: more may be inside':''}${item.includes?` · includes ${item.includes} other selected item${item.includes===1?'':'s'}`:''}${item.reason?`\n   Why: ${item.reason}`:''}`);
 return [method==='permanent'?'PERMANENT: these items are deleted immediately and cannot be recovered. A folder is removed with everything inside it, including items this scan deliberately skips (private keys, credentials, browser data).':'These items move to the Recycle Bin and can be restored from there until it is emptied. Space is freed when the Recycle Bin is emptied. A folder moves with everything inside it, including items this scan deliberately skips (private keys, credentials, browser data).',...lines].join('\n');
}

/** Removes the planned items one by one. Each is checked again first and confirmed gone afterwards. */
export async function executeDeletion(plan,{method='recycle',trash,remove=file=>rm(file,{recursive:true,force:false,maxRetries:2,retryDelay:200}),context,signal}){
 const deleted=[],failed=[];
 for(const item of plan.items){
  if(signal?.aborted){failed.push({path:item.path,error:'Stopped before this item.'});continue;}
  const again=await checkDeletable(item.path,context);
  if(!again.ok){failed.push({path:item.path,error:again.reason});continue;}
  if(item.identity&&again.identity!==item.identity){failed.push({path:item.path,error:'It was replaced by a different item after it was checked, so it was left alone.'});continue;}
  try{
   if(method==='permanent')await remove(again.path);
   else{if(typeof trash!=='function')throw Error('The Recycle Bin is unavailable here.');await trash(again.path);}
   let gone=false;try{await lstat(again.path);}catch(error){gone=error.code==='ENOENT';}
   if(gone)deleted.push({path:again.path,kind:again.kind,alloc:again.alloc,bytes:again.bytes});
   else failed.push({path:item.path,error:'It is still present. A program may be using it.'});
  }catch(error){
   const text=String(error?.message||error).replace(/\s+/g,' ').slice(0,240);
   failed.push({path:item.path,error:method==='recycle'?text+' If the Recycle Bin is unavailable for this location, delete permanently instead.':text});
  }
 }
 return {deleted,failed};
}

/**
 * Moves one file or folder to the Recycle Bin through Windows' own shell operation (built-in .NET, no
 * compiled code). The path travels in an environment variable, never inside the command text.
 */
export function recycleItem(file,{spawnImpl=spawn,timeoutMs=20*60*1000,platform=process.platform}={}){
 if(platform!=='win32')return Promise.reject(Error('The Recycle Bin is only available on Windows.'));
 const script="$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; $p=$env:EXOMINA_RECYCLE_PATH; $ui=[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs; $bin=[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin; $cancel=[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException; if(Test-Path -LiteralPath $p -PathType Container){[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,$ui,$bin,$cancel)}else{[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,$ui,$bin,$cancel)}";
 return new Promise((resolve,reject)=>{
  const child=spawnImpl(path.win32.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,EXOMINA_RECYCLE_PATH:file}});
  let errorText='',settled=false;const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
  const timer=setTimeout(()=>{child.kill();finish(Error('Windows did not finish moving it to the Recycle Bin in time.'));},timeoutMs);timer.unref?.();
  child.stderr?.setEncoding?.('utf8');child.stderr?.on('data',chunk=>{if(errorText.length<2000)errorText+=chunk;});
  child.on('error',finish);
  child.on('close',code=>finish(code===0?null:Error(errorText.replace(/\s+/g,' ').trim().slice(0,240)||'Windows could not move it to the Recycle Bin ('+code+').')));
 });
}
