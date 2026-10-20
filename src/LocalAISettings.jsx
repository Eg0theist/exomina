import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Check, Download, FolderOpen, LoaderCircle, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { api } from './transport.js';
import { normalizeAgentSettings, normalizeDecisionSettings } from '../desktop/decision-settings.mjs';
import './local-ai.css';

const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
const states = {'active':'Ready', 'not-installed':'Not installed', 'too-demanding':'Above this PC’s capacity', 'background-only':'Background only', 'paused':'Paused', 'low-memory':'Waiting for free memory'};
const newTrigger = () => ({name:'', folder:'', taskId:'', filter:'', condition:'', enabled:true});

export default function LocalAISettings({settings, saveSettings, Toggle, tasks, onOpen, onTasks}) {
  const [view, setView] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [form, setForm] = useState(null);
  const local = normalizeDecisionSettings(settings.decisionLayer), agent = normalizeAgentSettings(settings.agent);
  const load = useCallback(() => api.invoke('decision.status').then(setView).catch(error => setError(message(error))), []);
  useEffect(() => {
    load();
    return api.onEvent(event => {
      if (['decision.changed', 'agent.changed'].includes(event.type)) load();
      if (event.type === 'decision.download') setView(previous => previous && ({...previous, download:{...event, running:true}}));
    });
  }, [load]);
  async function action(work) {
    setBusy(true); setError('');
    try { await work(); await load(); } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  const setLocal = patch => action(() => saveSettings({decisionLayer:{...local,...patch}}));
  const setAgent = patch => action(() => saveSettings({agent:{...agent,...patch}}));
  const status = view?.status, download = view?.download;
  return <section className="settings-section local-ai-settings" id="settings-local-ai">
    <div className="section-title"><h2>Local AI &amp; background tasks</h2><button className="text-button" disabled={busy} onClick={() => action(load)}><RefreshCw size={14} />Refresh status</button></div>
    <p className="connection-small">Small decisions run on this PC, with no subscription requests. Uncertain answers are left to the task or to you.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="settings-row"><div><strong>Use local decisions</strong><p>Learn which follow-up suggestions are useful and check background events. Turning this off stops both learning and local decisions.</p></div><Toggle label="Use local decisions" checked={local.enabled} disabled={busy} onChange={enabled => setLocal({enabled})} /></div>
    {status && <><p className="connection-small">This PC can support Tier {status.tier.capable}; currently available: Tier {status.tier.active}. {status.hardware.ramGb} GB RAM · {status.hardware.threads} CPU threads.</p><div className="local-ai-tiers">{status.tiers.map(tier => <div key={tier.tier}><strong>Tier {tier.tier} · {tier.name}</strong><span>{states[tier.state] || tier.state}</span></div>)}</div></>}
    <div className="settings-row"><div><strong>Give demanding apps priority</strong><p>Local chat models wait while a full-screen app, game, GPU render or video export is detected. Windows checks stay on this device. Light workloads may need the manual pause.</p></div><Toggle label="Give demanding apps priority" checked={local.makeWay} disabled={busy || !local.enabled} onChange={makeWay => setLocal({makeWay})} /></div>
    <div className="settings-row"><div><strong>Pause local chat models</strong><p>{status?.paused || 'Temporarily free capacity for other work. The quick CPU checks can continue.'} Ollama can release its loaded model; LM Studio controls its own unload timeout.</p></div><button className="secondary-button" disabled={busy || !local.enabled} onClick={() => action(() => api.invoke(status?.manualPause ? 'decision.resume' : 'decision.pause'))}>{status?.manualPause ? <Play size={14} /> : <Pause size={14} />}{status?.manualPause ? 'Resume local AI' : 'Pause local AI now'}</button></div>
    <details className="local-ai-details"><summary>Tier 2 · Local statement checker</summary>
      <p className="connection-small">An optional CPU model for English and German decisions without task-specific training. Downloaded once from Hugging Face; inference stays offline. The multilingual model uses about 700 MB RAM while loaded and unloads after five idle minutes. Confidence is not yet calibrated on real Exomina tasks.</p>
      {status?.tier2Model && <p className="connection-small"><Check size={13} />Installed: {status.tier2Model.name}</p>}
      <div className="local-ai-downloads">{(view?.models || []).map(model => <button className="secondary-button" key={model.id} disabled={busy || download?.running || !local.enabled || status?.tier2Model?.id === model.id} onClick={() => action(() => api.invoke('decision.tier2.download',{id:model.id}))}><Download size={14} />{model.name} · {model.sizeMb} MB</button>)}</div>
      {download?.running && <div className="local-ai-progress" role="status"><progress max={download.total || 1} value={download.done || 0} /><span>{Math.round((download.done || 0)/1e6)} / {Math.round((download.total || 0)/1e6)} MB</span><button className="text-button" onClick={() => action(() => api.invoke('decision.tier2.cancel'))}>Cancel download</button></div>}
      {download?.error && <p className="inline-error" role="alert">{download.error}</p>}
      {status?.tier2Model && <button className="text-button danger-text-button" disabled={busy || download?.running} onClick={() => action(() => api.invoke('decision.tier2.remove'))}><Trash2 size={14} />Remove downloaded models</button>}
    </details>
    <details className="local-ai-details"><summary>What local AI has learned</summary><p className="connection-small">Each check needs at least 40 decisions with different outcomes before learning can help. The log contains short excerpts linked to their source chat; deleting a chat removes its decisions. Private chats are excluded.</p>
      {status?.gates?.length ? <ul>{status.gates.map(gate => <li key={gate.name}><strong>{gate.name}</strong> · {gate.examples} examples · {gate.trained ? 'Learning active' : 'Collecting examples'}</li>)}</ul> : <p className="connection-small">No recorded examples yet.</p>}
      <button className="text-button danger-text-button" disabled={busy} onClick={() => action(() => api.invoke('decision.clear'))}><Trash2 size={14} />Delete learned decisions</button>
    </details>
    <div className="section-title"><h2>Background agent</h2><span>{agent.enabled ? 'Enabled' : 'Off by default'}</span></div>
    <div className="settings-row"><div><strong>Run tasks when files change</strong><p>Watch folders in your project while Exomina is running, including in the tray. Each trigger uses a task’s saved instructions and selected AI. Runs use that AI’s allowance; results stay in Exomina for review. Enabling this does not start past events.</p></div><Toggle label="Run tasks when files change" checked={agent.enabled} disabled={busy} onChange={enabled => setAgent({enabled})} /></div>
    <div className="settings-row"><div><strong>Daily limit for folder-triggered runs</strong><p>{view?.agent?.runsToday || 0} started today. Failed and interrupted starts count. Existing scheduled tasks have their own schedules; this is a run limit, not a token budget.</p></div><input className="settings-input" type="number" min="1" max="100" aria-label="Daily limit for folder-triggered runs" value={agent.dailyBudget} disabled={busy} onChange={event => { const dailyBudget = Number(event.target.value); if (Number.isInteger(dailyBudget) && dailyBudget >= 1 && dailyBudget <= 100) setAgent({dailyBudget}); }} /></div>
    {(view?.agent?.triggers || []).map(trigger => <div className="local-ai-trigger" key={trigger.id}><div><strong>{trigger.name}</strong><small>{trigger.folder} · {trigger.enabled ? 'Enabled' : 'Paused'}</small></div><button className="text-button" onClick={() => setForm({...trigger})}>Edit</button><button className="icon-button" aria-label={'Remove trigger ' + trigger.name} disabled={busy} onClick={() => action(() => api.invoke('agent.removeTrigger',{id:trigger.id}))}><Trash2 size={14} /></button></div>)}
    <button className="secondary-button" disabled={busy} onClick={() => setForm(newTrigger())}>Add a folder trigger</button>
    {form && <form className="local-ai-form" onSubmit={event => { event.preventDefault(); action(async () => { await api.invoke('agent.saveTrigger', form); setForm(null); }); }}>
      <label>Trigger name<input className="settings-input" required maxLength="80" value={form.name} onChange={event => setForm({...form,name:event.target.value})} /></label>
      <div><span className="input-label">Folder in your project</span><p className="path-text">{form.folder || 'Choose a folder to watch'}</p><button type="button" className="secondary-button" disabled={busy} onClick={() => action(async () => { const folder = await api.invoke('agent.chooseFolder'); if (folder) setForm(previous => ({...previous,folder})); })}><FolderOpen size={14} />Choose folder</button></div>
      <label>Task to run<select aria-label="Task to run" required value={form.taskId} onChange={event => setForm({...form,taskId:event.target.value})}><option value="">Choose a saved task</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.name}</option>)}</select></label>
      {!tasks.length && <button type="button" className="text-button" onClick={onTasks}>Create a task in Projects<ArrowRight size={14} /></button>}
      <label>File names (optional)<input className="settings-input" placeholder="*.pdf, *.docx" maxLength="200" value={form.filter} onChange={event => setForm({...form,filter:event.target.value})} /></label>
      <label>When should it run? (optional)<input className="settings-input" placeholder="A new client report needs a summary." maxLength="300" value={form.condition} onChange={event => setForm({...form,condition:event.target.value})} /></label>
      <p className="connection-small">Changes settle for 30 seconds before a check. The CPU model sees file names, not file contents. If it is unsure, the saved task runs within your daily limit.</p>
      <label className="local-ai-checkbox"><input type="checkbox" checked={form.enabled} onChange={event => setForm({...form,enabled:event.target.checked})} />Enable this trigger</label>
      <div className="local-ai-downloads"><button className="primary-button" disabled={busy || !form.folder || !form.taskId}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Save trigger</button><button type="button" className="secondary-button" onClick={() => setForm(null)}>Cancel</button></div>
    </form>}
    <h3>Review inbox</h3><p className="connection-small">Results, skipped events and failures appear here. Your feedback teaches the local check when this trigger is useful.</p>
    {!(view?.agent?.inbox || []).length && <p className="connection-small">No folder events yet.</p>}
    {(view?.agent?.inbox || []).map(item => <article className="local-ai-inbox" key={item.id}><strong>{item.triggerName} · {item.status}</strong><small>{new Date(item.at).toLocaleString()}</small>{item.reason && <p>{item.reason}</p>}{item.files?.length > 0 && <details><summary>Changed files</summary><ul>{item.files.map(file => <li key={file}>{file}</li>)}</ul></details>}{item.conversationId && <button className="text-button" onClick={() => onOpen(item.conversationId)}>Open result<ArrowRight size={14} /></button>}{item.input && item.feedback === undefined && <div className="local-ai-downloads"><span>Should this have run?</span>{[[true,'Yes'],[false,'No']].map(([shouldRun,label]) => <button className="secondary-button" key={label} disabled={busy} onClick={() => action(() => api.invoke('agent.feedback',{id:item.id,shouldRun}))}>{label}</button>)}</div>}{item.feedback !== undefined && <small>Feedback saved: {item.feedback ? 'useful' : 'unnecessary'}</small>}</article>)}
  </section>;
}
