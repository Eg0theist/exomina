import React, { useState } from 'react';
import SkillLearning from './SkillLearning.jsx';

const lines = value => value.split('\n').map(line => line.trim()).filter(Boolean);
const empty = () => ({ parameters: [], preconditions: [], dataScope: [], tools: [], outputs: [], checks: [{ id: 'artifact', label: 'Output file exists', kind: 'file', subject: 'file result.txt' }], recovery: [] });
const labels = { preconditions: 'Before starting', dataScope: 'Data to use', tools: 'Tools to use', outputs: 'Expected outputs', recovery: 'If interrupted or a check fails' };

export function ProcedureEditor({ value, onChange }) {
  const change = (key, next) => onChange({ ...value, [key]: next });
  return <details className="skill-procedure-editor" open={!!value}><summary>Reusable procedure</summary>
    <label className="skill-procedure-toggle"><input type="checkbox" checked={!!value} onChange={event => onChange(event.target.checked ? empty() : null)} />Add inputs, checks and recovery steps</label>
    {value && <>
      <p>Describe the method and its boundaries. Preparing a checklist runs nothing. Use {'{{input_name}}'} to insert a named input.</p>
      <h4>Inputs</h4>{value.parameters.map((parameter, index) => <fieldset key={index}>
        <label>Input name<input required maxLength={40} value={parameter.name} onChange={event => change('parameters', value.parameters.map((item, position) => position === index ? { ...item, name: event.target.value } : item))} /></label>
        <label>What it means<input required maxLength={300} value={parameter.description} onChange={event => change('parameters', value.parameters.map((item, position) => position === index ? { ...item, description: event.target.value } : item))} /></label>
        <label className="skill-procedure-toggle"><input type="checkbox" checked={parameter.required} onChange={event => change('parameters', value.parameters.map((item, position) => position === index ? { ...item, required: event.target.checked } : item))} />Required</label>
        <button type="button" className="text-button" onClick={() => change('parameters', value.parameters.filter((_, position) => position !== index))}>Remove input</button>
      </fieldset>)}<button type="button" className="text-button" disabled={value.parameters.length >= 12} onClick={() => change('parameters', [...value.parameters, { name: '', description: '', required: true }])}>Add input</button>
      {Object.entries(labels).map(([key, label]) => <label key={key}>{label}<textarea rows={3} value={value[key].join('\n')} onChange={event => change(key, event.target.value.split('\n'))} onBlur={event => change(key, lines(event.target.value))} placeholder="One item per line" /></label>)}
      <h4>Acceptance checks</h4><p>Each check must match a recorded Exomina outcome exactly. A file check proves file properties; review its contents separately.</p>
      {value.checks.map((check, index) => {
        const edit = patch => change('checks', value.checks.map((item, position) => position === index ? { ...item, ...patch } : item));
        return <fieldset key={index}>
          <label>Check ID<input required maxLength={40} value={check.id} onChange={event => edit({ id: event.target.value })} /></label>
          <label>What to check<input required maxLength={300} value={check.label} onChange={event => edit({ label: event.target.value })} /></label>
          <label>Host observation<select value={check.kind} onChange={event => { const { minBytes, sha256, ...rest } = check; change('checks', value.checks.map((item, position) => position === index ? { ...rest, kind: event.target.value } : item)); }}><option value="file">File</option><option value="update_installed">Installed build</option><option value="update_staged">Staged update</option><option value="process_running">Running process</option><option value="github_pr_merged">Merged pull request</option><option value="github_checks">GitHub checks</option></select></label>
          <label>Exact outcome subject<input required maxLength={500} value={check.subject} onChange={event => edit({ subject: event.target.value })} placeholder="file {{artifact}}" /></label>
          {check.kind === 'file' && <label>Minimum file size in bytes (optional)<input type="number" min="0" value={check.minBytes ?? ''} onChange={event => { const next = { ...check }; if (event.target.value === '') delete next.minBytes; else next.minBytes = Number(event.target.value); change('checks', value.checks.map((item, position) => position === index ? next : item)); }} /></label>}
          <button type="button" className="text-button" disabled={value.checks.length === 1} onClick={() => change('checks', value.checks.filter((_, position) => position !== index))}>Remove check</button>
        </fieldset>;
      })}<button type="button" className="text-button" disabled={value.checks.length >= 12} onClick={() => change('checks', [...value.checks, { id: '', label: '', kind: 'file', subject: '' }])}>Add check</button>
    </>}
  </details>;
}

export function ProcedureView({ selected, call, act, busy, onChanged, onCreated }) {
  const [values, setValues] = useState({}), [plan, setPlan] = useState(null), [outcomes, setOutcomes] = useState({});
  const procedure = selected.procedure;
  if (!procedure) return null;
  async function prepare() { const result = await call({ action: 'prepare', id: selected.id, revision: selected.revision, hash: selected.hash, values }); setPlan(result); setOutcomes({}); }
  async function evaluate() { await call({ action: 'evaluate', id: selected.id, baseRevision: selected.revision, hash: selected.hash, planRef: plan.planRef, values: plan.bindings, outcomes }); await onChanged(); }
  return <section className="skill-procedure-view"><h4>Reusable procedure</h4><p className="skill-procedure-status">{selected.procedureStatus === 'conditions-checked' ? 'Acceptance conditions checked for recorded inputs' : selected.procedureStatus === 'needs-review' ? 'Inputs changed: review dependencies before reuse' : 'Draft: acceptance conditions not checked'}</p>
    {Object.entries(labels).map(([key, label]) => procedure[key].length > 0 && <div key={key}><b>{label}</b><ul>{procedure[key].map((item, index) => <li key={index}>{item}</li>)}</ul></div>)}
    <p>Preparing produces a checklist. It grants no tool or data access and does not start work.</p>
    {procedure.parameters.map(parameter => <label key={parameter.name}>{parameter.name}{parameter.required ? ' (required)' : ''}<small>{parameter.description}</small><input maxLength={1000} value={values[parameter.name] || ''} onChange={event => { setValues(current => ({ ...current, [parameter.name]: event.target.value })); setPlan(null); }} /></label>)}
    <button type="button" className="secondary-button" disabled={busy} onClick={() => act(prepare)}>Prepare checklist</button>
    {plan && <div className="skill-procedure-plan"><h4>Prepared checklist</h4>{Object.entries(labels).map(([key, label]) => plan[key].length > 0 && <div key={key}><b>{label}</b><ul>{plan[key].map((item, index) => <li key={index}>{item}</li>)}</ul></div>)}
      {plan.capabilities?.tools.length > 0 && <details><summary>Current tool compatibility</summary>{plan.capabilities.tools.map(tool => <p key={tool.name}>{tool.name}: {tool.status}</p>)}<p>{plan.capabilities.notice}</p></details>}
      {plan.checks.map(check => <label key={check.id}>{check.label}<small>{check.kind} · {check.subject}{check.minBytes !== undefined ? ` · at least ${check.minBytes} bytes` : ''}</small><input aria-label={`Outcome mark for ${check.id}`} placeholder="Exomina outcome mark ID" value={outcomes[check.id] || ''} onChange={event => setOutcomes(current => ({ ...current, [check.id]: event.target.value }))} /></label>)}
      {selected.editable && <button type="button" className="secondary-button" disabled={busy || selected.revision !== selected.versions.at(-1).revision} onClick={() => act(evaluate)}>Record acceptance evidence</button>}<p>{plan.notice}</p>
    </div>}
    {(selected.evaluations || []).map((evaluation, index) => <details key={index}><summary>Checked {new Date(evaluation.checkedAt).toLocaleString()} · {evaluation.checks.length} conditions</summary><p>{evaluation.notice}</p><pre>{JSON.stringify(evaluation.bindings, null, 2)}</pre>{evaluation.checks.map(check => <p key={check.checkId}>{check.checkId}: {check.subject} · {new Date(check.at).toLocaleString()}</p>)}</details>)}
    <SkillLearning selected={selected} call={call} act={act} busy={busy} onChanged={onChanged} onCreated={onCreated} useValues={next => { setValues(next); setPlan(null); setOutcomes({}); }} />
  </section>;
}
