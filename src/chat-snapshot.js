import {conversationSummary} from '../desktop/library-view.mjs';
/** Keep live streamed chats and unsaved starters during a library refresh. */
export function mergeChatSnapshot(previous,fresh,runs,selectedId){
 const earlier=new Map(previous.map(chat=>[chat.id,chat]));
 const compact=fresh.some(chat=>chat.messagesLoaded===false);
 return [...fresh.map(chat=>{
   const old=earlier.get(chat.id);
   if(compact&&chat.id!==selectedId)return conversationSummary(chat);
   if(runs[chat.id]&&old&&old.messagesLoaded!==false)return old;
   // A request started before navigation may return a metadata row for the
   // chat that has since opened. Do not replace its loaded body with emptiness.
   if(chat.messagesLoaded===false&&chat.id===selectedId&&old&&old.messagesLoaded!==false)return {...chat,messages:old.messages,messagesLoaded:true};
   return chat;
 }),...previous.filter(chat=>String(chat.id).startsWith('pending-')&&!fresh.some(item=>item.id===chat.id))];
}
