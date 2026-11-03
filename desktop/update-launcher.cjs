// Remains unelevated. Windows decides whether the parent's process job permits
// an independent lifetime. Keep a second watcher if PowerShell exits early.
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {readFileSync,writeFileSync,renameSync,unlinkSync}=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {finishActivation}=require('./update-activation.cjs');
const [powershell,...args]=process.argv.slice(2);
const argument=name=>args[args.indexOf(name)+1];
const state=argument('-State'),attemptId=argument('-AttemptId'),buildId=argument('-BuildId');
const bootstrapPid=Number(process.env.EXOMINA_UPDATER_BOOTSTRAP_PID)||process.pid;
process.env.EXOMINA_UPDATER_BOOTSTRAP_PID=String(bootstrapPid);
function read(name){try{return JSON.parse(readFileSync(path.join(state,name),'utf8'));}catch{return null;}}
function write(name,value){const file=path.join(state,name);writeFileSync(file+'.supervisor.tmp',JSON.stringify(value));renameSync(file+'.supervisor.tmp',file);}
function alive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
let completing;
function stopped(message){return completing||=(complete(message).catch(error=>{
  const finishedAt=new Date().toISOString();
  try{write('last-update.json',{attemptId,buildId,status:'failed',message:'Update recovery could not finish: '+error.message+'. Open Exomina Recovery from the Start menu.',finishedAt});write('update-watcher.json',{attemptId,buildId,phase:'failed',installerPid:0,updatedAt:finishedAt});}catch{}
}));}
async function complete(message){
  const progress=read('install-progress.json'),watcher=read('update-watcher.json');
  const matching=value=>value?.attemptId===attemptId&&value?.buildId===buildId;
  const installerPid=[progress,watcher].find(value=>matching(value)&&alive(value.installerPid))?.installerPid||0;
  while(alive(installerPid))await new Promise(resolve=>setTimeout(resolve,1000));
  const previous=read('last-update.json');
  if(previous?.attemptId===attemptId&&matching(watcher)&&watcher.phase===previous.status&&['installed','failed','declined','rolled-back','recovery-opened'].includes(previous.status))return;
  const report=read('install-report.json');
  let stamp;try{stamp=JSON.parse(readFileSync(path.join(argument('-InstallHome'),'App','exomina.build.json'),'utf8'));}catch{}
  const ok=matching(report)&&report.ok===true&&stamp?.id===buildId;
  if(matching(report)&&report.ok===true&&report.programCleanup?.monitored){
    // A normal runner already launched the candidate. If it died after copy or
    // before launch, start it once here, then use exactly the same health gate.
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.EXOMINA_UPDATER_BOOTSTRAP_PID;delete env.EXOMINA_WINDOWS_INDEPENDENT;
    const exe=path.join(argument('-InstallHome'),'App','Exomina.exe');
    async function open(target=exe){
      const child=spawn(target,[],{detached:true,windowsHide:false,stdio:'ignore',cwd:argument('-InstallHome'),env});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    }
    const reopened=read('update-reopen.json');
    const verdict=read('update-activation.json');
    if(!matching(verdict)&&(!matching(reopened)||reopened.status!=='launched'))await open().catch(()=>{});
    async function recover(){
      const control=report.programCleanup,home=path.resolve(argument('-InstallHome')),previous=path.resolve(control.previous||'');
      if(path.dirname(previous).toLowerCase()!==home.toLowerCase()||!/^App\.previous-[a-f0-9]{32}$/.test(path.basename(previous)))throw Error('Invalid recovery program path.');
      // If the privileged restore finished but publishing its verdict failed,
      // prefer the restored normal path to a side-by-side recovery instance.
      let active;try{active=JSON.parse(readFileSync(path.join(home,'App','exomina.build.json'),'utf8'));}catch{}
      if(active?.id&&active.id!==buildId){await open();return;}
      const result=await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'update-fallback.ps1'),'-InstallHome',home,'-Previous',previous,'-BuildId',buildId,'-CreatedAt',control.createdAt],{windowsHide:true,timeout:45000,env});
      if(result.stdout.trim()!=='previous-program-ready')throw Error('The previous program could not be safely reopened.');
      await open(path.join(previous,'Exomina.exe'));
    }
    write('update-watcher.json',{attemptId,buildId,pid:process.pid,installerPid:report.programCleanup.pid,phase:'verifying-startup',updatedAt:new Date().toISOString()});
    await finishActivation({attemptId,buildId,control:report.programCleanup,read,write,alive,open,recover});
    if(matching(read('pending-update.json')))try{unlinkSync(path.join(state,'pending-update.json'));}catch{}
    return;
  }
  // Old/unmonitored installers cannot turn file-copy success into verified
  // startup. Keep a truthful failure result rather than claiming installation.
  const status=ok?'installed-unverified':'failed',finishedAt=new Date().toISOString();
  write('last-update.json',{attemptId,buildId,status,message:ok?'Program files installed, but this older installer did not verify workspace startup.':matching(report)&&report.error?report.error:message,finishedAt});
  write('update-watcher.json',{attemptId,buildId,pid:process.pid,installerPid:0,phase:status,updatedAt:finishedAt});
  if(matching(read('pending-update.json')))try{unlinkSync(path.join(state,'pending-update.json'));}catch{}
  // The installer activates App, even when this attempt started from a recovery
  // directory. Only an unsuccessful install should reopen the previous copy.
  const exe=ok?path.join(argument('-InstallHome'),'App','Exomina.exe'):argument('-Exe');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.EXOMINA_UPDATER_BOOTSTRAP_PID;delete env.EXOMINA_WINDOWS_INDEPENDENT;
  const reopen={attemptId,buildId,requested:exe,opened:null,status:'failed',error:'',fallbackError:''};
  async function open(target){
    // Never hide the reopened program: Windows applies a hidden start state to the first window it shows, so the app would stay in the tray.
    const child=spawn(target,[],{detached:true,windowsHide:false,stdio:'ignore',cwd:argument('-InstallHome'),env});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();reopen.opened=target;
  }
  try{await open(exe);reopen.status='launched';}
  catch(error){
    reopen.error=error.message;
    const previousExe=argument('-Exe');
    if(ok&&path.resolve(exe).toLowerCase()!==path.resolve(previousExe).toLowerCase()){
      try{await open(previousExe);reopen.status='fallback';}catch(fallbackError){reopen.fallbackError=fallbackError.message;}
    }
    const previousResult=read('last-update.json');
    write('last-update.json',{...previousResult,message:reopen.status==='fallback'?'The new build was installed, but Windows could not reopen it. The previous recovery copy was reopened: '+reopen.error:((previousResult?.message||'')+' Exomina could not reopen: '+reopen.error).trim()});
  }
  write('update-reopen.json',reopen);
}
(async()=>{
  const {ensureWindowsAppIndependence}=await import(pathToFileURL(path.join(__dirname,'app-lifetime.mjs')).href);
  const lifetime=await ensureWindowsAppIndependence({packaged:true,exePath:process.execPath,scriptPath:path.join(__dirname,'app-lifetime.ps1'),args:process.argv.slice(1)});
  if(lifetime.handedOff){
    // Older installed hosts require this bootstrap PID alive through readiness.
    // Once the old app closes, release this shim before installer process checks.
    while(true){
      const ready=read('update-ready.json');
      if(ready?.attemptId===attemptId&&!alive(Number(argument('-AppPid'))))break;
      if(!alive(lifetime.pid))break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return;
  }
  if(lifetime.status==='failed')throw Error(lifetime.message);
  const child=spawn(powershell,[...args,'-LauncherPid',String(process.pid),'-BootstrapPid',String(bootstrapPid)],{detached:false,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let diagnostic='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-4096);});
  child.on('error',error=>{stopped('The updater watcher could not start: '+error.message).catch(()=>{}).finally(()=>{process.exitCode=1;});});
  child.on('exit',code=>{stopped('The updater watcher exited before completion (code '+code+').'+(diagnostic?' '+diagnostic.trim():'')).catch(()=>{}).finally(()=>{process.exitCode=code??1;});});
})().catch(error=>{try{write('last-update.json',{attemptId,buildId,status:'failed',message:error.message,finishedAt:new Date().toISOString()});}catch{}process.exitCode=1;});
