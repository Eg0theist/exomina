import React, {useCallback, useEffect, useRef, useState} from 'react';
import {LoaderCircle, Play, RefreshCw, Square, Terminal, X} from 'lucide-react';
import {api} from './transport.js';
import {agentCommandRows} from '../desktop/agent-commands.mjs';
import './terminal-panel.css';
import TerminalScreen from './TerminalScreen.jsx';
// Floating panels copy the owner's styles before a terminal engine may load.
// Keep this small sheet eager so first-open-in-float has the same cascade.
import '@xterm/xterm/css/xterm.css';

const live=new Set(['authorizing','running','stopping']);
const labels={authorizing:'Checking permission',running:'Running',stopping:'Stopping',stopped:'Stopped',complete:'Completed',error:'Failed',denied:'Not allowed','timed-out':'Timed out','output-limited':'Output limit reached',unconfirmed:'Result not confirmed',unknown:'Result not confirmed',recorded:'Recorded',done:'Completed'};
const message=error=>String(error?.message||error||'The terminal could not complete this request.').replace(/^Error invoking remote method ['"]studio:invoke['"]: (?:Error: )?/,'');

function InteractiveSessions({conversationId,sessions=[],owner,onRefresh,onError}){
  const [selected,setSelected]=useState(''),[opening,setOpening]=useState(false);
  const visible=sessions.filter(session=>session.owner===owner),session=visible.find(item=>item.id===selected)||visible.findLast(item=>item.status==='running')||visible.at(-1);
  const open=async startIn=>{setOpening(true);try{const value=await api.invoke('terminal.open',{conversationId,...(startIn?{startIn}:{})});setSelected(value.id);await onRefresh();}catch(error){onError(message(error));}finally{setOpening(false);}};
  const action=async(method,extra={})=>{try{await api.invoke(method,{conversationId,id:session.id,...extra});await onRefresh();}catch(error){onError(message(error));}};
  return <div className="terminal-live-sessions">
    <div className="terminal-live-toolbar">{owner==='user'&&<><button type="button" className="secondary-button" disabled={opening} onClick={()=>open()} title="Start PowerShell in your Windows user folder">{opening?<LoaderCircle size={13} className="spin"/>:<Play size={13}/>}New interactive session</button><button type="button" className="text-button" disabled={opening} onClick={()=>open('workspace')}>Open in workspace</button></>}{!!visible.length&&<label>Session<select aria-label={`${owner==='agent'?'Agent':'Your'} terminal session`} value={session?.id||''} onChange={event=>setSelected(event.target.value)}>{visible.map(item=><option key={item.id} value={item.id}>{item.title} · {item.status}</option>)}</select></label>}{session&&<><span className="terminal-session-owner">{owner==='agent'?'Shared with AI':'Your session'} · {session.backend||session.status}</span><button type="button" className="text-button" disabled={session.status!=='running'} onClick={()=>action('terminal.input',{text:'\u0003'})}>Ctrl+C</button><button type="button" className="text-button" disabled={!live.has(session.status)} onClick={()=>action('terminal.close')}><Square size={12}/>Close session</button></>}</div>
    {session?<><p className="terminal-context">Started in <strong>{session.startDirectory||session.workspace}</strong> · {session.status}{Number.isInteger(session.exitCode)?` · exit ${session.exitCode}`:''}{session.editor?' · '+session.editor:''}</p>{session.error&&<p className="inline-error">{session.error}</p>}<TerminalScreen key={session.id} conversationId={conversationId} session={session} onError={onError}/></>:<p className="terminal-empty">{owner==='agent'?'No shared AI terminal sessions yet. For interactive work, the AI can open one with terminal_open; it appears here for you to view and control.':'New sessions start in your Windows user folder. Choose Open in workspace to start in this chat’s project folder. Working folder, environment and interactive programs persist within each session.'}</p>}
    <p className="terminal-context">{owner==='agent'?'You and the AI type into the same approved session.':'The initial approval covers all input in this session.'} Closing this panel keeps it running. Close session ends the process tree. The AI can inspect this chat’s terminal output under its read permissions.</p>
  </div>;
}

function NativeTerminals({conversationId,onError}){
  const [value,setValue]=useState({entries:[],detail:''}),currentChat=useRef(conversationId);currentChat.current=conversationId;
  const refresh=useCallback(async()=>{try{const next=await api.invoke('terminal.native.list',{conversationId});if(currentChat.current===conversationId)setValue(next);}catch(error){if(currentChat.current===conversationId)onError(message(error));}},[conversationId]);
  useEffect(()=>{let live=true;const read=()=>{if(live)refresh();};read();const timer=setInterval(read,5000);return()=>{live=false;clearInterval(timer);};},[refresh]);
  return <div className="terminal-native"><div className="terminal-live-toolbar"><strong>Native provider terminals</strong><button type="button" className="text-button" onClick={refresh}><RefreshCw size={12}/>Refresh native terminals</button></div><p className="terminal-context">{value.detail}</p>{value.entries.map(entry=><article className="terminal-entry terminal-native-entry" key={entry.id}><pre>{entry.command}<br/>{entry.workspace}</pre><button type="button" className="text-button" onClick={async()=>{try{await api.invoke('terminal.native.stop',{conversationId,id:entry.id});await refresh();}catch(error){onError(message(error));}}}><Square size={12}/>Stop native terminal</button></article>)}{value.truncated&&<p className="terminal-context">Showing the first 50 native terminals.</p>}</div>;
}

function CommandOutput({entry,direct=false,onStop}){
  const statusLabel=direct?(entry.status==='complete'?'Process exited':entry.status==='error'?(Number.isInteger(entry.exitCode)?'Process exited':'Command failed'):labels[entry.status]):labels[entry.status];
  return <article className={`terminal-entry status-${entry.status}`} data-terminal-id={entry.id}>
    <div className="terminal-entry-head"><strong>{direct?'Your command':entry.provider}</strong><span role="status">{live.has(entry.status)&&<LoaderCircle size={12} className="spin"/>}{statusLabel||entry.status}{Number.isInteger(entry.exitCode)?` · exit ${entry.exitCode}`:''}</span>{direct&&live.has(entry.status)&&<button type="button" className="text-button" disabled={entry.status==='stopping'} onClick={()=>onStop(entry.id)}><Square size={12}/>Stop command</button>}</div>
    {entry.command?<pre className="terminal-command" aria-label="Command"><code>{entry.command}</code></pre>:<p className="terminal-context">The runtime did not include the command in this receipt.</p>}
    {direct&&<p className="terminal-context" title={entry.workspace}>{entry.workspace}</p>}
    {entry.output&&<pre className="terminal-output" tabIndex={0} aria-label="Command output">{entry.output}</pre>}
    {entry.outputTruncated&&<p className="terminal-context">Output shown here was shortened to keep this panel bounded.</p>}
    {entry.error&&<p className="inline-error">{entry.error}</p>}
    {!direct&&entry.permission&&<p className="terminal-context">{entry.permission}</p>}
    {!direct&&entry.detail&&<p className="terminal-context">{entry.detail}</p>}
    {!entry.output&&!entry.error&&<p className="terminal-context">{entry.status==='authorizing'?'Follow the current permission controls to authorize this command.':entry.status==='running'?'Waiting for output…':'No output was reported.'}</p>}
  </article>;
}

export default function TerminalPanel({conversationId,messages=[],running=false,onStopAgent,onClose}){
  const [tab,setTab]=useState('interactive'),[state,setState]=useState({workspace:'',entries:[],sessions:[]}),[command,setCommand]=useState(''),[timeout,setTimeoutSeconds]=useState(60),[error,setError]=useState(''),[busy,setBusy]=useState(false),[stoppingAgent,setStoppingAgent]=useState(false);
  const scope=useRef(0),request=useRef(0),input=useRef(null);
  const refresh=useCallback(async()=>{
    const generation=scope.current,serial=++request.current;
    try{const value=await api.invoke('terminal.list',{conversationId});if(generation===scope.current&&serial===request.current){setState(value);setError('');}}
    catch(failure){if(generation===scope.current&&serial===request.current)setError(message(failure));}
  },[conversationId]);
  useEffect(()=>{++scope.current;setState({workspace:'',entries:[]});setCommand('');setError('');setBusy(false);refresh();const unsubscribe=api.onEvent(event=>{if(event.type==='terminal.changed'&&(event.conversationId||null)===(conversationId||null))refresh();});return()=>{++scope.current;unsubscribe();};},[conversationId,refresh]);
  useEffect(()=>{if(tab==='direct')input.current?.focus({preventScroll:true});},[tab]);
  const run=async event=>{
    event.preventDefault();if(busy||!command.trim())return;
    const generation=scope.current;setBusy(true);setError('');
    try{await api.invoke('terminal.start',{conversationId,command,timeoutSeconds:timeout});if(generation===scope.current){setCommand('');await refresh();}}
    catch(failure){if(generation===scope.current)setError(message(failure));}
    finally{if(generation===scope.current)setBusy(false);}
  };
  const stop=async id=>{try{await api.invoke('terminal.stop',{conversationId,id});await refresh();}catch(failure){setError(message(failure));}};
  const stopAgent=async()=>{if(!onStopAgent)return;setStoppingAgent(true);try{await onStopAgent();}catch(failure){setError(message(failure));}finally{setStoppingAgent(false);}};
  const agentRows=agentCommandRows(messages,{running});
  return <section className="terminal-panel" aria-label="Terminal">
    <div className="terminal-panel-head"><strong><Terminal size={16}/>Terminal</strong><span>Advanced</span><button type="button" className="icon-button" aria-label="Close terminal" onClick={onClose}><X size={16}/></button></div>
    <div role="tablist" aria-label="Terminal views" className="terminal-tabs"><button type="button" role="tab" id="terminal-interactive-tab" aria-controls="terminal-interactive" aria-selected={tab==='interactive'} onClick={()=>setTab('interactive')}>Interactive sessions</button><button type="button" role="tab" id="terminal-direct-tab" aria-controls="terminal-direct" aria-selected={tab==='direct'} onClick={()=>setTab('direct')}>Direct commands</button><button type="button" role="tab" id="terminal-agent-tab" aria-controls="terminal-agent" aria-selected={tab==='agent'} onClick={()=>setTab('agent')}>Agent commands{agentRows.length?` (${agentRows.length})`:''}</button></div>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {tab==='interactive'?<div role="tabpanel" id="terminal-interactive" aria-labelledby="terminal-interactive-tab"><InteractiveSessions conversationId={conversationId} sessions={state.sessions} owner="user" onRefresh={refresh} onError={setError}/></div>:tab==='direct'?<div role="tabpanel" id="terminal-direct" aria-labelledby="terminal-direct-tab">
      <p className="terminal-context">Run a bounded PowerShell command using this chat’s permission level and rules. Each direct command starts a fresh process. Use Interactive sessions for persistent shells and interactive programs.</p>
      <p className="terminal-workspace"><strong>Working folder</strong><code>{state.workspace||'No workspace available'}</code></p>
      <form className="terminal-command-form" onSubmit={run}><label htmlFor="terminal-command">PowerShell command</label><textarea id="terminal-command" ref={input} value={command} maxLength={16000} rows={3} spellCheck={false} placeholder="Get-ChildItem" onChange={event=>setCommand(event.target.value)} onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();event.currentTarget.form.requestSubmit();}}}/><div><label>Time limit <select aria-label="Command time limit" value={timeout} onChange={event=>setTimeoutSeconds(Number(event.target.value))}><option value={30}>30 seconds</option><option value={60}>60 seconds</option><option value={120}>2 minutes</option></select></label><button type="button" className="text-button" onClick={refresh}><RefreshCw size={13}/>Refresh</button><button type="submit" className="secondary-button" disabled={busy||!command.trim()||!state.workspace}>{busy?<LoaderCircle size={13} className="spin"/>:<Play size={13}/>}Run command</button></div></form>
      <p className="terminal-context">Commands run with your Windows account’s permissions. Up to 20 recent transcripts across all chats stay in memory until Exomina closes; copy output into chat when you want the AI to use it. A zero exit code reports process completion, without verifying its effects. Closing this panel keeps running commands active until they finish or reach their time limit.</p>
      <div className="terminal-history" aria-label="Direct command history">{state.entries.length?state.entries.slice().reverse().map(entry=><CommandOutput key={entry.id} entry={entry} direct onStop={stop}/>):<p className="terminal-empty">No direct commands in this chat yet.</p>}</div>
    </div>:<div role="tabpanel" id="terminal-agent" aria-labelledby="terminal-agent-tab">
      <InteractiveSessions conversationId={conversationId} sessions={state.sessions} owner="agent" onRefresh={refresh} onError={setError}/>
      <NativeTerminals conversationId={conversationId} onError={setError}/>
      <div className="terminal-agent-intro"><p className="terminal-context">Command receipts below are reported by the provider and can be shortened. Internal provider terminals are separate from the shared sessions above; their input is not exposed by the provider protocol.</p>{running&&onStopAgent&&<button type="button" className="secondary-button" disabled={stoppingAgent} onClick={stopAgent}><Square size={13}/>{stoppingAgent?'Stopping task…':'Stop agent task'}</button>}</div>
      {running&&<p className="terminal-context">Stop agent task ends this chat’s active task and shared AI sessions. Supported native terminals can be stopped individually above; providers that supply command receipts only use whole-task Stop.</p>}
      <div className="terminal-history" aria-label="Agent command history">{agentRows.length?agentRows.slice().reverse().map(entry=><CommandOutput key={entry.id} entry={entry}/>):<p className="terminal-empty">No agent command activity was reported in this chat.</p>}</div>
    </div>}
  </section>;
}
