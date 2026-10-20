import path from 'node:path';

export function interactiveTerminalRestriction({mode,rules=[]}={}){
  if(mode==='read-only')return 'Read only mode blocks interactive shell input.';
  const tools=['workspace_shell','terminal_open','terminal_input','Bash','PowerShell','claude.Bash','claude.PowerShell','codex.command','gemini.execute','grok.execute','muse.execute','antigravity.execute','exec_command','write_stdin'];
  for(const rule of rules){if(rule.effect!=='deny')continue;const tool=String(rule.tool||''),pattern=tool.split('*').map(part=>part.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');if(tools.some(value=>new RegExp(`^${pattern}$`,'i').test(value))||/(?:^|[._:])(?:Bash|PowerShell|shell|execute|command|exec_command|write_stdin)$/i.test(tool))return 'Interactive shells cannot enforce your command deny rules. Use direct commands or revise those rules before opening a full shell.';}
  return null;
}

/** Manual commands obey the chat's policy without borrowing a running AI turn. */
export async function approveTerminalCommand({request, conversationId, signal, getContext, evaluate, ask}) {
  if (signal?.aborted) return false;
  if (!conversationId || request.conversationId !== conversationId) throw Error('The terminal command has no matching chat.');
  const before = await getContext(conversationId);
  const action = {kind: 'execute', tool: 'workspace_shell', target: request.input.command};
  const verdict = evaluate(action, conversationId);
  if (verdict.decision === 'deny') throw Object.assign(Error(verdict.reason || 'This chat’s permission level or deny rules block terminal commands. Review its Permissions control.'), {code: 'TERMINAL_DENIED'});
  const approved = verdict.decision === 'allow' || await ask({
    title: 'Run your terminal command?',
    detail: request.detail,
    action,
    input: request.input,
    reason: 'You entered this command in the Exomina terminal. It runs with your Windows account permissions.',
    requireConfirmation: true,
    confirmationSource: 'terminal',
    signal
  });
  if (!approved || signal?.aborted) return false;
  const after = await getContext(conversationId);
  if (path.resolve(after.workspace).toLowerCase() !== path.resolve(before.workspace).toLowerCase()) throw Error('The workspace changed while this command awaited approval. Retry in the selected folder.');
  const current = evaluate(action, conversationId);
  if (current.decision === 'deny') throw Object.assign(Error(current.reason || 'This command was blocked by a permission change while you were deciding.'), {code: 'TERMINAL_DENIED'});
  return !signal?.aborted;
}

/** A byte stream cannot be authorized as command prefixes. Ask/Auto-edit need
 * an explicit whole-session grant; unrestricted Full access supplies authority. */
export async function approveTerminalSession({conversationId,workspace,startDirectory=workspace,owner,signal,getContext,evaluate,getMode=()=>null,ask}){
  if(signal?.aborted)return false;
  const before=await getContext(conversationId),action={kind:'execute',tool:'terminal_open',target:'Interactive PowerShell session'};
  if(path.resolve(before.workspace).toLowerCase()!==path.resolve(workspace).toLowerCase())throw Error('The workspace changed before opening this terminal.');
  const verdict=evaluate(action,conversationId);if(verdict.decision==='deny')throw Object.assign(Error(verdict.reason||'This chat blocks interactive terminals.'),{code:'TERMINAL_DENIED'});
  const fromFull=getMode(conversationId)==='full'&&verdict.decision==='allow';
  const granted=fromFull||await ask({title:owner==='agent'?'Allow the AI an interactive terminal?':'Open your interactive terminal?',detail:`Starting folder: ${startDirectory}\n\nThis opens a real PowerShell session with your Windows account permissions. ${owner==='agent'?'The AI and you can type into the same session.':'You can type commands and run interactive programs.'} The AI can inspect this chat’s terminal output under its read permissions. Cwd and environment persist. This grants full shell input until this session closes; individual commands are not reviewed or matched to command-prefix rules. Closing the panel keeps the session running. Use Close session to end access.`,action,reason:'Authorize this whole interactive session explicitly.',requireConfirmation:true,confirmationSource:'terminal',signal,...(owner==='agent'?{conversationId}:{})});
  if(!granted||signal?.aborted)return false;const after=await getContext(conversationId);if(path.resolve(after.workspace).toLowerCase()!==path.resolve(workspace).toLowerCase())throw Error('The workspace changed during terminal approval. Open a new terminal.');
  const current=evaluate(action,conversationId);if(current.decision==='deny'||fromFull&&getMode(conversationId)!=='full')throw Object.assign(Error(current.reason||'This terminal was blocked by a permission change.'),{code:'TERMINAL_DENIED'});return {approved:true,source:fromFull?'implicitFull':'explicitSession'};
}
