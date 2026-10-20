import React from 'react';
import './sidebar-navigation.css';

export default function SidebarNav({items,page,onNavigate,newMemoryCount=0,needsConnection=false}){
 return <nav className="nav-list sidebar-navigation" aria-label="Main navigation">{items.map(({id,label,icon:Icon})=><button type="button" key={id} aria-label={label} aria-current={page===id?'page':undefined} aria-describedby={id==='memory'&&newMemoryCount>0?'new-memory-description':undefined} title={label} className={`nav-item nav-utility ${page===id?'active':''}`} onClick={()=>onNavigate(id)}>
  <Icon size={16} strokeWidth={1.7}/><span>{id==='workbench'?'Projects':label}</span>
  {id==='memory'&&newMemoryCount>0&&<><span className="nav-dot memory-update-dot" role="img" aria-label="New memories"/><span className="sr-only" id="new-memory-description">{newMemoryCount} new memories to review</span></>}
  {id==='connections'&&needsConnection&&<span className="nav-dot"/>}
 </button>)}</nav>;
}
