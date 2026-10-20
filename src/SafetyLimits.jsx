import React, { useCallback, useEffect, useState } from 'react';
import { Gauge, LoaderCircle, RotateCcw } from 'lucide-react';
import { api } from './transport.js';

const NAMES = { codex: 'ChatGPT', claude: 'Claude', antigravity: 'Gemini', grok: 'Grok', 'muse-code': 'Muse Code', 'openai-api': 'OpenAI API', 'anthropic-api': 'Anthropic API', gemini: 'Gemini API', xai: 'Grok API' };
const KINDS = [
  { id: 'reply', label: 'Chat replies', hint: 'Messages you send in a chat.' },
  { id: 'background', label: 'Background requests', hint: 'Helpers, on-demand summaries, chat titles and scheduled work. Memory catch-up has separate limits under Privacy & data → Memory & privacy.' },
];
const TOKENS = { id: 'tokens', label: 'API token budget (estimated)', hint: 'Per API connection. Before every round, reserve estimated input plus 8,192 output tokens. Unused output stays counted, including after failures and restarts. This is a conservative safeguard, not a currency or provider billing cap.' };
const count = value => Number(value || 0).toLocaleString('en-US');
const errorText = error => (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');

/** A bug must never be able to spend a subscription quietly. These limits are per account and apply to every model request Exomina starts. */
export default function SafetyLimits({ initial }) {
  const [view, setView] = useState(initial || null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => { try { const next = await api.invoke('guard.view'); setView(next); setDraft(current => current || next.limits); } catch (problem) { setError(errorText(problem)); } }, []);
  useEffect(() => { load(); const timer = setInterval(load, 15000); return () => clearInterval(timer); }, [load]);
  const limits = draft || view?.limits;
  if (!limits) return null;
  const set = (kind, window, value) => { setMessage(''); setDraft({ ...limits, [kind]: { ...limits[kind], [window]: Math.max(1, Math.min(kind === 'tokens' ? 1_000_000_000 : 100000, Math.floor(Number(value)) || 1)) } }); };
  async function save(next) {
    setBusy(true); setError(''); setMessage('');
    try { await api.invoke('settings.save', { requestLimits: next }); const fresh = await api.invoke('guard.view'); setView(fresh); setDraft(fresh.limits); setMessage('Safety limits saved.'); }
    catch (problem) { setError(errorText(problem)); }
    finally { setBusy(false); }
  }
  const providers = [...new Set([...Object.keys(view?.used || {}), ...Object.keys(view?.tokens || {})])].filter(id => NAMES[id]);
  return <section className="settings-section safety-limits" id="settings-safety-limits">
    <div className="section-title"><h2>Safety limits</h2><span className={`tag ${limits.enabled ? 'mint' : ''}`}><Gauge size={12} />{limits.enabled ? 'On' : 'Off'}</span></div>
    <p className="cloud-description">Exomina counts every model request it starts, per account, and pauses further ones past these limits. They protect your subscriptions if something goes wrong, and are separate from your plans’ own limits.</p>
    <label className="settings-toggle-row"><input type="checkbox" checked={limits.enabled} disabled={busy} onChange={event => setDraft({ ...limits, enabled: event.target.checked })} /><span>Pause requests that pass these limits</span></label>
    <div className="safety-limit-grid">
      {[...KINDS, TOKENS].map(kind => <div key={kind.id} className={`settings-row safety-limit-row ${kind === TOKENS ? 'advanced-only' : ''}`}>
        <div><strong>{kind.label}</strong><p>{kind.hint}</p></div>
        <div className="safety-limit-inputs">
          <label>Per hour<input type="number" min="1" max={kind.id === 'tokens' ? 1000000000 : 100000} aria-label={`${kind.label} per hour`} value={limits[kind.id].hour} disabled={!limits.enabled || busy} onChange={event => set(kind.id, 'hour', event.target.value)} /></label>
          <label>Per day<input type="number" min="1" max={kind.id === 'tokens' ? 1000000000 : 100000} aria-label={`${kind.label} per day`} value={limits[kind.id].day} disabled={!limits.enabled || busy} onChange={event => set(kind.id, 'day', event.target.value)} /></label>
        </div>
      </div>)}
    </div>
    {providers.length > 0 && <div className="safety-limit-used" aria-label="Requests counted so far">
      <strong>Counted so far</strong>
      {providers.map(id => <p key={id}>{NAMES[id]}: {KINDS.map(kind => { const used = view.used[id]?.[kind.id]; return used ? `${used.hour} ${kind.label.toLowerCase()} in the last hour (${used.day} in 24 hours)` : null; }).concat(view.tokens?.[id] ? [`${count(view.tokens[id].hour)} estimated tokens reserved in the last hour (${count(view.tokens[id].day)} in 24 hours)`] : []).filter(Boolean).join(' · ')}</p>)}
    </div>}
    <div className="modal-actions safety-limit-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => save(null)}><RotateCcw size={14} />Use recommended limits</button>
      <button type="button" className="primary-button" disabled={busy || JSON.stringify(limits) === JSON.stringify(view?.limits)} onClick={() => save(limits)}>{busy ? <LoaderCircle size={14} className="spin" /> : null}Save limits</button>
    </div>
    {message && <p className="provider-setup-message" role="status">{message}</p>}
    {(error || view?.error) && <p className="inline-error" role="alert">{error || view.error}</p>}
  </section>;
}
