const identifier=id=>{if(typeof id!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))throw Error('Choose a valid chat.');return id;};

/** Runs recheck this gate just before becoming active, including after asynchronous preparation. */
export class ChatDeletionCoordinator {
  constructor(getActive=()=>[]){this.getActive=getActive;this.ids=new Set();this.memoryLocked=false;}
  assertCanStart(id){if(this.memoryLocked||this.ids.has(id))throw Error('Wait for chat deletion to finish before starting this work.');}
  reserve(id,{deleteMemories}){
    identifier(id);const active=new Set(this.getActive());
    if(active.has(id))throw Error('Stop this chat first. It is still running.');if(deleteMemories&&active.size)throw Error('Stop active chats before deleting associated memories.');
    if(this.ids.has(id)||this.memoryLocked||deleteMemories&&this.ids.size)throw Error('Wait for the current chat deletion to finish.');
    this.ids.add(id);if(deleteMemories)this.memoryLocked=true;
    return ()=>{this.ids.delete(id);if(deleteMemories)this.memoryLocked=false;};
  }
}
const addPending=(store,id)=>{store.state.pendingChatMemoryDeletes=[...new Set([...(Array.isArray(store.state.pendingChatMemoryDeletes)?store.state.pendingChatMemoryDeletes:[]),id])];};
const removePending=(store,id)=>{store.state.pendingChatMemoryDeletes=(store.state.pendingChatMemoryDeletes||[]).filter(value=>value!==id);};

/** The chat removal and optional note-deletion intent are saved together.
 * A failed note transaction can then be retried without guessing which notes belonged to the chat. */
export async function deleteSavedConversation({store,memory,id,deleteMemories=false,active=false,anyActive=false,beforeDelete=async()=>{},afterCommit=async()=>{},onChanges=async()=>{},coordinator}){
  identifier(id);if(typeof deleteMemories!=='boolean')throw Error('Choose whether to delete associated memories.');
  const chat=store.conversation(id);
  if(active)throw Error('Stop this chat first. It is still running.');
  if(deleteMemories&&anyActive)throw Error('Stop active chats before deleting associated memories.');
  const release=coordinator?.reserve(id,{deleteMemories});
  try{
  await beforeDelete();
  const conversations=store.state.conversations,previousPending=store.state.pendingChatMemoryDeletes,index=conversations.findIndex(value=>value.id===id);
  store.state.conversations=conversations.filter(chat=>chat.id!==id);
  if(deleteMemories)addPending(store,id);
  try{await store.save();}catch(error){if(!store.state.conversations.some(value=>value.id===id))store.state.conversations.splice(Math.min(index,store.state.conversations.length),0,chat);if(deleteMemories&&!previousPending?.includes(id)){removePending(store,id);if(previousPending===undefined&&!store.state.pendingChatMemoryDeletes.length)delete store.state.pendingChatMemoryDeletes;}throw error;}
  if(!deleteMemories){await afterCommit(id);return {deleted:true,deletedMemories:0};}
  let result;
  try{
    await afterCommit(id);
    result=await memory.deleteChatNotes(id);
    await onChanges(id,result);
    removePending(store,id);await store.save();await memory.completeChatNoteDeletion(id);
    return {deleted:true,deletedMemories:result.deletedNoteIds.length,memoryChanges:result};
  }catch(error){
    addPending(store,id);
    return {deleted:true,...(result?{memoryChanges:result,deletedMemories:result.deletedNoteIds.length}:{}),memoryDeletionPending:true,message:'The conversation was deleted. Associated memory deletion is pending and will retry when Exomina opens. '+error.message};
  }
  }finally{release?.();}
}

export async function finishPendingChatMemoryDeletes({store,memory,onChanges=async()=>{},onError=()=>{}}){
  const results=[];
  const pending=[...new Set([...(Array.isArray(store.state.pendingChatMemoryDeletes)?store.state.pendingChatMemoryDeletes:[]),...await memory.pendingChatNoteDeletions()])];
  for(const id of pending){
    try{
      identifier(id);if(store.state.conversations.some(chat=>chat.id===id))continue;
      const changes=await memory.deleteChatNotes(id);await onChanges(id,changes);
      removePending(store,id);
      try{await store.save();await memory.completeChatNoteDeletion(id);}catch(error){addPending(store,id);throw error;}
      results.push({id,...changes});
    }catch(error){onError(id,error);results.push({id,pending:true,error:error.message});}
  }
  return results;
}
