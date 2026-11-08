import {useLayoutEffect,useRef,useState} from 'react';

const KEY='exomina.terminal.panelHeight',DEFAULT=400;
const saved=()=>{try{const value=Number(localStorage.getItem(KEY));if(Number.isFinite(value)&&value>=180&&value<=4000)return value;}catch{}return DEFAULT;};

/** Resize the entire docked panel, leaving room for the actual composer above.
 * A workspace pane already has its own divider and supplies its own height. */
export default function useTerminalPanelSize(fill,tab){
 const ref=useRef(null),drag=useRef(null),[preferred,setPreferred]=useState(saved),[limits,setLimits]=useState({min:240,max:600});
 const current=useRef(limits);current.current=limits;
 useLayoutEffect(()=>{
  const panel=ref.current;if(!panel||fill)return;
  const shell=panel.parentElement,composer=shell.querySelector('.chat-page .composer-region'),editor=composer?.querySelector('.composer textarea');
  const measure=()=>{
   const fixed=[...shell.children].filter(child=>child!==panel&&!child.classList.contains('chat-page')).reduce((sum,child)=>{const style=getComputedStyle(child);return style.position==='absolute'||style.position==='fixed'?sum:sum+child.getBoundingClientRect().height;},0);
   const style=getComputedStyle(panel),margin=(parseFloat(style.marginTop)||0)+(parseFloat(style.marginBottom)||0);
   // The editor's saved height is a preference, not permission to cover the
   // console. Account for wrapped terminal controls in narrow windows too.
   const toolbar=panel.querySelector('#terminal-interactive .terminal-live-toolbar'),minimum=Math.max(280,Math.ceil(230+(toolbar?.getBoundingClientRect().height||50)));
   const composerChrome=editor?composer.getBoundingClientRect().height-editor.getBoundingClientRect().height:160;
   const reserve=Math.max(0,Math.min(40,shell.clientHeight-fixed-margin-minimum-composerChrome-66));
   if(editor){
    const editorLimit=Math.max(66,Math.min(150,Math.floor(shell.clientHeight-fixed-margin-minimum-composerChrome-reserve)));
    const css=editorLimit+'px';if(shell.style.getPropertyValue('--terminal-composer-limit')!==css)shell.style.setProperty('--terminal-composer-limit',css);
   }
   const max=Math.max(180,Math.floor(shell.clientHeight-fixed-(composer?.getBoundingClientRect().height||160)-margin-reserve)),min=Math.min(minimum,max);
   setLimits(previous=>previous.min===min&&previous.max===max?previous:{min,max});
  };
  const observer=new ResizeObserver(measure);observer.observe(shell);if(composer)observer.observe(composer);
  const toolbar=panel.querySelector('#terminal-interactive .terminal-live-toolbar');if(toolbar)observer.observe(toolbar);
  for(const child of shell.children)if(child!==panel&&!child.classList.contains('chat-page'))observer.observe(child);
  measure();return()=>{observer.disconnect();shell.style.removeProperty('--terminal-composer-limit');};
 },[fill,tab]);
 const height=Math.round(Math.max(limits.min,Math.min(limits.max,preferred)));
 const clamp=value=>Math.round(Math.max(current.current.min,Math.min(current.current.max,value)));
 const remember=value=>{setPreferred(value);try{localStorage.setItem(KEY,String(value));}catch{}};
 const finish=(event,cancel=false)=>{if(!drag.current||event.pointerId!==drag.current.id)return;const active=drag.current;drag.current=null;if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);cancel?setPreferred(active.previous):remember(active.next);};
 return {ref,style:fill?undefined:{'--terminal-panel-height':height+'px','--terminal-panel-max-height':limits.max+'px'},handleProps:{
  role:'separator','aria-label':'Resize terminal panel','aria-orientation':'horizontal','aria-valuemin':limits.min,'aria-valuemax':limits.max,'aria-valuenow':height,tabIndex:0,
  title:'Drag to resize terminal · double-click to reset',
  onPointerDown:event=>{if(event.button!==0)return;event.preventDefault();drag.current={id:event.pointerId,y:event.clientY,height,previous:preferred,next:height};event.currentTarget.setPointerCapture(event.pointerId);},
  onPointerMove:event=>{const active=drag.current;if(!active||active.id!==event.pointerId)return;active.next=clamp(active.height+active.y-event.clientY);setPreferred(active.next);},
  onPointerUp:event=>finish(event),onPointerCancel:event=>finish(event,true),
  onKeyDown:event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();remember(event.key==='Home'?limits.min:event.key==='End'?limits.max:clamp(height+(event.key==='ArrowUp'?40:-40)));},
  onDoubleClick:()=>remember(DEFAULT),
 }};
}
