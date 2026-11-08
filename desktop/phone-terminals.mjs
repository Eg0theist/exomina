const strip=value=>String(value||'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
export async function phoneTerminalSnapshot({terminals,getChats,outputAllowed,checkRead},input={}){
  const visible=id=>getChats().some(chat=>chat.id===id&&!chat.private&&!chat.background&&!chat.channel);
  const sessions=[...(terminals?.sessions.values()||[])].filter(session=>session.owner==='agent'&&visible(session.conversationId));
  const result={protocolVersion:1,capabilities:{terminalOutput:outputAllowed()===true},sessions:sessions.slice(-24).map(session=>({id:session.id,conversationId:session.conversationId,title:session.title,status:session.status,keepAlive:!!session.keepAlive}))};
  if(input.id){
    if(!outputAllowed())throw Error('Terminal output sharing is off on the computer.');
    checkRead();const session=sessions.find(item=>item.id===input.id&&item.conversationId===input.conversationId);if(!session)throw Error('This shared terminal is unavailable.');
    const read=await terminals.read({conversationId:session.conversationId,id:session.id,cursor:Math.max(session.baseCursor,session.nextCursor-8000),limit:8000},{agent:true});
    if(!outputAllowed()||!visible(session.conversationId))throw Error('Terminal output sharing changed while reading.');checkRead();
    result.output={id:session.id,text:strip(read.text).slice(-8000),status:read.status,observedAt:new Date().toISOString()};
  }
  return result;
}
