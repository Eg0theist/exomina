// Remains unelevated. Windows decides whether the parent's process job permits
// an independent lifetime. Keep a second watcher if PowerShell exits early.
const {spawn}=require('node:child_process');
const {readFileSync,writeFileSync,renameSync,unlinkSync}=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const [powershell,...args]=process.argv.slice(2);
const argument=name=>args[args.indexOf(name)+1];
const state=argument('-State'),attemptId=argument('-AttemptId'),buildId=argument('-BuildId');
const bootstrapPid=Number(process.env.EXOMINA_UPDATER_BOOTSTRAP_PID)||process.pid;
process.env.EXOMINA_UPDATER_BOOTSTRAP_PID=String(bootstrapPid);
function read(name){try{return JSON.parse(readFileSync(path.join(state,name),'utf8'));}catch{return null;}}
function write(name,value){const file=path.join(state,name);writeFileSync(file+'.supervisor.tmp',JSON.stringify(value));renameSync(file+'.supervisor.tmp',file);}
function alive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
async function stopped(message){
  const progress=read('install-progress.json'),watcher=read('update-watcher.json');
  const matching=value=>value?.attemptId===attemptId&&value?.buildId===buildId;
  const installerPid=[progress,watcher].find(value=>matching(value)&&alive(value.installerPid))?.installerPid||0;
  while(alive(installerPid))await new Promise(resolve=>setTimeout(resolve,1000));
  const previous=read('last-update.json');
  if(previous?.attemptId===attemptId&&matching(watcher)&&watcher.phase===previous.status&&['installed','failed','declined'].includes(previous.status))return;
  const report=read('install-report.json');
  let stamp;try{stamp=JSON.parse(readFileSync(path.join(argument('-InstallHome'),'App','exomina.build.json'),'utf8'));}catch{}
  const ok=matching(report)&&report.ok===true&&stamp?.id===buildId;
  const status=ok?'installed':'failed',finishedAt=new Date().toISOString();
  write('last-update.json',{attemptId,buildId,status,message:ok?'':matching(report)&&report.error?report.error:message,finishedAt});
  write('update-watcher.json',{attemptId,buildId,pid:process.pid,installerPid:0,phase:status,updatedAt:finishedAt});
  if(matching(read('pending-update.json')))try{unlinkSync(path.join(state,'pending-update.json'));}catch{}
  // The installer activates App, even when this attempt started from a recovery
  // directory. Only an unsuccessful install should reopen the previous copy.
  const exe=ok?path.join(argument('-InstallHome'),'App','Exomina.exe'):argument('-Exe');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.EXOMINA_UPDATER_BOOTSTRAP_PID;delete env.EXOMINA_WINDOWS_INDEPENDENT;
  const reopen={attemptId,buildId,requested:exe,opened:null,status:'failed',error:'',fallbackError:''};
  async function open(target){
    // Never hide the reopened program: Windows applies a hidden start state to the first window it shows, so the app would stay in the tray.
    const child=spawn(target,[],{detached:true,windowsHide:false,stdio:'ignore',cwd:path.dirname(target),env});
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
