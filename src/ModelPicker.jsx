import React, { useState } from 'react';
import { Check, Settings2, Zap } from 'lucide-react';
import { modelVisible } from '../desktop/model-preferences.mjs';
import { effortTiers, effortTierLabel } from './InterfaceView.jsx';
import ModelChoiceGuide from './ModelChoiceGuide.jsx';

const ROUTES = [
  { id: 'auto', label: 'Auto', note: 'Keeps your selected AI. Ordinary conversation runs without coding tools; files, code and browsing switch on when needed, even mid-chat.' },
  { id: 'chat', label: 'Chat', note: 'Always light: memory and chat history only. The AI can still ask for tools when a request truly needs them.' },
  { id: 'tools', label: 'Tools', note: 'Always start with the full tool suite. Slower to start, best for longer work.' },
];
export const effortText = (efforts = [], id) => efforts.find(item => item.id === id)?.label || (id ? id.charAt(0).toUpperCase() + id.slice(1) : '');
export function modelText(models = [], id) {
  if (!id || id === 'auto' || id === 'default') return 'Default model';
  return models.find(item => item.id === id)?.label || id;
}
// "auto" and Claude's own "default" both mean the provider's default model, whose
// effort and speed options the runtime reports on the entry marked isDefault.
export function resolveModel(models = [], id) {
  const value = !id || id === 'default' ? 'auto' : id;
  return models.find(item => item.id === value) || (value === 'auto' ? models.find(item => item.isDefault) || models.find(item => item.id === 'default') : undefined);
}

export default function ModelPicker({ native, models = [], model, effort, onModel, onEffort, onClose, catalog = [], connections = [], provider, onProvider, onManage, preferences, onOptions, speed = '', onSpeed, paidSpeedConfirmed = false, onConfirmPaidSpeed, routing = 'auto', onRouting, standard = false, onAdvanced }) {
  const [confirming, setConfirming] = useState(null);
  const current = !model || model === 'default' ? 'auto' : model;
  const selected = resolveModel(models, current);
  const efforts = selected?.efforts || [];
  const speeds = onSpeed ? selected?.speeds || [] : [];
  const speedOption = speeds.find(item => item.id === speed);
  // A paid-speed confirmation already in progress stays visible in either view.
  if (standard && !confirming) {
    const tiers = effortTiers(efforts), tier = effort ? effortTierLabel(efforts, effort) : '';
    const named = models.filter(item => !['auto', 'default'].includes(item.id) && modelVisible(preferences, provider, item.id));
    const ready = id => connections.some(connection => connection.id === id && (connection.connected || connection.configured) && connection.available !== false);
    return <div className="model-popover model-choice-panel standard-choice" role="dialog" aria-label="Choose AI">
      <div className="model-provider-row"><label>Which AI<select aria-label="AI connection" value={provider} onChange={event => onProvider(event.target.value)}>{catalog.map(item => <option key={item.id} value={item.id}>{item.name}{ready(item.id) ? '' : ' (not connected yet)'}</option>)}</select></label><button type="button" className="icon-button" aria-label="Manage AI connections" title="Connect or manage AIs" onClick={onManage}><Settings2 size={15}/></button></div>
      <ModelChoiceGuide models={models} provider={provider} preferences={preferences} onModel={onModel} onEffort={onEffort}/>
      {named.length > 0 && <label className="standard-model-select">Version<select aria-label="Model" value={named.some(item => item.id === current) ? current : 'auto'} onChange={event => onModel(event.target.value)}><option value="auto">Recommended{/\(currently ([^)]+)\)/.exec(resolveModel(models, 'auto')?.description || '')?.[1] ? ` (${/\(currently ([^)]+)\)/.exec(resolveModel(models, 'auto').description)[1]})` : ''}</option>{named.map(item => <option key={item.id} value={item.id}>{item.label || item.id}{item.description ? ` – ${item.description}` : ''}</option>)}</select></label>}
      {tiers.length > 1 && <div className="standard-tiers" role="radiogroup" aria-label="How carefully should it work?">
        <button type="button" role="radio" aria-checked={!effort} className={!effort ? 'selected' : ''} onClick={() => onEffort('')}><strong>Use the default</strong><small>This model’s default reasoning effort</small></button>
        {tiers.map(item => <button type="button" role="radio" key={item.id} aria-checked={tier === item.label} className={tier === item.label ? 'selected' : ''} onClick={() => onEffort(item.effort)}><strong>{item.label}</strong><small>{item.note}</small></button>)}
      </div>}
      {!models.length && <p className="standard-model-summary">Loading the options for this AI…</p>}
      {speedOption && <p className="standard-model-summary"><strong>{speedOption.label}{speedOption.paid ? ' · costs extra' : ''}</strong> {speedOption.description || ''}</p>}
      <button type="button" className="menu-footer" onClick={onAdvanced}>More options in Advanced view</button>
    </div>;
  }
  // Paid speeds ask once, before the first message that would spend extra usage.
  const chooseSpeed = item => { if (item?.paid && !paidSpeedConfirmed) { setConfirming(item); return; } setConfirming(null); onSpeed(item?.id || ''); };
  const all = [...models];
  for (const id of native ? [] : preferences?.models?.[provider] || []) if (id !== 'auto' && !all.some(item => item.id === id)) all.push({ id, label: id });
  const choices = all.filter(item => !['auto', 'default'].includes(item.id) && modelVisible(preferences, provider, item.id));
  const list = native || all.length > 0 || Array.isArray(preferences?.models?.[provider]);
  return <div className="model-popover model-choice-panel" role="dialog" aria-label="AI, model, reasoning effort and speed">
    {onProvider && <div className="model-provider-row"><label>AI connection<select aria-label="AI connection" value={provider} onChange={event => onProvider(event.target.value)}>{catalog.map(item => { const ready = connections.some(connection => connection.id === item.id && (connection.connected || connection.configured) && connection.available !== false); return <option key={item.id} value={item.id}>{item.name}{ready ? '' : ' · connect first'}</option>; })}</select></label><button type="button" className="icon-button" aria-label="Manage AI connections" title="Manage AI connections" onClick={onManage}><Settings2 size={15} /></button></div>}
    <ModelChoiceGuide models={models} provider={provider} preferences={preferences} onModel={onModel} onEffort={onEffort}/>
    <div className="popover-label">MODEL</div>
    {list ? <div className="model-list" role="listbox" aria-label="Model">
      {modelVisible(preferences, provider, 'auto') && <button type="button" role="option" aria-selected={current === 'auto'} className="model-option" onClick={() => onModel('auto')}><span><strong>Provider default</strong><small>The provider picks the model and effort.</small></span>{current === 'auto' && <Check size={14} />}</button>}
      {choices.map(item => <button type="button" role="option" key={item.id} aria-selected={current === item.id} className="model-option" onClick={() => onModel(item.id)}><span><strong>{item.label || item.id}</strong>{item.description && <small>{item.description}</small>}{item.efforts?.length ? <small>{item.efforts.length} effort levels</small> : null}</span>{current === item.id && <Check size={14} />}</button>)}
      {(current !== 'auto' && !choices.some(item => item.id === current) || current === 'auto' && !modelVisible(preferences, provider, 'auto')) && <div role="option" aria-selected className="model-option"><span><strong>{selected?.label || (current === 'auto' ? 'Provider default' : current)}</strong><small>Current choice, hidden from new selections</small></span><Check size={14} /></div>}
    </div> : <div className="model-id-field"><input aria-label="Model ID" key={current} defaultValue={current} placeholder="auto" onKeyDown={event => { if (event.key === 'Enter') { onModel(event.currentTarget.value.trim() || 'auto'); onClose(); } }} onBlur={event => onModel(event.currentTarget.value.trim() || 'auto')} /><small>Use auto for this connection’s default, or enter a supported model ID.</small></div>}
    {efforts.length > 0 && <><div className="popover-label">REASONING EFFORT</div><div className="effort-segments" role="radiogroup" aria-label="Reasoning effort">
      <button type="button" role="radio" aria-checked={!efforts.some(item => item.id === effort)} onClick={() => onEffort('')} title={selected.defaultEffort ? `Provider default (${selected.defaultEffort})` : 'Provider default'}>Auto</button>
      {efforts.map(item => <button type="button" role="radio" key={item.id} aria-checked={effort === item.id} onClick={() => onEffort(item.id)}>{item.label || item.id}</button>)}
    </div></>}
    {speeds.length > 0 && <><div className="popover-label">SPEED</div><div className="effort-segments speed-segments" role="radiogroup" aria-label="Speed">
      <button type="button" role="radio" aria-checked={!speedOption} onClick={() => chooseSpeed(null)} title="Normal speed and usage">Standard</button>
      {speeds.map(item => <button type="button" role="radio" key={item.id} aria-checked={speed === item.id} onClick={() => chooseSpeed(item)} title={item.description || item.label}><Zap size={11} />{item.label}{item.paid ? <span className="speed-paid">paid</span> : null}</button>)}
    </div>
    {confirming ? <div className="speed-confirm" role="alertdialog" aria-label="Confirm paid speed"><p><strong>{confirming.label} costs extra.</strong> {confirming.description} Exomina only uses it for messages you send while it is selected; fallbacks, helpers and scheduled tasks stay at standard speed.</p><div><button type="button" className="secondary-button" onClick={() => setConfirming(null)}>Cancel</button><button type="button" className="primary-button" onClick={() => { onConfirmPaidSpeed?.(); const item = confirming; setConfirming(null); onSpeed(item.id); }}>Use {confirming.label}</button></div></div>
      : <p className="speed-note">{speedOption ? speedOption.description || `${speedOption.label} speed.` : 'Normal speed and usage.'}</p>}</>}
    {onRouting && <><div className="popover-label">ANSWER WITH</div><div className="effort-segments" role="radiogroup" aria-label="Chat or tools">
      {ROUTES.map(item => <button type="button" role="radio" key={item.id} aria-checked={routing === item.id} onClick={() => onRouting(item.id)} title={item.note}>{item.label}</button>)}
    </div><p className="speed-note">{ROUTES.find(item => item.id === routing)?.note}</p></>}
    {native && <p className="popover-footnote">Options are reported by the provider runtime and depend on your plan.</p>}
    {onOptions && <button type="button" className="menu-footer" onClick={onOptions}>Visible models &amp; fallback settings…</button>}
  </div>;
}
