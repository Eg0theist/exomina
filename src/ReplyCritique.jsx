import React,{useCallback,useRef,useState} from 'react';
import {ShieldCheck} from 'lucide-react';
import {ProviderMark,providerReady} from './ProviderConnections.jsx';
import {critiqueRequest} from './critique-request.js';
import {temporarySupported} from '../desktop/privacy.mjs';
import useDismiss from './useDismiss.js';

export default function ReplyCritique({request,text,current,catalog,connections,onAsk}) {
  const [open,setOpen]=useState(false),area=useRef(null),close=useCallback(()=>setOpen(false),[]);
  useDismiss(area,open,close);
  const ready=catalog.filter(item=>item.id!==current&&temporarySupported(item.id)&&providerReady(connections.find(connection=>connection.id===item.id)));
  if(!ready.length||!text?.trim())return null;
  return <div className="message-actions reply-critique"><span className="ask-another" ref={area}><button type="button" className="copy-button" aria-expanded={open} onClick={()=>setOpen(value=>!value)} title="Ask a different connected AI to challenge this reply without tools."><ShieldCheck size={13}/>Critique reply</button>{open&&<div className="popover ask-another-menu" role="menu" aria-label="Choose a reviewer"><p className="quick-nav-status">Sends the quoted request and reply to the selected account and uses its allowance. No tools or files. Earlier conversation may contain requirements this excerpt misses.</p>{ready.map(item=><button type="button" role="menuitem" key={item.id} onClick={()=>{close();onAsk(critiqueRequest(request,text),item.id,{review:true});}}><ProviderMark provider={item.id} info={item} small/><span>{item.name}</span></button>)}</div>}</span></div>;
}
