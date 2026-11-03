import {AI_VOICE_ACKNOWLEDGMENT,normalizeVoice,patchVoice} from './voice-settings.mjs';
import {beginSettingsTransaction} from './runtime-settings-transaction.mjs';

export const AI_VOICE_DISCLOSURE=Object.freeze({
 type:'question',title:'Start AI voice?',message:'Send microphone audio and chat context to ChatGPT?',
 detail:'AI voice sends live microphone audio to OpenAI. It also shares this chat’s recent conversation and instructions, relevant saved or imported memories when enabled, and project instructions. Completed transcripts are kept in this chat; Exomina does not save the audio. OpenAI’s account settings and service limits apply.\n\nThis choice is remembered for this Exomina profile. You can stop voice at any time. The microphone stays off until you agree and ChatGPT voice availability has been checked.',
 buttons:['Not now','Agree and start AI voice'],defaultId:0,cancelId:0,noLink:true,
});

export async function persistAiVoiceAcknowledgment({settings,version,persist,onChange=()=>{}}){
 const transaction=beginSettingsTransaction(settings,{voicePatch:{aiVoiceAcknowledged:version}});
 settings.voice=patchVoice(settings.voice,{aiVoiceAcknowledged:version});
 try{await persist();transaction.commit();onChange();}
 catch(error){try{await transaction.rollback({persist,onRestore:onChange});}catch(rollback){throw new Error(`${error.message} Restoring the previous voice acknowledgment also failed: ${rollback.message}`,{cause:error});}throw error;}
}

/** Reject a context prepared across a chat, permission or sharing change. */
export function voiceContextGuard({eligible,policy}){
 eligible();const initial=JSON.stringify(policy());
 return()=>{eligible();if(JSON.stringify(policy())!==initial)throw Error('Voice context settings changed. Start voice again to use the current choices.');return true;};
}

/** One explicit, persisted acknowledgment before the host arms microphone access. */
export class AiVoiceConsent {
 constructor({read,save,confirm}){Object.assign(this,{read,save,confirm});this.generation=0;this.pending=null;}
 cancel(){this.generation++;}
 async ensure({isCurrent=()=>true}={}){
  if(!isCurrent())return false;
  if(this.pending)return false;
  if(normalizeVoice(this.read()).aiVoiceAcknowledged===AI_VOICE_ACKNOWLEDGMENT)return true;
  const generation=this.generation,live=()=>generation===this.generation&&isCurrent();
  const task=(async()=>{
   if(!await this.confirm(AI_VOICE_DISCLOSURE)||!live())return false;
   await this.save(AI_VOICE_ACKNOWLEDGMENT);
   return live();
  })();this.pending=task;
  try{return await task;}finally{if(this.pending===task)this.pending=null;}
 }
}
