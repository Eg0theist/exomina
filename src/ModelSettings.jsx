import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { normalizeModelPreferences, modelVisible, visibleModels, providerVisible } from '../desktop/model-preferences.mjs';
import { ProviderMark, providerReady } from './ProviderConnections.jsx';
import './model-settings.css';

export default function ModelSettings({ value, catalog, connections, models = {}, onChange, Toggle, onConnections }) {
  const prefs = normalizeModelPreferences(value);
  const ready = catalog.filter(item => providerReady(connections.find(c => c.id === item.id)) && providerVisible(prefs, item.id, connections.find(c => c.id === item.id), models[item.id]));
  const options = id => {
    const all = [{ id: 'auto', label: 'Provider default' }, ...(models[id] || []).filter(item => !['default', 'auto'].includes(item.id))];
    const connection = connections.find(c => c.id === id), info = catalog.find(item => item.id === id);
    if (info?.mode !== 'subscription' && connection?.model && !all.some(item => item.id === connection.model)) all.push({ id: connection.model, label: connection.model });
    return all;
  };
  const [provider, setProvider] = useState('codex'), [model, setModel] = useState('auto'), [effort,setEffort] = useState('');
  const chosenProvider = ready.some(item => item.id === provider) ? provider : ready[0]?.id || '';
  const choices = options(chosenProvider).filter(item => modelVisible(prefs, chosenProvider, item.id));
  const chosenModel = choices.some(item => item.id === model) ? model : choices[0]?.id || '';
  const modelInfo=(models[chosenProvider]||[]).find(item=>chosenModel==='auto'?item.isDefault:item.id===chosenModel);
  const efforts=modelInfo?.efforts||[],chosenEffort=efforts.some(item=>item.id===effort)?effort:'';
  const save = patch => onChange({ ...prefs, ...patch });
  const fallback = patch => save({ fallback: { ...prefs.fallback, ...patch } });
  function showModel(provider, id, checked, all) {
    const next = new Set(prefs.models[provider] || all.map(item => item.id));
    checked ? next.add(id) : next.delete(id);
    save({ models: { ...prefs.models, [provider]: [...next] } });
  }
  function move(index, direction) { const next = [...prefs.fallback.targets]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; fallback({ targets: next }); }
  return <section className="settings-section" id="settings-models">
    <div className="section-title"><h2>Models &amp; continuity</h2><span>Choose what appears and who takes over</span></div>
    <details className="model-visibility-provider model-access-note"><summary>How model updates and access work</summary><p className="model-continuity-note">Exomina reads model choices from connected providers. Refresh Connections to check for new choices. A provider can add a model without an Exomina update; new tools, voice features or runtime changes can still need an app update. Hidden models stay hidden until you enable them.</p><p className="model-continuity-note">Access and usage follow your provider account, plan and rollout. A free offer in a provider’s own desktop app does not guarantee access through Exomina’s connection. Exomina adds no subscription allowance. A compatible local model can work without a paid AI account, after its separate setup.</p><button type="button" className="text-button" onClick={onConnections}>Check my connections</button></details>
    <div className="settings-row"><div><strong>Show connected options only</strong><p>Hide inactive connections from the chat picker and new-chat cards. Connections always shows the full list.</p></div><Toggle label="Show connected options only" checked={prefs.connectedOnly} onChange={connectedOnly => save({ connectedOnly })} /></div>
    <div className="model-visibility-list">{catalog.map(item => {
      const connection = connections.find(c => c.id === item.id), shown = !prefs.hiddenProviders.includes(item.id);
      const all = options(item.id);
      return <details className="model-visibility-provider" key={item.id}><summary><ProviderMark provider={item.id} info={item} small /><span>{item.name}</span><small>{providerReady(connection) ? `${visibleModels(prefs, item.id, all).length} choices` : 'Not connected'}</small></summary>
        <label className="model-check"><input type="checkbox" aria-label={`Show ${item.name} in pickers`} checked={shown} onChange={event => save({ hiddenProviders: event.target.checked ? prefs.hiddenProviders.filter(id => id !== item.id) : [...prefs.hiddenProviders, item.id] })} />Show this connection in pickers and new chats</label>
        {shown && <div className="model-check-grid">{all.map(m => <label className="model-check" key={m.id}><input type="checkbox" aria-label={`Show ${item.name} ${m.label}`} checked={modelVisible(prefs, item.id, m.id)} onChange={event => showModel(item.id, m.id, event.target.checked, all)} />{m.label || m.id}</label>)}</div>}
        {prefs.models[item.id] && <button type="button" className="text-button" onClick={() => { const next = { ...prefs.models }; delete next[item.id]; save({ models: next }); }}>Show all reported models, including future additions</button>}
        {connection?.configured && item.mode !== 'subscription' && !models[item.id]?.length && <p className="popover-hint">This connection uses its configured model. Discover or configure more models in Connections.</p>}
      </details>;
    })}</div>
    <div className="settings-row"><div><strong>Automatic usage fallback</strong><p>Keep the same task running with another enabled provider when its allowance is exhausted. On by default; your choice is remembered. At 85% usage, ChatGPT or Claude is asked to save a progress briefing first. Completed work, tool results and chat context carry over.</p></div><Toggle label="Automatic usage fallback" checked={prefs.fallback.enabled} onChange={enabled => fallback({ enabled })} /></div>
    <label className="fallback-mode">Fallback selection<select aria-label="Fallback selection" value={prefs.fallback.mode} onChange={event => fallback({ mode: event.target.value })}><option value="available">Choose an available subscription or local model</option><option value="ordered">Use my list in order</option></select></label>
    {prefs.fallback.mode === 'available' ? <p className="popover-hint">Automatic selection tries your usual AI, model and effort first, then compatible connected subscriptions. It skips exhausted allowances and options that cannot handle the task’s tools or images.</p> : <>
      <ol className="fallback-targets">{prefs.fallback.targets.map((target, index) => { const info = catalog.find(p => p.id === target.provider), option = models[target.provider]?.find(m => m.id === target.model); return <li key={`${target.provider}:${target.model}`}><span><strong>{info?.name} · {target.model === 'auto' ? 'Provider default' : option?.label || target.model}</strong><small>Effort: {target.effort || 'provider default'}</small>{info?.mode === 'api' && <small>Uses this connection’s API billing</small>}</span><button type="button" className="icon-button" aria-label={`Move fallback ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button type="button" className="icon-button" aria-label={`Move fallback ${index + 1} down`} disabled={index === prefs.fallback.targets.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button><button type="button" className="icon-button" aria-label={`Remove fallback ${index + 1}`} onClick={() => fallback({ targets: prefs.fallback.targets.filter((_, i) => i !== index) })}><Trash2 size={14} /></button></li>; })}</ol>
      <div className="fallback-add"><select aria-label="Fallback AI" value={chosenProvider} onChange={event => { setProvider(event.target.value); setModel('auto'); }}>{ready.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select aria-label="Fallback model" value={chosenModel} onChange={event => setModel(event.target.value)}>{choices.map(m => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}</select><select aria-label="Fallback effort" value={chosenEffort} onChange={event=>setEffort(event.target.value)}><option value="">Provider default effort</option>{efforts.map(item=><option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select><button type="button" className="secondary-button" disabled={!chosenProvider || !chosenModel || prefs.fallback.targets.length >= 12 || prefs.fallback.targets.some(t => t.provider === chosenProvider && t.model === chosenModel)} onClick={() => fallback({ targets: [...prefs.fallback.targets, { provider: chosenProvider, model: chosenModel, effort: chosenEffort }] })}><Plus size={14} />Add fallback</button></div>
      {!prefs.fallback.targets.length && <p className="popover-hint">Add at least one fallback. The list is used from top to bottom, skipping disconnected, hidden or exhausted choices.</p>}
    </>}
    <p className="model-continuity-note">Handoffs wait for already-started tools to finish, preserve attached images where supported, and keep your permissions and follow-up queue. Each choice is tried once. A provider with an exhausted allowance is skipped unless it reports a separate available model allowance. Temporary throttling and network errors do not trigger a switch. Resets remain a manual action in the usage panel.</p>
    <button type="button" className="text-button" onClick={onConnections}>Manage connections</button>
  </section>;
}
