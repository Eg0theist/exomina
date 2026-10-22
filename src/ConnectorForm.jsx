import React,{useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import './connector-forms.css';

export default function ConnectorForm({request,chatTitle,onRespond}){
  const [values,setValues]=useState({}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[escapeHint,setEscapeHint]=useState(false);
  const dialog=useRef(null);
  useLayoutEffect(()=>{
    const previous=document.activeElement,frame=document.querySelector('.app-frame'),wasInert=frame?.inert;
    if(frame)frame.inert=true;
    (dialog.current?.querySelector('input,select,textarea')||dialog.current)?.focus({preventScroll:true});
    const keyboard=event=>{
      if((event.ctrlKey||event.metaKey)&&['n',',','f'].includes(event.key.toLowerCase())){event.preventDefault();event.stopImmediatePropagation();}
      // Escape is also used to leave no-HUD mode. Cancellation requires its
      // visible button, so changing presentation cannot cancel a pending action.
      else if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();setEscapeHint(true);}
      else if(event.key==='Tab')keydown(event);
    };
    document.addEventListener('keydown',keyboard,true);
    return ()=>{document.removeEventListener('keydown',keyboard,true);if(frame)frame.inert=wasInert;if(previous?.isConnected&&!previous.closest('[inert]'))previous.focus?.({preventScroll:true});};
  },[request.id]);
  const change=(name,value)=>setValues(previous=>({...previous,[name]:value}));
  async function respond(action){
    if(busy)return;setBusy(true);setError('');
    try{
      const content={};
      if(action==='accept')for(const field of request.fields){
        const value=values[field.name]??(field.type==='array'&&field.required?[]:undefined);
        if(value===undefined||value===''&&!field.required)continue;
        content[field.name]=['number','integer'].includes(field.type)?Number(value):field.type==='boolean'?value==='true':value;
      }
      await onRespond({id:request.id,action,...(action==='accept'?{content}:{})});
    }catch(reason){setError(reason.message||String(reason));setBusy(false);}
  }
  const keydown=event=>{
    if(event.key!=='Tab')return;
    const controls=[...dialog.current.querySelectorAll('input,select,button,textarea')].filter(element=>!element.disabled),first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&(document.activeElement===first||!dialog.current.contains(document.activeElement))){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||!dialog.current.contains(document.activeElement))){event.preventDefault();first?.focus();}
  };
  return createPortal(<div className="modal-backdrop connector-backdrop"><section ref={dialog} tabIndex={-1} className="modal connector-modal" role="dialog" aria-modal="true" aria-labelledby="connector-title">
    <h2 id="connector-title">{request.serverName} needs your input</h2>
    <p className="connector-chat">{chatTitle||'Active task'}</p><p className="connector-message">{request.message}</p>
    <p className="connector-transfer">Send these answers to {request.serverName} to continue.</p>
    {escapeHint&&<p role="status">This request is still waiting. Choose an action below, or use Cancel to dismiss it.</p>}
    <form onSubmit={event=>{event.preventDefault();respond('accept');}}>
      <div className="connector-fields">{request.fields.map((field,index)=>{
        const id='connector-field-'+index,value=values[field.name]??'';
        return <div className="connector-field" key={field.name}><label htmlFor={id}>{field.label}{field.required?' *':''}</label>{field.description&&<p id={id+'-description'}>{field.description}</p>}
          {field.type==='array'?<fieldset id={id} aria-label={field.label}><legend className="sr-only">{field.label}</legend>{field.options.map(option=><label className="connector-choice" key={option.value}><input type="checkbox" disabled={busy} checked={(values[field.name]||[]).includes(option.value)} onChange={event=>change(field.name,event.target.checked?[...(values[field.name]||[]),option.value]:(values[field.name]||[]).filter(entry=>entry!==option.value))}/>{option.label}</label>)}</fieldset>:
          field.options||field.type==='boolean'?<select id={id} value={value} required={field.required} disabled={busy} onChange={event=>change(field.name,event.target.value)}><option value="">Choose…</option>{(field.options||[{value:'true',label:'Yes'},{value:'false',label:'No'}]).map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>:
          <input id={id} disabled={busy} value={value} required={field.required} aria-describedby={field.description?id+'-description':undefined} type={['number','integer'].includes(field.type)?'number':field.format==='email'?'email':field.format==='date'?'date':'text'} min={field.minimum} max={field.maximum} step={field.type==='integer'?1:'any'} maxLength={field.type==='string'?8000:undefined} onChange={event=>change(field.name,event.target.value)}/>}</div>;
      })}</div>
      {error&&<p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>respond('cancel')}>Cancel</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>respond('decline')}>Decline</button><button className="primary-button" disabled={busy}>{busy?'Sending…':'Send answers'}</button></div>
    </form>
  </section></div>,document.body);
}
