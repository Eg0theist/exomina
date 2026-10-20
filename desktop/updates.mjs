import {readFile,writeFile,mkdir,stat,lstat,rm,link,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {PublicUpdates,updateUrl,releaseIsNewer,compareVersions} from './public-updates.mjs';
import {distributionMetadataDirectory} from './app-paths.mjs';
import {UpdateMerge} from './update-merge.mjs';

/** Written by `npm run package` into the build folder; the installer mirrors it into App\. */
export const STAMP='exomina.build.json';
const RESULT='last-update.json',PENDING='pending-update.json',PROGRESS='install-progress.json',WATCHER='update-watcher.json';
const READY='update-ready.json';
function processAlive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
const exists=file=>stat(file).then(()=>true,()=>false);
async function readJson(file){try{return JSON.parse(await readFile(file,'utf8'))}catch{return null}}
async function writePending(file,value,{claim=false}={}){
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});
    // Linking the completed file makes the initial claim atomic and exclusive.
    // Later records replace it only after their complete JSON is on disk.
    if(claim)await link(temporary,file);else await rename(temporary,file);
  }finally{await rm(temporary,{force:true});}
}
export async function readStamp(dir,{platform=process.platform}={}){
  const value=await readJson(path.join(distributionMetadataDirectory(dir,{platform}),STAMP));
  if(typeof value?.id!=='string'||!/^[\w-]{8,64}$/.test(value.id))return null;
  return {id:value.id,version:String(value.version||'').slice(0,40),builtAt:String(value.builtAt||'').slice(0,40),...(value.customized&&typeof value.officialId==='string'?{customized:true,officialId:value.officialId,officialVersion:value.officialVersion}:{})};
}

export const updateDefinitions=[
  {name:'app_update_prepare',description:'Prepare an isolated three-way merge of the downloaded release, its official baseline and customized Source. Returns a workspace and conflict list. Never executes project code or installs. Requires approval to read/copy app source.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'app_update_resolve',description:'After editing one conflict in the prepared update workspace, mark that file reviewed. Deletions are supported. Rejects leftover merge markers; edits invalidate verification. Requires approval.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
  {name:'app_update_verify',description:'After resolving update conflicts, ask approval to install npm dependencies, run tests and package ONLY the isolated update workspace. Project and dependency scripts execute under the user account. Failed checks block installation. Requires Node/npm; can take several minutes.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'app_update_status',description:'Check the running Exomina build, waiting update and exact live restart blockers, including open terminals, commands, analysis, replies and voice. Counts include the reply calling this tool. Does not read terminal output or account stores.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'app_restart_to_update',description:'Ask the user for permission to restart Exomina and install the waiting update. Always asks, at every permission level. If approved, Exomina restarts after your current reply finishes; Windows then asks the user for administrator approval and Exomina reopens on the new build. Finish your reply normally after calling this.',inputSchema:{type:'object',properties:{reason:{type:'string',description:'One sentence shown to the user, for example what the update changes.'}},additionalProperties:false}},
];

/** Installs a verified public download or a locally packaged build. Program
 * files stay admin-only: the installer always runs through Windows' own UAC
 * consent, from the copy shipped inside the installed (protected) App folder,
 * and Exomina reopens without elevation afterwards.
 */
export class Updater {
  constructor({packaged,appDir,home,manualUpdates=false,repositoryUrl='',resourcesDir,stateDir,exePath,channelFile,emit=()=>{},fetchImpl=fetch,extractImpl,allowLoopback=false,spawnImpl=spawn,isProcessAlive=processAlive,readyTimeoutMs=20000,powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')}){
    Object.assign(this,{packaged,appDir,home,stateDir,exePath,spawnImpl,powershell,isProcessAlive,readyTimeoutMs});
    this.manualUpdates=manualUpdates;
    this.repositoryUrl=/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(repositoryUrl)?repositoryUrl:'';
    this.installer=resourcesDir&&path.join(resourcesDir,'app.asar.unpacked','scripts','install-windows.ps1');
    this.runner=resourcesDir&&path.join(resourcesDir,'app.asar.unpacked','desktop','update-runner.ps1');
    this.launcher=resourcesDir&&path.join(resourcesDir,'app.asar.unpacked','desktop','update-launcher.cjs');
    this.build=home&&path.join(home,'Source','release','win-unpacked');
    this.channelFile=channelFile;this.feedUrl='';this.automatic=true;
    this.public=new PublicUpdates({stateDir,emit,fetchImpl,spawnImpl,extractImpl,allowLoopback,powershell});
    this.merge=new UpdateMerge({home,appDir,stateDir,emit,powershell});
    this.launched=false;this.launchPromise=null;this.startingAttempt=null;
  }
  async init({feedUrl,automatic=true}={}){
    const channel=this.channelFile?await readJson(this.channelFile):null;
    this.defaultFeed=channel?.feedUrl||'';
    try{this.configure({feedUrl,automatic});}catch(error){this.feedUrl='';this.automatic=automatic;this.public.notify({phase:'error',message:error.message});}
    if(this.stateDir)await this.public.init();
  }
  configure({feedUrl,automatic=this.automatic}={}){
    const source=feedUrl===undefined?this.feedUrl||this.defaultFeed:feedUrl||this.defaultFeed;
    this.feedUrl=source?updateUrl(source,{allowLoopback:this.public.allowLoopback}):'';
    this.automatic=automatic;
  }
  async check({download=this.automatic}={}){
    const status=await this.status();
    if(!status.supported)throw Error(status.reason);
    if(this.feedUrl)await this.public.check({feedUrl:this.feedUrl,installed:status.installed,download});
    return this.status();
  }
  start(){
    const check=()=>{if(this.automatic&&this.feedUrl)this.check().catch(()=>{});};check();
    clearInterval(this.timer);this.timer=setInterval(check,6*60*60*1000);this.timer.unref?.();
  }
  close(){clearInterval(this.timer);this.public.close();}
  async status(){
    let lastResult=this.stateDir?await readJson(path.join(this.stateDir,RESULT)):null;
    if(this.manualUpdates)return {supported:false,manualUpdates:true,installed:this.appDir?await readStamp(this.appDir):null,repositoryUrl:this.repositoryUrl,reason:'This private beta updates by running the latest installer from GitHub Releases. Your chats and sign-ins are kept. Repository access is required.',lastResult};
    if(!this.packaged||!this.home)return {supported:false,reason:'Updates install only into an installed Exomina (C:\\Program Files\\Exomina layout), not a development or portable copy.',lastResult};
    if(!await exists(this.installer)||!await exists(this.runner))return {supported:false,reason:'This installation predates automatic updates. Install once with scripts\\install-windows.ps1; later updates install themselves.',lastResult};
    const [installed,local,remote]=await Promise.all([readStamp(this.appDir),readStamp(this.build),this.public.ready(this.feedUrl)]);
    const candidates=[];
    if(local&&releaseIsNewer(local,installed)&&await exists(path.join(this.build,'Exomina.exe')))candidates.push({staged:local,buildPath:this.build,source:'local'});
    if(remote&&releaseIsNewer(remote.release,installed))candidates.push({staged:remote.release,buildPath:remote.buildPath,source:'public'});
    candidates.sort((a,b)=>compareVersions(b.staged.version,a.staged.version)||Date.parse(b.staged.builtAt)-Date.parse(a.staged.builtAt));
    const selected=candidates[0],staged=selected?.staged,available=!!selected;
    // A build the user declined, or that failed, is not retried on every launch; a newer package or "Restart and install" retries it.
    // Readiness establishes the handoff; a live runner or elevated installer
    // remains active regardless of how long consent, copying or verification takes.
    const pending=await readJson(path.join(this.stateDir,PENDING)),started=Date.parse(pending?.startedAt);
    const acknowledgement=await readJson(path.join(this.stateDir,READY));
    const [progress,watcher]=await Promise.all([readJson(path.join(this.stateDir,PROGRESS)),readJson(path.join(this.stateDir,WATCHER))]);
    const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{return this.isProcessAlive(pid);}catch{return false;}};
    const liveRunner=pending?.ready===true&&acknowledgement?.attemptId===pending.attemptId&&(acknowledgement.supervisorPid||acknowledgement.pid)===pending.pid&&alive(pending.pid);
    const starting=pending?.phase==='starting'&&Number.isFinite(started)&&Date.now()>=started&&Date.now()-started<this.readyTimeoutMs+2000&&(alive(pending.pid)||alive(pending.ownerPid));
    const validInstallation=value=>typeof value?.attemptId==='string'&&/^[a-f0-9-]{36}$/i.test(value.attemptId)&&typeof value.buildId==='string'&&/^[\w-]{8,64}$/.test(value.buildId)&&typeof value.phase==='string'&&!['installed','failed','declined','complete','done'].includes(value.phase)&&Number.isFinite(Date.parse(value.updatedAt));
    // The unelevated watcher is an independent fallback when progress writing
    // fails, or when its first record predates the elevated installer PID.
    const liveInstallation=[progress,watcher].find(value=>validInstallation(value)&&(!pending||(value.attemptId===pending.attemptId&&value.buildId===pending.buildId))&&alive(value.installerPid));
    const liveInstaller=!!liveInstallation;
    const inProgress=!!(liveRunner||starting||liveInstaller||(pending&&this.startingAttempt===pending.attemptId));
    if(pending&&!inProgress){
      // A runner can finish its result before removing pending state. Preserve
      // that concrete outcome instead of replacing it with a generic crash.
      const sameAttempt=lastResult?.attemptId&&lastResult.attemptId===pending.attemptId&&lastResult.buildId===pending.buildId;
      if(!sameAttempt){
        lastResult={buildId:pending.buildId,attemptId:pending.attemptId,status:'failed',message:'The previous updater stopped before it finished. Exomina has reopened; you can retry the update.',finishedAt:new Date().toISOString()};
        await writeFile(path.join(this.stateDir,RESULT),JSON.stringify(lastResult),{mode:0o600});
      }
      await rm(path.join(this.stateDir,PENDING),{force:true});
    }
    // An old failure notice is not the outcome of an installation still running.
    if(liveInstaller&&lastResult?.buildId===liveInstallation.buildId&&(!lastResult.attemptId||lastResult.attemptId===liveInstallation.attemptId))lastResult=null;
    const autoBlocked=!inProgress&&available&&lastResult?.buildId===staged.id&&lastResult.status!=='installed';
    const release=this.public.feedUrl===this.feedUrl&&releaseIsNewer(this.public.release,installed)?this.public.release:null;
    const merge=available?await this.merge.inspect({installed,staged,source:selected.source,buildPath:selected.buildPath}):null;
    return {supported:true,installed,staged:staged||null,available,autoBlocked,inProgress,buildPath:selected?.buildPath||this.build,source:selected?.source,lastResult,merge,remote:{configured:!!this.feedUrl,feedUrl:this.feedUrl,release,checkedAt:this.public.checkedAt,progress:this.public.progress}};
  }
  /** Reads the result of the update that ran before this launch, once. */
  async takeResult(){
    if(!this.stateDir)return null;
    const file=path.join(this.stateDir,RESULT),value=await readJson(file);
    if(!value||value.seen)return null;
    await writeFile(file,JSON.stringify({...value,seen:true}),{mode:0o600}).catch(()=>{});
    return value;
  }
  /** Called after backend initialization, main-page load and a stable interval.
   * The elevated installer helper validates the process path/start time itself;
   * this record never supplies deletion targets or permission to start helpers.
   */
  async confirmStartup({now=Date.now(),pid=process.pid,rendererPid}={}){
    if(!this.packaged||!this.home||!this.stateDir||path.resolve(this.appDir)!==path.join(path.resolve(this.home),'App')||!Number.isInteger(pid)||pid<=0||!Number.isInteger(rendererPid)||rendererPid<=0)return false;
    const file=path.join(this.stateDir,'program-cleanup-pending.json');
    const metadata=await lstat(file).catch(()=>null);if(!metadata?.isFile()||metadata.isSymbolicLink())return false;
    const challenge=await readJson(file),stamp=await readStamp(this.appDir);
    const created=Date.parse(challenge?.createdAt),expiry=Date.parse(challenge?.expiresAt);
    if(challenge?.schema!==1||!/^[a-f0-9]{32}$/.test(challenge.token||'')||challenge.buildId!==stamp?.id||!Number.isFinite(created)||!Number.isFinite(expiry)||now<created||now>=expiry||expiry-created>180000||expiry<=created)return false;
    await writePending(path.join(this.stateDir,'program-cleanup-health.json'),{schema:1,token:challenge.token,buildId:stamp.id,pid,rendererPid,ready:true,readyAt:new Date(now).toISOString()});
    return true;
  }
  /** Wait for the runner to acknowledge startup before allowing Exomina to quit. */
  launch(request={}){
    if(this.launchPromise)return this.launchPromise;
    const promise=this.launchAttempt(request);this.launchPromise=promise;
    const clear=()=>{if(this.launchPromise===promise)this.launchPromise=null;};
    promise.then(clear,clear);return promise;
  }
  async launchAttempt({conversationId}={}){
    const current=await this.status();
    if(!current.supported)throw Error(current.reason);
    if(!current.available)throw Error('No downloaded or locally packaged update is ready to apply.');
    if(this.public.work)throw Error('Wait for the update download to finish or cancel it before applying.');
    if(current.inProgress)return current;
    await this.merge.assertProgramUnmodified(current.installed);
    let checked;if(current.merge?.required){checked=await this.merge.approvedBuild(current);current.buildPath=checked.buildPath;current.staged=checked.staged;}
    this.launched=false;
    await mkdir(this.stateDir,{recursive:true});
    const pending=path.join(this.stateDir,PENDING);
    const record={buildId:current.staged.id,conversationId:conversationId||null,startedAt:new Date().toISOString(),attemptId:randomUUID(),phase:'starting',ownerPid:process.pid};
    this.startingAttempt=record.attemptId;
    try{await writePending(pending,record,{claim:true});}
    catch(error){
      this.startingAttempt=null;
      if(error.code==='EEXIST'){
        const active=await this.status();if(active.inProgress)return active;
        throw Error('Another update handoff changed state. Retry the update.');
      }
      throw error;
    }
    const build=current.buildPath;
    const args=['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',this.runner,'-Installer',this.installer,'-Build',build,'-InstallHome',this.home,'-Exe',this.exePath,'-State',this.stateDir,'-BuildId',current.staged.id,'-AttemptId',record.attemptId,'-AppPid',String(process.pid)];
    if(checked)args.push('-ExpectedManifest',checked.receipt,'-ExpectedManifestHash',checked.receiptHash);
    let child;
    try{
      // Detach a Node supervisor, not PowerShell. The supervisor keeps the
      // non-detached PowerShell alive after Electron closes.
      // Run from the staged build so the installed executable is not locked.
      child=this.spawnImpl(path.join(build,'Exomina.exe'),[this.launcher,this.powershell,...args],{detached:true,stdio:'ignore',windowsHide:true,cwd:this.stateDir,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
      let failure,childExitCode,acknowledgement;
      child.on('error',e=>{failure=Error(`The updater could not start (${e.code||'process error'}).`);});
      // A supervisor may relay itself out of a Windows process job. Its original
      // process exits successfully before the replacement acknowledges readiness.
      child.on('exit',code=>{childExitCode=code;if(code!==0)failure=Error(`The updater exited before it was ready (code ${code}).`);});
      await writePending(pending,{...record,pid:child.pid});
      const deadline=Date.now()+this.readyTimeoutMs;
      while(true){
        if(failure)throw failure;
        const ready=await readJson(path.join(this.stateDir,READY));
        if(ready?.attemptId===record.attemptId&&ready.pid===child.pid){acknowledgement=ready;break;}
        if(Date.now()>=deadline)throw Error(childExitCode===0?'The updater exited before it was ready (code 0).':'The updater did not confirm startup. Exomina will stay open.');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      await writePending(pending,{...record,phase:'ready',pid:acknowledgement.supervisorPid||child.pid,bootstrapPid:child.pid,ready:true});
      child.unref?.();this.launched=true;
      return current;
    }catch(error){
      child?.kill?.();
      const concrete=await readJson(path.join(this.stateDir,RESULT));
      if(concrete?.attemptId===record.attemptId&&concrete.buildId===record.buildId&&concrete.status==='failed'&&typeof concrete.message==='string'&&concrete.message){error=Error(concrete.message);}
      else await writeFile(path.join(this.stateDir,RESULT),JSON.stringify({buildId:record.buildId,attemptId:record.attemptId,status:'failed',message:error.message,finishedAt:new Date().toISOString()}),{mode:0o600});
      await rm(pending,{force:true});
      throw error;
    }finally{this.startingAttempt=null;}
  }
}
