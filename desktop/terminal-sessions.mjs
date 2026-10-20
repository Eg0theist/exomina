import {randomUUID} from 'node:crypto';

const MAX_ENTRIES=20,MAX_OUTPUT=256*1024,MAX_ACTIVE=3;
const live=entry=>['authorizing','running','stopping'].includes(entry.status);
const clean=value=>String(value??'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
const chatId=value=>{if(value==null||value==='')return null;if(typeof value!=='string'||value.length>200)throw Error('Choose a valid chat for this terminal.');return value;};
const resultValue=result=>{if(result&&typeof result.exitCode!=='undefined')return result;const text=result?.content?.find(item=>item.type==='text')?.text;if(typeof text!=='string')throw Error('The command ended without a readable result.');return JSON.parse(text);};

/** Local, bounded, in-memory command transcripts. Uses the existing workspace
 * runner and policy, with an independent process key for each direct command.
 * It is deliberately not a PTY, persistent shell or provider terminal attach.
 */
export class TerminalSessions {
  constructor({getContext,execute,cancel,interactive,emit=()=>{},now=()=>Date.now()}){Object.assign(this,{getContext,execute,cancel,interactive,emit,now});this.entries=[];this.tasks=new Map();this.notifications=new Map();this.closed=false;}
  get busy(){return this.tasks.size>0||!!this.interactive?.busy;}
  hasRunning(conversationId){const id=chatId(conversationId);return [...this.tasks.values()].some(task=>task.entry.conversationId===id)||!!this.interactive?.hasRunning(id);}
  stamp(){return new Date(this.now()).toISOString();}
  changed(conversationId,immediate=false){
    const send=()=>{this.notifications.delete(conversationId);this.emit({type:'terminal.changed',conversationId});};
    if(immediate){clearTimeout(this.notifications.get(conversationId));send();return;}
    if(!this.notifications.has(conversationId)){const timer=setTimeout(send,80);timer.unref?.();this.notifications.set(conversationId,timer);}
  }
  async context(conversationId){const context=await this.getContext(conversationId);if(typeof context?.workspace!=='string'||!context.workspace)throw Error('Choose a workspace before running terminal commands.');return context;}
  async list(conversationId){const id=chatId(conversationId),context=await this.context(id);return {workspace:context.workspace,interactive:!!this.interactive,sessions:this.interactive?await this.interactive.list(id):[],entries:this.entries.filter(entry=>entry.conversationId===id).map(entry=>({...entry}))};}
  async start({conversationId,command,timeoutSeconds=60}={}){
    if(this.closed)throw Error('The terminal is closing.');
    const id=chatId(conversationId),context=await this.context(id);
    if(this.closed)throw Error('The terminal is closing.');
    if(typeof command!=='string'||!command.trim()||command.length>16000)throw Error('Enter a command of up to 16,000 characters.');
    if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<1||timeoutSeconds>120)throw Error('Choose a command timeout between 1 and 120 seconds.');
    if(this.tasks.size>=MAX_ACTIVE)throw Error('Up to three direct commands can run at once. Stop or finish one first.');
    const entry={id:'terminal:'+randomUUID(),conversationId:id,workspace:context.workspace,command,status:'authorizing',output:'',outputTruncated:false,createdAt:this.stamp()};
    const controller=new AbortController();this.entries.push(entry);this.tasks.set(entry.id,{controller,entry});
    while(this.entries.length>MAX_ENTRIES){const index=this.entries.findIndex(value=>!live(value));if(index<0)break;this.entries.splice(index,1);}
    this.changed(id,true);
    Promise.resolve().then(async()=>{
      if(controller.signal.aborted)throw Object.assign(Error('Command stopped before execution.'),{code:'TERMINAL_CANCELLED'});
      const result=resultValue(await this.execute({command,timeoutSeconds},{conversationId:id,workspace:context.workspace,processKey:entry.id,signal:controller.signal,onEvent:event=>{
        if(event.type==='start'){entry.status=controller.signal.aborted?'stopping':'running';entry.startedAt=this.stamp();entry.workspace=event.cwd||entry.workspace;}
        if(event.type==='output'){const text=clean(event.text),remaining=MAX_OUTPUT-entry.output.length;entry.output+=text.slice(0,Math.max(0,remaining));if(text.length>remaining)entry.outputTruncated=true;}
        this.changed(id);
      }}));
      const output=clean(result.output);entry.output=output.slice(0,MAX_OUTPUT);entry.outputTruncated||=output.length>MAX_OUTPUT||result.truncated===true;
      entry.exitCode=Number.isInteger(result.exitCode)?result.exitCode:null;entry.signal=result.signal||null;entry.timedOut=result.timedOut===true;
      entry.status=controller.signal.aborted||result.cancelled?'stopped':entry.timedOut?'timed-out':result.truncated?'output-limited':entry.exitCode===0?'complete':entry.exitCode===null?'unconfirmed':'error';
    }).catch(error=>{entry.status=controller.signal.aborted||error.code==='TERMINAL_CANCELLED'?'stopped':error.code==='TERMINAL_DENIED'?'denied':'error';entry.error=clean(error.message||error).slice(0,4000);}).finally(()=>{entry.endedAt=this.stamp();this.tasks.delete(entry.id);this.changed(id,true);});
    return {...entry};
  }
  async stop({conversationId,id}={}){
    const scope=chatId(conversationId);await this.context(scope);
    const task=this.tasks.get(id);if(!task||task.entry.conversationId!==scope)throw Error('This direct command is not running in the selected terminal.');
    task.entry.status='stopping';task.controller.abort();this.cancel(id);this.changed(scope,true);return {stopping:true,id};
  }
  stopConversation(conversationId){const id=chatId(conversationId);for(const [key,task]of this.tasks)if(task.entry.conversationId===id){task.entry.status='stopping';task.controller.abort();this.cancel(key);}this.changed(id,true);}
  close(){this.closed=true;this.interactive?.close();for(const [id,task]of this.tasks){task.controller.abort();this.cancel(id);}for(const timer of this.notifications.values())clearTimeout(timer);this.notifications.clear();}
}
