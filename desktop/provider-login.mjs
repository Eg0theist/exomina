import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {stopPtyTree} from './terminal-pty.mjs';

/** An official interactive login needs a terminal, including its paste-code prompt.
 * This terminal is private to the login operation; its output is never recorded. */
export async function spawnLogin(executable,args,{cwd,env},load=()=>import('@lydell/node-pty'),cleanup=stopPtyTree){
  const imported=await load(),native=imported.default||imported;
  const terminal=native.spawn(executable,args,{name:'xterm-256color',cols:4096,rows:32,cwd,env,useConpty:true,conptyInheritCursor:false});
  const child=new EventEmitter();
  let cleanupPromise;const dispose=()=>cleanupPromise??=Promise.resolve().then(()=>cleanup(terminal)).catch(()=>{child.cleanupFailed=true;});
  Object.assign(child,{pid:terminal.pid,exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{void dispose();}});
  child.stdin=new Writable({write(chunk,_encoding,done){try{terminal.write(chunk.toString('utf8'));done();}catch(error){done(error);}}});
  const data=terminal.onData(chunk=>child.stdout.write(chunk));
  const exit=terminal.onExit(async({exitCode,signal})=>{child.exitCode=exitCode;child.signalCode=signal||null;data.dispose();child.stdout.end();child.stderr.end();await dispose();child.emit('exit',exitCode,signal);child.emit('close',exitCode,signal);exit.dispose();});
  return child;
}
