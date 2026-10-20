/** Store complete text only; audio, SDP and partial captions never enter chat storage. */
export function appendVoiceTranscript(chat,event,at=new Date().toISOString()) {
  const transcript=event?.event;
  if(!chat||transcript?.type!=='transcript'||transcript.done!==true||!['user','assistant'].includes(transcript.role)||typeof transcript.id!=='string'||!transcript.id||typeof event.sessionId!=='string'||typeof transcript.text!=='string'||!transcript.text.trim())return false;
  const id='voice-'+event.sessionId+'-'+transcript.id;
  if(chat.messages.some(message=>message.id===id))return false;
  chat.messages.push({id,role:transcript.role,provider:'codex',voice:'realtime',lane:'chat',content:transcript.text.slice(0,100000),startedAt:at,completedAt:at});chat.updatedAt=at;
  return true;
}
