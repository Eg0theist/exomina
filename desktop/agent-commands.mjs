import {toolActivityState} from './activity-visibility.mjs';

/** Only activity the host actually received. No provider home, native terminal
 * history or account files are probed to manufacture an attach capability.
 */
export function agentCommandRows(messages=[],{running=false}={}){
  const latest=messages.findLastIndex(message=>message.role==='assistant');
  return messages.flatMap((message,index)=>message.role!=='assistant'?[]:(message.activity||[]).filter(step=>step.kind==='tool'&&(step.category==='execute'||/(?:^|[:.])\s*(?:commandExecution|Bash|PowerShell|workspace_shell|exec_command|write_stdin)$/i.test(step.name||''))).map(step=>{
    let input={};if(typeof step.input==='string')try{input=JSON.parse(step.input);}catch{}
    const value=input.command??input.cmd,command=Array.isArray(value)?value.join(' '):typeof value==='string'?value:step.target||'';
    const state=toolActivityState(step),active=running&&index===latest&&!message.finishedAt;
    return {id:`${message.id||index}:${step.id}`,provider:message.provider||'AI',tool:step.name,command,output:String(step.output||''),detail:String(step.detail||''),permission:String(step.permission||''),status:state==='running'&&!active?'unconfirmed':state,startedAt:step.startedAt,endedAt:step.endedAt,canStopTask:state==='running'&&active};
  })).slice(-60);
}
