import {readFile,writeFile,readdir,realpath,stat,lstat,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {normalizedPath,pathsEqual,pathWithin} from './path-policy.mjs';

const within=pathWithin;
const sameDirectory=pathsEqual;
const textResult=value=>({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]});
const definitions=[
  {name:'workspace_list',description:'List files in a directory inside the chosen workspace. Requires approval.',inputSchema:{type:'object',properties:{path:{type:'string',description:'Relative directory, defaults to .'}},additionalProperties:false}},
  {name:'workspace_read',description:'Read a UTF-8 text file inside the chosen workspace with pagination. Requires approval.',inputSchema:{type:'object',properties:{path:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:64000}},required:['path'],additionalProperties:false}},
  {name:'workspace_write',description:'Write a UTF-8 file inside the chosen workspace after approval. An existing file is backed up first.',inputSchema:{type:'object',properties:{path:{type:'string'},text:{type:'string'}},required:['path','text'],additionalProperties:false}},
  {name:'workspace_shell',description:'Run a terminal command from the workspace after approval. It runs with your account permissions, not an OS sandbox.',inputSchema:{type:'object',properties:{command:{type:'string'},timeoutSeconds:{type:'integer',minimum:1,maximum:120}},required:['command'],additionalProperties:false}}
];
export function workspaceShell(platform,command,{systemRoot=process.env.SystemRoot||'C:\\Windows'}={}){
  if(platform==='win32')return {executable:path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo','-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; '+command],label:'PowerShell'};
  if(['darwin','linux'].includes(platform))return {executable:'/bin/sh',args:['-c',command],label:'POSIX shell'};
  throw Error('Workspace terminal commands are not available on this operating system.');
}
export class WorkspaceTools {
  constructor({dataDir,privateDirs=[],getSettings,approve,platform=process.platform,spawnImpl=spawn,killImpl=process.kill.bind(process)}){Object.assign(this,{dataDir,privateDirs,getSettings,approve,platform,spawnImpl,killImpl});this.processes=new Map();}
  get definitions(){return definitions;}
  async excludePrivate(actual){
    const resolved=normalizedPath(actual);
    const core=normalizedPath(await realpath(this.dataDir));
    if(within(core,resolved)&&!within(path.join(core,'workspace'),resolved))throw Error('Exomina account stores and app data are outside the file tools.');
    for(const directory of this.privateDirs){
      if(sameDirectory(directory,this.dataDir))continue;
      let privateRoot;try{privateRoot=normalizedPath(await realpath(directory));}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(within(privateRoot,resolved))throw Error('Exomina account stores and app data are outside the file tools.');
    }
  }
  async target(value,writing=false){
    if(typeof value!=='string'||value.length>4000||value.includes('\0'))throw Error('Provide a relative workspace path.');
    const root=await realpath(this.getSettings().workspace);const file=path.resolve(root,value);
    if(!within(root,file))throw Error('The path is outside the chosen workspace.');
    if(this.platform==='win32'&&file.includes(':',3))throw Error('Alternate data streams are not supported.');
    const protectedRoot=path.resolve(this.dataDir);const defaultWorkspace=path.join(protectedRoot,'workspace');
    if(within(protectedRoot,file)&&!within(defaultWorkspace,file))throw Error('Exomina account stores and app data are outside the file tools.');
    if(this.privateDirs.some(dir=>!sameDirectory(dir,this.dataDir)&&within(path.resolve(dir),file)))throw Error('Exomina account stores and app data are outside the file tools.');
    let ancestor=writing?path.dirname(file):file;
    while(true){try{const actual=await realpath(ancestor);if(!within(root,actual))throw Error('This path follows a link outside the workspace.');await this.excludePrivate(actual);break;}catch(error){if(error.code!=='ENOENT'||!writing)throw error;const entry=await lstat(ancestor).catch(failure=>{if(failure.code!=='ENOENT')throw failure;});if(entry?.isSymbolicLink())throw Error('This path follows a link that cannot be resolved safely.');const parent=path.dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;}}
    // Existing destinations must also resolve within the workspace.
    if(writing){try{const actual=await realpath(file);if(!within(root,actual))throw Error('This file links outside the workspace.');await this.excludePrivate(actual);}catch(error){if(error.code!=='ENOENT')throw error;}}
    return file;
  }
  async call(name,args={},conversationId){
    if(!definitions.some(item=>item.name===name))throw Error('Unknown workspace tool.');
    if(name==='workspace_shell')return this.shell(args,conversationId);
    const writing=name==='workspace_write';const file=await this.target(args.path||(name==='workspace_list'?'.':''),writing);
    let content;
    if(writing){if(typeof args.text!=='string'||Buffer.byteLength(args.text,'utf8')>1024*1024)throw Error('Write at most 1 MiB of UTF-8 text per call.');content=args.text;}
    const detail=writing?`${file}\n\nWrite ${Buffer.byteLength(content,'utf8')} bytes. Existing contents will be backed up.\n\n${content}`:file;
    if(!await this.approve({title:writing?'Allow file write?':name==='workspace_read'?'Allow file read?':'Allow folder listing?',detail,conversationId}))throw Error('You declined this workspace action.');
    // Revalidate after the permission dialog to avoid following a changed link.
    await this.target(args.path||(name==='workspace_list'?'.':''),writing);
    if(name==='workspace_list')return textResult((await readdir(file,{withFileTypes:true})).slice(0,500).map(entry=>({name:entry.name,kind:entry.isDirectory()?'directory':entry.isSymbolicLink()?'link':'file'})));
    if(name==='workspace_read'){
      if((await stat(file)).size>8*1024*1024)throw Error('This text file exceeds the 8 MiB reading limit.');
      const data=await readFile(file,'utf8');if(data.includes('\0'))throw Error('This looks like a binary file.');
      const offset=Math.max(0,Math.floor(Number(args.offset)||0));const limit=Math.min(64000,Math.max(1,Math.floor(Number(args.limit)||16000)));
      return textResult({path:args.path,text:data.slice(offset,offset+limit),totalCharacters:data.length,nextOffset:offset+limit<data.length?offset+limit:null});
    }
    let backup;
    try{const current=await stat(file);if(!current.isFile())throw Error('The destination is not a regular file.');if(current.size>32*1024*1024)throw Error('The existing file is too large to back up automatically.');const backups=path.join(this.dataDir,'file-backups');await mkdir(backups,{recursive:true});backup=path.join(backups,randomUUID()+'.bak');await copyFile(file,backup);}catch(error){if(error.code!=='ENOENT')throw error;}
    await mkdir(path.dirname(file),{recursive:true});await this.target(args.path,true);await writeFile(file,content,'utf8');return textResult({written:args.path,bytes:Buffer.byteLength(content,'utf8'),backup:backup||null});
  }
  async shell(args,conversationId,{processKey=conversationId,signal,onEvent,expectedWorkspace}={}){
    const checkCancelled=()=>{if(signal?.aborted)throw Object.assign(Error('This terminal command was stopped.'),{code:'TERMINAL_CANCELLED'});};
    const observe=event=>{try{onEvent?.(event);}catch{}};
    checkCancelled();
    if(typeof args.command!=='string'||!args.command.trim()||args.command.length>16000)throw Error('Provide a command of up to 16,000 characters.');
    const cwd=await realpath(this.getSettings().workspace);
    if(expectedWorkspace&&!sameDirectory(cwd,expectedWorkspace))throw Error('The workspace changed after this terminal command was submitted. Retry in the selected folder.');
    await this.excludePrivate(cwd);
    const shell=workspaceShell(this.platform,args.command);
    const approval=this.approve({title:'Allow terminal command?',detail:`Runs in ${shell.label} with your account permissions and can access beyond this folder.\n\nWorking folder: ${cwd}\n\n${args.command}`,conversationId,action:{kind:'execute',tool:'workspace_shell',target:args.command},input:{command:args.command,cwd},...(signal?{signal}:{})});
    let abortApproval;
    const approved=await(signal?Promise.race([approval,new Promise((_resolve,reject)=>{abortApproval=()=>reject(Object.assign(Error('This terminal command was stopped.'),{code:'TERMINAL_CANCELLED'}));signal.addEventListener('abort',abortApproval,{once:true});if(signal.aborted)abortApproval();})]).finally(()=>signal.removeEventListener('abort',abortApproval)):approval);
    checkCancelled();
    if(!approved)throw Object.assign(Error('This terminal command was declined or blocked by the current permissions.'),{code:'TERMINAL_DENIED'});
    // The workspace may have changed while the approval was open. Never execute
    // a command in a newly linked or private directory under the earlier grant.
    const current=await realpath(this.getSettings().workspace);if(!sameDirectory(current,cwd))throw Error('The workspace changed while this command awaited approval. Retry in the selected folder.');await this.excludePrivate(current);checkCancelled();
    const env={...process.env};for(const key of Object.keys(env))if(/(?:TOKEN|API_?KEY|AUTHORIZATION|SECRET|PASSWORD|^META_|^MUSE_|^OPENAI_|^ANTHROPIC_|^CODEX_|^CLAUDE_|^GEMINI_|^GOOGLE_|^AWS_|^AZURE_|^KIMI_|^MOONSHOT_|^GITHUB_|^GH_|^COPILOT_|^GROK_|^XAI_|^EXOMINA_|^NODE_OPTIONS$|^BUN_OPTIONS$|^NODE_EXTRA_CA_CERTS$|^NODE_TLS_REJECT_UNAUTHORIZED$|^NODE_DEBUG|^SSLKEYLOGFILE$|^PSModulePath$)/i.test(key))delete env[key];
    const child=this.spawnImpl(shell.executable,shell.args,{cwd,env,windowsHide:true,shell:false,detached:this.platform!=='win32',stdio:['ignore','pipe','pipe']});
    this.processes.set(processKey,child);let output='',truncated=false,timedOut=false,cancelled=false;
    const stop=()=>{cancelled=true;this.stop(child);};signal?.addEventListener('abort',stop,{once:true});
    if(signal?.aborted)stop();
    observe({type:'start',cwd});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    const read=chunk=>{const text=String(chunk),remaining=2*1024*1024-output.length;if(remaining>0){const accepted=text.slice(0,remaining);output+=accepted;observe({type:'output',text:accepted});}if(text.length>remaining&&!truncated){truncated=true;this.stop(child);}};
    child.stdout.on('data',read);child.stderr.on('data',read);
    const timer=setTimeout(()=>{timedOut=true;this.stop(child)},Math.min(120,Math.max(1,Number(args.timeoutSeconds)||60))*1000);
    try{return await new Promise((resolve,reject)=>{const fail=error=>{this.stop(child);reject(error);};child.on('error',fail);child.stdout.on('error',fail);child.stderr.on('error',fail);child.on('close',(exitCode,exitSignal)=>resolve(textResult({exitCode,signal:exitSignal,output,timedOut,truncated,cancelled})));});}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);if(this.processes.get(processKey)===child)this.processes.delete(processKey);}
  }
  stop(child){
    if(!child)return;
    if(this.platform==='win32'){
      if(child.exitCode!=null||child.signalCode)return;
      if(child.pid){const killer=this.spawnImpl(path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/pid',String(child.pid),'/t','/f'],{windowsHide:true,shell:false,stdio:'ignore'});killer.on('error',()=>child.kill());}
      else child.kill();
      return;
    }
    // The shell may have exited while background descendants still own its
    // pipes. Keep targeting the run's detached group until shell() closes.
    // Like Windows taskkill /f, Stop/deadline must also terminate commands that
    // ignore graceful signals; no delayed signal can hit a reused process ID.
    if(Number.isInteger(child.pid)&&child.pid>0){try{this.killImpl(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
    else child.kill('SIGKILL');
  }
  cancel(id){this.stop(this.processes.get(id));}
  close(){for(const child of this.processes.values())this.stop(child);}
}
