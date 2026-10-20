import React, { useEffect, useState } from 'react';
import ChatMemoryProgress from './ChatMemoryProgress.jsx';
const BACKFILL_DEFAULT_CAP = 1500;
// Providers whose usage Exomina can read; the spare-allowance guard needs it.
const BACKFILL_PROVIDERS = [['codex', 'ChatGPT'], ['claude', 'Claude'], ['muse-code', 'Muse Code']];
const BACKFILL_REASONS = {
  off: 'Paused.',
  'daily-cap': 'Daily limit reached; it continues tomorrow.',
  'usage-unknown': 'Waiting until usage of the chosen provider can be checked.',
  'usage-limit': 'Waiting: the provider reports that ordinary usage is not allowed.',
  unavailable: 'Waiting: the chosen model is not available.',
  storage: 'Paused: the request counter is unavailable.',
  'safety-storage': 'Paused: Exomina’s safety counters are unavailable. Check Settings → Models & usage → Usage.'
};
const effortId = effort => typeof effort === 'string' ? effort : effort?.id || '';
export default function ChatMemorySettings({ settings, status, models = {}, connections = [], onChange, disabled }) {
  const enabled = settings.chatMemoryEnabled !== false;
  const summaries = settings.chatMemoryOnDemand === true && settings.chatMemorySummaries !== false;
  const backfill = enabled && settings.chatMemoryBackfill !== false;
  const unlimited = settings.chatMemoryBackfillDailyCap === null;
  const savedCap = Number.isInteger(settings.chatMemoryBackfillDailyCap) ? settings.chatMemoryBackfillDailyCap : BACKFILL_DEFAULT_CAP;
  const [cap, setCap] = useState(String(savedCap));
  const hourlyUnlimited = settings.chatMemoryBackfillHourlyCap === null;
  const savedHourlyCap = Number.isInteger(settings.chatMemoryBackfillHourlyCap) ? settings.chatMemoryBackfillHourlyCap : 300;
  const [hourlyCap, setHourlyCap] = useState(String(savedHourlyCap));
  useEffect(() => setHourlyCap(String(savedHourlyCap)), [savedHourlyCap]);
  const commitHourlyCap = () => { const value = Number(hourlyCap); if (hourlyCap.trim() && Number.isInteger(value) && value >= 1 && value <= 20000 && value !== savedHourlyCap) onChange({ chatMemoryBackfillHourlyCap: value }); else setHourlyCap(String(savedHourlyCap)); };
  const usageGuard = settings.chatMemoryBackfillUsageCeiling !== null;
  const savedCeiling = Number.isInteger(settings.chatMemoryBackfillUsageCeiling) ? settings.chatMemoryBackfillUsageCeiling : 50;
  const savedReserve = 100 - savedCeiling;
  const [reserve, setReserve] = useState(String(savedReserve));
  useEffect(() => setReserve(String(savedReserve)), [savedReserve]);
  const commitReserve = () => { const value = Number(reserve); if (reserve.trim() && usageGuard && Number.isInteger(value) && value >= 0 && value <= 99 && value !== savedReserve) onChange({ chatMemoryBackfillUsageCeiling: 100 - value }); else setReserve(String(savedReserve)); };
  useEffect(() => setCap(String(savedCap)), [savedCap]);
  const commitCap = () => { const value = Number(cap); if (Number.isInteger(value) && value >= 0 && value <= 20000 && value !== savedCap) onChange({ chatMemoryBackfillDailyCap: value }); else setCap(String(savedCap)); };
  const choice = settings.chatMemoryBackfillModel || null;
  const options = BACKFILL_PROVIDERS.filter(([id]) => connections.some(c => c.id === id && c.connected) || choice?.provider === id).flatMap(([provider, name]) => (models[provider] || []).filter(model => model.id && model.id !== 'auto').map(model => ({ provider, name, model })));
  const selected = choice ? options.find(option => option.provider === choice.provider && option.model.id === choice.model) : null;
  const efforts = (selected?.model.efforts || []).map(effortId).filter(Boolean);
  const pickModel = value => { if (!value) return onChange({ chatMemoryBackfillModel: null }); const [provider, ...rest] = value.split('|'); onChange({ chatMemoryBackfillModel: { provider, model: rest.join('|'), effort: '' } }); };
  const background = status?.background || {}, progress = status?.backfill;
  const label = !enabled ? 'Whole-chat memory is off.' : !summaries && !backfill ? 'Originals and existing summaries are saved. Automatic model requests are off.' : background.running ? `Summarising with ${background.model?.model || 'the selected model'}.` : summaries ? 'Compression waits until an active chat needs it.' : 'Catch-up waits for spare allowance.';
  const safety = progress?.safety;
  const reason = !backfill ? BACKFILL_REASONS.off : /^safety-(hour|day)$/.test(progress?.reason || '') ? `Waiting for the catch-up limit: ${safety?.used} of ${safety?.max} requests per ${safety?.window === 'day' ? '24 hours' : 'hour'}.${Number.isFinite(safety?.retryAt) ? ` Room returns after ${new Date(safety.retryAt).toLocaleString()}; catch-up checks automatically.` : ''} Change catch-up limits here.` : progress?.reason === 'usage-high' ? `Paused to keep ${100 - (progress.ceiling ?? savedCeiling)}% of your allowance available for chats (${progress.ceiling ?? savedCeiling}% used).` : BACKFILL_REASONS[progress?.reason];
  const backfillLabel = enabled && progress ? `Catch-up today: ${progress.requests}${progress.unlimited ? '' : ` of ${progress.cap}`} request reservations.${reason ? ' ' + reason : ''}` : '';
  return <div className="chat-memory-settings">
    <div className="settings-row"><div><strong>Remember the whole chat</strong><p>Keep the chat and tool results across providers. Existing summaries and original records remain available.</p></div><input type="checkbox" aria-label="Remember the whole chat" checked={enabled} disabled={disabled} onChange={event => onChange({ chatMemoryEnabled: event.target.checked })} /></div>
    <div className="settings-row"><div><strong>Bring back relevant earlier passages</strong><p>Add up to three short passages matching file names, IDs, versions or error text in the recent conversation. The extra input is bounded, and search makes no model requests. Large tool output stays searchable without being summarised.</p></div><input type="checkbox" aria-label="Bring back relevant earlier passages" checked={enabled && settings.chatMemoryRecall !== false} disabled={disabled || !enabled} onChange={event => onChange({ chatMemoryRecall: event.target.checked })} /></div>
    <div className="settings-row"><div><strong>Catch up older chats in the background</strong><p>Summarise older passages one request at a time on your subscription so long chats get a complete memory view. Switch off to pause; today's count is kept.</p></div><input type="checkbox" aria-label="Catch up older chats in the background" checked={backfill} disabled={disabled || !enabled} onChange={event => onChange({ chatMemoryBackfill: event.target.checked })} /></div>
    <div className="settings-row"><div><strong>Keep allowance for your chats</strong><p>Pause catch-up when any usage window has this much allowance left, or its usage can't be checked. {usageGuard ? `Your setting: pause at ${savedReserve}% left (${savedCeiling}% used).` : 'The reserve is off; catch-up can use your remaining allowance.'} Provider limits still apply.</p></div><span className="settings-inline">
      <label><input type="checkbox" aria-label="Use catch-up allowance reserve" checked={usageGuard} disabled={disabled || !enabled} onChange={event => onChange({ chatMemoryBackfillUsageCeiling: event.target.checked ? savedCeiling : null })} /> Enabled</label>
      <label><input type="number" aria-label="Allowance to keep for chats (% left)" min="0" max="99" step="1" value={reserve} disabled={disabled || !enabled || !usageGuard} onChange={event => setReserve(event.target.value)} onBlur={commitReserve} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /> % left</label>
    </span></div>
    <div className="settings-row"><div><strong>Catch-up model</strong><p>The recommended choice is GPT-6-Luna at high effort on ChatGPT, falling back to GPT-6.1-Sol. A chosen model is never replaced by another.</p></div><span className="settings-inline">
      <select aria-label="Catch-up model" value={choice ? `${choice.provider}|${choice.model}` : ''} disabled={disabled || !enabled} onChange={event => pickModel(event.target.value)}>
        <option value="">Recommended: GPT-6-Luna, high (ChatGPT)</option>
        {choice && !selected && <option value={`${choice.provider}|${choice.model}`} disabled>{choice.model} (not available)</option>}
        {options.map(option => <option key={`${option.provider}|${option.model.id}`} value={`${option.provider}|${option.model.id}`}>{option.name} · {option.model.label || option.model.id}</option>)}
      </select>
      {selected && efforts.length > 0 && <select aria-label="Catch-up effort" value={choice.effort || ''} disabled={disabled || !enabled} onChange={event => onChange({ chatMemoryBackfillModel: { ...choice, effort: event.target.value } })}>
        <option value="">Provider default</option>
        {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
      </select>}
    </span></div>
    <div className="settings-row"><div><strong>Hourly catch-up limit</strong><p>Maximum catch-up requests in a rolling hour, including retries. Independent of other background work. The allowance reserve still applies.</p></div><span className="settings-inline">
      <input type="number" aria-label="Hourly catch-up limit" min="1" max="20000" step="1" value={hourlyUnlimited ? '' : hourlyCap} placeholder={hourlyUnlimited ? 'No limit' : ''} disabled={disabled || !enabled || hourlyUnlimited} onChange={event => setHourlyCap(event.target.value)} onBlur={commitHourlyCap} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
      <label><input type="checkbox" aria-label="No hourly limit" checked={hourlyUnlimited} disabled={disabled || !enabled} onChange={event => onChange({ chatMemoryBackfillHourlyCap: event.target.checked ? null : savedHourlyCap })} /> No limit</label>
    </span></div>
    <div className="settings-row"><div><strong>Daily catch-up limit</strong><p>Maximum request reservations per local calendar day, including retries. A stopped attempt may count without reaching the provider. 0 stops catch-up for the day. Catch-up has its own limits; the shared background limits do not apply. The allowance reserve still applies when either limit is removed.</p></div><span className="settings-inline">
      <input type="number" aria-label="Daily catch-up limit" min="0" max="20000" step="1" value={unlimited ? '' : cap} placeholder={unlimited ? 'No limit' : ''} disabled={disabled || !enabled || unlimited} onChange={event => setCap(event.target.value)} onBlur={commitCap} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
      <label><input type="checkbox" aria-label="No daily limit" checked={unlimited} disabled={disabled || !enabled} onChange={event => onChange({ chatMemoryBackfillDailyCap: event.target.checked ? null : savedCap })} /> No limit</label>
    </span></div>
    <div className="settings-row"><div><strong>Compress when needed</strong><p>Off by default. If enabled, only compress an active chat that exceeds its memory budget, using that chat's provider. At most four model requests per reply, including retries, with one running at a time. This uses your allowance.</p></div><input type="checkbox" aria-label="Compress when needed" checked={summaries} disabled={disabled || !enabled} onChange={event => onChange({ chatMemoryOnDemand: event.target.checked, chatMemorySummaries: event.target.checked })} /></div>
    <p role="status" className="settings-help">{[label, backfillLabel, background.lastError ? `${background.lastError}${background.retryAt ? ' Automatic retries wait at least one minute; pause and resume after correcting the problem.' : ''}` : '', status?.lastError ? `Memory log unavailable: ${status.lastError}` : ''].filter(Boolean).join(' ')}</p>
    <ChatMemoryProgress />
  </div>;
}
