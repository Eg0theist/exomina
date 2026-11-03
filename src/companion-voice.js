import {normalizeVoice} from '../desktop/voice-settings.mjs';

/** A preference, never a fallback: an unavailable AI voice must not start device speech. */
export function companionVoiceAction({settings,active=false,canRealtime=false,canTalk=false,unavailableReason=''}={}) {
  const device=normalizeVoice(settings).companionMode==='device';
  const available=device?canTalk:canRealtime;
  return {
    mode:device?'conversation':'realtime',
    label:active?'Stop voice':device?'Talk on device':'Talk with AI',
    available:active||available,
    description:active?'Stop voice and release the microphone.':available?
      device?'Use Windows speech with your selected AI.':'Use ChatGPT AI voice. Audio goes to OpenAI; chat context is shared and transcripts stay in this chat.':
      unavailableReason||(device?'Open a chat, send or clear your draft and wait for the current reply.':'Connect ChatGPT, open a chat, send or clear your draft and wait for the current reply.'),
  };
}

/** The device choice is explicit and persisted before microphone input, with scope rechecks. */
export async function chooseDeviceSpeech({invoke,current,allowed=()=>true,start}){
 const scope=current(),check=()=>{const next=current();if(!allowed()||next.page!=='chat'||next.running||next.page!==scope.page||(next.conversationId||'')!==(scope.conversationId||'')||next.provider!==scope.provider)throw Error('Voice was not started because this chat changed or is busy. Choose Talk again when ready.');};
 check();const status=await invoke('voice.status');check();
 if(!status?.available||!status.voices?.length)throw Error(status?.error||'This PC’s speech is unavailable. Check installed speech languages and voices.');
 await invoke('settings.save',{voicePatch:{companionMode:'device'}});check();
 await start('conversation');return true;
}
