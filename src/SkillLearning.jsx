import React, { useState } from 'react';

export default function SkillLearning({ selected, call, act, busy, onChanged, onCreated, useValues }) {
  const [open, setOpen] = useState(false), [source, setSource] = useState(''), [cases, setCases] = useState([{ id: 'case_one', values: {} }, { id: 'case_two', values: {} }]), [review, setReview] = useState('');
  const learning = selected.learning, current = selected.revision === selected.versions.at(-1).revision;
  const eligible = selected.editable && selected.status === 'active' && current;
  async function learn() {
    const result = await call({ action: 'learn', id: selected.id, baseRevision: selected.revision, hash: selected.hash, sourceEvaluationHash: source, holdouts: cases });
    await onCreated(result.skill.id);
  }
  async function promote() { await call({ action: 'promote', id: selected.id, baseRevision: selected.revision, hash: selected.hash, review }); await onChanged(); }
  return <div className="skill-learning">
    {learning && <><h4>Procedure learning: {selected.learningStatus === 'needs-review' ? 'evidence or inputs changed, review required' : learning.status === 'promoted' ? 'reviewed for recorded cases' : 'candidate'}</h4><p>{learning.notice}</p><p>Inputs were committed {new Date(learning.committedAt).toLocaleString()}. The candidate stays in its originating chat.</p>
      {learning.cases.map(item => <details key={item.id}><summary>Withheld case: {item.id}</summary><pre>{JSON.stringify(item.values, null, 2)}</pre>{eligible && learning.revision === selected.revision && <button type="button" className="text-button" disabled={busy} onClick={() => useValues(item.values)}>Use these inputs</button>}</details>)}
      {learning.status === 'promoted' ? <p><b>Review:</b> {learning.review}</p> : eligible && learning.revision === selected.revision && <><label>Review meaning and remaining limitations<textarea aria-label="Learning review" rows={3} minLength={40} maxLength={1500} value={review} onChange={event => setReview(event.target.value)} /></label><button type="button" className="secondary-button" disabled={busy || review.trim().length < 40} onClick={() => act(promote)}>Review and promote candidate</button><p>Every committed case needs fresh, distinct host observations. Promotion asks you to review the inputs and limits.</p></>}
    </>}
    {eligible && selected.procedure.parameters.length > 0 && selected.evaluations.length > 0 && !learning && <><button type="button" className="text-button" disabled={busy} onClick={() => setOpen(value => !value)}>Learn a procedure from an accepted run</button>
      {open && <div className="skill-library-form"><p>Select a checked run and commit two different cases before testing. Bound values are replaced with named inputs in the copied method. Review any facts that were never declared as inputs.</p><label>Accepted source run<select aria-label="Learning source run" value={source} onChange={event => setSource(event.target.value)}><option value="">Choose checked inputs</option>{selected.evaluations.map(item => <option key={item.evaluationHash} value={item.evaluationHash}>{new Date(item.checkedAt).toLocaleString()} · {JSON.stringify(item.bindings)}</option>)}</select></label>
        {cases.map((item, index) => <fieldset key={item.id}><legend>Withheld case {index + 1}</legend>{selected.procedure.parameters.map(parameter => <label key={parameter.name}>{parameter.name}{parameter.required ? ' (required)' : ''}<input aria-label={`Withheld ${index + 1} ${parameter.name}`} maxLength={1000} value={item.values[parameter.name] || ''} onChange={event => setCases(previous => previous.map((entry, at) => at === index ? { ...entry, values: { ...entry.values, [parameter.name]: event.target.value } } : entry))} /></label>)}</fieldset>)}
        <button type="button" className="secondary-button" disabled={busy || !source} onClick={() => act(learn)}>Review generalized candidate</button>
      </div>}
    </>}
  </div>;
}
