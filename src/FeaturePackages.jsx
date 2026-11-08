import React,{useEffect,useState,useRef} from 'react';
import {Blocks,ChevronDown,X} from 'lucide-react';
import {api} from './transport.js';
import {featurePanelSource} from '../desktop/feature-panel.mjs';
import './feature-packages.css';

const errorText=error=>(error?.message||String(error)).replace(/^Error invoking remote method '[^']+': Error: /,'');
export const featureRequest=idea=>`Build this as an Exomina feature: ${idea.trim()}\n\nUse feature_package prepare to show a preview in this chat. Include a complete self-contained package with exomina-feature.json (apiVersion 1). Explain what works in the preview and what access the enabled feature needs. Wait for me to review and enable it; do not activate it automatically.`;

export default function FeaturePackages({conversationId,chat=false,onDraft}){
  const [rows,setRows]=useState([]),[previews,setPreviews]=useState([]),[open,setOpen]=useState(!chat),[idea,setIdea]=useState(''),[pending,setPending]=useState(new Set()),[error,setError]=useState(''),[warning,setWarning]=useState(''),[notice,setNotice]=useState('');
  const request=useRef(0),seen=useRef(new Set());
  const payload={...(conversationId?{conversationId}:{})};
  const refresh=()=>{
    const serial=++request.current;
    return api.invoke('features.view',{...payload,content:open}).then(value=>{
      if(serial!==request.current)return;
      setRows(value.packages);setWarning(value.warning);setPreviews(value.previews||[]);
      if((value.previews||[]).some(item=>!seen.current.has(item.previewId)))setOpen(true);
      seen.current=new Set((value.previews||[]).map(item=>item.previewId));
    });
  };
  useEffect(()=>{
    refresh().catch(e=>setError(errorText(e)));
    const unsubscribe=api.onEvent(event=>{if(event.type==='state.changed'||event.type==='feature.preview'&&event.conversationId===conversationId)refresh().catch(e=>setError(errorText(e)));});
    const timer=setInterval(()=>refresh().catch(()=>{}),30_000);
    return()=>{request.current++;clearInterval(timer);unsubscribe();};
  },[conversationId,open]);
  async function act(key,operation,message){
    setPending(old=>new Set([...old,key]));setError('');setNotice('');
    try{await operation();if(message)setNotice(message);await refresh();}
    catch(e){setError(errorText(e));await refresh().catch(()=>{});}
    finally{setPending(old=>{const next=new Set(old);next.delete(key);return next;});}
  }
  const busy=pending.size>0;
  const draft=text=>{onDraft?.(text);setNotice('Request added to your message. Review it and send when ready.');};
  const revise=(id,version,previewId)=>draft(`Revise Exomina feature ${id} (${version}). Read its package with feature_package source using ${previewId?`previewId ${previewId}`:`id ${id}`}, then prepare the complete revised package with the same feature id and dataVersion. Show me the new preview before activation.\n\nChanges I want: `);
  const panel=(html,title)=><iframe key={'panel:'+title} title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={featurePanelSource(html)}/>;
  return <section className={chat?'chat-feature-loop':'feature-packages'} aria-label={chat?'Chat features':'Feature packages'}>
    {chat&&<button type="button" className="feature-loop-toggle" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><Blocks size={14}/><span>Features{previews.length?` · ${previews.length} ready to preview`:rows.length?` · ${rows.filter(row=>row.enabled).length} on`:''}</span><ChevronDown size={14}/></button>}
    {open&&<div className={chat?'feature-loop-body feature-packages':'feature-package-body'}>
      <div className="section-title"><h2>{chat?'Your features':'Feature packages'}</h2>{chat?<button type="button" className="icon-button" aria-label="Close features" onClick={()=>setOpen(false)}><X size={15}/></button>:<button type="button" disabled={busy} onClick={()=>act('choose',()=>api.invoke('features.choose',payload))}>Add or update a feature</button>}</div>
      {onDraft&&<div className="feature-idea"><label htmlFor="chat-feature-idea">What would you like Exomina to add?</label><input id="chat-feature-idea" value={idea} maxLength={2000} placeholder="For example, a checklist for reviewing my releases" onChange={event=>setIdea(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&idea.trim()){event.preventDefault();draft(featureRequest(idea));setIdea('');}}}/><button type="button" disabled={!idea.trim()} onClick={()=>{draft(featureRequest(idea));setIdea('');}}>Add request to chat</button></div>}
      <p className="connection-small">Preview here, enable when ready, then ask for revisions or restore the previous version. Exomina stays open. Previews do not run workers.</p>
      {!rows.length&&!previews.length&&<p className="feature-empty">{chat?'Describe a feature in your message, or add an idea above. Its preview will appear here.':'No features enabled yet. Ask for one in chat or choose a local package.'}</p>}
      {previews.map(preview=><article className="feature-package-preview" key={preview.previewId} aria-label={`${preview.manifest.name} preview`}>
        <strong>{preview.manifest.name} · {preview.manifest.version}</strong><p>{preview.manifest.description}</p>
        <p>{preview.currentVersion?`Update from ${preview.currentVersion}. `:''}{preview.warning}</p>
        {preview.sourceNotice&&<p role="status">{preview.sourceNotice}</p>}
        {preview.panel?panel(preview.panel,preview.manifest.name+' preview'):<p className="feature-empty">Tools-only preview. Review the source below; the worker starts after approval.</p>}
        {preview.manifest.settings.length>0&&<p>Settings after enabling: {preview.manifest.settings.map(field=>field.label).join(', ')}.</p>}
        <p className="connection-small">{preview.stale?'This feature changed since this preview. Ask for a fresh revision.':'Preview expires after 10 minutes. Enable asks you to approve the exact package.'}</p>
        <details><summary>Review package · {preview.files.length} files</summary><code>SHA-256 {preview.sha256}</code><pre>{preview.files.map(file=>file.name+' '+file.sha256).join('\n')}</pre>{preview.sourceFiles?.map(file=><details key={file.name}><summary>{file.name}</summary><pre>{file.text}</pre></details>)}<p>Scripts, forms and network access are removed from the panel preview. Enabling a worker gives it your account permissions. Rollback restores code and keeps feature data.</p></details>
        <div className="feature-actions"><button type="button" disabled={busy||preview.stale} onClick={()=>act(preview.previewId,()=>api.invoke('features.activate',{...payload,previewId:preview.previewId}),`${preview.manifest.name} ${preview.manifest.version} is enabled.`)}>{pending.has(preview.previewId)?'Waiting for approval…':chat?(preview.currentVersion?'Enable update':'Enable feature'):'Review and activate'}</button>
          {onDraft&&<button type="button" onClick={()=>revise(preview.manifest.id,preview.manifest.version,preview.previewId)}>Ask for changes</button>}
          <button type="button" onClick={()=>act('discard:'+preview.previewId,()=>api.invoke('features.discard',{...payload,previewId:preview.previewId}))}>Discard preview</button></div>
      </article>)}
      {rows.map(row=><article className="feature-package-row" key={row.id} aria-label={`${row.name} installed feature`}>
        <strong>{row.name} · {row.version}</strong><p>{row.description}</p><p>{row.enabled?'On':'Off'}{row.trustedWorker?' · Trusted Node worker':''}</p>
        <div className="feature-actions"><button type="button" disabled={row.enabled?pending.has('disable:'+row.id):busy} onClick={()=>act((row.enabled?'disable:':'enable:')+row.id,()=>api.invoke('features.change',{...payload,id:row.id,action:row.enabled?'disable':'enable'}))}>{row.enabled?'Turn off':'Turn on'}</button>
          {onDraft&&<button type="button" onClick={()=>revise(row.id,row.version)}>Revise in chat</button>}
          {row.canRollback&&<button type="button" disabled={busy} onClick={()=>act('rollback:'+row.id,()=>api.invoke('features.change',{...payload,id:row.id,action:'rollback'}),'Previous version restored. Feature data was kept.')}>Restore previous version{row.previousVersion?` (${row.previousVersion})`:''}</button>}
          <button type="button" disabled={pending.has('remove:'+row.id)} onClick={()=>act('remove:'+row.id,()=>api.invoke('features.change',{...payload,id:row.id,action:'remove'}),'Feature removed. Saved feature data was kept.')}>Remove feature</button></div>
        {row.error&&<p className="inline-error" role="status">{row.error}</p>}
        {row.enabled&&row.panel&&panel(row.panel,row.name+' panel')}
        {row.settings.length>0&&<FeatureSettings key={'settings:'+row.generation} row={row} busy={busy} save={values=>act('settings:'+row.id,()=>api.invoke('features.settings',{id:row.id,values}),'Feature settings saved.')}/>}
      </article>)}
      {warning&&<p className="inline-error" role="status">{warning}</p>}
    </div>}
    {error&&<p className="inline-error" role="alert">{error}</p>}{notice&&<p className="feature-notice" role="status">{notice}</p>}
  </section>;
}
function FeatureSettings({row,busy,save}){
  const [values,setValues]=useState(row.values);
  return <form onSubmit={event=>{event.preventDefault();save(values);}}>{row.settings.map(field=><label key={field.key}>{field.label}<input type={field.type==='boolean'?'checkbox':field.type==='number'?'number':'text'} maxLength={2000} checked={field.type==='boolean'?!!values[field.key]:undefined} value={field.type==='boolean'?undefined:values[field.key]??''} onChange={event=>setValues(old=>({...old,[field.key]:field.type==='boolean'?event.target.checked:field.type==='number'?Number(event.target.value):event.target.value}))}/></label>)}<button disabled={busy}>Save feature settings</button></form>;
}
