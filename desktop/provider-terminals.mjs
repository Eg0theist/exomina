import {randomUUID} from 'node:crypto';

/** Only terminals reported by the existing connection for the exact active
 * Codex chat. No process scanning, account reads or provider stdin writes. */
export class ProviderTerminals{
  constructor({getContext,getState,getRpc}){Object.assign(this,{getContext,getState,getRpc});this.handles=new Map();}
  scope(conversationId){const state=this.getState(conversationId),rpc=this.getRpc();return state?.provider==='codex'&&!state.cancelled&&!state.turnEnded&&typeof state.sessionId==='string'&&rpc&&!rpc.closed?{state,rpc,threadId:state.sessionId}:null;}
  async list(conversationId){
    await this.getContext(conversationId);const scope=this.scope(conversationId);
    if(!scope){for(const [id,handle]of this.handles)if(handle.conversationId===conversationId)this.handles.delete(id);return {available:false,entries:[],detail:'Native terminal controls are available during an active Codex task. Shared AI sessions above remain available independently.'};}
    try{
      const value=await scope.rpc.request('thread/backgroundTerminals/list',{threadId:scope.threadId,limit:50},5000);
      if(this.scope(conversationId)?.state!==scope.state||scope.state.sessionId!==scope.threadId)return {available:false,entries:[],detail:'The native task changed. Refresh its terminals.'};
      const entries=(Array.isArray(value.data)?value.data:[]).slice(0,50).filter(item=>typeof item.processId==='string'&&item.processId&&item.processId.length<300).map(item=>{
        let handle=[...this.handles.values()].find(handle=>handle.conversationId===conversationId&&handle.state===scope.state&&handle.threadId===scope.threadId&&handle.processId===item.processId);
        if(!handle){handle={id:'native-terminal:'+randomUUID(),conversationId,state:scope.state,threadId:scope.threadId,processId:item.processId};this.handles.set(handle.id,handle);if(this.handles.size>300)this.handles.delete(this.handles.keys().next().value);}
        return {id:handle.id,provider:'Codex',command:String(item.command||'').slice(0,8000),workspace:String(item.cwd||'').slice(0,4000),canStop:true,inputAvailable:false};
      });
      const live=new Set(entries.map(item=>item.id));for(const [id,handle]of this.handles)if(handle.conversationId===conversationId&&!live.has(id))this.handles.delete(id);
      return {available:true,entries,truncated:!!value.nextCursor,detail:'Live native Codex terminals. Stop is supported; the provider does not expose their input for attachment.'};
    }catch{return {available:false,entries:[],detail:'Native terminal inventory is unavailable for this connection right now. Command receipts remain below; use shared AI sessions for interactive control.'};}
  }
  async stop({conversationId,id}={}){
    await this.getContext(conversationId);const handle=this.handles.get(id),scope=this.scope(conversationId);
    if(!handle||handle.conversationId!==conversationId||scope?.state!==handle.state||scope.threadId!==handle.threadId)throw Error('This native terminal is not owned by the active chat.');
    const current=await this.list(conversationId),present=this.scope(conversationId);if(!current.entries.some(entry=>entry.id===id)||present?.state!==handle.state||present?.threadId!==handle.threadId||present?.rpc!==scope.rpc)throw Error('The native terminal is no longer running in this chat.');
    await scope.rpc.request('thread/backgroundTerminals/terminate',{threadId:handle.threadId,processId:handle.processId},5000);this.handles.delete(id);return {id,stopped:true};
  }
}
