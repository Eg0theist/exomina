import React, {useEffect, useRef, useState} from 'react';
import {SlidersHorizontal, X} from 'lucide-react';

/** Secondary chat controls keep their state while the disclosure is closed. */
export default function ComposerOptions({children, memoryEnabled, privateChat=false}) {
  const [open,setOpen]=useState(false),area=useRef(null),trigger=useRef(null);
  useEffect(()=>{
    if(!open)return;
    const outside=event=>{if(!area.current?.contains(event.target))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  function close(){setOpen(false);trigger.current?.focus({preventScroll:true});}
  if(privateChat)return null;
  return <div className="composer-options" ref={area} onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();close();}}}>
    <button ref={trigger} type="button" className="composer-chip composer-options-trigger" aria-label={`Chat context and options. Memory ${memoryEnabled?'on':'off'}`} aria-expanded={open} aria-controls="chat-context-options" onClick={()=>setOpen(value=>!value)}><SlidersHorizontal size={15}/><span>Context</span></button>
    <section id="chat-context-options" className="composer-options-panel" aria-label="Chat context and options" hidden={!open}>
      <header><strong>Chat context</strong><button type="button" className="icon-button" aria-label="Close chat context" onClick={close}><X size={15}/></button></header>
      <div className="composer-options-fields">{children}</div>
    </section>
  </div>;
}
