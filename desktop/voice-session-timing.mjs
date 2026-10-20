// Shared by the renderer and diagnostic sink. Accept timings, never conversation data.
const frontendNames=new Set(['session-start','prepare-complete','microphone-ready','rtc-connected','playback-started','speech-started','speech-stopped','response-output','output-stopped','interrupted','microphone-muted','microphone-unmuted']);
const backendNames=new Set(['thread-ready','handoff-request','turn-started','turn-completed']);
const efforts=new Set(['none','minimal','low','medium','high','xhigh','max','ultra','unknown']);
const statuses=new Set(['inProgress','completed','interrupted','failed','unknown']);
export const boundedVoiceMs=value=>typeof value==='number'&&Number.isFinite(value)?Math.round(Math.min(3600000,Math.max(0,value))):0;
export function voiceTimingEvent(value) {
  if(!value||typeof value!=='object'||(!frontendNames.has(value.name)&&!backendNames.has(value.name)))return null;
  const event={name:value.name,atMs:boundedVoiceMs(value.atMs)};
  if(backendNames.has(value.name))event.elapsedMs=boundedVoiceMs(value.elapsedMs);
  if(value.name==='thread-ready')event.reasoningEffort=efforts.has(value.reasoningEffort)?value.reasoningEffort:'unknown';
  if(value.name==='turn-started'||value.name==='turn-completed')event.status=statuses.has(value.status)?value.status:'unknown';
  if(value.name==='turn-completed'&&typeof value.turnElapsedMs==='number'&&Number.isFinite(value.turnElapsedMs))event.turnElapsedMs=boundedVoiceMs(value.turnElapsedMs);
  if(value.name==='response-output'&&typeof value.responseDelayMs==='number'&&Number.isFinite(value.responseDelayMs))event.responseDelayMs=boundedVoiceMs(value.responseDelayMs);
  return event;
}
export function voiceTimingRun(payload,at=new Date().toISOString()) {
  return {at,result:payload?.result==='error'?'error':'stopped',events:Array.isArray(payload?.events)?payload.events.slice(0,120).map(voiceTimingEvent).filter(Boolean):[]};
}
