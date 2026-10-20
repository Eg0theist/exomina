import React, { useEffect, useRef, useState } from 'react';
import { api } from './transport.js';
import { ArrowUp, X } from 'lucide-react';
import { applyAppearance } from './appearance.js';
export default function QuickAsk(){
  const [text,setText]=useState(''),[state,setState]=useState({connections:[]}),[provider,setProvider]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const question=useRef(null);
  useEffect(()=>{const load=()=>api.invoke('quick.state').then(s=>{setState(s);setProvider(s.connections.some(c=>c.id===s.provider)?s.provider:s.connections[0]?.id||'');applyAppearance(s.appearance);question.current?.focus();}).catch(e=>setError(e.message));load();return api.onEvent(e=>{if(e.type==='quick.focus')load();});},[]);
  const send=async e=>{e.preventDefault();if(busy||!text.trim()||!provider)return;setBusy(true);setError('');try{await api.invoke('quick.submit',{text,provider});setText('');}catch(e){setError(e.message);}finally{setBusy(false);}};
  return <div className="quick-ask" onKeyDown={e=>{if(e.key==='Escape')api.invoke('quick.dismiss');}}><div className="quick-heading"><strong>Ask Exomina</strong><small>Ctrl + Shift + Space</small><button className="icon-button" aria-label="Close quick access" onClick={()=>api.invoke('quick.dismiss')}><X size={17}/></button></div><form onSubmit={send}><textarea ref={question} aria-label="Quick question" autoFocus placeholder="What would you like to do?" value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send(e);}}}/>{error&&<p className="inline-error">{error}</p>}<div className="quick-actions"><select aria-label="Quick question AI" value={provider} onChange={e=>setProvider(e.target.value)}>{!state.connections.length&&<option value="">Connect an AI first</option>}{state.connections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><span>Opens a full chat for the reply</span><button className="send-button" disabled={busy||!text.trim()||!provider} aria-label="Send quick question"><ArrowUp size={18}/></button></div></form></div>;
}
