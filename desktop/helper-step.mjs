import {nativeActivityText} from './provider-activity.mjs';

const text=(value,limit)=>typeof value==='string'?nativeActivityText(value,limit).trim():'';
const thread=value=>typeof value==='string'&&value.length>0&&value.length<=300&&!/[\x00-\x1f\x7f]/.test(value)?value:null;
const statuses={pendingInit:'waiting',running:'running',interrupted:'cancelled',completed:'complete',errored:'failed',shutdown:'cancelled',notFound:'failed'};
const kinds=new Set(['started','interacted','interrupted','completed']);

/** Bounded display metadata from Codex's native protocol. This never admits a
 * child thread or grants it tools; CodexChildRouting proves ownership separately.
 */
export function nativeHelperStep(item){
  if(!item||!['subAgentActivity','collabAgentToolCall'].includes(item.type))return null;
  const result={provider:'codex',type:item.type};
  if(item.type==='subAgentActivity'){
    if(thread(item.agentThreadId))result.threadIds=[item.agentThreadId];
    if(kinds.has(item.kind))result.action=item.kind;
    if(text(item.agentPath,200))result.name=text(item.agentPath,200);
  }else{
    result.threadIds=Array.isArray(item.receiverThreadIds)?[...new Set(item.receiverThreadIds.filter(thread))].slice(0,32):[];
    if(text(item.tool,80))result.action=text(item.tool,80);
    if(text(item.prompt,2000))result.task=text(item.prompt,2000);
    if(item.tool==='spawnAgent'){
      if(text(item.model,160))result.requestedModel=text(item.model,160);
      if(text(item.reasoningEffort,40))result.requestedEffort=text(item.reasoningEffort,40);
    }
    const reported={};
    for(const id of result.threadIds)if(statuses[item.agentsStates?.[id]?.status])reported[id]=statuses[item.agentsStates[id].status];
    if(Object.keys(reported).length)result.statuses=reported;
  }
  return result;
}

const helperNames=new Set(['subAgentActivity','collabAgentToolCall','Task','Agent']);
export const isHelperStep=step=>Boolean(step?.helper)||helperNames.has(step?.name);

/** Join only an explicit thread/tool identifier on this owning message. Missing
 * receipts stay unknown; an unrelated helper must never supply their identity.
 */
export function helperStepRows(step,helpers=[],provider){
  if(!isHelperStep(step))return [];
  let input={};
  if(['Task','Agent'].includes(step.name)&&typeof step.input==='string')try{input=JSON.parse(step.input);}catch{}
  const nativeProvider=['subAgentActivity','collabAgentToolCall'].includes(step.name)?'codex':['Task','Agent'].includes(step.name)?'claude':provider;
  const metadata=step.helper||{provider:nativeProvider,task:text(input?.prompt,2000),name:text(input?.name||input?.description,200),requestedModel:text(input?.model,160)},ids=Array.isArray(metadata.threadIds)?metadata.threadIds:[];
  const rows=ids.map(id=>{
    const known=helpers.find(helper=>helper.nativeThreadId===id);
    if(known)return known;
    return {id:`unlinked:${id}`,kind:'native',provider:metadata.provider||provider,name:metadata.name,task:metadata.task,requestedModel:metadata.requestedModel,
      status:metadata.statuses?.[id]||({started:'running',interrupted:'cancelled',completed:'complete'})[metadata.action]};
  });
  if(rows.length)return rows;
  const byTool=helpers.filter(helper=>helper.nativeToolUseId===(step.nativeToolUseId||step.id));
  if(byTool.length)return byTool;
  return [{id:`unlinked:${step.id}`,kind:'native',provider:metadata.provider||provider,name:metadata.name,task:metadata.task,requestedModel:metadata.requestedModel}];
}

export function helperStepTitle(step){
  const action=step.helper?.action;
  return {started:'Helper started',interacted:'Helper interaction',interrupted:'Helper stopped',completed:'Helper completed',spawnAgent:'Starting a helper',sendInput:'Sending a helper task',sendMessage:'Messaging a helper',followupTask:'Sending a helper follow-up',wait:'Waiting for helpers',closeAgent:'Stopping a helper'}[action]||'Helper activity';
}
