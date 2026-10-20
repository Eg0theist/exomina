import { mkdir, readFile, writeFile, rename, stat, open, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_PACKAGE=8*1024**3,MAX_MANIFEST=256*1024;
const readJson=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch{return null;}};
export function updateUrl(value,{allowLoopback=false,base}={}){
 let url;try{url=new URL(value,base);}catch{throw Error('Use a valid HTTPS release address.');}
 const local=allowLoopback&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if((url.protocol!=='https:'&&!local)||url.username||url.password||url.hash)throw Error('Updates require HTTPS without embedded credentials.');
 return url.href;
}
function versionParts(value){const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value||'');if(!match)throw Error('The release has an invalid version.');return[...match.slice(1,4).map(Number),match[4]||''];}
export function compareVersions(a,b){
 const left=versionParts(a),right=versionParts(b);
 for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;
 if(left[3]===right[3])return 0;if(!left[3])return 1;if(!right[3])return -1;
 const x=left[3].split('.'),y=right[3].split('.');
 for(let i=0;i<Math.max(x.length,y.length);i++){if(x[i]===undefined)return-1;if(y[i]===undefined)return 1;if(x[i]===y[i])continue;const xn=/^\d+$/.test(x[i]),yn=/^\d+$/.test(y[i]);if(xn!==yn)return xn?-1:1;return xn?(Number(x[i])>Number(y[i])?1:-1):(x[i]>y[i]?1:-1);}
 return 0;
}
export function releaseIsNewer(release,installed){
 if(!release||release.id===installed?.id)return false;
 if(!installed?.version)return true;
 let version;try{version=compareVersions(release.version,installed.officialVersion||installed.version);}catch{return false;}
 return version>0||(version===0&&Date.parse(release.builtAt)>Date.parse(installed.builtAt));
}
export function normalizeRelease(value,feedUrl,options={}){
 const asset=value?.windows?.x64;
 if(value?.format!==1||typeof value.id!=='string'||! /^[\w-]{8,64}$/.test(value.id)||typeof value.version!=='string'||value.version.length>40||typeof value.builtAt!=='string'||value.builtAt.length>40||!Number.isFinite(Date.parse(value.builtAt)))throw Error('The update feed does not describe a valid Exomina release.');
 versionParts(value.version);
 if(!asset||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>MAX_PACKAGE||! /^[a-f0-9]{64}$/i.test(asset.sha256||''))throw Error('The release has no verifiable Windows x64 download.');
 return{id:value.id,version:value.version,builtAt:value.builtAt,notes:typeof value.notes==='string'?value.notes.slice(0,10000):'',asset:{url:updateUrl(asset.url,{...options,base:feedUrl}),sha256:asset.sha256.toLowerCase(),size:asset.size}};
}

/** Downloads public program files only. A ready package waits for explicit Apply. */
export class PublicUpdates{
 constructor({stateDir,fetchImpl=fetch,spawnImpl=spawn,emit=()=>{},allowLoopback=false,extractImpl,powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')}){
  Object.assign(this,{stateDir,fetch:fetchImpl,spawn:spawnImpl,emit,allowLoopback,extractImpl,powershell});this.progress=null;this.release=null;this.checkedAt=null;this.feedUrl='';
 }
 notify(progress){this.progress=progress;this.emit({type:'update.progress',progress});}
 async init(){
  const saved=await readJson(path.join(this.stateDir,'public-release.json'));if(saved){this.checkedAt=saved.checkedAt;this.feedUrl=saved.feedUrl;this.release=saved.release;}
 }
 async ready(feedUrl){
  const value=await readJson(path.join(this.stateDir,'public-ready.json'));if(!value||value.feedUrl!==feedUrl)return null;
  const base=path.resolve(this.stateDir,'downloads'),target=path.resolve(value.buildPath||'');
  if(!target.startsWith(base+path.sep))return null;
  const stamp=await readJson(path.join(target,'exomina.build.json'));
  if(stamp?.id!==value.release?.id||stamp?.version!==value.release?.version||!await stat(path.join(target,'Exomina.exe')).catch(()=>null))return null;
  return{buildPath:target,release:value.release};
 }
 async request(url,signal){
  for(let redirects=0;redirects<=5;redirects++){
   const target=updateUrl(url,{allowLoopback:this.allowLoopback});
   const response=await this.fetch(target,{redirect:'manual',signal,headers:{Accept:'application/json, application/zip, application/octet-stream','User-Agent':'Exomina-Updater'}});
   if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');await response.body?.cancel?.().catch(()=>{});if(!next)throw Error('The release redirect has no destination.');url=updateUrl(next,{base:target,allowLoopback:this.allowLoopback});continue;}
   if(!response.ok)throw Error(`The update server returned HTTP ${response.status}.`);return response;
  }
  throw Error('The update server redirected too many times.');
 }
 async check({feedUrl,installed,download=true}){
  if(this.work)return this.work;
  const work=this.work=this.performCheck({feedUrl,installed,download});
  try{return await work;}finally{if(this.work===work)this.work=null;}
 }
 async performCheck({feedUrl,installed,download}){
  const controller=this.controller=new AbortController();
  try{
   feedUrl=updateUrl(feedUrl,{allowLoopback:this.allowLoopback});this.notify({phase:'checking',message:'Checking for updates'});
   const response=await this.request(feedUrl,AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]));
   let bytes=0,text='';const decoder=new TextDecoder();
   for await(const chunk of response.body){bytes+=chunk.length;if(bytes>MAX_MANIFEST)throw Error('The update feed is too large.');text+=decoder.decode(chunk,{stream:true});}text+=decoder.decode();
   const release=normalizeRelease(JSON.parse(text),feedUrl,{allowLoopback:this.allowLoopback});
   this.feedUrl=feedUrl;this.release=release;this.checkedAt=new Date().toISOString();await mkdir(this.stateDir,{recursive:true});
   await writeFile(path.join(this.stateDir,'public-release.json'),JSON.stringify({feedUrl,release,checkedAt:this.checkedAt}),{mode:0o600});
   if(!releaseIsNewer(release,installed)){this.notify({phase:'current',message:'Exomina is up to date'});return;}
   const ready=await this.ready(feedUrl);if(ready?.release.id===release.id){this.notify({phase:'ready',message:'Update ready to apply'});return;}
   if(!download){this.notify({phase:'available',message:'An update is available'});return;}
   await this.download(release,feedUrl,controller.signal);
  }catch(error){this.notify({phase:controller.signal.aborted?'cancelled':'error',message:controller.signal.aborted?'Update download cancelled':error.message});throw error;}
  finally{if(this.controller===controller)this.controller=null;}
 }
 async download(release,feedUrl,signal){
  const target=path.join(this.stateDir,'downloads',release.id+'-'+randomUUID()),buildPath=path.join(target,'build'),archive=path.join(target,'update.zip'),partial=archive+'.part';
  await mkdir(buildPath,{recursive:true});let handle,published=false;
  try{
   this.notify({phase:'downloading',message:'Downloading update',completed:0,total:release.asset.size});
   const response=await this.request(release.asset.url,AbortSignal.any([signal,AbortSignal.timeout(30*60*1000)]));
   const length=response.headers.get('content-length');if(length&&Number(length)!==release.asset.size)throw Error('The update size does not match the release.');
   handle=await open(partial,'wx',0o600);const hash=createHash('sha256');let completed=0,at=0;
   for await(const chunk of response.body){completed+=chunk.length;if(completed>release.asset.size)throw Error('The update exceeds its expected size.');hash.update(chunk);await handle.writeFile(chunk);if(Date.now()-at>250){at=Date.now();this.notify({phase:'downloading',message:'Downloading update',completed,total:release.asset.size});}}
   await handle.close();handle=null;
   if(completed!==release.asset.size||hash.digest('hex')!==release.asset.sha256)throw Error('The update failed its integrity check. It was not staged.');
   await rename(partial,archive);this.notify({phase:'verifying',message:'Preparing the verified update'});
   await this.extract(archive,buildPath,signal);
   const stamp=await readJson(path.join(buildPath,'exomina.build.json'));
   if(stamp?.id!==release.id||stamp?.version!==release.version||stamp?.builtAt!==release.builtAt)throw Error('The downloaded build does not match the release.');
   for(const file of ['Exomina.exe','resources/app.asar','resources/app.asar.unpacked/scripts/install-windows.ps1','resources/app.asar.unpacked/desktop/update-runner.ps1'])if(!(await stat(path.join(buildPath,file)).catch(()=>null))?.isFile())throw Error('The downloaded Exomina package is incomplete.');
   const record={feedUrl,release,buildPath};await writeFile(path.join(this.stateDir,'public-ready.json.tmp'),JSON.stringify(record),{mode:0o600});await rename(path.join(this.stateDir,'public-ready.json.tmp'),path.join(this.stateDir,'public-ready.json'));
   published=true;await unlink(archive).catch(()=>{});this.notify({phase:'ready',message:'Update ready to apply'});
  }finally{
   await handle?.close().catch(()=>{});await unlink(partial).catch(()=>{});
   const resolved=path.resolve(target),downloads=path.resolve(this.stateDir,'downloads');
   if(!published&&resolved.startsWith(downloads+path.sep))await rm(resolved,{recursive:true,force:true}).catch(()=>{});
  }
 }
 async extract(archive,target,signal){
  if(this.extractImpl)return this.extractImpl(archive,target,signal);
  const script=fileURLToPath(new URL('./extract-update.ps1',import.meta.url));
  await new Promise((resolve,reject)=>{
   const child=this.spawn(this.powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',script],{windowsHide:true,env:{...process.env,EXOMINA_UPDATE_ARCHIVE:archive,EXOMINA_UPDATE_TARGET:target},stdio:['ignore','ignore','pipe'],signal});let message='';
   child.stderr.on('data',chunk=>{message=(message+chunk).slice(-2000);});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Could not prepare the update: '+message)));
  });
 }
 cancel(){this.controller?.abort();}
 close(){this.cancel();}
}
