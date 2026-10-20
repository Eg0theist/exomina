import React,{useEffect,useRef,useState} from 'react';
import {Terminal as Xterm} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {api} from './transport.js';

/** A view of one host-owned PTY; moving this DOM between workspace windows
 * preserves the xterm instance and its input/output cursor. */
export default function PtyTerminal({conversationId,session,onError}){
  const host=useRef(null),instance=useRef(null),status=useRef(session?.status),[documentEpoch,setDocumentEpoch]=useState(0);status.current=session?.status;
  useEffect(()=>{
    if(!session?.id||!host.current)return;
    let disposed=false,cursor=0,reading=false,requested=false,resizeTimer,writeQueue=Promise.resolve();const ownerDocument=host.current.ownerDocument;
    const terminal=new Xterm({fontFamily:'Consolas, monospace',fontSize:12,scrollback:3000,screenReaderMode:true,allowProposedApi:false,disableStdin:session.status!=='running',cursorBlink:true,theme:{background:'#111318',foreground:'#e2e7ef',cursor:'#8fe1c0'},linkHandler:{activate:()=>{},hover:()=>{},leave:()=>{}},windowOptions:{}}),fit=new FitAddon();instance.current=terminal;
    terminal.loadAddon(fit);terminal.open(host.current);terminal.textarea?.setAttribute('aria-label','Interactive terminal input');
    // Terminal output cannot read/write the clipboard or open links for the user.
    const clipboard=terminal.parser.registerOscHandler(52,()=>true);
    const send=text=>{writeQueue=writeQueue.then(()=>disposed?null:api.invoke('terminal.input',{conversationId,id:session.id,text})).catch(error=>{if(!disposed)onError?.(error.message||String(error));});};
    const input=terminal.onData(send);
    const resize=terminal.onResize(size=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(!disposed&&status.current==='running'&&size.cols>=20&&size.rows>=5)api.invoke('terminal.resize',{conversationId,id:session.id,...size}).catch(error=>{if(!disposed&&status.current==='running')onError?.(error.message||String(error));});},100);});
    const measure=()=>{if(disposed)return;if(host.current?.ownerDocument!==ownerDocument){setDocumentEpoch(value=>value+1);return;}if(host.current?.clientWidth&&host.current?.clientHeight)try{fit.fit();}catch{}};
    const observer=new ResizeObserver(measure);observer.observe(host.current);measure();
    const documentObserver=new MutationObserver(measure);documentObserver.observe(ownerDocument.body,{childList:true,subtree:true});
    const drain=async()=>{
      requested=true;if(reading)return;reading=true;
      try{do{requested=false;let more=true;while(more&&!disposed){const value=await api.invoke('terminal.read',{conversationId,id:session.id,cursor,limit:64000});if(disposed)return;if(value.truncated)terminal.reset();if(value.text)terminal.write(value.text);cursor=value.nextCursor;more=value.hasMore;}}while(requested&&!disposed);}
      catch(error){if(!disposed)onError?.(error.message||String(error));}finally{reading=false;}
    };
    drain();const unsubscribe=api.onEvent(event=>{if(event.type==='terminal.changed'&&event.conversationId===conversationId)drain();});
    return()=>{disposed=true;clearTimeout(resizeTimer);unsubscribe();observer.disconnect();documentObserver.disconnect();input.dispose();resize.dispose();clipboard.dispose();terminal.dispose();instance.current=null;};
  },[conversationId,session?.id,documentEpoch]);
  useEffect(()=>{const terminal=instance.current;if(terminal){terminal.options.disableStdin=session?.status!=='running';if(session?.status==='running'&&terminal.cols>=20&&terminal.rows>=5)api.invoke('terminal.resize',{conversationId,id:session.id,cols:terminal.cols,rows:terminal.rows}).catch(error=>onError?.(error.message||String(error)));}},[session?.status]);
  return <div ref={host} className="terminal-live-screen" data-pty-session={session?.id} aria-label={`${session?.owner==='agent'?'Agent':'Your'} interactive terminal output`} onPointerDown={()=>instance.current?.focus()}/>;
}
