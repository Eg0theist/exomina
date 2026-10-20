import React, { useState } from 'react';
import { Blocks, LoaderCircle, Sparkles, Trash2 } from 'lucide-react';
import { api } from './transport.js';

const errorText = error => (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
const shown = server => [server.command, ...(server.args || [])].join(' ');

/** Small local programs that give the AI more to do. Exomina can write one on request; here they are switched on, off or removed. */
export default function Extensions({ settings, status = [], act, refresh, busyAction, hasActiveRun = false }) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const servers = (settings.externalMcpServers || []).filter(server => server.id !== 'cua');
  const apply = (id, change) => act('extension-' + id, async () => {
    setError('');
    try {
      const next = (settings.externalMcpServers || []).flatMap(server => server.id !== id ? [server] : change(server) ? [change(server)] : []);
      await api.invoke('settings.save', { externalMcpServers: next });
      await api.invoke('mcp.refresh'); await refresh();
    } catch (problem) { setError(errorText(problem)); }
  });
  return <section className="extensions-panel" aria-labelledby="extensions-title">
    <div className="section-title"><h2 id="extensions-title">Extensions</h2><span>{servers.length ? `${servers.length} added` : 'None yet'}</span></div>
    <div className="extensions-hint"><Sparkles size={17} strokeWidth={1.6} /><p><strong>Missing something? Ask for it.</strong> Tell Exomina in any chat what you want, for example “add a tool that checks my server status”. It writes a small program, shows you exactly what will run, and only saves and starts it after you approve.</p></div>
    {servers.length > 0 && <div className="extension-list">{servers.map(server => {
      const state = status.find(item => item.id === server.id), busy = busyAction === 'extension-' + server.id;
      return <div className="tool-row extension-row" key={server.id}>
        <span className="tool-row-icon"><Blocks size={17} /></span>
        <div><strong>{server.name || server.id}</strong><p title={shown(server)}>{shown(server)}</p>{server.enabled && state?.error && <p className="inline-error" role="status">{state.error}</p>}</div>
        <span className={`tool-state ${server.enabled && state?.connected ? 'enabled' : ''}`}><span />{!server.enabled ? 'Off' : state?.connected ? `${state.toolCount} tool${state.toolCount === 1 ? '' : 's'}` : 'Not running'}</span>
        <label className="extension-switch"><input type="checkbox" role="switch" aria-label={`Run ${server.name || server.id}`} checked={!!server.enabled} disabled={!!busyAction || hasActiveRun} onChange={event => apply(server.id, current => ({ ...current, enabled: event.target.checked }))} /><span>{server.enabled ? 'On' : 'Off'}</span></label>
        {confirm === server.id
          ? <span className="extension-confirm"><button className="danger-text-button" disabled={!!busyAction} onClick={() => { setConfirm(''); apply(server.id, () => null); }}>{busy ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}Remove</button><button className="text-button" onClick={() => setConfirm('')}>Keep</button></span>
          : <button className="icon-button" aria-label={`Remove ${server.name || server.id}`} disabled={!!busyAction || hasActiveRun} onClick={() => setConfirm(server.id)}><Trash2 size={14} /></button>}
      </div>;
    })}</div>}
    {hasActiveRun && servers.length > 0 && <p className="connection-small">Extensions can be changed when no chat is replying.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
