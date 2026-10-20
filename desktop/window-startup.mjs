const CANCELLED=Symbol('window startup cancelled');

function aborted(error){return error?.code==='ERR_ABORTED'||error?.errno===-3||/\bERR_ABORTED\b/.test(error?.message||'');}

/** A same-page reload can cancel loadURL even while its replacement succeeds. */
export async function openExominaLocation(window,url,{isShuttingDown=()=>false,shutdown,timeoutMs=10000,maxRetries=1}={}){
  const contents=window.webContents,closed=()=>isShuttingDown()||window.isDestroyed()||contents.isDestroyed();
  if(closed())return false;
  let navigation=0,target='',unexpected=false,finished=false,failure=null,wake,timeout;
  let cancel;const cancelled=new Promise(resolve=>{cancel=()=>resolve(CANCELLED);});
  const changed=()=>wake?.();
  const stopped=()=>{cancel();changed();};
  const started=(_event,next,_inPlace,main)=>{if(!main)return;navigation++;target=next;unexpected||=next!==url;finished=false;failure=null;changed();};
  const completed=()=>{finished=contents.getURL()===url;changed();};
  const failed=(_event,code,description,next,main)=>{if(!main||code===-3)return;failure=Object.assign(Error(`${description} (${code}) loading '${next}'`),{errno:code});changed();};
  contents.on('did-start-navigation',started);contents.on('did-finish-load',completed);contents.on('did-stop-loading',changed);contents.on('did-fail-load',failed);contents.on('destroyed',stopped);window.on('closed',stopped);shutdown?.on('before-quit',stopped);
  const deadline=Date.now()+timeoutMs;
  const expired=new Promise((_resolve,reject)=>{timeout=setTimeout(()=>reject(Error('The workspace page did not finish loading within '+timeoutMs+' ms.')),timeoutMs);});
  async function guarded(promise){const result=await Promise.race([promise,cancelled,expired]);if(result===CANCELLED||closed())throw CANCELLED;return result;}
  function waitForChange(ms){return new Promise(resolve=>{const timer=setTimeout(()=>{wake=null;resolve(false);},ms);wake=()=>{clearTimeout(timer);wake=null;resolve(true);};});}
  try{
    for(let attempt=0;attempt<=maxRetries;attempt++){
      const before=navigation;
      try{await guarded(window.loadURL(url));if(contents.getURL()!==url)throw Error('The workspace page opened an unexpected location.');return true;}
      catch(error){
        if(error===CANCELLED||closed())return false;
        // Only an observed replacement of this exact trusted page is recoverable.
        if(!aborted(error)||navigation<before+2||target!==url||unexpected)throw error;
        const waitUntil=Date.now()+Math.max(1,Math.floor((deadline-Date.now())/(maxRetries-attempt+1)));
        while(Date.now()<waitUntil){
          if(closed())return false;if(unexpected||target!==url)throw error;
          if(failure)throw failure;
          if(finished&&contents.getURL()===url&&!contents.isLoadingMainFrame())return true;
          await guarded(waitForChange(Math.max(1,waitUntil-Date.now())));
        }
        if(attempt===maxRetries)throw error;
      }
    }
    return false;
  }catch(error){if(error===CANCELLED||closed())return false;throw error;}
  finally{clearTimeout(timeout);wake?.();contents.removeListener('did-start-navigation',started);contents.removeListener('did-finish-load',completed);contents.removeListener('did-stop-loading',changed);contents.removeListener('did-fail-load',failed);contents.removeListener('destroyed',stopped);window.removeListener('closed',stopped);shutdown?.removeListener('before-quit',stopped);}
}
