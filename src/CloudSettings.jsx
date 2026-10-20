import React, { useEffect, useState } from 'react';
import { Cloud, Link2, LoaderCircle, RefreshCw, Unplug } from 'lucide-react';
import { api, isDesktop } from './transport.js';

export function syncLabel(sync = {}) {
  if (!sync.enabled) return 'Sync not configured';
  if (sync.state === 'syncing') return 'Syncing';
  if (sync.state === 'synced') return 'Synced';
  if (sync.state === 'offline') return sync.pendingCount ? 'Offline · changes pending' : 'Offline';
  if (sync.state === 'error') return 'Sync needs attention';
  return 'Waiting to sync';
}

export default function CloudSettings({ initialStatus, onStatus }) {
  const [status, setStatus] = useState(initialStatus || {});
  const [url, setUrl] = useState(initialStatus?.url || '');
  const [pairingCode, setPairingCode] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (initialStatus) setStatus(initialStatus); }, [initialStatus]);
  async function perform(action) {
    setPending(action); setError('');
    try {
      if (action === 'connect') { await api.invoke('cloud.configure', { url: url.trim(), pairingCode: pairingCode.trim() }); setPairingCode(''); }
      if (action === 'disconnect') await api.invoke('cloud.disconnect');
      if (action === 'sync') await api.invoke('sync.now');
      const next = await api.invoke('cloud.status'); setStatus(next); onStatus(next);
      if (next.url) setUrl(next.url);
    } catch (err) { setError(err.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { setPending(''); }
  }
  useEffect(() => { if (isDesktop) perform('refresh'); }, []);
  const timestamp = status.lastSyncedAt ? new Date(status.lastSyncedAt) : null;
  return <section className="settings-section cloud-settings"><div className="section-title"><h2>Private Exomina sync</h2><span className={`sync-status ${status.state || 'disconnected'}`}><Cloud size={13} />{syncLabel(status)}</span></div><p className="cloud-description">Optional sync with a separately hosted Exomina server for chats and saved memories. Codex Cloud tasks do not require this connection. Your PC’s tools remain available only while it is online.</p>{!status.enabled && <form onSubmit={event => { event.preventDefault(); perform('connect'); }}><label className="input-label" htmlFor="cloud-server-url">Private server address</label><input id="cloud-server-url" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://your-exomina-server.example" required /><label className="input-label" htmlFor="cloud-pairing-code">Pairing code</label><input id="cloud-pairing-code" type="password" autoComplete="off" value={pairingCode} onChange={event => setPairingCode(event.target.value)} placeholder="Code from your private server" required /><button className="primary-button" disabled={!!pending || !url.trim() || !pairingCode.trim()}>{pending === 'connect' ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />}Connect</button></form>}{status.enabled && <div className="cloud-connected"><p>{status.url || 'Private server connected'}</p><div className="cloud-sync-meta"><span>{timestamp && !Number.isNaN(timestamp.getTime()) ? `Last synced ${timestamp.toLocaleString()}` : 'No completed sync reported yet.'}</span>{Number(status.pendingCount) > 0 && <span>{status.pendingCount} changes pending</span>}</div><div className="cloud-actions"><button className="secondary-button" disabled={!!pending} onClick={() => perform('sync')}>{pending === 'sync' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Sync now</button><button className="text-button" disabled={!!pending} onClick={() => perform('disconnect')}><Unplug size={14} />Disconnect</button></div></div>}{(error || status.error) && <p className="inline-error" role="alert">{error || status.error}</p>}</section>;
}
