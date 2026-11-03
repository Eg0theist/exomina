// Shared by the normal updater and its supervisor recovery path. A successful
// file copy is provisional until the independent elevated helper confirms that
// storage, services and the responsive workspace renderer opened successfully.
async function finishActivation({attemptId,buildId,control,read,write,alive,open,recover,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=240000}) {
  const matching=value=>value?.attemptId===attemptId&&value?.buildId===buildId;
  if(!control?.monitored||!Number.isInteger(control.pid)||control.pid<=0||!/^[a-f0-9]{32}$/.test(control.token||'')||!matching(control))throw Error('The installer did not establish automatic startup recovery.');
  const deadline=now()+timeoutMs;
  let verdict;
  while(true){
    const value=read('update-activation.json');
    if(matching(value)&&value.schema===1&&value.token===control.token&&['healthy','rolled-back','recovery-failed'].includes(value.status)){verdict=value;break;}
    // Never launch another copy while the elevated helper may still rename it.
    if(!alive(control.pid)||now()>=deadline)break;
    await wait(250);
  }
  // The helper may publish its result immediately before exiting.
  if(!verdict){const value=read('update-activation.json');if(matching(value)&&value.schema===1&&value.token===control.token&&['healthy','rolled-back','recovery-failed'].includes(value.status))verdict=value;}
  let status=verdict?.status==='healthy'?'installed':verdict?.status==='rolled-back'?'rolled-back':'failed';
  let message=verdict?.message||(status==='installed'?'':'The new build did not confirm startup. Automatic recovery could not be confirmed; the previous program copy has been kept.');
  if(status==='rolled-back'){
    try{await open();}
    catch{message+=' The previous program is restored at the normal shortcut, but Windows could not reopen it automatically.';}
  }
  if(status==='failed'&&verdict?.status==='recovery-failed'&&recover){
    const stopDeadline=now()+10000;while(alive(control.pid)&&now()<stopDeadline)await wait(250);
  }
  if(status==='failed'&&!alive(control.pid)&&recover){
    try{await recover();status='recovery-opened';message='The update could not finish startup. The preserved previous program was reopened; automatic retry is blocked.';}
    catch{message+=' Open Exomina Recovery from the Start menu to use the preserved previous program.';}
  }
  const result={attemptId,buildId,status,message,finishedAt:new Date(now()).toISOString()};
  write('last-update.json',result);
  write('update-watcher.json',{attemptId,buildId,phase:status,installerPid:0,updatedAt:result.finishedAt});
  return result;
}
module.exports={finishActivation};
