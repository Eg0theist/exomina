import {mkdir,readFile,writeFile,rename,realpath,lstat,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';

const MAX_OUTPUT=512*1024;
const clean=value=>String(value||'').trim();
const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export const WORKER_TOOLS=[{name:'worker_run',description:'Run an approved command in a configured isolated Docker container or SSH worker. Lists show configured resources only. Each run requests explicit approval for its command, workspace access and network destination. Docker uses a digest-pinned preinstalled image, no network, a read-only root and dropped privileges. SSH runs remotely with that account permissions; it is not a sandbox. No credentials are accepted. Commands never run on the local host as a fallback.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['list','run']},id:{type:'string'},command:{type:'string',maxLength:16000},timeoutSeconds:{type:'integer',minimum:1,maximum:1800}},required:['action'],additionalProperties:false}}];

export function normalizeWorker(input){
  if(!input||typeof input!=='object')throw Error('Provide a worker configuration.');
  const id=input.id||randomUUID(),name=clean(input.name);
  if(!/^[\w-]{1,64}$/.test(id)||!name||name.length>80)throw Error('Use a worker ID and name up to 80 characters.');
  if(!['docker','ssh'].includes(input.backend))throw Error('Choose Docker or SSH.');
  if(input.backend==='docker'){
    const image=clean(input.image),folder=clean(input.folder)||'.';
    if(!/^[a-z0-9][a-z0-9._/:\-]*@sha256:[a-f0-9]{64}$/.test(image)||image.length>350)throw Error('Docker images must use an immutable image@sha256:digest reference. Pull the reviewed image separately before running.');
    if(path.isAbsolute(folder)||folder.includes('\0')||folder.split(/[\\/]/).includes('..')||folder.length>1000)throw Error('Use a relative project folder inside the selected workspace.');
    return {id,name,backend:'docker',image,folder,writable:input.writable===true,memoryMiB:Math.min(8192,Math.max(128,Math.floor(Number(input.memoryMiB)||1024))),cpus:Math.min(8,Math.max(0.25,Number(input.cpus)||1))};
  }
  const host=clean(input.host),directory=clean(input.directory),port=Number(input.port)||22;
  if(!/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)||host.length>250||!Number.isInteger(port)||port<1||port>65535)throw Error('Use an SSH destination user@host and a valid port.');
  if(!directory.startsWith('/')||directory.length>1000||/[\x00-\x1f]/.test(directory))throw Error('Use an absolute remote POSIX project directory.');
  return {id,name,backend:'ssh',host,port,directory};
}

// Never consult PATH or the job's current directory for a worker runtime.
// A project-local docker.exe/ssh.exe must not turn isolation into host execution.
export function workerExecutableCandidates(backend){
  if(process.platform==='win32'){
    const system=process.env.SystemRoot||'C:/Windows',programs=process.env.ProgramW6432||process.env.ProgramFiles||'C:/Program Files';
    return backend==='ssh'?[path.join(system,'System32','OpenSSH','ssh.exe')]:[path.join(programs,'Docker','Docker','resources','bin','docker.exe')];
  }
  return backend==='ssh'?['/usr/bin/ssh','/bin/ssh']:['/usr/bin/docker','/usr/local/bin/docker','/Applications/Docker.app/Contents/Resources/bin/docker'];
}
export function workerInvocation(worker,{command,cwd,jobName,executable}){
  if(typeof command!=='string'||!command.trim()||command.length>16000||command.includes('\0'))throw Error('Provide a command of up to 16,000 characters.');
  if(typeof executable!=='string'||!path.isAbsolute(executable))throw Error('A resolved absolute worker executable is required.');
  if(worker.backend==='docker')return {file:executable,args:['--context','default','run','--rm','--pull','never','--name',jobName,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','65534:65534','--pids-limit','128','--memory',worker.memoryMiB+'m','--cpus',String(worker.cpus),'--tmpfs','/tmp:rw,noexec,nosuid,size=256m','--mount',`type=bind,source=${cwd},target=/workspace${worker.writable?'':',readonly'}`,'--workdir','/workspace',worker.image,'sh','-lc',command]};
  return {file:executable,args:['-F',process.platform==='win32'?'NUL':'/dev/null','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','ConnectTimeout=15','-p',String(worker.port),'--',worker.host,`cd -- ${quote(worker.directory)} && ${command}`]};
}

export class Workers{
  constructor({dir,workspaceTools,approve,spawnImpl=spawn,executableCandidates=workerExecutableCandidates,emit=()=>{}}){Object.assign(this,{dir,workspaceTools,approve,spawnImpl,executableCandidates,emit});this.configs=[];this.running=new Map();this.queue=Promise.resolve();}
  async init(){await mkdir(this.dir,{recursive:true});try{const data=JSON.parse(await readFile(path.join(this.dir,'workers.json'),'utf8'));if(!Array.isArray(data)||data.length>24)throw Error('Invalid worker store.');this.configs=data.map(normalizeWorker);}catch(error){if(error.code!=='ENOENT')throw error;}}
  list(){return {workers:structuredClone(this.configs),running:[...this.running.values()].map(({id,workerId,conversationId,startedAt})=>({id,workerId,conversationId,startedAt})),notice:'Docker and SSH must already be installed and configured. No live connection is probed. SSH is remote execution under its account, not isolation from that remote account.'};}
  async save(input){
    const worker=normalizeWorker(input);
    return this.mutate(values=>{if(!values.some(w=>w.id===worker.id)&&values.length>=24)throw Error('Keep at most 24 workers.');return [...values.filter(w=>w.id!==worker.id),worker];});
  }
  async remove(id){if(this.running.size&&[...this.running.values()].some(job=>job.workerId===id))throw Error('Stop this worker job before removing its configuration.');return this.mutate(values=>values.filter(w=>w.id!==id));}
  async mutate(change){
    const task=this.queue.catch(()=>{}).then(async()=>{const next=change(this.configs),file=path.join(this.dir,'workers.json'),temporary=file+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,JSON.stringify(next,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});await rename(temporary,file);}catch(error){throw Error('Worker configuration was not saved: '+error.message);}this.configs=next;this.emit({type:'workers.changed'});return this.list();});this.queue=task;return task;
  }
  async mountRoot(worker){
    const cwd=await this.workspaceTools.target(worker.folder||'.'),metadata=await lstat(cwd);
    if(!metadata.isDirectory()||metadata.isSymbolicLink()||cwd.includes(','))throw Error('Worker mount must be a plain project directory without commas.');
    for(const privateDir of [this.workspaceTools.dataDir,...this.workspaceTools.privateDirs]){
      const privateRoot=await realpath(privateDir).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(privateRoot&&inside(cwd.toLowerCase(),privateRoot.toLowerCase()))throw Error('A worker mount cannot include Exomina private data or account stores.');
    }
    return cwd;
  }
  async executableBinding(candidate,cwd){
    if(typeof candidate!=='string'||!path.isAbsolute(candidate))throw Error('Worker executable must have an absolute installed path.');
    const file=await realpath(candidate),workspace=await realpath(this.workspaceTools.getSettings().workspace);
    const normalize=value=>process.platform==='win32'?value.toLowerCase():value;
    for(const directory of [workspace,cwd,this.workspaceTools.dataDir,...this.workspaceTools.privateDirs].filter(Boolean)){
      const root=await realpath(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(root&&inside(normalize(root),normalize(file)))throw Error('Worker executables must be installed outside the workspace and private app data.');
    }
    const entry=await lstat(file);if(!entry.isFile()||entry.isSymbolicLink()||entry.size>256*1024*1024)throw Error('The installed worker executable is unsafe or too large.');
    const handle=await open(file,'r');
    try{
      const before=await handle.stat(),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(128*1024);let size=0;
      if(!before.isFile()||before.size!==entry.size||before.ino!==entry.ino||before.dev!==entry.dev)throw Error('The worker executable changed during verification.');
      while(true){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;if(size>before.size)throw Error('The worker executable changed during verification.');hash.update(buffer.subarray(0,bytesRead));}
      const after=await handle.stat();if(size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('The worker executable changed during verification.');
      return {candidate,file,size,sha256:hash.digest('hex'),dev:before.dev,ino:before.ino,mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs};
    }finally{await handle.close();}
  }
  async resolveExecutable(backend,cwd){
    for(const candidate of this.executableCandidates(backend))try{return await this.executableBinding(candidate,cwd);}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
    throw Error(`${backend==='docker'?'Docker':'SSH'} is not installed in a supported application location. No worker process was started.`);
  }
  async recheckExecutable(binding,cwd){
    const current=await this.executableBinding(binding.candidate,cwd);
    if(JSON.stringify(current)!==JSON.stringify(binding))throw Error('The approved worker executable changed. Review the worker job again.');
  }
  admission(conversationId){
    if(this.running.size>=3)throw Error('Three worker jobs are already running.');
    if([...this.running.values()].some(job=>job.conversationId===conversationId))throw Error('This chat already has a worker job.');
  }
  async call(args,conversationId,{signal}={}){
    if(args.action==='list')return this.list();
    if(args.action!=='run')throw Error('Choose list or run.');
    if(!conversationId)throw Error('Run workers from a chat.');
    const worker=this.configs.find(item=>item.id===args.id);if(!worker)throw Error('Configure this worker in Settings before running it.');
    this.admission(conversationId);
    const expected=JSON.stringify(worker),id=randomUUID(),jobName='exomina-'+id,cwd=worker.backend==='docker'?await this.mountRoot(worker):undefined;
    const executable=await this.resolveExecutable(worker.backend,cwd),invocation=workerInvocation(worker,{command:args.command,cwd,jobName,executable:executable.file}),timeout=Math.min(1800,Math.max(1,Number(args.timeoutSeconds)||120));
    const detail=JSON.stringify({worker,command:args.command,timeoutSeconds:timeout,...(cwd?{localProject:cwd,access:worker.writable?'read/write':'read only'}:{remoteAccess:'SSH account permissions'}),network:worker.backend==='docker'?'none':worker.host,invocation},null,2);
    if(!await this.approve({title:'Run worker job?',detail,conversationId,requireConfirmation:true,action:{kind:'execute',tool:'worker_run',target:worker.id},input:{id:worker.id,command:args.command}}))throw Error('Worker job was declined.');
    if(signal?.aborted)throw Error('Worker job was stopped.');
    if(JSON.stringify(this.configs.find(w=>w.id===worker.id))!==expected)throw Error('Worker configuration changed while approval was open.');
    if(cwd&&await this.mountRoot(worker)!==cwd)throw Error('Worker project changed while approval was open.');
    await this.recheckExecutable(executable,cwd);
    if(signal?.aborted)throw Error('Worker job was stopped.');
    this.admission(conversationId); // Last await is over; reserve synchronously with spawn/map insertion.
    // Only ordinary process lookup and SSH home/system inputs are inherited.
    // Provider tokens, Docker endpoint overrides and application transports never are.
    const allowed=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','LANG','LC_ALL']);
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.has(key.toUpperCase())));
    const child=this.spawnImpl(invocation.file,invocation.args,{cwd:cwd||undefined,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const job={id,workerId:worker.id,conversationId,startedAt:new Date().toISOString(),child};this.running.set(id,job);
    let output='',truncated=false,timedOut=false,cancelled=false,stopped=false,finished=false,cleanupError='',cleanupPromise=Promise.resolve();
    const stop=()=>{
      if(stopped)return;stopped=true;try{child.kill?.();}catch(error){cleanupError=error.message;}
      if(worker.backend==='docker')cleanupPromise=this.recheckExecutable(executable,cwd).then(()=>{const cleanup=this.spawnImpl(executable.file,['--context','default','rm','-f',jobName],{env,shell:false,windowsHide:true,stdio:'ignore'});cleanup.on?.('error',error=>{cleanupError=error.message;});}).catch(error=>{cleanupError='Container cleanup could not use the approved executable: '+error.message;});
      else if(process.platform==='win32'&&child.pid)try{const cleanup=this.spawnImpl(path.join(process.env.SystemRoot||'C:/Windows','System32/taskkill.exe'),['/pid',String(child.pid),'/t','/f'],{windowsHide:true,shell:false,stdio:'ignore'});cleanup.on?.('error',error=>{cleanupError=error.message;});}catch(error){cleanupError=error.message;}
    };
    job.stop=()=>{cancelled=true;stop();};
    const read=chunk=>{const text=String(chunk),remaining=MAX_OUTPUT-output.length;output+=text.slice(0,Math.max(0,remaining));if(text.length>remaining){truncated=true;stop();}};
    const completion=new Promise((resolve,reject)=>{
      const fail=error=>{if(finished)return;stop();reject(Error('Worker process or output failed: '+error.message));};
      child.on('error',fail);child.stdout.on('error',fail);child.stderr.on('error',fail);
      child.once('close',(exitCode,exitSignal)=>resolve({id,workerId:worker.id,backend:worker.backend,exitCode,signal:exitSignal}));
    });
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',read);child.stderr.on('data',read);
    const timer=setTimeout(()=>{timedOut=true;stop();},timeout*1000),onAbort=job.stop;signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
    let result;
    try{result=await completion;}
    finally{finished=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);await cleanupPromise;this.running.delete(id);this.emit({type:'workers.changed'});}
    return {...result,output,truncated,timedOut,cancelled,...(cleanupError?{cleanupError}:{}),notice:worker.backend==='ssh'?'Stopping the SSH connection does not guarantee that a remote process stopped. Inspect the remote job before retrying.':undefined};
  }
  cancel(conversationId){for(const job of this.running.values())if(job.conversationId===conversationId)job.stop?.();}
  close(){for(const job of this.running.values())job.stop?.();}
}
