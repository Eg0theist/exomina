import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, LoaderCircle, X } from 'lucide-react';
import { api } from './transport.js';
import { MARKETING_CHANNELS } from '../desktop/marketing-loop.mjs';
import './local-ai.css';

const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
const labels = {x:'X', reddit:'Reddit', linkedin:'LinkedIn', blog:'Blog', other:'Other'};
const stateText = {pending:'Waiting for your review', approved:'Approved, not posted yet', rejected:'Rejected', posted:'Posted'};

export default function MarketingSettings({saveSettings, Toggle, providers = []}) {
  const [view, setView] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [samples, setSamples] = useState(''), [notes, setNotes] = useState(''), [channel, setChannel] = useState(''), [edit, setEdit] = useState({});
  const load = useCallback(() => api.invoke('marketing.view').then(setView).catch(e => setError(message(e))), []);
  useEffect(() => { load(); }, [load]);
  const current = view?.settings || {enabled:false, provider:'', channels:[], brief:{}};
  async function run(work) {
    setBusy(true); setError('');
    try { const next = await work(); if (next?.drafts) setView(next); else await load(); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  const configure = patch => run(async () => { await saveSettings({marketing:{...current, ...patch}}); return null; });
  const brief = (key, value) => configure({brief:{...current.brief, [key]:value}});
  const toggleChannel = id => configure({channels:current.channels.includes(id) ? current.channels.filter(c => c !== id) : [...current.channels, id]});
  const field = (key, label, hint) => <label key={key}>{label}<textarea className="settings-input" rows="2" aria-label={label} placeholder={hint} defaultValue={current.brief[key] || ''} onBlur={event => event.target.value !== (current.brief[key] || '') && brief(key, event.target.value)} /></label>;
  return <section className="settings-section local-ai-settings" id="settings-marketing">
    <div className="section-title"><h2>Marketing helper</h2><span>{current.enabled ? 'Enabled' : 'Off by default'}</span></div>
    <p className="connection-small">Drafts posts about Exomina in your own style. It never posts anything: you review each draft, copy it out and publish it yourself.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="settings-row"><div><strong>Draft marketing posts</strong><p>Uses your chosen AI’s allowance only when you press Generate.</p></div><Toggle label="Draft marketing posts" checked={current.enabled} disabled={busy} onChange={checked => configure({enabled:checked})} /></div>
    {current.enabled && <>
      <div className="settings-row"><div><strong>AI used for drafts</strong></div><select aria-label="AI used for drafts" value={current.provider} onChange={event => configure({provider:event.target.value})}><option value="">Choose an AI</option>{providers.map(p => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}</select></div>
      <div className="local-ai-downloads">{MARKETING_CHANNELS.map(id => <label key={id} className="local-ai-checkbox"><input type="checkbox" checked={current.channels.includes(id)} onChange={() => toggleChannel(id)} />{labels[id]}</label>)}</div>
      <h3>Step 1 · Tell it about the product</h3>
      <div className="local-ai-form">{field('product', 'What is the product?', 'One or two sentences.')}{field('audience', 'Who is it for?', 'Who should care?')}{field('voiceNotes', 'Voice notes (optional)', 'Dry, direct, a little ironic…')}{field('avoid', 'Never mention or imitate (optional)', 'Competitors, phrases, topics.')}</div>
      <h3>Step 2 · Teach it your style</h3>
      <p className="connection-small">Paste some of your own public writing. Only numbers such as sentence length are kept; the text itself is discarded.{view?.style?.ready ? ` Style learned from ${view.style.words} words.` : ' No style learned yet.'}</p>
      <textarea className="settings-input" rows="4" aria-label="Writing samples" value={samples} onChange={event => setSamples(event.target.value)} />
      <button className="secondary-button" disabled={busy || samples.trim().length < 200} onClick={() => run(async () => { const next = await api.invoke('marketing.style', {samples}); setSamples(''); return next; })}>Learn my style</button>
      <h3>Step 3 · Generate and review drafts</h3>
      <textarea className="settings-input" rows="5" aria-label="Release notes" placeholder="Paste the release notes the posts should be based on." value={notes} onChange={event => setNotes(event.target.value)} />
      <div className="local-ai-downloads"><select aria-label="Channel" value={channel || current.channels[0] || ''} onChange={event => setChannel(event.target.value)}>{current.channels.map(id => <option key={id} value={id}>{labels[id]}</option>)}</select>
        <button className="primary-button" disabled={busy || !current.provider || !current.channels.length || notes.trim().length < 20} onClick={() => run(() => api.invoke('marketing.generate', {channel:channel || current.channels[0], releaseNotes:notes}))}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Generate drafts</button></div>
      {!(view?.drafts || []).length && <p className="connection-small">No drafts yet.</p>}
      {(view?.drafts || []).map(draft => <article className="local-ai-inbox" key={draft.id}>
        <strong>{labels[draft.channel]} · {stateText[draft.status]}</strong>
        {draft.status === 'posted' ? <p>{draft.text}</p> : <textarea className="settings-input" rows="3" aria-label="Draft text" value={edit[draft.id] ?? draft.text} onChange={event => setEdit({...edit, [draft.id]:event.target.value})} />}
        {draft.reason && <small>Based on: {draft.reason}</small>}
        <div className="local-ai-downloads">
          {draft.status !== 'posted' && edit[draft.id] != null && edit[draft.id] !== draft.text && <button className="secondary-button" disabled={busy} onClick={() => run(async () => { const next = await api.invoke('marketing.edit', {id:draft.id, text:edit[draft.id]}); setEdit({...edit, [draft.id]:undefined}); return next; })}>Save edit</button>}
          {draft.status === 'pending' && <button className="secondary-button" disabled={busy} onClick={() => run(() => api.invoke('marketing.approve', {id:draft.id}))}><Check size={14} />Approve</button>}
          {draft.status !== 'rejected' && draft.status !== 'posted' && <button className="text-button" disabled={busy} onClick={() => run(() => api.invoke('marketing.reject', {id:draft.id}))}><X size={14} />Reject</button>}
          {draft.status === 'approved' && <><button className="secondary-button" onClick={() => navigator.clipboard?.writeText(draft.text)}><Copy size={14} />Copy</button><button className="secondary-button" disabled={busy} onClick={() => run(() => api.invoke('marketing.posted', {id:draft.id}))}>I posted this</button></>}
        </div>
      </article>)}
    </>}
  </section>;
}
