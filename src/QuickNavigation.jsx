import React,{useLayoutEffect,useMemo,useRef,useState} from 'react';
import {ArrowRight,Search,X} from 'lucide-react';
import {settingsDestinations} from './SettingsLayout.jsx';
import {findDestinations} from './navigation-search.js';
import './quick-navigation.css';

const pages=[
  {id:'chat',label:'Current chat',description:'Return to your conversation and draft.',keywords:'home conversation chat message',category:'Go to'},
  {id:'workbench',label:'Projects & prompts',description:'Your projects, reusable prompts and work plans.',keywords:'workspace folder task plan prompt',category:'Go to',desktop:true},
  {id:'tools',label:'Tools',description:'Browser, computer use, files and app analysis.',keywords:'ghidra reverse engineering read write shell terminal browser computer',category:'Go to'},
  {id:'memory',label:'Saved memories',description:'Find, review and correct saved context.',keywords:'memory notes history context remember',category:'Go to'},
  {id:'connections',label:'AI connections',description:'Manage your connected AI accounts.',keywords:'login sign in provider subscription account',category:'Go to'},
  {id:'tutorials',label:'Tutorials',description:'Guided introductions to Exomina.',keywords:'help guide getting started learn',category:'Go to'},
];

export default function QuickNavigation({desktop,onNavigate,onSettings,onClose}) {
  const [query,setQuery]=useState(''),[selected,setSelected]=useState(0),dialog=useRef(null);
  const items=useMemo(()=>[...pages.filter(item=>!item.desktop||desktop),...settingsDestinations(desktop)],[desktop]);
  const matches=useMemo(()=>findDestinations(items,query),[items,query]),results=matches.slice(0,14);
  const active=results[Math.min(selected,results.length-1)];
  useLayoutEffect(()=>{const previous=document.activeElement;dialog.current.showModal();return()=>{dialog.current?.close();if(previous?.isConnected)previous.focus({preventScroll:true});};},[]);
  useLayoutEffect(()=>{if(active)document.getElementById('quick-nav-'+active.id)?.scrollIntoView({block:'nearest'});},[active?.id]);
  function choose(item){if(!item)return;onClose();if(item.section)onSettings(item.section);else onNavigate(item.id);}
  return <dialog ref={dialog} className="quick-navigation" aria-labelledby="quick-nav-title" onCancel={event=>{event.preventDefault();onClose();}} onPointerDown={event=>{if(event.target!==event.currentTarget)return;const bounds=event.currentTarget.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)onClose();}}>
    <div className="quick-nav-heading"><h2 id="quick-nav-title">Find a feature</h2><button type="button" className="icon-button" aria-label="Close feature search" onClick={onClose}><X size={17}/></button></div>
    <div className="quick-nav-search"><Search size={18}/><input autoFocus role="combobox" aria-label="Find a feature" aria-expanded="true" aria-controls="quick-nav-results" aria-autocomplete="list" aria-activedescendant={active?'quick-nav-'+active.id:undefined} placeholder="Try phone, approvals, backup or voice…" value={query} maxLength={160} onChange={event=>{setQuery(event.target.value);setSelected(0);}} onKeyDown={event=>{
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setSelected(index=>results.length?(index+(event.key==='ArrowDown'?1:-1)+results.length)%results.length:0);}
      if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();choose(active);}
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}
    }}/></div>
    <div id="quick-nav-results" className="quick-nav-results" role="listbox" aria-label="Features">{results.map((item,index)=><button type="button" role="option" tabIndex={-1} aria-selected={item===active} id={'quick-nav-'+item.id} key={item.id} onMouseMove={()=>setSelected(index)} onClick={()=>choose(item)}><span><small>{item.category}</small><strong>{item.label}</strong><span>{item.description}</span></span><ArrowRight size={16}/></button>)}</div>
    <p className="quick-nav-status">{matches.length?`${matches.length} ${matches.length===1?'destination':'destinations'}${matches.length>results.length?'; type to narrow the results':''}. Arrow keys to choose, Enter to open.`:'No matching feature. Try “memory”, “phone” or “permissions”.'}</p>
  </dialog>;
}
