/** Keep live streamed chats and unsaved starters during a library refresh. */
export function mergeChatSnapshot(previous,fresh,runs){
 const earlier=new Map(previous.map(chat=>[chat.id,chat]));
 return [...fresh.map(chat=>runs[chat.id]?earlier.get(chat.id)||chat:chat),...previous.filter(chat=>String(chat.id).startsWith('pending-')&&!fresh.some(item=>item.id===chat.id))];
}
