import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ChevronDown, Columns2, ExternalLink, GripVertical, MoreHorizontal, RotateCcw, X} from 'lucide-react';
import {api} from './transport.js';
import {WORKFLOW_PANELS, WORKFLOW_PANEL_LABELS, createWorkflowLayout, createWorkflowPreset, workflowDropIndex, normalizeWorkflowLayout, moveWorkflowPanel, removeWorkflowPanel, setWorkflowActive, floatWorkflowPanel, readWorkflowPreferences, writeWorkflowPreferences} from './workflow-layout.js';
import './workflow-workspace.css';
import {LayoutPreview} from './WorkspaceMap.jsx';

const labels=WORKFLOW_PANEL_LABELS;
const groups=['right','bottom'];
const defaultGroup=panel=>['terminal','workbench'].includes(panel)?'bottom':'right';
const boundsOf=child=>({x:Math.round(child.screenX),y:Math.round(child.screenY),width:Math.round(child.outerWidth),height:Math.round(child.outerHeight)});
const layoutStorage=()=>{try{return window.localStorage;}catch{return null;}};
function usePopupAnchor(open,anchor,width){
  const [position,setPosition]=useState({top:50,left:12});
  useLayoutEffect(()=>{
    if(!open||!anchor.current)return;
    const view=anchor.current.ownerDocument.defaultView;
    const measure=()=>{const rect=anchor.current?.getBoundingClientRect();if(rect)setPosition({position:'fixed',top:Math.max(8,Math.min(view.innerHeight-150,rect.bottom+7)),left:Math.max(8,Math.min(view.innerWidth-width-8,rect.right-width)),maxHeight:`${Math.max(120,view.innerHeight-rect.bottom-16)}px`});};
    measure();view.addEventListener('resize',measure);view.addEventListener('scroll',measure,true);return()=>{view.removeEventListener('resize',measure);view.removeEventListener('scroll',measure,true);};
  },[open,anchor,width]);
  return position;
}

// One React owner and one portal container per panel. Moving the container between
// documents keeps note edits, console input and component state alive.
export function useWorkflowWorkspace({available=false,suspended=false,onError}) {
  const [preferences,setPreferences]=useState(()=>readWorkflowPreferences(available?layoutStorage():null));
  const [menuOpen,setMenuOpen]=useState(false),[panelMenuOpen,setPanelMenuOpen]=useState(null),[windows,setWindows]=useState({}),[resizing,setResizing]=useState(false),[reconcile,setReconcile]=useState(0);
  const preferencesRef=useRef(preferences),windowsRef=useRef(windows),opening=useRef(new Set()),generation=useRef(0),panelGeneration=useRef({}),mounted=useRef(true);
  preferencesRef.current=preferences;windowsRef.current=windows;
  const enabled=available&&preferences.current.enabled;
  const active=enabled&&!suspended;
  const activeRef=useRef(active);activeRef.current=active;
  const commit=useCallback(change=>setPreferences(previous=>{const next=typeof change==='function'?change(previous):change;return {...next,current:normalizeWorkflowLayout(next.current)};}),[]);
  const changeLayout=useCallback(update=>commit(previous=>({...previous,current:typeof update==='function'?update(previous.current):update})),[commit]);
  useEffect(()=>{if(available&&!writeWorkflowPreferences(layoutStorage(),preferences))onError?.('This layout is available for this session, but could not be saved on this device.');},[available,preferences]);
  const closeWindow=useCallback(async panel=>{
    const item=windowsRef.current[panel];if(!item)return;
    item.themeObserver.disconnect();
    const remaining={...windowsRef.current};delete remaining[panel];windowsRef.current=remaining;
    setWindows(previous=>{const next={...previous};delete next[panel];return next;});
    try{await api.invoke('workspace.window.close',{id:item.id});}catch{try{item.child.close();}catch{}}
  },[]);
  const move=useCallback((panel,group,index)=>{panelGeneration.current[panel]=(panelGeneration.current[panel]||0)+1;changeLayout(layout=>moveWorkflowPanel(layout,panel,group,index));closeWindow(panel);},[changeLayout,closeWindow]);
  const hide=useCallback(panel=>{panelGeneration.current[panel]=(panelGeneration.current[panel]||0)+1;changeLayout(layout=>removeWorkflowPanel(layout,panel));closeWindow(panel);},[changeLayout,closeWindow]);
  const hasPanel=panel=>groups.some(name=>preferences.current.groups[name].panels.includes(panel))||preferences.current.floating.some(item=>item.panel===panel);
  const show=useCallback(panel=>{
    const current=preferencesRef.current.current;
    const group=groups.find(name=>current.groups[name].panels.includes(panel));
    if(group)changeLayout(layout=>setWorkflowActive({...layout,enabled:true},group,panel));
    else if(current.floating.some(item=>item.panel===panel)){windowsRef.current[panel]?.child.focus();}
    else move(panel,defaultGroup(panel));
  },[changeLayout,move]);
  const dock=useCallback((panel,group=defaultGroup(panel))=>move(panel,group),[move]);
  const openFloating=useCallback(async(panel,bounds)=>{
    if(opening.current.has(panel)||windowsRef.current[panel])return;
    opening.current.add(panel);const epoch=generation.current,panelEpoch=panelGeneration.current[panel]||0;
    const stale=()=>!mounted.current||epoch!==generation.current||panelEpoch!==(panelGeneration.current[panel]||0);
    let id,child;
    try{
      id=`panel-${panel}-${crypto.randomUUID()}`;
      const prepared=await api.invoke('workspace.window.prepare',{id,panel,title:labels[panel],...(bounds?{bounds}:{})});
      if(stale()){await api.invoke('workspace.window.close',{id});return;}
      child=window.open(prepared.url,`exomina-panel-${id}`,`popup,width=${bounds?.width||760},height=${bounds?.height||640}`);
      if(!child)throw Error('The panel window could not be opened. Your panel remains docked.');
      await new Promise((resolve,reject)=>{
        let finished=false;
        const done=()=>{if(finished)return;finished=true;clearTimeout(timer);resolve();};
        const timer=setTimeout(()=>{if(finished)return;finished=true;reject(Error('The panel window did not become ready.'));},10000);
        if(child.document.readyState==='complete'&&child.location.hash.startsWith('#workspace-panel='))done();else child.addEventListener('load',done,{once:true});
      });
      if(stale()){await api.invoke('workspace.window.close',{id});return;}
      const target=child.document.getElementById('root');if(!target)throw Error('The panel window has no content area.');
      target.replaceChildren();
      for(const item of document.querySelectorAll('link[rel="stylesheet"],style'))child.document.head.appendChild(item.cloneNode(true));
      const syncTheme=()=>{child.document.documentElement.className=`${document.documentElement.className} workflow-floating-document`;for(const attribute of document.documentElement.attributes)if(attribute.name==='style'||attribute.name.startsWith('data-'))child.document.documentElement.setAttribute(attribute.name,attribute.value);};
      syncTheme();const themeObserver=new MutationObserver(syncTheme);themeObserver.observe(document.documentElement,{attributes:true});
      const content=child.document.createElement('div');content.className='workflow-floating-slot';target.appendChild(content);
      const record={id,child,target:content,themeObserver};
      setWindows(previous=>({...previous,[panel]:record}));
      changeLayout(layout=>floatWorkflowPanel(layout,panel,boundsOf(child)));
    }catch(error){
      if(id)await api.invoke('workspace.window.close',{id}).catch(()=>{});
      if(!stale()){changeLayout(layout=>moveWorkflowPanel(layout,panel,defaultGroup(panel)));onError?.(String(error.message||error));}
    }finally{opening.current.delete(panel);if(stale()&&mounted.current&&activeRef.current&&preferencesRef.current.current.floating.some(item=>item.panel===panel))setReconcile(value=>value+1);}
  },[changeLayout,onError]);
  useEffect(()=>api.onEvent(event=>{
    if(event.type==='workspace.window.bounds'){
      const panel=Object.keys(windowsRef.current).find(key=>windowsRef.current[key].id===event.id);
      if(panel&&event.bounds)changeLayout(layout=>({...layout,floating:layout.floating.map(item=>item.panel===panel?{...item,bounds:event.bounds}:item)}));
      return;
    }
    if(event.type!=='workspace.window.closed')return;
    const panel=Object.keys(windowsRef.current).find(key=>windowsRef.current[key].id===event.id);if(!panel)return;
    windowsRef.current[panel].themeObserver.disconnect();
    setWindows(previous=>{const next={...previous};delete next[panel];return next;});
    changeLayout(layout=>layout.floating.some(item=>item.panel===panel)?moveWorkflowPanel(layout,panel,defaultGroup(panel)):layout);
  }),[changeLayout]);
  useEffect(()=>{
    if(!active){generation.current++;setMenuOpen(false);setPanelMenuOpen(null);for(const panel of Object.keys(windowsRef.current))closeWindow(panel);return;}
    for(const item of preferences.current.floating)openFloating(item.panel,item.bounds);
    for(const panel of Object.keys(windowsRef.current))if(!preferences.current.floating.some(item=>item.panel===panel))closeWindow(panel);
  },[active,preferences.current.floating,openFloating,closeWindow,reconcile]);
  useEffect(()=>{
    mounted.current=true;
    return()=>{mounted.current=false;generation.current++;for(const item of Object.values(windowsRef.current)){item.themeObserver.disconnect();api.invoke('workspace.window.close',{id:item.id}).catch(()=>{});}};
  },[]);
  const reset=useCallback(()=>{generation.current++;for(const panel of Object.keys(windowsRef.current))closeWindow(panel);changeLayout(createWorkflowLayout());},[changeLayout,closeWindow]);
  const restore=useCallback(name=>{const saved=preferencesRef.current.saved.find(item=>item.name===name);if(!saved)return;generation.current++;for(const panel of Object.keys(windowsRef.current))closeWindow(panel);changeLayout(saved.layout);},[changeLayout,closeWindow]);
  const preset=useCallback(name=>{generation.current++;for(const panel of Object.keys(windowsRef.current))closeWindow(panel);changeLayout(createWorkflowPreset(name));},[changeLayout,closeWindow]);
  const snapshot=()=>{
    const layout=normalizeWorkflowLayout(preferencesRef.current.current);
    layout.floating=layout.floating.map(item=>({...item,bounds:windowsRef.current[item.panel]?boundsOf(windowsRef.current[item.panel].child):item.bounds}));
    return layout;
  };
  return {available,enabled,active,suspended,layout:preferences.current,saved:preferences.saved,windows,menuOpen,setMenuOpen,panelMenuOpen,setPanelMenuOpen,resizing,setResizing,changeLayout,move,hide,show,dock,detach:openFloating,hasPanel,reset,restore,preset,
    visible:panel=>active&&(groups.some(name=>preferences.current.groups[name].active===panel)||!!windows[panel]),
    browserOwner:active?windows.browser?.id||null:null,
    save:name=>{const title=name.trim().slice(0,60);if(!title)return;const layout=snapshot();commit(previous=>({...previous,saved:[...previous.saved.filter(item=>item.name.toLocaleLowerCase()!==title.toLocaleLowerCase()),{name:title,layout}].slice(-20)}));},
    deleteSaved:name=>commit(previous=>({...previous,saved:previous.saved.filter(item=>item.name!==name)})),
  };
}

export function WorkflowControls({workspace}) {
  const [name,setName]=useState(''),[selected,setSelected]=useState(''),[status,setStatus]=useState('');
  const wrapper=useRef(null),popup=useRef(null),position=usePopupAnchor(workspace.menuOpen,wrapper,350);
  useEffect(()=>{if(!workspace.menuOpen)return;const dismiss=event=>{if(!wrapper.current?.contains(event.target)&&!popup.current?.contains(event.target))workspace.setMenuOpen(false);};document.addEventListener('pointerdown',dismiss);return()=>document.removeEventListener('pointerdown',dismiss);},[workspace.menuOpen]);
  if(!workspace.available)return null;
  return <div className="workflow-controls" ref={wrapper} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();workspace.setMenuOpen(false);wrapper.current?.querySelector('button')?.focus();}}}>
    <button type="button" className={`browser-toggle workflow-trigger ${workspace.enabled?'active':''}`} aria-label="Workspaces" aria-haspopup="dialog" aria-expanded={workspace.menuOpen} disabled={workspace.suspended} onClick={()=>workspace.setMenuOpen(!workspace.menuOpen)}><Columns2 size={15}/><span>Workspaces</span><ChevronDown size={12}/></button>
    {workspace.menuOpen&&createPortal(<section className="workflow-menu" style={position} ref={popup} role="dialog" aria-label="Workflow workspaces"><div className="workflow-menu-heading"><strong>Workspace layout</strong><button type="button" className="icon-button" aria-label="Close workspaces" onClick={()=>workspace.setMenuOpen(false)}><X size={16}/></button></div><p>Choose a starting layout, then drag panel tabs where you want them. Your chat stays open.</p>
      <div className="workflow-presets" aria-label="Starting layouts">{[['research','Research','Browser beside chat, notes below'],['writing','Writing','Notes beside chat, projects below'],['coding','Coding','Browser beside chat, terminal below']].map(([id,title,hint])=><button type="button" key={id} className="secondary-button" title={hint} onClick={()=>{workspace.preset(id);workspace.setMenuOpen(false);}}><LayoutPreview kind={id}/><strong>{title}</strong><span>{hint}</span></button>)}</div>
      {!workspace.enabled?<button type="button" className="secondary-button" onClick={()=>workspace.changeLayout(layout=>({...layout,enabled:true}))}>Customize workspace</button>:<><label>Visible panels</label><div className="workflow-panel-switches">{WORKFLOW_PANELS.map(panel=><label key={panel}><input type="checkbox" checked={workspace.hasPanel(panel)} onChange={event=>event.target.checked?workspace.show(panel):workspace.hide(panel)}/>{labels[panel]}</label>)}</div><p className="workflow-menu-hint">Drag tabs to another tab group or the highlighted right/bottom areas. The ↗ button opens a separate window. Drag its panel header back to dock it. The tab menu offers the same moves.</p></>}
      <form onSubmit={event=>{event.preventDefault();if(!name.trim())return;workspace.save(name);setSelected(name.trim().slice(0,60));setStatus('Workspace saved.');}}><label>Save this arrangement<input aria-label="Workspace name" maxLength={60} value={name} onChange={event=>setName(event.target.value)} placeholder="Name your layout…"/></label><button type="submit" className="secondary-button" disabled={!name.trim()}>Save workspace</button></form>
      {!!workspace.saved.length&&<div className="workflow-saved"><label>Saved workspace<select aria-label="Saved workspace" value={selected} onChange={event=>{setSelected(event.target.value);setStatus('');}}><option value="">Choose a workspace</option>{workspace.saved.map(item=><option key={item.name}>{item.name}</option>)}</select></label><div><button type="button" className="secondary-button" disabled={!selected} onClick={()=>{workspace.restore(selected);setStatus('Workspace restored.');}}>Restore workspace</button><button type="button" className="text-button" disabled={!selected} onClick={()=>{workspace.deleteSaved(selected);setSelected('');setStatus('Saved workspace deleted.');}}>Delete saved workspace</button></div></div>}
      <button type="button" className="text-button workflow-reset" onClick={()=>{workspace.reset();setStatus('Default layout restored. Your saved workspaces are kept.');}}><RotateCcw size={14}/>Reset layout</button>{status&&<p role="status">{status}</p>}
    </section>,document.body)}
  </div>;
}

function PanelActions({panel,group,workspace}) {
  const [open,setOpen]=useState(false),wrapper=useRef(null),popup=useRef(null),label=labels[panel],position=usePopupAnchor(open,wrapper,175);
  useEffect(()=>{if(open)workspace.setPanelMenuOpen(panel);else workspace.setPanelMenuOpen(current=>current===panel?null:current);return()=>workspace.setPanelMenuOpen(current=>current===panel?null:current);},[open,panel]);
  useEffect(()=>{if(!open)return;const dismiss=event=>{if(!wrapper.current?.contains(event.target)&&!popup.current?.contains(event.target))setOpen(false);};const doc=wrapper.current?.ownerDocument;doc?.addEventListener('pointerdown',dismiss);return()=>doc?.removeEventListener('pointerdown',dismiss);},[open]);
  const choose=action=>{setOpen(false);action();};
  const index=workspace.layout.groups[group]?.panels.indexOf(panel)??-1;
  return <div className="workflow-tab-actions" ref={wrapper} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setOpen(false);}}}><button type="button" className="icon-button" aria-label={`Arrange ${label}`} aria-expanded={open} onClick={()=>setOpen(!open)}><MoreHorizontal size={15}/></button>{open&&createPortal(<div role="menu" ref={popup} style={{...position,overflow:'auto',right:'auto',zIndex:100}} className="workflow-tab-menu">{groups.map(target=><button type="button" role="menuitem" key={target} onClick={()=>choose(()=>workspace.move(panel,target))}>Move to {target}</button>)}{group&&<><button type="button" role="menuitem" disabled={index<=0} onClick={()=>choose(()=>workspace.move(panel,group,index-1))}>Move tab left</button><button type="button" role="menuitem" disabled={index<0||index>=workspace.layout.groups[group].panels.length-1} onClick={()=>choose(()=>workspace.move(panel,group,index+1))}>Move tab right</button></>}<button type="button" role="menuitem" onClick={()=>choose(()=>workspace.detach(panel))}><ExternalLink size={12}/>Detach panel</button><button type="button" role="menuitem" onClick={()=>choose(()=>workspace.hide(panel))}>Hide panel</button></div>,wrapper.current.ownerDocument.body)}</div>;
}

function WorkflowGroup({name,workspace,slots,dragging,dropTarget,setDropTarget,startDrag,finishDrag,dropPanel}) {
  const group=workspace.layout.groups[name];
  const sideFor=event=>event.clientX<event.currentTarget.getBoundingClientRect().left+event.currentTarget.getBoundingClientRect().width/2?'before':'after';
  return <section className={`workflow-group workflow-${name} ${group.panels.length?'':'is-empty'} ${dragging&&dropTarget?.group===name&&dropTarget.kind==='group'?'is-drop-target':''}`} data-workflow-group={name} aria-label={`${name==='right'?'Right':'Bottom'} workflow panels`} onDragOver={event=>{if(dragging){event.preventDefault();event.dataTransfer.dropEffect='move';setDropTarget({kind:'group',group:name});}}} onDrop={event=>dropPanel(event,name)}>
    <div className="workflow-group-caption"><span>{name==='right'?'Beside chat':'Below chat'}</span><span>Drag tabs to arrange</span></div>
    <div className="workflow-tabs" role="tablist" aria-label={`${name==='right'?'Right':'Bottom'} panel tabs`}>{group.panels.map((panel,index)=><div className={`workflow-tab-wrap ${dragging===panel?'is-dragging':''} ${dropTarget?.kind==='tab'&&dropTarget.panel===panel?'drop-'+dropTarget.side:''}`} key={panel} onDragOver={event=>{if(dragging){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';setDropTarget({kind:'tab',group:name,panel,side:sideFor(event)});}}} onDrop={event=>dropPanel(event,name,workflowDropIndex(workspace.layout,dragging,name,panel,sideFor(event)))}><button type="button" role="tab" draggable data-workflow-panel={panel} id={`workflow-tab-${panel}`} aria-controls={`workflow-panel-${panel}`} aria-label={labels[panel]} aria-selected={group.active===panel} tabIndex={group.active===panel?0:-1} title={`Drag ${labels[panel]} to move or group it`} onClick={()=>workspace.changeLayout(layout=>setWorkflowActive(layout,name,panel))} onDragStart={event=>startDrag(event,panel)} onDragEnd={finishDrag} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?group.panels.length-1:(index+(event.key==='ArrowRight'?1:group.panels.length-1))%group.panels.length;const nextPanel=group.panels[next];workspace.changeLayout(layout=>setWorkflowActive(layout,name,nextPanel));event.currentTarget.closest('[role=tablist]')?.querySelector(`[data-workflow-panel="${nextPanel}"]`)?.focus();}}><GripVertical size={12}/><span>{labels[panel]}</span></button><button type="button" className="icon-button workflow-detach" aria-label={`Open ${labels[panel]} in separate window`} title="Open in separate window" onClick={()=>workspace.detach(panel)}><ExternalLink size={13}/></button><PanelActions panel={panel} group={name} workspace={workspace}/></div>)}</div>
    {!group.panels.length&&<div className="workflow-drop-hint">Drop a panel tab here</div>}
    {group.panels.map(panel=><div key={panel} className="workflow-panel-slot" id={`workflow-panel-${panel}`} role="tabpanel" aria-labelledby={`workflow-tab-${panel}`} hidden={group.active!==panel} ref={element=>{if(element)slots.current[panel]=element;else if(slots.current[panel]?.id===`workflow-panel-${panel}`)delete slots.current[panel];}}/>)}
  </section>;
}

function ResizeHandle({name,workspace,container}) {
  const drag=useRef(null),vertical=name==='right';
  const limits=()=>{const rect=container.current?.getBoundingClientRect();return vertical?{min:280,max:Math.max(280,(rect?.width||900)-(window.innerWidth<=1000?287:307))}:{min:180,max:Math.max(180,(rect?.height||700)-227)};};
  const resize=value=>{const {min,max}=limits();workspace.changeLayout(layout=>({...layout,sizes:{...layout.sizes,[name]:Math.round(Math.max(min,Math.min(max,value)))}}));};
  const finish=event=>{if(!drag.current)return;drag.current=null;workspace.setResizing(false);if(event?.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);};
  useEffect(()=>()=>{if(drag.current)workspace.setResizing(false);},[]);
  return <div className={`workflow-resizer workflow-resize-${name}`} role="separator" tabIndex={0} aria-label={`Resize ${name} panels`} aria-orientation={vertical?'vertical':'horizontal'} aria-valuenow={workspace.layout.sizes[name]} aria-valuemin={limits().min} aria-valuemax={limits().max} onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);drag.current={pointerId:event.pointerId,start:vertical?event.clientX:event.clientY,size:workspace.layout.sizes[name]};workspace.setResizing(true);}} onPointerMove={event=>{const current=drag.current;if(current&&current.pointerId===event.pointerId)resize(current.size+current.start-(vertical?event.clientX:event.clientY));}} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onDoubleClick={()=>resize(vertical?420:300)} onKeyDown={event=>{const step=event.shiftKey?96:32;let value;if(event.key===(vertical?'ArrowLeft':'ArrowUp'))value=workspace.layout.sizes[name]+step;else if(event.key===(vertical?'ArrowRight':'ArrowDown'))value=workspace.layout.sizes[name]-step;else if(event.key==='Home')value=limits().min;else if(event.key==='End')value=limits().max;else if(event.key==='Enter')value=vertical?420:300;else if(event.key==='Escape'&&drag.current){value=drag.current.size;finish();}else return;event.preventDefault();resize(value);}}/>;
}

export default function WorkflowWorkspace({workspace,panels,children}) {
  const containers=useRef(null),slots=useRef({}),stash=useRef(null),container=useRef(null),dragToken=useRef(crypto.randomUUID()),[dragging,setDragging]=useState(null),[dropTarget,setDropTarget]=useState(null),[everEnabled,setEverEnabled]=useState(workspace.enabled);
  if(!containers.current)containers.current=Object.fromEntries(WORKFLOW_PANELS.map(panel=>{const element=document.createElement('div');element.className=`workflow-panel-content workflow-content-${panel}`;return [panel,element];}));
  useEffect(()=>{if(workspace.enabled)setEverEnabled(true);},[workspace.enabled]);
  const finishDrag=()=>{setDragging(null);setDropTarget(null);workspace.setResizing(false);};
  const startDrag=(event,panel)=>{
    event.dataTransfer.setData('application/x-exomina-panel',`${dragToken.current}:${panel}`);
    event.dataTransfer.effectAllowed='move';setDragging(panel);setDropTarget(null);
    // The native browser view otherwise sits above DOM drop targets.
    workspace.setResizing(true);
  };
  const dropPanel=(event,group,index)=>{
    if(!dragging||event.dataTransfer.getData('application/x-exomina-panel')!==`${dragToken.current}:${dragging}`)return;
    event.preventDefault();event.stopPropagation();const panel=dragging;finishDrag();
    if(group==='floating')workspace.detach(panel);else workspace.move(panel,group,index);
  };
  useEffect(()=>{if(!workspace.active&&dragging)finishDrag();},[workspace.active]);
  useEffect(()=>{
    if(!dragging)return;
    const cancel=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finishDrag();}};
    const documents=[document,...Object.values(workspace.windows).map(item=>item.target.ownerDocument)];
    documents.forEach(doc=>doc.addEventListener('keydown',cancel,true));
    return()=>documents.forEach(doc=>doc.removeEventListener('keydown',cancel,true));
  },[dragging,workspace.windows]);
  useLayoutEffect(()=>{
    for(const panel of WORKFLOW_PANELS){
      const element=containers.current[panel],floating=workspace.active&&workspace.windows[panel];
      const target=floating?.target||workspace.active&&slots.current[panel]||stash.current;
      if(target&&element.parentNode!==target){
        const focused=element.contains(element.ownerDocument.activeElement)?element.ownerDocument.activeElement:null;
        const selection=focused&&typeof focused.selectionStart==='number'?{start:focused.selectionStart,end:focused.selectionEnd,direction:focused.selectionDirection}:null;
        const scroll=[element,...element.querySelectorAll('*')].filter(node=>node.scrollTop||node.scrollLeft).map(node=>({node,top:node.scrollTop,left:node.scrollLeft}));
        target.appendChild(element);
        if(focused){focused.focus({preventScroll:true});if(selection)focused.setSelectionRange(selection.start,selection.end,selection.direction);}
        for(const item of scroll){item.node.scrollTop=item.top;item.node.scrollLeft=item.left;}
      }
    }
  });
  const right=workspace.active&&workspace.layout.groups.right.panels.length>0;
  const bottom=workspace.active&&workspace.layout.groups.bottom.panels.length>0;
  const dropTargets=workspace.active&&!!dragging;
  return <div ref={container} className={`workflow-workspace ${workspace.active?'is-custom':''} ${right?'has-right':''} ${bottom?'has-bottom':''} ${workspace.resizing?'is-resizing':''} ${dragging?'is-dragging-panel':''}`} style={{'--workflow-right':`${workspace.layout.sizes.right}px`,'--workflow-bottom':`${workspace.layout.sizes.bottom}px`}}>
    <div className="workflow-primary">{children}</div>
    {workspace.active&&<>{right&&<><ResizeHandle name="right" workspace={workspace} container={container}/><WorkflowGroup name="right" workspace={workspace} slots={slots} dragging={dragging} dropTarget={dropTarget} setDropTarget={setDropTarget} startDrag={startDrag} finishDrag={finishDrag} dropPanel={dropPanel}/></>}{bottom&&<><ResizeHandle name="bottom" workspace={workspace} container={container}/><WorkflowGroup name="bottom" workspace={workspace} slots={slots} dragging={dragging} dropTarget={dropTarget} setDropTarget={setDropTarget} startDrag={startDrag} finishDrag={finishDrag} dropPanel={dropPanel}/></>}</>}
    {dropTargets&&<div className="workflow-drop-zones" aria-label={`Move ${labels[dragging]}`}>{[['right','Place beside chat','Drop to dock on the right'],['bottom','Place below chat','Drop to dock at the bottom'],...(!workspace.windows[dragging]?[['floating','Separate window','Drop to open its own window']]:[])].map(([target,title,hint])=><div key={target} data-workflow-drop={target} className={`workflow-drop-zone workflow-drop-${target} ${dropTarget?.kind==='zone'&&dropTarget.group===target?'is-over':''}`} onDragOver={event=>{event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';setDropTarget({kind:'zone',group:target});}} onDrop={event=>dropPanel(event,target)}><strong>{title}</strong><span>{hint}</span></div>)}</div>}
    <div hidden ref={stash} className="workflow-panel-stash"/>
    {(everEnabled||workspace.enabled)&&!workspace.suspended&&WORKFLOW_PANELS.map(panel=>createPortal(panel==='browser'&&!workspace.active?null:panels[panel],containers.current[panel],panel))}
    {Object.entries(workspace.windows).map(([panel,item])=>createPortal(<div className="workflow-floating"><header><button type="button" draggable className="workflow-floating-drag" aria-label={`Drag ${labels[panel]} back to workspace`} title="Drag this panel header onto the main workspace to dock it" onDragStart={event=>startDrag(event,panel)} onDragEnd={finishDrag}><GripVertical size={14}/><strong>{labels[panel]}</strong></button><span>Drag header back to dock</span><select aria-label="Dock panel position" defaultValue={defaultGroup(panel)} id={`workflow-dock-${panel}`}><option value="right">Beside chat</option><option value="bottom">Below chat</option></select><button type="button" className="secondary-button" onClick={()=>workspace.dock(panel,item.target.ownerDocument.getElementById(`workflow-dock-${panel}`).value)}>Dock panel</button></header></div>,item.target.ownerDocument.getElementById('root'),`frame-${panel}`))}
  </div>;
}
