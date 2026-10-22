/** Metadata rows never hold message bodies. Full history is fetched on open. */
export function conversationSummary(chat){
  const {messages,...metadata}=chat;
  return {...metadata,messages:[],messageCount:chat.messagesLoaded===false?chat.messageCount:(messages?.length||0),hasUserMessages:chat.messagesLoaded===false?chat.hasUserMessages:!!messages?.some(message=>message.role==='user'),messagesLoaded:false};
}
export function libraryConversations(conversations,{compact=false,conversationId}={}){
  return compact===true?conversations.map(chat=>chat.id===conversationId?chat:conversationSummary(chat)):conversations;
}
