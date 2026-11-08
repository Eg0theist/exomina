import net from 'node:net';
import path from 'node:path';
import {readFile,writeFile,mkdir,rename,rm,lstat,chmod} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {executionProof,equalProof} from './execution-protocol.mjs';
import {terminalEnvironment,terminalShellArguments,systemPsReadLine,stopPtyTree,terminalCwd} from './terminal-pty.mjs';
const LIMIT=512*1024;
// Additive capabilities. A newer desktop checks these before relying on them.
export const EXECUTION_HOST_FEATURES=['update-hold','transcripts','cwd','disconnect-grace'];
const HOLD_MAX_MS=30*60_000;
const CRASH_GRACE_MS=10*60_000;
const safeSession=session=>Object.fromEntries(Object.entries(session).filter(([key])=>!['pty','buffer','dirty','updateHold','crashHold'].includes(key)));
const transcriptName=id=>/^pty:([-a-f0-9]{36})$/.exec(id)?.[1];

/** Local authenticated PTY backend. The desktop alone approves input. Socket
 * credentials are profile-private and never exposed to a page or remote client.
 * Recent output and the last reported folder are saved in the profile so a
 * crash or power loss still leaves a readable transcript. */
export async function startExecutionHost({root,endpoint,token,nonce,load=()=>import('@lydell/node-pty'),killTree=stopPtyTree,idleMs=30_000,transcriptMs=2000,crashGraceMs=CRASH_GRACE_MS}){
  if(!Number.isFinite(crashGraceMs)||crashGraceMs<=0||crashGraceMs>CRASH_GRACE_MS)throw Error('Invalid execution disconnect grace period.');
  const sessions=new Map(),terminations=new Map();let owner=null,closed=false,persistQueue=Promise.resolve(),persistError=null,idleTimer,holdTimer,crashTimer;
  const index=path.join(root,'session-index.json'),transcripts=path.join(root,'transcripts');await mkdir(root,{recursive:true});await mkdir(transcripts,{recursive:true,mode:0o700});
  const transcriptFile=id=>{const name=transcriptName(id);return name?path.join(transcripts,name+'.json'):null;};
  async function readTranscript(id){const file=transcriptFile(id);if(!file)return null;try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>4*LIMIT)return null;const value=JSON.parse(await readFile(file,'utf8'));return value?.version===1&&typeof value.text==='string'?value:null;}catch{return null;}}
  try{for(const record of JSON.parse(await readFile(index,'utf8')).slice(-24)){const lost=['running','stopping','error'].includes(record.status),saved=await readTranscript(record.id),text=saved?.text.slice(-LIMIT)||'',next=Math.max(record.nextCursor||0,saved?.nextCursor||0);sessions.set(record.id,{...record,pty:null,buffer:text,nextCursor:next,baseCursor:next-text.length,cwd:saved?.cwd||record.cwd||null,status:lost?'unavailable':record.status,error:lost?'The previous execution host ended, for example after a crash or restart. Its process state cannot be confirmed. Output saved before it ended is shown.':record.error});}}catch(error){if(error.code!=='ENOENT'){persistError='Previous execution metadata could not be read.';await rename(index,index+'.corrupt-'+Date.now()).catch(()=>{});}}
  function persist(){const value=[...sessions.values()].map(safeSession);persistQueue=persistQueue.then(async()=>{const temporary=index+'.tmp';await writeFile(temporary,JSON.stringify(value),{encoding:'utf8',mode:0o600});for(let attempt=0;;attempt++)try{await rename(temporary,index);break;}catch(error){if(attempt>=2||!['EBUSY','EPERM','EACCES'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,30));}persistError=null;}).catch(error=>{persistError=String(error.message).slice(0,500);});}
  function saveTranscripts(){
    const dirty=[...sessions.values()].filter(session=>session.dirty);if(!dirty.length)return persistQueue;
    for(const session of dirty)session.dirty=false;
    const values=dirty.map(session=>({file:transcriptFile(session.id),value:JSON.stringify({version:1,baseCursor:session.baseCursor,nextCursor:session.nextCursor,cwd:session.cwd||null,text:session.buffer})})).filter(item=>item.file);
    persistQueue=persistQueue.then(async()=>{for(const {file,value} of values){const temporary=file+'.tmp';await writeFile(temporary,value,{encoding:'utf8',mode:0o600});for(let attempt=0;;attempt++)try{await rename(temporary,file);break;}catch(error){if(attempt>=2||!['EBUSY','EPERM','EACCES'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,30));}}}).catch(error=>{persistError=String(error.message).slice(0,500);});
    return persistQueue;
  }
  const transcriptTimer=setInterval(saveTranscripts,transcriptMs);transcriptTimer.unref?.();
  function forget(session){sessions.delete(session.id);const file=transcriptFile(session.id);if(file)persistQueue=persistQueue.then(()=>rm(file,{force:true})).catch(()=>{});}
  const survives=session=>session.keepAlive||session.updateHold||session.crashHold;
  function releaseHold(){clearTimeout(holdTimer);holdTimer=null;for(const session of sessions.values())session.updateHold=false;}
  function releaseCrashHold(){clearTimeout(crashTimer);crashTimer=null;for(const session of sessions.values())session.crashHold=false;}
  function disconnected(clean){
    if(!clean&&!closed){
      // An update already has an explicit deadline. Unexpected disconnection
      // must not extend it, nor turn a transient hold into persistent keep-alive.
      const live=[...sessions.values()].filter(session=>session.pty&&!session.keepAlive&&!session.updateHold);
      if(live.length){for(const session of live)session.crashHold=true;
        crashTimer=setTimeout(()=>{crashTimer=null;for(const session of sessions.values()){session.crashHold=false;if(!owner&&session.pty&&!survives(session))stop(session).catch(()=>{});}},crashGraceMs);crashTimer.unref?.();}
    }
    for(const session of sessions.values())if(session.pty&&!survives(session))stop(session).catch(()=>{});
    saveTranscripts();scheduleIdle();
  }
  const server=net.createServer(socket=>{
    socket.setEncoding('utf8');let buffer='',authenticated=false,chain=Promise.resolve();const challenge=randomBytes(32).toString('hex'),timeout=setTimeout(()=>{if(!authenticated)socket.destroy();},2500);timeout.unref();
    const send=value=>{if(socket.destroyed)return;if(socket.writableLength>2*1024*1024){socket.destroy();return;}socket.write(JSON.stringify(value)+'\n');};
    send({challenge,version:1,nonce,pid:process.pid,proof:executionProof(token,'server',nonce,challenge,process.pid)});
    socket.on('error',()=>{});
    socket.on('close',()=>{clearTimeout(timeout);if(owner===socket){owner=null;disconnected(socket.cleanDetach===true);}});
    socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>(authenticated?1_000_000:8000)){socket.destroy();return;}let boundary;while((boundary=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,boundary);buffer=buffer.slice(boundary+1);chain=chain.then(async()=>{
      let message;try{message=JSON.parse(line);if(!authenticated){if(closed||message.method!=='hello'||message.version!==1||message.nonce!==nonce||!/^[a-f0-9]{64}$/.test(message.clientNonce||'')||!equalProof(message.proof,executionProof(token,'client',nonce,challenge,message.clientNonce,process.pid)))throw Error('Execution host authentication failed.');authenticated=true;clearTimeout(timeout);const previous=owner;owner=socket;previous?.destroy();clearTimeout(idleTimer);
          // A desktop reattached, so an update restart (or its rollback) finished. The
          // hold ends; each session keeps only its own keep-alive choice from here.
          const held=[...sessions.values()].filter(session=>session.updateHold).map(session=>session.id),recovered=[...sessions.values()].filter(session=>session.crashHold).map(session=>session.id);releaseHold();releaseCrashHold();
          send({id:message.id,value:{version:1,nonce,pid:process.pid,features:EXECUTION_HOST_FEATURES,released:held,recovered}});return;}
        if(closed||owner!==socket)throw Error('This execution attachment was replaced.');const value=await dispatch(message.method,message.args||{},socket);send({id:message.id,value});
      }catch(error){send({id:message?.id,error:String(error.message).slice(0,2000)});if(!authenticated)socket.destroy();}
    }).catch(()=>socket.destroy());}});
  });
  function scheduleIdle(){clearTimeout(idleTimer);if(!owner&&![...sessions.values()].some(session=>session.pty)){idleTimer=setTimeout(()=>close().catch(()=>{}),idleMs);idleTimer.unref?.();}}
  async function stop(session){if(!session.pty)return;if(terminations.has(session.id))return terminations.get(session.id);session.status='stopping';const work=Promise.resolve().then(()=>killTree(session.pty)).catch(error=>{session.stopError=error.message;session.status='running';throw error;}).finally(()=>{terminations.delete(session.id);persist();});terminations.set(session.id,work);return work;}
  const owned=args=>{const session=sessions.get(args.id);if(!session||args.conversationId!==session.conversationId||args.owner!==session.owner)throw Error('The execution session is not owned by this chat.');return session;};
  async function dispatch(method,args,caller){
    if(method==='list')return [...sessions.values()].map(session=>({...safeSession(session),storageWarning:persistError}));
    if(method==='detach'){caller.cleanDetach=args.clean===true;return {clean:caller.cleanDetach};}
    if(method==='shutdown'){if([...sessions.values()].some(session=>session.pty))throw Error('Close all background terminals before updating Exomina.');setTimeout(()=>close().catch(()=>{}),20);return {shuttingDown:true};}
    if(method==='hold'){
      // Keeps every running session alive through one desktop restart. If no
      // desktop reattaches in time, sessions that were not kept by choice stop.
      const ms=Number(args.ms);releaseHold();if(!Number.isFinite(ms)||ms<=0)return {held:0};
      const live=[...sessions.values()].filter(session=>session.pty);for(const session of live)session.updateHold=true;
      holdTimer=setTimeout(()=>{holdTimer=null;const expired=[...sessions.values()].filter(session=>session.updateHold);for(const session of expired){session.updateHold=false;if(!owner&&session.pty&&!survives(session))stop(session).catch(()=>{});}},Math.min(ms,HOLD_MAX_MS));holdTimer.unref?.();
      await saveTranscripts();return {held:live.length,ms:Math.min(ms,HOLD_MAX_MS)};
    }
    if(method==='spawn'){
      const binding=args.binding;if(!binding||typeof binding.conversationId!=='string'||!binding.conversationId||!['user','agent'].includes(binding.owner)||!/^pty:[-a-f0-9]{36}$/.test(binding.id)||sessions.has(binding.id))throw Error('Invalid execution binding.');
      if([...sessions.values()].filter(item=>item.pty).length>=6)throw Error('Six interactive sessions are already running.');
      if(typeof binding.workspace!=='string'||typeof binding.startDirectory!=='string'||!Number.isInteger(binding.cols)||binding.cols<20||binding.cols>400||!Number.isInteger(binding.rows)||binding.rows<5||binding.rows>150)throw Error('Invalid execution dimensions or workspace.');
      const module=await load(),native=module.default||module;const systemModule=await systemPsReadLine();
      if(closed||owner!==caller||caller.destroyed)throw Error('The desktop detached while this terminal was starting.');
      if(sessions.has(binding.id)||[...sessions.values()].filter(item=>item.pty).length>=6)throw Error('The execution session limit changed while starting.');
      const shell=process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'/bin/sh';
      const shellArgs=process.platform==='win32'?terminalShellArguments({systemModule,historyPath:path.join(root,'unused-history')}):['-i'];
      const session={...binding,status:'running',keepAlive:false,baseCursor:0,nextCursor:0,buffer:'',cwd:binding.startDirectory,pty:null};
      const pty=native.spawn(shell,shellArgs,{name:'xterm-256color',cwd:binding.startDirectory,env:terminalEnvironment(),cols:binding.cols,rows:binding.rows,useConpty:true,conptyInheritCursor:false});session.pty=pty;session.pid=pty.pid;sessions.set(session.id,session);
      pty.onData(value=>{const text=String(value);session.buffer+=text;session.nextCursor+=text.length;if(session.buffer.length>LIMIT){const excess=session.buffer.length-LIMIT;session.buffer=session.buffer.slice(excess);session.baseCursor+=excess;}const cwd=terminalCwd(session.buffer.slice(-(text.length+1100)));if(cwd)session.cwd=cwd;session.dirty=true;});
      pty.onExit(({exitCode,signal})=>{session.pty=null;session.updateHold=false;session.exitCode=exitCode;session.signal=signal||null;session.status=session.status==='stopping'?'stopped':'exited';session.endedAt=new Date().toISOString();session.dirty=true;saveTranscripts();persist();scheduleIdle();});
      while(sessions.size>24){const old=[...sessions.values()].find(item=>!item.pty);if(!old)break;forget(old);}persist();return safeSession(session);
    }
    const session=owned(args);
    if(method==='read'){const cursor=Math.min(session.nextCursor,Math.max(session.baseCursor,Number.isInteger(args.cursor)?args.cursor:session.baseCursor)),text=session.buffer.slice(cursor-session.baseCursor,cursor-session.baseCursor+64000);return {...safeSession(session),storageWarning:persistError,live:!!session.pty,text,cursor,nextCursor:cursor+text.length,hasMore:cursor+text.length<session.nextCursor};}
    if(method==='close'){await stop(session);return {stopping:!!session.pty};}
    if(!session.pty||session.status!=='running')throw Error('This execution session is not running.');
    if(method==='input'){if(typeof args.text!=='string'||args.text.length>65536)throw Error('Input is too large.');session.pty.write(args.text);return {written:args.text.length};}
    if(method==='resize'){if(!Number.isInteger(args.cols)||args.cols<20||args.cols>400||!Number.isInteger(args.rows)||args.rows<5||args.rows>150)throw Error('Invalid terminal dimensions.');session.pty.resize(args.cols,args.rows);session.cols=args.cols;session.rows=args.rows;return {};}
    if(method==='keep'){session.keepAlive=args.enabled===true;persist();return {keepAlive:session.keepAlive};}
    throw Error('Unsupported execution host operation.');
  }
  server.maxConnections=8;
  if(process.platform!=='win32'){const directory=path.dirname(endpoint);await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(info.isSymbolicLink()||info.uid!==process.getuid())throw Error('Execution socket directory is not privately owned.');await chmod(directory,0o700);}
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});
  async function close(){if(closed)return;closed=true;clearTimeout(idleTimer);clearTimeout(holdTimer);clearTimeout(crashTimer);clearInterval(transcriptTimer);owner?.destroy();await Promise.allSettled([...sessions.values()].map(stop));await new Promise(resolve=>server.close(resolve));await saveTranscripts();await persistQueue;try{const file=path.join(root,'endpoint.json'),saved=JSON.parse(await readFile(file,'utf8'));if(saved.nonce===nonce)await rm(file);}catch{}if(process.platform!=='win32')await rm(endpoint,{force:true}).catch(()=>{});}
  scheduleIdle();return {server,sessions,close};
}
