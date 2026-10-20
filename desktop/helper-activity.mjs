import {nativeActivityText} from './provider-activity.mjs';

export const HELPER_DISPLAY_LIMITS=Object.freeze({count:80,task:30000,text:50000,savedText:300000});
const statuses=new Set(['running','complete','failed','cancelled','waiting','stopped']);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fields={sourceProvider:80,sourceModel:160,sourceModelSource:40,sourceRequestedModel:160,provider:80,model:160,effort:40,effortSource:80,selectionMode:80,difficulty:40,rationale:1000,requestedProvider:80,requestedModel:160,requestedEffort:40,effectiveProvider:80,effectiveModel:160,effectiveEffort:40,configuredModel:160,configuredEffort:40,modelSource:40,name:200,role:200,task:30000,statusDetail:2000,summary:2000,error:4000,text:50000,startedAt:80,finishedAt:80,nativeThreadId:200,nativeTurnId:200,nativeTaskId:200,nativeToolUseId:300,parentThreadId:200,parentHelperId:400};

/** Display metadata only. Provider/model identifiers never choose a tool owner. */
export function normalizeHelperActivity(value){
  if(!object(value)||typeof value.id!=='string'||!value.id||value.id.length>400)return null;
  const helper={id:value.id};
  if(value.kind==='native'||value.kind==='consult')helper.kind=value.kind;
  if(statuses.has(value.status))helper.status=value.status;
  for(const [field,limit] of Object.entries(fields))if(own(value,field)&&typeof value[field]==='string')helper[field]=nativeActivityText(value[field],limit);
  // Explicit clears reflect an actual runtime reroute. Omitted fields remain
  // partial lifecycle updates and retain earlier reported metadata.
  for(const field of ['effectiveProvider','effectiveModel','effectiveEffort'])if(own(value,field)&&value[field]===null)helper[field]=null;
  for(const field of ['startedAt','finishedAt'])if(typeof value[field]==='number'&&Number.isFinite(value[field])&&Math.abs(value[field])<=8.64e15)helper[field]=new Date(value[field]).toISOString();
  if(typeof value.background==='boolean')helper.background=value.background;
  if(typeof value.task==='string'&&value.task.length>HELPER_DISPLAY_LIMITS.task)helper.taskTruncated=true;
  if(value.taskTruncated===true)helper.taskTruncated=true;
  if(typeof value.text==='string'&&value.text.length>HELPER_DISPLAY_LIMITS.text||value.textTruncated===true)helper.textTruncated=true;
  if(Array.isArray(value.fallback))helper.fallback=value.fallback.slice(0,10).filter(object).map(row=>Object.fromEntries(['provider','model','effort','reason'].filter(key=>typeof row[key]==='string').map(key=>[key,nativeActivityText(row[key],key==='reason'?1000:160)]))).filter(row=>row.provider);
  if(Array.isArray(value.images))helper.images=value.images.slice(0,5).filter(object).map(row=>row.id?{id:nativeActivityText(row.id,100)}:typeof row.path==='string'?{path:nativeActivityText(row.path,4000)}:null).filter(Boolean);
  return helper;
}

/** Stable order, partial native lifecycle updates and a bounded saved display. */
export function mergeHelperActivity(previous,value){
  const next=normalizeHelperActivity(value);if(!next)return {helpers:Array.isArray(previous)?previous:[],omitted:0};
  const helpers=Array.isArray(previous)?previous.slice():[],index=helpers.findIndex(helper=>helper.id===next.id);
  if(index>=0)helpers[index]={...helpers[index],...next};else helpers.push(next);
  let omitted=0;
  while(helpers.length>HELPER_DISPLAY_LIMITS.count){const removable=helpers.findIndex(helper=>helper.id!==next.id&&!['running','waiting'].includes(helper.status));helpers.splice(removable>=0?removable:0,1);omitted++;}
  let size=helpers.reduce((sum,helper)=>sum+(helper.text?.length||0)+(helper.task?.length||0),0);
  for(let index=0;size>HELPER_DISPLAY_LIMITS.savedText&&index<helpers.length;index++){
    const helper=helpers[index];if(helper.id===next.id||!helper.text)continue;size-=helper.text.length;helpers[index]={...helper,text:'',textTruncated:true};
  }
  for(let index=0;size>HELPER_DISPLAY_LIMITS.savedText&&index<helpers.length;index++){
    const helper=helpers[index];if(helper.id===next.id||!helper.task)continue;size-=helper.task.length;helpers[index]={...helper,task:'',taskTruncated:true};
  }
  return {helpers,omitted};
}
