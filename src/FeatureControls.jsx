import React,{useState} from 'react';
import {Blocks,RotateCcw,Trash2} from 'lucide-react';
import {FEATURES,featureFor,featureDisabled} from '../desktop/features.mjs';
import './feature-controls.css';

export default function FeatureControls({settings,tools=[],saveSettings,busy=false}){
  const [query,setQuery]=useState(''),[showRemoved,setShowRemoved]=useState(false);
  const disabled=settings.disabledFeatures||[],removed=settings.disabledTools||[];
  const toggle=(id,on)=>saveSettings({disabledFeatures:on?disabled.filter(value=>value!==id):[...disabled,id]});
  const remove=(name,off)=>saveSettings({disabledTools:off?[...new Set([...removed,name])]:removed.filter(value=>value!==name)});
  const rows=tools.filter(tool=>featureFor(tool.name)&&(!query||`${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()))&&(showRemoved||!removed.includes(tool.name)));
  return <section className="feature-controls" aria-label="Features and tools"><div className="section-title"><h2>Features &amp; tools</h2><span>Changes apply immediately</span></div>
    <p className="connection-small">Keep what you use. Turning a feature off stops new tool calls, including in open chats. Your saved work stays here. Provider-native tools follow their own permissions.</p>
    <div className="feature-grid">{FEATURES.map(feature=><div className="feature-row" key={feature.id}><Blocks size={17}/><div><strong>{feature.name}</strong><p>{feature.description}</p>{feature.setting&&!settings[feature.setting]&&!disabled.includes(feature.id)&&<small>Access is off above</small>}</div><label className="extension-switch"><input type="checkbox" role="switch" aria-label={`Enable ${feature.name}`} checked={!disabled.includes(feature.id)} disabled={busy} onChange={event=>toggle(feature.id,event.target.checked)}/><span>{disabled.includes(feature.id)?'Off':'On'}</span></label></div>)}</div>
    <details className="individual-tools"><summary>Manage individual tools{removed.length?` · ${removed.length} removed`:''}</summary><p>Remove a tool from the AI’s list, or restore it here. Built-in code stays with Exomina; local extensions can be uninstalled under Connected tools.</p><div className="feature-search"><input type="search" aria-label="Find a tool" placeholder="Find a tool…" value={query} onChange={event=>setQuery(event.target.value)}/><label><input type="checkbox" checked={showRemoved} onChange={event=>setShowRemoved(event.target.checked)}/>Show removed tools</label></div><div className="feature-tool-list">{rows.map(tool=><div className="feature-tool-row" key={tool.name}><div><strong>{tool.name}</strong><small>{featureFor(tool.name)?.name} · {featureDisabled(tool.name,settings)?'Off':tool.enabled===false?'Access off':'Available'}</small></div><button type="button" className="icon-button" disabled={busy} aria-label={`${removed.includes(tool.name)?'Restore':'Remove'} tool ${tool.name}`} onClick={()=>remove(tool.name,!removed.includes(tool.name))}>{removed.includes(tool.name)?<RotateCcw size={15}/>:<Trash2 size={15}/>}</button></div>)}{!rows.length&&<p>No matching tools.</p>}</div></details>
  </section>;
}
