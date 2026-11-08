import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile,writeFile,rename,rm,lstat,chmod} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {executionProof,equalProof,executionEndpoint} from './execution-protocol.mjs';
import {terminalEnvironment} from './terminal-pty.mjs';
const alive=pid=>{if(!Number.isInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};

export class ExecutionClient{
  /** prepare({keep}) may return {command,daemon,runtime}: a host started from a
   * private runtime copy does not hold Exomina's program files, so it can keep
   * terminals running while an update replaces them. Without it, or if staging
   * fails, the host runs from the program files and updates must close terminals. */
  constructor({root,command=process.execPath,daemon=fileURLToPath(new URL('./execution-daemon.mjs',import.meta.url)),validateRoot=async()=>{},prepare=null}){Object.assign(this,{root,command,daemon,validateRoot,prepare});this.pending=new Map();this.serial=0;this.socket=null;this.starting=null;this.ptys=new Set();this.identity=null;this.attached=null;this.runtimeError=null;}
  /** True only when the attached host runs outside the program files and supports update holds. */
  get survivesUpdates(){return !!(this.socket&&!this.socket.destroyed&&this.attached?.runtime&&this.identity?.features?.includes('update-hold'));}
  async holdForUpdate(ms=10*60_000){if(!this.survivesUpdates)throw Error('This execution host cannot keep terminals through an update.');return this.request('hold',{ms});}
  async releaseHold(){if(this.socket&&!this.socket.destroyed&&this.identity?.features?.includes('update-hold'))return this.request('hold',{ms:0}).catch(()=>null);return null;}
  async descriptor(){const file=path.join(this.root,'endpoint.json');try{const info=await lstat(file);if(info.isSymbolicLink()||info.size>4000)throw Error('Invalid execution descriptor file.');const value=JSON.parse(await readFile(file,'utf8'));if(value.version!==1||!/^[a-f0-9]{64}$/.test(value.token)||!/^[-a-f0-9]{36}$/.test(value.nonce)||!Number.isInteger(value.pid)||value.pid<1||value.endpoint!==executionEndpoint(this.root)||value.runtime!==undefined&&!/^[a-f0-9]{24}$/.test(value.runtime))throw Error('Invalid execution endpoint.');return value;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
  request(method,args={},timeout=8000){if(!this.socket||this.socket.destroyed)return Promise.reject(Error('The execution host is disconnected. Reopen Exomina to reattach.'));const id=++this.serial,serialized=JSON.stringify({id,method,args});if(Buffer.byteLength(serialized)>700_000)return Promise.reject(Error('Execution request is too large.'));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(Error('Execution request timed out; its effects are unknown. Inspect the session before retrying.'),{code:'EXECUTION_TIMEOUT'}));},timeout);this.pending.set(id,{resolve,reject,timer});this.socket.write(serialized+'\n');});}
  async connect(descriptor){
    const socket=net.createConnection(descriptor.endpoint);let buffer='';socket.setEncoding('utf8');this.connectingSocket=socket;
    const id=++this.serial;let handshakeTimer;const hello=new Promise((resolve,reject)=>{handshakeTimer=setTimeout(()=>{this.pending.delete(id);reject(Error('Execution handshake timed out.'));socket.destroy();},2500);this.pending.set(id,{resolve,reject,timer:handshakeTimer});});hello.catch(()=>{});
    const fail=()=>{if(this.socket!==socket&&this.connectingSocket!==socket)return;if(this.socket===socket)this.socket=null;if(this.connectingSocket===socket)this.connectingSocket=null;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('Execution host connection ended. Session state is unknown.'));}this.pending.clear();};
    socket.on('error',fail);socket.on('close',fail);
    socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>2*1024*1024){socket.destroy();return;}let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let message;try{message=JSON.parse(line);}catch{socket.destroy();return;}
      if(message.challenge){if(message.version!==1||message.nonce!==descriptor.nonce||message.pid!==descriptor.pid||!equalProof(message.proof,executionProof(descriptor.token,'server',descriptor.nonce,message.challenge,descriptor.pid))){const pending=this.pending.get(id);pending?.reject(Object.assign(Error('Execution host authentication failed.'),{code:'EXECUTION_AUTH'}));this.pending.delete(id);clearTimeout(handshakeTimer);socket.destroy();return;}const clientNonce=randomBytes(32).toString('hex');socket.write(JSON.stringify({id,method:'hello',version:1,nonce:descriptor.nonce,clientNonce,proof:executionProof(descriptor.token,'client',descriptor.nonce,message.challenge,clientNonce,descriptor.pid)})+'\n');continue;}
      const item=this.pending.get(message.id);if(item){this.pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error)):item.resolve(message.value);}
    }});
    try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.destroy();reject(Error('Execution endpoint did not respond.'));},1500);socket.once('connect',()=>{clearTimeout(timer);resolve();});socket.once('error',error=>{clearTimeout(timer);reject(error);});});const identity=await hello;if(identity.version!==1||identity.nonce!==descriptor.nonce||identity.pid!==descriptor.pid)throw Error('Execution host identity changed.');this.socket=socket;this.connectingSocket=null;this.identity=identity;this.attached=descriptor;return this;}catch(error){socket.destroy();throw error;}
  }
  async init({existingOnly=false}={}){if(this.socket&&!this.socket.destroyed)return this;if(this.starting){const value=await this.starting;if(value||existingOnly)return value;return this.init();}this.starting=this.start(existingOnly);try{return await this.starting;}finally{this.starting=null;}}
  async start(existingOnly){
    await mkdir(this.root,{recursive:true,mode:0o700});await this.validateRoot(this.root);const previous=await this.descriptor();if(previous){try{return await this.connect(previous);}catch(error){this.socket?.destroy();this.socket=null;if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw Error('The existing execution endpoint could not be authenticated. It was kept. '+error.message);}}
    if(existingOnly)return null;
    const lock=path.join(this.root,'startup.lock'),nonce=randomUUID();
    try{await writeFile(lock,JSON.stringify({pid:process.pid,nonce}),{encoding:'utf8',flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;const info=await lstat(lock);let held={};try{held=JSON.parse(await readFile(lock,'utf8'));}catch{}if(Date.now()-info.mtimeMs<30_000&&(alive(held.pid)||!held.pid))throw Error('Another Exomina is starting the execution host. Wait briefly before opening another terminal.');await rename(lock,lock+'.stale-'+nonce);await writeFile(lock,JSON.stringify({pid:process.pid,nonce}),{encoding:'utf8',flag:'wx',mode:0o600});}
    try{
      const again=await this.descriptor();if(again&&again.nonce!==previous?.nonce){try{return await this.connect(again);}catch{throw Error('Execution host startup raced another attachment. No second host was started.');}}
      const token=randomBytes(32).toString('hex'),endpoint=executionEndpoint(this.root);
      if(process.platform!=='win32'){const directory=path.dirname(endpoint);await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==process.getuid())throw Error('Execution socket directory is not privately owned.');await chmod(directory,0o700);if(previous)try{const stale=await lstat(endpoint);if(!stale.isSocket())throw Error('Unexpected execution socket file.');await rm(endpoint);}catch(error){if(error.code!=='ENOENT')throw error;}}
      let launch={command:this.command,daemon:this.daemon,runtime:undefined};
      if(this.prepare)try{launch=await this.prepare({keep:previous?.runtime?[previous.runtime]:[]});this.runtimeError=null;}catch(error){this.runtimeError=String(error.message||error).slice(0,500);launch={command:this.command,daemon:this.daemon,runtime:undefined};}
      const child=spawn(launch.command,[launch.daemon],{windowsHide:true,detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{...terminalEnvironment(),ELECTRON_RUN_AS_NODE:'1'}});
      const pid=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Execution host startup timed out.'));},10_000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(Error('Execution host ended before readiness: '+code));});child.once('message',message=>{clearTimeout(timer);message.ready?resolve(message.pid):reject(Error(message.error||'Execution host startup failed.'));});child.send({root:this.root,endpoint,token,nonce});});if(child.connected)child.disconnect();child.unref();
      const descriptor={version:1,endpoint,token,nonce,pid,...(launch.runtime?{runtime:launch.runtime}:{})};const temporary=path.join(this.root,'endpoint.tmp');await writeFile(temporary,JSON.stringify(descriptor),{encoding:'utf8',mode:0o600});await rename(temporary,path.join(this.root,'endpoint.json'));return await this.connect(descriptor);
    }finally{try{const held=JSON.parse(await readFile(lock,'utf8'));if(held.nonce===nonce)await rm(lock);}catch{}}
  }
  get native(){return {spawn:async(_shell,_args,options)=>{await this.init();const binding=options.exomina;try{const value=await this.request('spawn',{binding},30_000);return this.proxy(value);}catch(error){if(error.code==='EXECUTION_TIMEOUT')this.request('close',{id:binding.id,conversationId:binding.conversationId,owner:binding.owner},30_000).catch(()=>{});throw error;}}};}
  proxy(value){const client=this,binding={id:value.id,conversationId:value.conversationId,owner:value.owner};let cursor=value.baseCursor||0,dataCallback,exitCallback,disposed=false,polling=false,ended=false;
    const proxy={pid:value.pid,remote:true,storageWarning:value.storageWarning||null,write:text=>client.request('input',{...binding,text}),resize:(cols,rows)=>client.request('resize',{...binding,cols,rows}),setKeepAlive:enabled=>client.request('keep',{...binding,enabled}),kill:()=>client.request('close',binding),onData(callback){dataCallback=callback;return {dispose:()=>{dataCallback=null;}};},onExit(callback){exitCallback=callback;return {dispose:()=>{exitCallback=null;}};},dispose(){disposed=true;clearInterval(timer);client.ptys.delete(proxy);}};
    const poll=async()=>{if(disposed||polling||!dataCallback)return;polling=true;let result;try{result=await client.request('read',{...binding,cursor});}catch(error){if(error.code==='EXECUTION_TIMEOUT'&&client.socket&&!client.socket.destroyed)return;if(!disposed&&!ended){ended=true;exitCallback?.({exitCode:null,signal:'host-disconnected',error:error.message});proxy.dispose();}return;}finally{polling=false;}if(disposed)return;if(proxy.storageWarning!==result.storageWarning){proxy.storageWarning=result.storageWarning||null;dataCallback?.('');}if(result.cursor>cursor&&cursor>0)dataCallback?.('\r\n[Earlier output is no longer retained]\r\n');cursor=result.nextCursor;if(result.text)dataCallback?.(result.text);if(!result.hasMore&&!result.live&&!ended){ended=true;exitCallback?.({exitCode:result.exitCode??null,signal:result.signal||null});proxy.dispose();}};
    const timer=setInterval(()=>poll().catch(()=>{}),80);timer.unref?.();this.ptys.add(proxy);return proxy;
  }
  async existing(){
    if(await this.init({existingOnly:true})){
      // Ended sessions carry their saved output so a reopened panel is not blank.
      const records=await this.request('list');
      for(const record of records)if(!['running','stopping'].includes(record.status))record.text=await this.transcript(record).catch(()=>'');
      return records;
    }
    const file=path.join(this.root,'session-index.json');
    try{const info=await lstat(file);if(info.isSymbolicLink()||info.size>512*1024)throw Error('Invalid execution history file.');const saved=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(saved))throw Error('Invalid execution history.');
      const records=saved.slice(-24).filter(item=>item&&/^pty:[-a-f0-9]{36}$/.test(item.id)&&typeof item.conversationId==='string'&&['user','agent'].includes(item.owner)&&typeof item.workspace==='string').map(item=>{
        const value=Object.fromEntries(['id','conversationId','owner','workspace','startDirectory','title','cols','rows','createdAt','baseCursor','nextCursor','pid','status','keepAlive','exitCode','endedAt','cwd'].filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
        if(['running','stopping','error'].includes(value.status)){value.status='unavailable';value.error='The previous execution host ended, for example after a crash or restart. Its process state cannot be confirmed. Output saved before it ended is shown.';}return value;
      });
      for(const record of records){const saved=await this.savedTranscript(record.id);if(!saved)continue;record.text=saved.text;record.nextCursor=Math.max(record.nextCursor||0,saved.nextCursor||0);if(typeof saved.cwd==='string')record.cwd=saved.cwd;}
      return records;
    }catch(error){if(error.code==='ENOENT')return [];throw error;}
  }
  async transcript(record){let cursor=record.baseCursor||0,text='';for(let page=0;page<12;page++){const value=await this.request('read',{id:record.id,conversationId:record.conversationId,owner:record.owner,cursor});text+=value.text;cursor=value.nextCursor;if(!value.hasMore)break;}return text;}
  async savedTranscript(id){
    const name=/^pty:([-a-f0-9]{36})$/.exec(id)?.[1];if(!name)return null;const file=path.join(this.root,'transcripts',name+'.json');
    try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>2*1024*1024)return null;const value=JSON.parse(await readFile(file,'utf8'));return value?.version===1&&typeof value.text==='string'?{text:value.text.slice(-512*1024),nextCursor:Number.isInteger(value.nextCursor)?value.nextCursor:0,cwd:typeof value.cwd==='string'?value.cwd:null}:null;}catch{return null;}
  }
  async shutdown(){if(!await this.init({existingOnly:true}))return;const descriptor=await this.descriptor();await this.request('shutdown');this.close();const deadline=Date.now()+5000;while(alive(descriptor.pid)){if(Date.now()>deadline)throw Error('The execution host is still releasing its program files. Wait before updating.');await new Promise(resolve=>setTimeout(resolve,50));}}
  /** Clean quit explicitly releases ordinary sessions. A killed desktop sends no
   * intent, so the host holds its shells briefly for a new authenticated owner. */
  async detach({clean=true}={}){try{if(this.socket&&!this.socket.destroyed&&this.identity?.features?.includes('disconnect-grace'))await this.request('detach',{clean},2000);}finally{this.close();}}
  close(){for(const pty of this.ptys)pty.dispose();for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('Execution host connection ended. Reattach before retrying.'));}this.pending.clear();this.socket?.destroy();this.connectingSocket?.destroy();this.socket=null;this.connectingSocket=null;}
}
