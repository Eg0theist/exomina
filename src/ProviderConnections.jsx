import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Check, ExternalLink, Globe2, Image as ImageIcon, KeyRound, LoaderCircle, LogOut, Orbit, RefreshCw, ShieldCheck, Terminal, Unplug, X } from 'lucide-react';

import { api } from './transport.js';
import ProviderPrivacy from './ProviderPrivacy.jsx';
import ModelAvailability from './ModelAvailability.jsx';
import { useStandardView } from './InterfaceView.jsx';
import { isLocalEndpoint } from '../desktop/api-endpoint.mjs';
import './custom-ai.css';
export const DEFAULT_PROVIDERS = [
  { id: 'codex', name: 'ChatGPT', engine: 'Codex', mode: 'subscription', authType: 'official', defaultModel: 'auto', description: 'Use a ChatGPT plan that includes Codex.', billingNote: 'Your subscription and provider usage settings apply.' },
  { id: 'claude', name: 'Claude', engine: 'Claude Code', mode: 'subscription', authType: 'official', defaultModel: 'auto', description: 'Use a Claude plan that includes Claude Code.', billingNote: 'Your subscription and provider usage settings apply.' },
];
export const providerModeLabel = mode => mode === 'local' ? 'Local' : mode === 'api' ? 'API connection' : 'Subscription';
export const providerReady = connection => connection?.checking !== true && connection?.available !== false && !!(connection?.configured || connection?.connected);
const unavailable = (provider, connection, isWeb) => connection?.available === false || (isWeb && provider.mode !== 'api' && connection?.available !== true);
const errorText = error => (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
const normalizeModels = models => (models || []).map(model => typeof model === 'string' ? { id: model, label: model } : { ...model, label: model.label || model.name || model.id }).filter(model => model.id);
const accents = { codex: '#b8e9cb', claude: '#d7b095', antigravity: '#9baff4', grok: '#d4d8d5', 'muse-code': '#77b5ff', 'openai-api': '#8fd1b0', 'anthropic-api': '#c99a7c', gemini: '#86a0ea', xai: '#bfc4c0' };

export function ProviderMark({ provider, info, small = false }) {
  const accent = info?.accent || accents[provider] || '#adc8b9';
  const title = info?.name || DEFAULT_PROVIDERS.find(item => item.id === provider)?.name || provider || 'AI';
  const isClaude = provider === 'claude';
  const isOpenAI = provider === 'codex';
  return <span className={`provider-mark catalog-mark ${small ? 'small' : ''}`} style={{ '--provider-accent': accent }} aria-hidden="true">
    {isClaude ? <span className="claude-star">✳</span> : isOpenAI ? <Orbit size={small ? 15 : 21} strokeWidth={1.6} /> : <span className="provider-monogram">{title.slice(0, 1).toUpperCase()}</span>}
  </span>;
}

export function ProviderMenu({ catalog, connections, selected, onSelect, onManage, isWeb = false }) {
  const [query, setQuery] = useState('');
  const filtered = catalog.filter(item => `${item.name} ${item.engine || ''} ${(item.aliases || []).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="provider-menu catalog-provider-menu"><div className="popover-label">CHOOSE YOUR AI</div><div className="provider-menu-search"><input autoFocus aria-label="Search providers" placeholder="Find a provider…" value={query} onChange={event => setQuery(event.target.value)} /></div><div className="provider-menu-list">{['subscription', 'api', 'local'].map(mode => { const entries = filtered.filter(item => (item.mode || 'subscription') === mode); return entries.length ? <div key={mode}><div className="provider-menu-group">{mode === 'subscription' ? 'Subscriptions' : mode === 'api' ? 'API connection' : 'Local models'}</div>{entries.map(item => { const status = connections.find(connection => connection.id === item.id); return <button type="button" className="provider-menu-item" key={item.id} disabled={status?.checking || unavailable(item, status, isWeb)} title={status?.unavailableReason || (unavailable(item, status, isWeb) ? 'Unavailable on this host' : '')} onClick={() => onSelect(item)}><ProviderMark provider={item.id} info={item} small /><span><strong>{item.name}</strong><small>{status?.checking ? 'Checking…' : unavailable(item, status, isWeb) ? status?.unavailableReason || 'Unavailable on this host' : providerReady(status) ? mode === 'subscription' ? item.engine : status.model || 'Configured' : 'Setup needed'}</small></span>{selected === item.id ? <Check size={14} /> : providerReady(status) ? <span className="provider-ready-dot" /> : null}</button>; })}</div> : null; })}{!filtered.length && <p className="provider-menu-empty">No matching providers</p>}</div><button type="button" className="menu-footer" onClick={onManage}>Manage connections <ArrowRight size={13} /></button></div>;
}

function ProviderSetup({ provider, connection, onClose, onSaved, onModalChange, isWeb = false }) {
  const custom = provider.configurableEndpoint === true;
  const customUrl = provider.mode === 'local' || custom;
  const urlChoices = (provider.allowedBaseUrls || []).map(value => typeof value === 'string' ? { url: value, label: value } : { url: value.url || value.value, label: value.label || value.url || value.value });
  const defaultUrl = provider.baseUrl || provider.defaultBaseUrl || urlChoices[0]?.url || '';
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl || defaultUrl);
  const local = provider.mode === 'local' || custom && isLocalEndpoint(baseUrl);
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [supportsTools, setSupportsTools] = useState(connection?.supportsTools === true);
  const [supportsImages, setSupportsImages] = useState(connection?.supportsImages === true);
  const [maxOutputTokens, setMaxOutputTokens] = useState(connection?.maxOutputTokens || 2048);
  const [model, setModel] = useState(connection?.model || provider.defaultModel || '');
  const [models, setModels] = useState(normalizeModels(provider.models));
  const [accepted, setAccepted] = useState(!!connection?.configured);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => { onModalChange(true); return () => onModalChange(false); }, [onModalChange]);

  function changeAddress(value) {
    setBaseUrl(value); setModels([]); setMessage(''); setError(''); setAccepted(false);
    setKey(''); setRemoveKey(false);
  }

  async function loadModels() {
    setPending('models'); setError(''); setMessage('');
    try {
      const result = await api.invoke('provider.models', { provider: provider.id, ...(key.trim() ? { apiKey: key.trim() } : {}), ...(removeKey ? { removeKey: true } : {}), ...(baseUrl ? { baseUrl } : {}) });
      const next = normalizeModels(result.models);
      setModels(next);
      if (!model && next.length === 1) setModel(next[0].id);
      setMessage(result.message || (next.length ? `${next.length} models returned. Choose one or enter its model ID below.` : 'No model list was returned. Enter a model ID manually.'));
    } catch (err) { setError(errorText(err)); }
    finally { setPending(''); }
  }

  async function save(event) {
    event.preventDefault(); setPending('save'); setError('');
    try {
      await api.invoke('provider.configure', { provider: provider.id, model: model.trim(), ...(baseUrl ? { baseUrl: baseUrl.trim() } : {}), ...(key.trim() ? { apiKey: key.trim() } : {}), ...(local ? {} : { allowPaidApi: accepted }), ...(custom ? { removeKey, supportsTools, supportsImages, maxOutputTokens: Number(maxOutputTokens) } : {}) });
      setKey(''); await onSaved(`${provider.name} is configured. No completion request was sent.`); onClose();
    } catch (err) { setError(errorText(err)); }
    finally { setPending(''); }
  }

  async function disconnect() {
    setPending('disconnect'); setError('');
    try { await api.invoke('provider.disconnect', { provider: provider.id }); setKey(''); await onSaved(`${provider.name} configuration removed.`); onClose(); }
    catch (err) { setError(errorText(err)); }
    finally { setPending(''); }
  }

  return createPortal(<div className="modal-backdrop"><section className="modal provider-setup-modal" role="dialog" aria-modal="true" aria-labelledby="provider-setup-title">
    <button className="modal-close icon-button" aria-label="Close provider setup" disabled={!!pending} onClick={onClose}><X size={18} /></button>
    <div className="provider-setup-heading"><ProviderMark provider={provider.id} info={provider} /><div><div className="eyebrow">{custom ? 'OPTIONAL CONNECTION' : local ? 'LOCAL MODEL' : 'API CONNECTION'}</div><h2 id="provider-setup-title">{custom ? 'Add your own AI' : `Set up ${provider.name}`}</h2></div></div>
    <p>{custom ? 'Use a local model or a hosted service with an OpenAI-compatible Chat Completions API. Your prompts, enabled shared memory and approved tool results go to this server. Exomina does not download or start a model for you.' : local ? 'Connect to a model server running on your computer. Exomina does not download or start a model for you.' : 'Connect with your API key and choose a model. Your provider’s API quotas and billing rules apply; Exomina never uses this connection as an automatic fallback.'}</p>
    <form onSubmit={save}><fieldset className="provider-setup-fields" disabled={!!pending}>
      {custom && <div className="custom-ai-presets" aria-label="Server examples"><span>Start with</span><button type="button" onClick={() => changeAddress('http://127.0.0.1:1234/v1')}>LM Studio</button><button type="button" onClick={() => changeAddress('http://127.0.0.1:11434/v1')}>Ollama</button><button type="button" onClick={() => changeAddress('')}>Hosted server</button></div>}
      {customUrl ? <div className="provider-form-field"><label className="input-label" htmlFor="provider-base-url">Server address</label><input id="provider-base-url" type="url" autoComplete="off" spellCheck={false} value={baseUrl} onChange={event => changeAddress(event.target.value)} placeholder="http://127.0.0.1:1234/v1 or https://your-provider.example/v1" required /><p>{local ? `Local to ${isWeb ? 'your private server' : 'this computer'}. Start your model server first, then load its models.` : 'Use an HTTPS API base address you trust, usually ending in /v1. Your prompts and approved tool results will be sent there.'}</p></div> : urlChoices.length > 1 ? <div className="provider-form-field"><label className="input-label" htmlFor="provider-region">Endpoint / region</label><select id="provider-region" value={baseUrl} onChange={event => setBaseUrl(event.target.value)}>{urlChoices.map(choice => <option key={choice.url} value={choice.url}>{choice.label}</option>)}</select><p>Choose the endpoint that matches where your provider account and API key were created.</p></div> : defaultUrl ? <div className="provider-endpoint"><Globe2 size={13} /><span>{defaultUrl}</span></div> : null}
      {(!local || custom) && <div className="provider-form-field"><label className="input-label" htmlFor="provider-api-key">API key{custom && ' (optional)'}{connection?.hasKey && !removeKey && <span>Saved securely</span>}</label><input id="provider-api-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => { setKey(event.target.value); setRemoveKey(false); }} placeholder={connection?.hasKey && !removeKey ? 'Leave blank to keep the saved key' : custom ? 'Only if your server requires one' : 'Paste your API key'} required={!custom && !connection?.hasKey} /><p>{isWeb ? 'The key is saved on your private server. It is not saved in this browser.' : 'The key is stored using your operating system’s protected storage.'}{custom && ' Changing the address requires a new key or explicit removal of the saved key.'}</p>{custom && connection?.hasKey && <label className="custom-ai-choice"><input type="checkbox" checked={removeKey} onChange={event => { setRemoveKey(event.target.checked); setKey(''); }} />Remove saved key and connect without it</label>}</div>}
      <div className="provider-model-heading"><label className="input-label" htmlFor="provider-model-id">Model ID</label><button type="button" className="text-button" disabled={!!pending || (customUrl && !baseUrl.trim()) || (!custom && !local && !key.trim() && !connection?.hasKey)} onClick={loadModels}>{pending === 'models' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}Load models</button></div>
      {models.length > 0 && <select className="provider-model-select" aria-label="Available models" value={models.some(item => item.id === model) ? model : ''} onChange={event => { if (event.target.value) setModel(event.target.value); }}><option value="">Choose a model or enter its ID below</option>{models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}
      <div className="provider-form-field"><input id="provider-model-id" autoComplete="off" spellCheck={false} value={model} onChange={event => setModel(event.target.value)} placeholder="Enter the provider’s model ID" required /><p>Load models retrieves model metadata only. It does not send a chat or a paid completion request.</p></div>
      {custom && <fieldset className="custom-ai-capabilities"><legend>Model support</legend><p>Start with text chat. Enable these only if your chosen model and server support them.</p><label className="custom-ai-choice"><input type="checkbox" checked={supportsTools} onChange={event => setSupportsTools(event.target.checked)} /><span>Tools <small>Use Exomina’s tools with the usual permission controls.</small></span></label><label className="custom-ai-choice"><input type="checkbox" checked={supportsImages} onChange={event => setSupportsImages(event.target.checked)} /><span>Image input <small>Let this model read attached images and images returned by tools.</small></span></label><label className="custom-ai-token-limit">Maximum reply tokens<input type="number" min="128" max="32768" step="1" value={maxOutputTokens} onChange={event => setMaxOutputTokens(event.target.value)} required /></label></fieldset>}
      {message && <p className="provider-setup-message" role="status">{message}</p>}
      {!local && <label className="api-billing-consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} required /><span>{custom ? 'I trust this server with my prompts and approved tool results, and understand its quotas and billing rules apply.' : 'I understand that this connection uses the provider’s API quotas and billing rules.'}</span></label>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions provider-setup-actions">{providerReady(connection) && <button className="danger-text-button" type="button" disabled={!!pending} onClick={disconnect}><Unplug size={14} />Remove connection</button>}<button className="secondary-button" type="button" disabled={!!pending} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!!pending || !model.trim() || (!local && !accepted)}>{pending === 'save' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Save connection</button></div>
    </fieldset></form>
  </section></div>, document.body);
}

export default function ProviderConnections({ catalog, connections, busyAction, act, refresh, connect, signOut, onModalChange = () => {}, onNotice, openExternal, openWebsite = openExternal, isWeb = false, extra, onBack }) {
  const [confirmOut, setConfirmOut] = useState('');
  const [setup, setSetup] = useState(null);
  const [filter, setFilter] = useState('');
  const [chosenType, setConnectionType] = useState('subscription');
  // Standard shows the account sign-ins people already have; API keys and GitHub live in Advanced.
  const standard = useStandardView();
  const connectionType = standard ? 'subscription' : chosenType;
  const extraTabs = !extra ? [] : Array.isArray(extra) ? extra.filter(Boolean) : [{ id: 'github', label: 'GitHub', content: extra }];
  const groups = [
    { mode: 'subscription', title: 'Subscriptions', description: 'Use the official sign-in flow for a supported subscription.' },
    { mode: 'api', title: 'API keys', description: 'Pay per use with your own key. Exomina’s safety limits apply, and there is never an automatic fallback to an API.' },
    { mode: 'custom', title: 'Your own AI', description: 'An optional connection for a local model server or a hosted service. Configure it once, then choose it in any chat.' },
  ];
  async function saved(message) { await refresh(); onNotice(message); }
  const filtered = catalog.filter(item => `${item.name} ${item.engine || ''} ${(item.aliases || []).join(' ')}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return <div className="content-page connections-page">
    {onBack && <button className="text-button" onClick={onBack}><ArrowLeft size={14} />Back to Settings</button>}
    <div className="page-heading"><div><div className="eyebrow">ACCOUNTS & MODELS</div><h1>Connect your accounts</h1><p>{standard ? 'Sign in to the AI accounts you already have. You can sign out again at any time.' : 'Use your subscriptions, API keys or your own AI server. Each connection can be removed again at any time.'}</p></div><button className="secondary-button" onClick={() => act('refresh-connections', refresh)}>{busyAction === 'refresh-connections' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}Refresh status</button></div>
    {!isWeb&&<ModelAvailability catalog={catalog}/>}
    {catalog.length > 10 && <div className="provider-catalog-search search-field"><Globe2 size={15} /><input aria-label="Filter providers" placeholder="Find a provider…" value={filter} onChange={event => setFilter(event.target.value)} />{filter && <button className="icon-button" aria-label="Clear provider filter" onClick={() => setFilter('')}><X size={13} /></button>}</div>}
    {standard ? <p className="connection-standard-note">API keys, your own AI and GitHub are in Advanced view.</p> : <div className="connection-types" role="tablist" aria-label="Connection types">{[...groups.map(group=>({id:group.mode,label:group.title})),...extraTabs].map(type=><button type="button" role="tab" key={type.id} id={`connection-tab-${type.id}`} aria-selected={connectionType===type.id} aria-controls={`connection-panel-${type.id}`} className={connectionType===type.id?'selected':''} onClick={()=>setConnectionType(type.id)}>{type.label}</button>)}</div>}
    {groups.map(group => { const members = filtered.filter(item => (item.configurableEndpoint ? 'custom' : item.mode || 'subscription') === group.mode); if (!members.length) return null; return <section className="provider-group" role="tabpanel" id={`connection-panel-${group.mode}`} aria-labelledby={`connection-tab-${group.mode}`} hidden={connectionType!==group.mode} data-mode={group.mode} key={group.mode}><div className="provider-group-heading"><h2>{group.title}</h2><p>{group.description}</p></div><div className="connection-grid">{members.map(item => {
      const status = connections.find(entry => entry.id === item.id);
      const native = group.mode === 'subscription';
      const checking = status?.checking === true;
      const off = item.optIn && status?.enabled !== true;
      const blocked = !checking && !off && unavailable(item, status, isWeb);
      const ready = !blocked && providerReady(status);
      return <article className={`connection-card catalog-connection-card ${ready ? 'connected' : ''}`} key={item.id} data-provider={item.id}>
        <div className="connection-card-top"><ProviderMark provider={item.id} info={item} /><span className={`tag ${ready ? 'mint' : ''}`}>{checking ? 'Checking…' : blocked ? 'Unavailable here' : ready ? <><span className="status-dot" />{native ? 'Connected' : 'Configured'}</> : item.optional ? 'Optional' : native ? status?.installed ? 'Ready to sign in' : 'Setup needed' : group.mode === 'api' ? 'API key required' : 'Not configured'}</span></div>
        <h2>{item.name}</h2><p className="connection-subtitle">{native ? (standard ? 'Your account' : `Uses ${item.engine}`) : providerModeLabel(item.mode)}</p>
        <p className="connection-description">{standard && native ? `Use your ${item.name} plan here. Sign in once and Exomina remembers it on this PC.` : item.description || (native ? `Connect through ${item.engine}.` : group.mode === 'local' ? 'Use models served locally on your computer.' : 'Connect with your own API key and choose a model.')}</p>
        {(native || ready || blocked) && <div className="connection-detail">{native && !standard ? <Terminal size={14} /> : <KeyRound size={14} />}<span>{(blocked && (status?.unavailableReason || 'This provider needs a connected host that supports it.')) || (standard && native && !ready ? (status?.installed ? 'Not signed in yet.' : 'Needs a one-time setup. Click below and follow the steps.') : '') || status?.detail || (ready && status.model ? `Model: ${status.model}` : native ? 'Connection has not been checked.' : 'No connection configured.')}</span></div>}
        {['codex','grok'].includes(item.id) && !blocked && status?.imageGeneration && <div className="connection-detail image-capability-note"><ImageIcon size={14} /><span><strong>{item.id==='grok'?'Imagine images & videos':'Image generation'}</strong><br />{status.imageGeneration.detail || 'Image availability has not been checked.'}</span></div>}
        {item.mediaWebsite && <details className="connection-billing connection-capabilities"><summary>Images &amp; videos</summary><p className="connection-small">Create images and videos on Gemini’s website with your Google plan.</p><button className="text-button" onClick={() => openWebsite(item.mediaWebsite.url)}>{item.mediaWebsite.label}<ExternalLink size={11} /></button></details>}
        <button className={`${ready ? 'secondary-button' : 'primary-button'} full-width`} disabled={checking || blocked || busyAction === `connect-${item.id}`} onClick={() => native ? connect(item.id) : setSetup(item)}>{checking || busyAction === `connect-${item.id}` ? <LoaderCircle size={15} className="spin" /> : ready ? <KeyRound size={15} /> : <ArrowRight size={15} />}{checking ? 'Checking…' : blocked ? 'Unavailable on this host' : native ? ready ? 'Manage sign-in' : status?.installed ? `Sign in to ${item.name}` : `Set up ${standard ? item.name : item.engine}` : ready ? 'Manage connection' : item.configurableEndpoint ? 'Add your own AI' : group.mode === 'local' ? 'Connect local model' : 'Add API key'}</button>
        {native && ready && !isWeb && signOut && (confirmOut === item.id
          ? <div className="connection-signout-confirm" role="group" aria-label={`Sign out of ${item.name}`}><span>Sign out of {item.name}?</span><button className="danger-text-button" disabled={busyAction === `signout-${item.id}`} onClick={() => { setConfirmOut(''); signOut(item.id, item.name); }}>{busyAction === `signout-${item.id}` ? <LoaderCircle size={13} className="spin" /> : <LogOut size={13} />}Sign out</button><button className="text-button" onClick={() => setConfirmOut('')}>Cancel</button></div>
          : <button className="text-button connection-signout" disabled={!!busyAction} onClick={() => setConfirmOut(item.id)}><LogOut size={13} />Sign out</button>)}
        {status?.executionLocation && <p className="connection-location">Runs on {status.executionLocation}</p>}
        <details className="connection-billing"><summary>Billing &amp; limits</summary><p className="connection-small">{item.billingNote || (native ? 'Your subscription and provider usage settings apply.' : group.mode === 'local' ? 'The model runs on your local server.' : 'Your provider’s API quotas and billing rules apply. No automatic fallback.')}</p></details>
        <ProviderPrivacy provider={item.id} openExternal={openExternal} />
        {item.setupUrl && !standard && <button className="provider-setup-link text-button" onClick={() => openExternal(item.setupUrl)}>Provider setup <ExternalLink size={11} /></button>}
      </article>;
    })}</div></section>; })}
    {!filtered.length && <p className="provider-no-results">No providers match that name.</p>}
    {extraTabs.map(tab => <div role="tabpanel" key={tab.id} id={`connection-panel-${tab.id}`} aria-labelledby={`connection-tab-${tab.id}`} hidden={connectionType!==tab.id}>{tab.content}</div>)}
    <div className="explanation-card"><ShieldCheck size={22} strokeWidth={1.4} /><div><h3>You choose the connection</h3><p>Exomina never switches from a subscription to an API key by itself. API keys are stored encrypted on this computer and are held to the safety limits in Settings → Usage. Creating an image with ChatGPT from another provider’s chat asks for your approval first. Models, limits and available tools depend on the provider.</p></div></div>
    {setup && <ProviderSetup isWeb={isWeb} key={setup.id} provider={setup} connection={connections.find(item => item.id === setup.id)} onClose={() => setSetup(null)} onSaved={saved} onModalChange={onModalChange} />}
  </div>;
}
