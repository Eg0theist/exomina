// A failed startup shows a native "could not start" dialog and waits for the user,
// so the app neither exits nor loads a page. Stop at the app's own failure line
// (EXOMINA_STARTUP_DIAGNOSTICS=1) or at an early exit, instead of a blind timeout.
const failureLine=/\[exomina-startup\] failure phase=([\w.]+) errorClass=(\w+)/;
export function watchStartup(child){
 let failure=null,buffer='',fail;
 const failed=new Promise((_,reject)=>{fail=reject;});failed.catch(()=>{});
 const stop=error=>{if(failure)return;failure=error;fail(error);};
 child.stderr.on('data',chunk=>{
  buffer=(buffer+chunk.toString()).slice(-4096);const found=failureLine.exec(buffer);
  if(found)stop(Object.assign(Error(`Exomina reported a startup failure at phase ${found[1]} (${found[2]}).`),{startupPhase:found[1],errorClass:found[2]}));
  // Electron reports module/parse failures before Exomina can install its own
  // handler. Its native error dialog can keep the process alive indefinitely.
  if(/(?:^|\n)App threw an error during load(?:\r?\n|$)/.test(buffer))stop(Object.assign(Error('Electron could not load the app main process. See captured stderr for the module or syntax error.'),{startupPhase:'electron.load',errorClass:'MainProcessLoadError'}));
 });
 child.once('error',error=>stop(Object.assign(Error('Exomina could not be launched: '+error.message),{startupPhase:'process.spawn',errorClass:error.code||error.name})));
 child.once('close',(code,signal)=>stop(Object.assign(Error(`Exomina exited during startup (code ${code}${signal?', signal '+signal:''}).`),{exitCode:code,signal})));
 return {
  // Resolve with the awaited step unless startup fails first.
  race:promise=>Promise.race([promise,failed]),
  check(){if(failure)throw failure;},
  get failure(){return failure;},
 };
}
