import React,{useEffect,useState} from 'react';
import {api} from './transport.js';
import './client-scopes.css';

export default function ClientScopes({invoke=(method,payload)=>api.invoke(method,payload),onChange=()=>{}}){
  const [status,setStatus]=useState(null),[organizationId,setOrganization]=useState(''),[clientId,setClient]=useState(''),[orgName,setOrgName]=useState(''),[clientName,setClientName]=useState(''),[projectName,setProjectName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const load=async()=>{const next=await invoke('clients.status');setStatus(next);return next;};
  useEffect(()=>{let live=true;invoke('clients.status').then(next=>{if(live)setStatus(next);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[]);
  const change=async action=>{setBusy(true);setError('');setNotice('');try{await action();await load();onChange();}catch(e){setError(e.message);}finally{setBusy(false);}};
  const clients=status?.clients.filter(client=>client.organizationId===organizationId)||[];
  return <section className="settings-card client-scopes"><h2>Client workspaces</h2>
    <p>Create a fresh project with its own memory and conversations. The AI cannot search other clients or your personal library from that project.</p>
    <p className="field-help">Local desktop owner controls only. Tools without client boundaries, shared skills, file execution and AI voice are unavailable inside these projects. This does not create employee accounts or an operating-system sandbox.</p>
    {error&&<p role="alert" className="inline-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <form onSubmit={event=>{event.preventDefault();change(async()=>{const result=await invoke('clients.manage',{action:'createOrganization',name:orgName});setOrganization(result.result.id);setOrgName('');});}}>
      <label>Organization name<input aria-label="Organization name" value={orgName} maxLength={120} onChange={event=>setOrgName(event.target.value)}/></label><button className="secondary-button" disabled={busy||!orgName.trim()}>Create organization</button>
    </form>
    <label>Organization<select aria-label="Client organization" value={organizationId} onChange={event=>{setOrganization(event.target.value);setClient('');}}><option value="">Choose organization</option>{status?.organizations.map(org=><option key={org.id} value={org.id}>{org.name}</option>)}</select></label>
    <form onSubmit={event=>{event.preventDefault();change(async()=>{const result=await invoke('clients.manage',{action:'createClient',organizationId,name:clientName});setClient(result.result.id);setClientName('');});}}>
      <label>Client name<input aria-label="Client name" value={clientName} maxLength={120} onChange={event=>setClientName(event.target.value)}/></label><button className="secondary-button" disabled={busy||!organizationId||!clientName.trim()}>Create client</button>
    </form>
    <label>Client<select aria-label="Workspace client" value={clientId} onChange={event=>setClient(event.target.value)}><option value="">Choose client</option>{clients.map(client=><option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
    <form onSubmit={event=>{event.preventDefault();change(async()=>{const project=await invoke('clients.createProject',{organizationId,clientId,name:projectName});setProjectName('');setNotice(`Created ${project.name}. Select it in a new chat’s project menu.`);});}}>
      <label>New project name<input aria-label="Client project name" value={projectName} maxLength={80} onChange={event=>setProjectName(event.target.value)}/></label><button className="primary-button" disabled={busy||!clientId||!projectName.trim()}>Create isolated project</button>
    </form>
    <p>Existing conversations keep their original boundaries. Start a new chat in the client project.</p>
  </section>;
}
