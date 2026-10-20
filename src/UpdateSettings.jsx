import React, { useEffect, useState } from 'react';
import { Download, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { api } from './transport.js';
import useUpdateStatus from './useUpdateStatus.js';
import './updates.css';

const when=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?null:date.toLocaleString();};
const buildLabel=build=>build?`${build.version||'Unknown version'} · ${when(build.builtAt)||'build date unavailable'}`:'Build information unavailable';
const bytes=value=>value>=1024**3?`${(value/1024**3).toFixed(1)} GB`:`${(value/1024**2).toFixed(1)} MB`;
const OUTCOME={installed:'Installed',declined:'Administrator approval was declined',failed:'Failed'};
const failureText=failure=>(failure.message||String(failure)).replace(/^Error invoking remote method '[^']+': Error: /,'');

export default function UpdateSettings({Toggle,active=false,onAutoUpdate,onReleaseSource,onReview}){
 const{status,setStatus,error,setError,load}=useUpdateStatus();
 const[pending,setPending]=useState(''),[source,setSource]=useState(''),[sourceChanged,setSourceChanged]=useState(false);
 useEffect(()=>{if(!sourceChanged)setSource(status?.remote?.feedUrl||'');},[status?.remote?.feedUrl,sourceChanged]);
 async function action(method){setPending(method);setError('');try{const result=await api.invoke(method);if(result?.cancelled)setPending('');else if(method!=='update.install')setStatus(result);}catch(failure){setError(failureText(failure));setPending('');}finally{if(method!=='update.install')setPending('');else load();}}
 async function saveSource(event){event.preventDefault();setError('');try{await onReleaseSource(source.trim());setSourceChanged(false);await load();}catch(failure){setError(failureText(failure));}}
 const progress=status?.remote?.progress,busy=!!pending||['checking','downloading','verifying'].includes(progress?.phase),release=status?.remote?.release,last=status?.lastResult,merge=status?.merge;
 const blockers=status?.activity?.blockers||[],openTerminals=blockers.some(item=>item.kind==='terminals'),waiting=blockers.some(item=>item.kind!=='terminals');
 async function prepare(){setPending('update.prepare');setError('');try{await api.invoke('update.prepare');await load();}catch(failure){setError(failureText(failure));}finally{setPending('');}}
 async function review(){try{const value=await api.invoke('update.review');await onReview?.(value);}catch(failure){setError(failureText(failure));}}
 if(status?.manualUpdates)return <section className="settings-section" id="settings-updates"><div className="section-title"><h2>Updates</h2></div><div className="settings-row"><div><strong>Private beta updates</strong><p>Running: {buildLabel(status.installed)}</p><p>Download the latest installer from the private GitHub repository and run it again. Your chats and sign-ins are kept.</p><p>You need access to the repository to download releases.</p>{error&&<p className="inline-error" role="alert">{error}</p>}</div>{status.repositoryUrl&&<button className="secondary-button" onClick={()=>api.invoke('app.openExternal',{url:status.repositoryUrl+'/releases'}).catch(failure=>setError(failureText(failure)))}><Download size={15}/>Open beta releases</button>}</div></section>;
 return <section className="settings-section" id="settings-updates">
  <div className="section-title"><h2>Updates</h2></div>
  <div className="settings-row"><div><strong>Download updates automatically</strong><p>Exomina checks for new releases in the background and downloads them. Choose Apply update when you are ready to restart. Windows may ask for administrator approval.</p></div><Toggle label="Download updates automatically" checked={status?status.autoUpdate:true} disabled={!status?.supported} onChange={async value=>{await onAutoUpdate(value);load();}}/></div>
  <div className="settings-row"><div><strong>{status?.available?'Ready to apply':release?'New version available':'Installed version'}</strong>
   {!status&&!error&&<p>Checking…</p>}
   {status&&!status.supported&&<p>{status.reason}</p>}
   {status?.supported&&<p>Running: {buildLabel(status.installed)}</p>}
   {status?.available&&<p>Ready: {buildLabel(status.staged)}</p>}
   {!status?.available&&release&&<p>Available: {buildLabel(release)}</p>}
   {status?.supported&&!status.available&&!release&&<p>{status.remote?.configured?'No downloaded update is waiting.':'Online updates will be available when a release source is published.'}</p>}
   {status?.remote?.checkedAt&&<p>Last checked: {when(status.remote.checkedAt)}</p>}
   {progress&&<p role="status">{progress.message}{progress.phase==='downloading'?` · ${bytes(progress.completed)} of ${bytes(progress.total)}`:''}</p>}
   {progress?.phase==='downloading'&&<progress aria-label="Update download progress" value={progress.completed} max={progress.total}/>}
   {status?.autoBlocked&&<p>The previous installation did not finish. Apply update will try again.</p>}
   {last&&<p>Last installation: {OUTCOME[last.status]||last.status}{when(last.finishedAt)?`, ${when(last.finishedAt)}`:''}{last.message?`. ${last.message}`:''}</p>}
   {status?.restartApproved&&<p>A restart is approved. It will start when the activity below finishes and open terminals are closed.</p>}
   {merge?.required&&<p>{merge.message||`Customized update: ${merge.phase}. ${merge.conflicts?.filter(c=>!c.resolved).length||0} unresolved conflicts.`}</p>}
   {merge?.error&&<p className="inline-error">{merge.error}</p>}
   {merge?.changes?.length>0&&<details><summary>{merge.changes.length} changed source files</summary><ul>{merge.changes.map(file=><li key={file.path}>{file.path}{file.local?' · customized':''}</li>)}</ul></details>}
   {merge?.phase==='verified'&&<p>The merged version passed dependency, test and package checks. Review its changes before applying. The current app and the complete original source copy are preserved for recovery.</p>}
   {status?.available&&blockers.length>0&&<div className="update-blockers" role="status"><strong>Before restarting</strong><ul>{blockers.map(item=><li key={item.kind}>{item.message}</li>)}</ul>{openTerminals&&<p>Apply can close these terminal sessions after you confirm.</p>}</div>}
   {active&&status?.available&&!status.activity&&<p>Finish or stop active replies and voice sessions before applying.</p>}
   {error&&<p className="inline-error" role="alert">{error}</p>}
  </div></div>
  <div className="update-actions">
   <button className="secondary-button" onClick={()=>action('update.check')} disabled={!status?.supported||busy}>{pending==='update.check'?<LoaderCircle size={15} className="spin"/>:<RefreshCw size={15}/>}Check for updates</button>
   {release&&!status?.available&&<button className="secondary-button" onClick={()=>action('update.download')} disabled={busy}><Download size={15}/>Download update</button>}
   {progress?.phase==='downloading'&&<button className="secondary-button" onClick={()=>api.invoke('update.cancel')}><X size={15}/>Cancel download</button>}
   {merge?.required&&<button className="secondary-button" disabled={busy||active||merge.phase==='baseline-missing'||merge.phase==='checking'} onClick={prepare}>Prepare merged update</button>}
   {merge?.workspace&&<button className="secondary-button" disabled={busy||active} onClick={review}>Review with AI</button>}
   <button className="primary-button" onClick={()=>action('update.install')} disabled={!status?.available||active||waiting||busy||merge?.required&&merge.phase!=='verified'}>{pending==='update.install'?<LoaderCircle size={15} className="spin"/>:<Download size={15}/>}Apply update</button>
  </div>
  {(status?.staged?.notes||release?.notes)&&<details className="update-notes"><summary>Release notes</summary><p>{status?.staged?.notes||release.notes}</p></details>}
  <details className="update-source advanced-only"><summary>Update source</summary><p>Public releases use the address supplied with Exomina. This preview can also use a publisher’s HTTPS release feed.</p><form onSubmit={saveSource}><label htmlFor="update-feed-address">Release feed address</label><input id="update-feed-address" type="url" placeholder="https://…/latest.json" value={source} onChange={event=>{setSource(event.target.value);setSourceChanged(true);}}/><button className="secondary-button" disabled={!status?.supported||busy||!sourceChanged}>Save address</button></form></details>
 </section>;
}
