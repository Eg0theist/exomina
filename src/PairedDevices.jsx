import React, { useEffect, useState } from 'react';
import { Copy, KeyRound, LoaderCircle, Monitor, RefreshCw, Unplug, X } from 'lucide-react';
import { api } from './transport.js';

const dateLabel = value => { const date = new Date(value); return !value || Number.isNaN(date.getTime()) ? null : date.toLocaleString(); };
export default function PairedDevices() {
  const [devices, setDevices] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  async function list() {
    const result = await api.invoke('device.list');
    if (!Array.isArray(result) && !Array.isArray(result?.devices)) throw new Error('The server returned an unreadable device list.');
    setDevices(Array.isArray(result) ? result : result.devices); setLoaded(true);
  }
  async function act(action, callback) { setPending(action); setError(''); try { await callback(); } catch (err) { setError(err.message); } finally { setPending(''); } }
  useEffect(() => { act('list', list); }, []);
  useEffect(() => { if (!pairing) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [pairing]);
  const expiry = pairing?.expiresAt ? new Date(pairing.expiresAt).getTime() : NaN;
  const expired = !Number.isFinite(expiry) || now >= expiry;
  async function createCode() {
    await act('pair', async () => { const result = await api.invoke('device.pairingCode'); if (!result?.code || !dateLabel(result.expiresAt)) throw new Error('The server did not return a valid pairing code and expiry.'); setNow(Date.now()); setPairing(result); setCopied(false); });
  }
  return <section className="settings-section paired-devices"><div className="section-title"><h2>Desktop connections</h2><button className="text-button" disabled={!!pending} onClick={() => act('list', list)} aria-label="Refresh paired devices"><RefreshCw size={14} />Refresh</button></div><p className="cloud-description">Create a private pairing code, then enter it in the desktop app under Cloud & sync. Keep the code private until it expires.</p><div className="server-address"><span>Server address</span><code>{window.location.origin}</code></div><button className="secondary-button" disabled={!!pending} onClick={createCode}>{pending === 'pair' ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}{pairing ? 'Create a new pairing code' : 'Create pairing code'}</button>{pairing && <div className={`pairing-code-panel ${expired ? 'expired' : ''}`}><div><strong>{expired ? 'Pairing code expired' : 'Private pairing code'}</strong><button className="icon-button" aria-label="Hide pairing code" onClick={() => setPairing(null)}><X size={15} /></button></div>{!expired && <><code className="pairing-code">{pairing.code}</code><p>Expires {dateLabel(pairing.expiresAt)}</p><button className="text-button" onClick={() => act('copy', async () => { await navigator.clipboard.writeText(pairing.code); setCopied(true); })} disabled={!!pending}><Copy size={14} />{copied ? 'Copied' : 'Copy code'}</button></>}{expired && <p>Create a new code to connect a desktop.</p>}</div>}{error && <p className="inline-error" role="alert">{error}</p>}<div className="paired-device-list">{!loaded ? <p>{pending === 'list' ? 'Loading connected devices…' : 'Device list unavailable.'}</p> : !devices.length ? <p>No desktops are paired with this server.</p> : devices.map(device => <article key={device.id} className={device.revokedAt ? 'revoked-device' : ''}><Monitor size={19} /><div><strong>{device.name || device.label || 'Desktop app'}</strong><p>{device.revokedAt ? `Revoked ${dateLabel(device.revokedAt) || ''}` : dateLabel(device.lastSeenAt) ? `Last seen ${dateLabel(device.lastSeenAt)}` : 'No activity reported yet.'}</p>{!device.revokedAt && confirm === device.id && <div className="revoke-confirm"><p>Revoke this desktop’s access to the server? Its local data will stay on the device.</p><button className="secondary-button" disabled={!!pending} onClick={() => setConfirm(null)}>Cancel</button><button className="danger-text-button" disabled={!!pending} onClick={() => act('revoke', async () => { await api.invoke('device.revoke', { id: device.id }); setConfirm(null); await list(); })}>Revoke access</button></div>}</div>{device.revokedAt && <span className="tag">Access revoked</span>}{!device.revokedAt && confirm !== device.id && <button className="text-button" disabled={!!pending} onClick={() => setConfirm(device.id)}><Unplug size={14} />Revoke</button>}</article>)}</div></section>;
}
