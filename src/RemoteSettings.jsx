import React, { useEffect, useState } from 'react';
import { Smartphone, RefreshCw } from 'lucide-react';
import { api } from './transport.js';
import './remote.css';

export default function RemoteSettings() {
  const [status, setStatus] = useState({ phones: [], pending: [] });
  const [base, setBase] = useState(''), [invitation, setInvitation] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState({});
  useEffect(() => {
    let alive = true;
    const load = () => api.invoke('remote.status').then(value => { if (alive) setStatus(value); }).catch(e => { if (alive) setError(e.message); });
    load(); const off = api.onEvent(event => { if (event.type === 'remote.changed') load(); });
    return () => { alive = false; off(); };
  }, []);
  async function act(method, payload = {}) {
    setBusy(true); setError('');
    try { setStatus(await api.invoke(method, payload)); if (method === 'remote.configure') setInvitation(''); }
    catch (failure) { setError(failure.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); setStatus(await api.invoke('remote.status').catch(() => status)); }
    finally { setBusy(false); }
  }
  return <section className="settings-section remote-settings"><div className="section-title"><h2><Smartphone size={18}/>Phone access</h2></div>
    <p>Use your phone to chat with Exomina running on this computer, answer questions and approve actions. Your computer must stay on and awake.</p>
    {!status.configured ? <form onSubmit={event => { event.preventDefault(); act('remote.configure', { base, invitation }); }}>
      <p>Connect an owner-hosted Exomina relay first. This is separate from Private Exomina sync; no server is included or rented automatically.</p>
      <label>Phone relay address<input aria-label="Phone relay address" type="url" placeholder="https://your-relay.example" required value={base} onChange={e => setBase(e.target.value)}/></label>
      <label>Invitation code<input aria-label="Phone relay invitation" type="password" autoComplete="off" required value={invitation} onChange={e => setInvitation(e.target.value)}/></label>
      <button className="primary-button" disabled={busy}>Connect phone relay</button>
    </form> : <>
      <p>{status.base}</p><label className="remote-toggle"><input type="checkbox" role="switch" aria-label="Allow phone control" checked={status.enabled} disabled={busy} onChange={event => act('remote.enabled', { enabled: event.target.checked })}/>Allow phone control</label>
      <p role="status">{!status.enabled ? 'Phone control is off.' : status.connected ? 'Computer connected to your relay.' : status.error?'Connection needs attention.':'Connecting to your relay…'}</p>
      {status.lastConnectedAt&&<p>Last connected: {new Date(status.lastConnectedAt).toLocaleString()}</p>}
      {status.enabled&&status.retryAt&&<p>Retrying automatically after {new Date(status.retryAt).toLocaleTimeString()}.</p>}
      <button className="secondary-button" disabled={busy||!status.enabled} onClick={()=>act('remote.reconnect')}>Reconnect now</button>
      {status.error&&<details><summary>Connection help</summary><p>Open the relay address on this computer and your phone. The relay service must be running with a valid HTTPS certificate. This connection uses the relay’s device registration; changing its database or hostname can require recovery or pairing again. Reconnect keeps existing paired phones.</p><p>You can also continue work through a paired Discord account under Settings → Messaging while the relay is unavailable.</p></details>}
      <div className="remote-actions"><button className="primary-button" disabled={busy || !status.enabled} onClick={() => act('remote.pair')}>Pair a phone</button><button className="secondary-button" disabled={busy} onClick={() => act('remote.refresh')}><RefreshCw size={14}/>Refresh phones</button></div>
      {status.pairing && <div className="remote-pair-code"><h3>Scan with your phone’s camera</h3><img src={status.pairing.image} alt="Phone pairing QR code" width="280" height="280"/><p>Expires {new Date(status.pairing.expiresAt).toLocaleTimeString()}. Keep this code private. You will confirm the phone here before it can connect.</p><details><summary>Open or copy the pairing link</summary><input aria-label="Phone pairing link" readOnly value={status.pairing.link} onFocus={event => event.target.select()}/></details></div>}
      {status.pending.map(phone => <div className="remote-phone" key={phone.id}><div><strong>{phone.name} wants to pair</strong><p>Confirmation code: <b>{phone.fingerprint}</b></p><label><input type="checkbox" checked={confirmed[phone.id] === true} onChange={e => setConfirmed(old => ({ ...old, [phone.id]: e.target.checked }))}/>The code matches my phone</label></div><button className="primary-button" disabled={busy || !confirmed[phone.id]} onClick={() => act('remote.approve', { id: phone.id, confirmation: phone.fingerprint })}>Approve phone</button><button disabled={busy} onClick={() => act('remote.remove', { id: phone.id })}>Reject</button></div>)}
      {status.phones.map(phone => <div className="remote-phone" key={phone.id}><div><strong>{phone.name}</strong><p>{phone.lastSeen ? 'Last seen ' + new Date(phone.lastSeen).toLocaleString() : 'Waiting for the phone to connect.'}</p></div><button className="secondary-button" disabled={busy} onClick={() => act('remote.remove', { id: phone.id })}>Remove phone</button></div>)}
      {!status.phones.length && <p>No phones paired yet.</p>}
      <button className="text-button" disabled={busy || status.phones.length > 0} onClick={() => act('remote.disconnect')}>Disconnect phone relay</button>
    </>}
    <p className="remote-limit">Your relay carries encrypted messages. Use a server you control: its website code is trusted on your phone. Removing a phone stops future access; it cannot erase content already seen. Device keys do not provide forward secrecy. Phone approvals are “Allow once” or “Deny”; change permissions and provider logins on this computer.</p>
    {(error || status.error) && <p className="inline-error" role="alert">{error || status.error}</p>}
  </section>;
}
