import React, { useState } from 'react';
import { Blocks, LoaderCircle, Sparkles, Trash2, RefreshCw } from 'lucide-react';
import { api } from './transport.js';
import RemoteServices from './RemoteServices.jsx';

const errorText = error => (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
const shown = server => [server.command, ...(server.args || [])].join(' ');

/** Small local programs that give the AI more to do. Exomina can write one on request; here they are switched on, off or removed. */
export default function Extensions({ settings, status = [], act, refresh, busyAction, hasActiveRun = false }) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const servers = (settings.externalMcpServers || []).filter(server => server.id !== 'cua'&&server.transport!=='http');
  const apply = (id, action) => act('extension-' + id, async () => {
    setError('');
    try {
      await api.invoke('mcp.extensionChange', { id, action });
      await refresh();
    } catch (problem) { setError(errorText(problem)); }
  });
  return <section className="extensions-panel" aria-labelledby="extensions-title">
    <div className="section-title"><h2 id="extensions-title">Extensions</h2><span>{servers.length} local programs</span></div>
    <div className="extensions-hint"><Sparkles size={17} strokeWidth={1.6} /><p><strong>Missing something? Ask for it.</strong> Tell Exomina in any chat what you want, for example “add a tool that checks my server status”. It writes a small program, shows you exactly what will run, and only saves and starts it after you approve.</p></div>
    {servers.length > 0 && <div className="extension-list">{servers.map(server => {
      const state = status.find(item => item.id === server.id), busy = busyAction === 'extension-' + server.id;
      return <div className="tool-row extension-row" key={server.id}>
        <span className="tool-row-icon"><Blocks size={17} /></span>
        <div><strong>{server.name || server.id}</strong><p title={shown(server)}>{shown(server)}</p>{server.enabled && state?.error && <p className="inline-error" role="status">{state.error}</p>}</div>
        <span className={`tool-state ${server.enabled && state?.connected ? 'enabled' : ''}`}><span />{!server.enabled ? 'Off' : state?.connected ? `${state.toolCount} tool${state.toolCount === 1 ? '' : 's'}` : 'Not running'}</span>
        <button type="button" className="icon-button" aria-label={`Refresh tools for ${server.name||server.id}`} disabled={!!busyAction||hasActiveRun||!server.enabled} onClick={()=>apply(server.id,'reconnect')}><RefreshCw size={14}/></button>
        <label className="extension-switch"><input type="checkbox" role="switch" aria-label={`Run ${server.name || server.id}`} checked={!!server.enabled} disabled={!!busyAction || hasActiveRun&&!server.enabled} onChange={event => apply(server.id, event.target.checked?'enable':'disable')} /><span>{server.enabled ? 'On' : 'Off'}</span></label>
        {confirm === server.id
          ? <span className="extension-confirm"><button className="danger-text-button" disabled={!!busyAction} onClick={() => { setConfirm(''); apply(server.id, 'remove'); }}>{busy ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}Remove</button><button className="text-button" onClick={() => setConfirm('')}>Keep</button></span>
          : <button className="icon-button" aria-label={`Remove ${server.name || server.id}`} disabled={!!busyAction} onClick={() => setConfirm(server.id)}><Trash2 size={14} /></button>}
      </div>;
    })}</div>}
    {servers.length > 0 && <p className="connection-small">Turn off or remove an extension immediately. An in-flight action may already have taken effect. Reconnecting waits for replies to finish and reloads only that extension; Exomina stays open. Removing a connection keeps its source files.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <RemoteServices settings={settings} status={status} refresh={refresh} hasActiveRun={hasActiveRun}/>
  </section>;
}
