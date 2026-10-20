import React, { useEffect, useState } from 'react';
import { ExternalLink, FolderOpen, Copy, Unplug, Globe2 } from 'lucide-react';
import { api } from './transport.js';
import { useStandardView } from './InterfaceView.jsx';
import './browser-connection.css';

export default function BrowserConnection({ source, act, refresh, busyAction }) {
  const [status, setStatus] = useState({}), [setup, setSetup] = useState(null), [error, setError] = useState('');
  const standard = useStandardView();
  useEffect(() => {
    let live = true;
    const load = () => api.invoke('browser.connection').then(value => { if (live) setStatus(value); }).catch(() => {});
    load(); const interval = setInterval(load, 3000);
    return () => { live = false; clearInterval(interval); };
  }, []);
  async function action(name, work) {
    setError(''); await act(name, async () => { try { return await work(); } catch (failure) { setError(failure.message); throw failure; } });
  }
  const useBrowser = value => action('browser-source', async () => { await api.invoke('settings.save', { browserSource: value }); setSetup(null); await refresh(); });
  return <section className="browser-connection">
    <div><Globe2 size={21} /><h2>{standard ? 'Which browser your AI uses' : 'Browser used by AI tools'}</h2><span className={`inline-status ${source==='embedded'||status.connected ? 'enabled' : ''}`}><span />{source==='embedded'?'Built-in browser selected':status.connected?`${status.browser} selected`:'Selected browser disconnected'}</span></div>
    {standard ? <p>Your AI uses Exomina’s own browser. To let it use websites you are already signed in to, connect Chrome or Edge.</p> : <>
    <p>Page reads, actions and source inspection use this selection. Exomina does not switch to your personal browser when a page cannot be read.</p>
    <p>The built-in browser keeps its own sign-ins across chats and restarts. Sign in directly on the website; login windows now open normally.</p>
    <p>To use accounts already signed in to Chrome or Edge, connect the Exomina browser extension. Each chat gets its own browser tab. Page reads and actions still follow your Exomina permissions.</p></>}
    <div className="browser-connection-actions">
      <button className="secondary-button" disabled={!!busyAction || source !== 'connected'} onClick={() => useBrowser('embedded')}>Use built-in browser</button>
      <button className="secondary-button" disabled={!!busyAction || !status.connected || source === 'connected'} onClick={() => useBrowser('connected')}><ExternalLink size={14} />Use my browser</button>
      <button className="text-button" disabled={!!busyAction} onClick={() => action('browser-prepare', async () => setSetup(await api.invoke('browser.connection.prepare')))}>{status.paired ? 'Connect another browser' : 'Connect Chrome or Edge'}</button>
      {status.paired && <button className="text-button" disabled={!!busyAction} onClick={() => action('browser-disconnect', async () => { await api.invoke('browser.connection.disconnect'); setStatus({}); setSetup(null); await refresh(); })}><Unplug size={14} />Disconnect</button>}
    </div>
    {setup && <div className="browser-connection-setup">
      <ol><li>Open <strong>chrome://extensions</strong> in Chrome, or <strong>edge://extensions</strong> in Edge. Turn on Developer mode.</li><li>Choose <strong>Load unpacked</strong> and select the Exomina extension folder.<button className="text-button" onClick={() => action('browser-folder', () => api.invoke('browser.connection.folder'))}><FolderOpen size={14} />Open extension folder</button></li><li>Open the Exomina extension, paste this connection code, and press <strong>Connect</strong>.</li></ol>
      <div className="browser-pair-code"><input aria-label="Browser connection code" value={setup.code} readOnly /><button className="secondary-button" onClick={() => action('browser-code', () => api.invoke('browser.connection.copyCode'))}><Copy size={14} />Copy code</button></div>
      <p>The code expires after 10 minutes. Install the extension in the browser profile whose sign-ins you want to use.</p>
    </div>}
    {(error || status.error) && <p className="inline-error" role="alert">{error || status.error}</p>}
  </section>;
}
