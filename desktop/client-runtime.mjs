import path from 'node:path';
import {createHash} from 'node:crypto';
import {MemoryStore} from './memory.mjs';
const SCOPED_TOOLS=new Set(['memory_wake','memory_recall','memory_knowledge','memory_note','memory_nap','memory_zoom','memory_forget','conversation_read','conversation_search','conversation_find','conversation_zoom','conversation_date','conversation_set_title','tool_discover','tool_details','followup_update','question_update','ask_user_question','ask_user_question_async']);

// Local desktop owner boundaries. This is not an OS sandbox or remote tenant
// identity service: the owner's renderer can still inspect the entire library.
export class ClientRuntime {
  constructor({scopes,dataDir,getChats,memoryFactory=dir=>new MemoryStore(dir)}){
    Object.assign(this,{scopes,dataDir,getChats,memoryFactory});this.memories=new Map();
  }
  context(chatId){return this.scopes.context(chatId);}
  scopedChats(context){
    return this.getChats().filter(row=>{
      try{const other=this.context(row.id);return !row.private&&other?.organizationId===context.organizationId&&other?.clientId===context.clientId;}
      catch{return false;}
    });
  }
  chats(chatId){
    const context=this.context(chatId),rows=this.getChats();
    if(context)return this.scopedChats(context);
    // Unscoped chats cannot accidentally retrieve newly isolated material.
    return rows.filter(row=>{
      try{const other=this.context(row.id);return !other;}
      catch{return false;}
    });
  }
  async memory(chatId){
    const context=this.context(chatId);if(!context)throw Error('Choose a client-scoped chat.');const job=this.scopes.captureJob(chatId);
    const key=createHash('sha256').update(JSON.stringify([context.organizationId,context.clientId])).digest('hex');
    let pending=this.memories.get(key);
    if(!pending){pending=(async()=>{const memory=this.memoryFactory(path.join(this.dataDir,'client-data',key));await memory.init();memory.setOutcomeSource(()=>this.scopedChats(context).filter(row=>!row.private).flatMap(row=>row.outcomeMarks||[]));return memory;})();this.memories.set(key,pending);pending.catch(()=>this.memories.delete(key));}
    const memory=await pending;this.scopes.assertJob(job);return memory;
  }
  allowed(chatId,name){
    if(!this.context(chatId))return true;
    // Each memory tool is directed to a physically separate database. Transcript
    // tools receive a filtered source. Metadata discovery cannot widen this set.
    if(!SCOPED_TOOLS.has(name))return false;
    if(['memory_note','memory_nap','memory_forget','conversation_set_title'].includes(name))return this.scopes.allowsResource(chatId,{kind:'chat',id:chatId},'write');
    return true;
  }
  assertTool(chatId,name){if(!this.allowed(chatId,name))throw Error('This tool has no client-isolated adapter. Use this client’s memory and conversation tools, or a separate unscoped chat.');}
  fingerprint(chatId){return this.scopes.fingerprint(chatId);}
  runOptions(chatId,definitions){return this.context(chatId)?{toolDefinitions:definitions.filter(tool=>this.allowed(chatId,tool.name)),hostToolsOnly:true,noPersistence:true,ephemeral:true,noAuthRetry:true}:{};}
  async close(){for(const pending of this.memories.values())try{(await pending).close();}catch{}this.memories.clear();}
}
