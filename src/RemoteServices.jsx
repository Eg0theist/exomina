import React,{useRef,useState} from 'react';
import {Link,LoaderCircle,Plus,Trash2,X} from 'lucide-react';
import {api} from './transport.js';

const cleanError=error=>(error?.message||String(error)).replace(/^Error invoking remote method '[^']+': Error: /,'');
export default function RemoteServices({settings,status=[],refresh,hasActiveRun=false}){
 const [custom,setCustom]=useState(false),[name,setName]=useState(''),[url,setUrl]=useState(''),[busy,setBusy]=useState({}),[error,setError]=useState(''),[confirm,setConfirm]=useState(''),generation=useRef(new Map());
 const servers=(settings.externalMcpServers||[]).filter(server=>server.transport==='http');
 const action=async(method,input)=>{
  const key=input.id||'add',seq=(generation.current.get(key)||0)+1;generation.current.set(key,seq);
  setBusy(old=>({...old,[key]:method}));setError('');
  try{await api.invoke(method,input);await refresh();}
  catch(problem){if(generation.current.get(key)===seq)setError(cleanError(problem));}
  finally{if(generation.current.get(key)===seq)setBusy(old=>{const next={...old};delete next[key];return next;});}
 };
 const addCustom=async event=>{
  event.preventDefault();let address;
  try{address=new URL(url);if(address.protocol!=='https:'||address.username||address.password||address.hash||address.search)throw Error('Use the service’s HTTPS MCP address, without a login, query or fragment.');}
  catch(problem){setError(cleanError(problem));return;}
  await action('remoteMcp.add',{id:'service-'+crypto.randomUUID().slice(0,8),name:name.trim(),url:address.href});
 };
 return <section className="remote-services" aria-labelledby="remote-services-title">
  <div className="section-title"><h3 id="remote-services-title">Connected services</h3><span>{servers.length?servers.length+' added':'Optional'}</span></div>
  <p className="connection-small">Use a service’s tools directly from chat. Adding it saves an address. Connect may open a browser to approve access. Tool actions still follow your permissions.</p>
  <div className="remote-service-preset"><div><strong>Suno</strong><p>Create and continue music using Suno’s official tools. Music actions use your Suno credits. Connecting does not create music or share your whole chat.</p></div>
   {!servers.some(server=>server.url==='https://api.suno.com/mcp')&&<button className="secondary-button" disabled={hasActiveRun||!!busy.add||!!busy.suno} onClick={()=>action('remoteMcp.add',{id:'suno',name:'Suno',url:'https://api.suno.com/mcp',preset:'suno'})}><Plus size={14}/>Add Suno</button>}
  </div>
  {servers.length>0&&<div className="extension-list">{servers.map(server=>{
   const state=status.find(item=>item.id===server.id)||{},connecting=state.connecting||busy[server.id]==='remoteMcp.connect',connected=!!state.connected;
   return <div className="tool-row extension-row remote-service-row" key={server.id}>
    <span className="tool-row-icon"><Link size={17}/></span>
    <div><strong>{server.name||server.id}</strong><p title={server.url}>{server.url}</p><p className="remote-service-state" role="status">{connecting?'Sign-in in progress. Complete it in the browser, or cancel here.':connected?`${state.toolCount||0} tools connected`:'Saved locally. Connect to make its tools available.'}</p>{state.error&&!connecting&&<p className="inline-error remote-service-message">{state.error}</p>}</div>
    {connecting?<button className="secondary-button" onClick={()=>action('remoteMcp.disconnect',{id:server.id})}><X size={14}/>Cancel sign-in</button>:connected?<button className="secondary-button" disabled={!!busy[server.id]} onClick={()=>action('remoteMcp.disconnect',{id:server.id})}>Disconnect</button>:<button className="secondary-button" disabled={hasActiveRun||!!busy[server.id]} onClick={()=>action('remoteMcp.connect',{id:server.id})}>{busy[server.id]?<LoaderCircle size={14} className="spin"/>:<Link size={14}/>}Connect</button>}
    {confirm===server.id?<span className="extension-confirm"><button className="danger-text-button" disabled={!!busy[server.id]&&!connecting} onClick={()=>{setConfirm('');action('remoteMcp.remove',{id:server.id});}}>Remove</button><button className="text-button" onClick={()=>setConfirm('')}>Keep</button></span>:<button className="icon-button" aria-label={`Remove ${server.name||server.id} service`} disabled={!!busy[server.id]&&!connecting} onClick={()=>setConfirm(server.id)}><Trash2 size={14}/></button>}
   </div>;
  })}</div>}
  <details open={custom} onToggle={event=>setCustom(event.currentTarget.open)}><summary>Add another service</summary>
   <form className="remote-service-form" onSubmit={addCustom}><label>Service name<input value={name} maxLength={80} required onChange={event=>setName(event.target.value)}/></label><label>HTTPS MCP address<input type="url" value={url} maxLength={2048} required placeholder="https://service.example/mcp" onChange={event=>setUrl(event.target.value)}/></label>
    <p className="connection-small">Use an official address supplied by the service. Local network endpoints and pasted access tokens are not supported here. The service controls its own permissions and charges.</p>
    <button className="secondary-button" disabled={hasActiveRun||Object.values(busy).includes('remoteMcp.add')||!name.trim()||!url.trim()} type="submit"><Plus size={14}/>Add service</button>
   </form>
  </details>
  {hasActiveRun&&<p className="connection-small">Add or connect when no chat is replying. You can still disconnect a service or cancel sign-in.</p>}
  {error&&<p className="inline-error" role="alert">{error}</p>}
 </section>;
}
