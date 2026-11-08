import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Plus, RefreshCw, X } from 'lucide-react';
import { api } from './transport.js';
import { ProcedureEditor, ProcedureView } from './SkillProcedure.jsx';
import VerificationJourneys from './VerificationJourneys.jsx';
import OutcomeArchive from './OutcomeArchive.jsx';
import './skill-library.css';

const defaultInvoke = (method, payload) => api.invoke(method, payload);
const blank = () => ({ name: '', description: '', instructions: '', tags: '', appliesWhen: '', caveat: '', scope: 'chat', references: [], refinementId: '', procedure: null });

/** Desktop owner UI. The host supplies userInitiated; it is never accepted from a tool argument. */
export default function SkillLibrary({ conversationId, invoke = defaultInvoke, onNotice = () => {}, refinements = [] }) {
  const [catalog, setCatalog] = useState([]), [selected, setSelected] = useState(null), [draft, setDraft] = useState(null);
  const [query, setQuery] = useState(''), [retired, setRetired] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [nextOffset, setNextOffset] = useState(null);
  const [reference, setReference] = useState(null);
  const [importText, setImportText] = useState(null), [importPreview, setImportPreview] = useState(null), [dependencyView, setDependencyView] = useState(null);
  const generation = useRef({ chat: conversationId, value: 0 });
  if (generation.current.chat !== conversationId) generation.current = { chat: conversationId, value: generation.current.value + 1 };
  const live = token => generation.current.chat === conversationId && generation.current.value === token;
  const call = useCallback(args => invoke('skills.call', { conversationId, args }), [invoke, conversationId]);
  const reload = useCallback(async () => {
    const token = generation.current.value;
    if (generation.current.chat !== conversationId) return;
    if (!conversationId) { setCatalog([]); return; }
    const result = await call({ action: 'catalog', query, includeRetired: retired, limit: 50 });
    if (generation.current.chat !== conversationId || generation.current.value !== token) return;
    setCatalog(result.skills || []); setNextOffset(result.nextOffset);
  }, [call, conversationId, query, retired]);
  useEffect(() => { setSelected(null); setDraft(null); setReference(null); setCatalog([]); setNextOffset(null); setError(''); setBusy(false); }, [conversationId]);
  useEffect(() => { let alive = true; const token = generation.current.value; if (conversationId) call({ action: 'catalog', query, includeRetired: retired, limit: 50 }).then(result => { if (alive && live(token)) { setCatalog(result.skills || []); setNextOffset(result.nextOffset); } }).catch(failure => { if (alive && live(token)) setError(failure.message); }); else { setCatalog([]); setNextOffset(null); } return () => { alive = false; }; }, [call, conversationId, query, retired]);
  async function act(work) { const token = generation.current.value; setBusy(true); setError(''); try { await work(); } catch (failure) { if (live(token)) setError(failure.message); } finally { if (live(token)) setBusy(false); } }
  async function open(id, revision) { const token = generation.current.value; if (!live(token)) return; const value = await call({ action: 'read', id, ...(revision ? { revision } : {}), limit: 24000 }); if (!live(token)) return; setSelected(value); setReference(null); setDraft(null); }
  async function edit(copy = false) {
    const token = generation.current.value;
    const refs = await Promise.all(selected.references.map(async ref => ({ name: ref.name, text: (await call({ action: 'read', id: selected.id, revision: selected.revision, hash: selected.hash, reference: ref.name, limit: 24000 })).text })));
    if (!live(token)) return;
    setDraft({ ...blank(), ...selected, tags: selected.tags.join(', '), instructions: selected.text, references: refs, refinementId: '', ...(copy ? { id: undefined, scope: 'chat' } : {}) });
    setReference(null);
  }
  async function save(event) {
    event.preventDefault();
    const token = generation.current.value;
    await act(async () => {
      const args = { action: draft.id ? 'revise' : 'create', ...(draft.id ? { id: draft.id, baseRevision: draft.revision } : { scope: draft.scope }), name: draft.name, description: draft.description, instructions: draft.instructions, tags: draft.tags.split(',').map(tag => tag.trim()).filter(Boolean), appliesWhen: draft.appliesWhen, caveat: draft.caveat, references: draft.references, procedure: draft.procedure, ...(draft.refinementId ? { refinementId: draft.refinementId } : {}) };
      if (draft.dependencies) args.dependencies = draft.dependencies;
      const result = await call(args); if (!live(token)) return; await reload(); if (!live(token)) return; await open(result.skill.id); if (live(token)) onNotice('Skill revision saved.');
    });
  }
  const change = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  useEffect(() => { setImportText(null); setImportPreview(null); setDependencyView(null); }, [conversationId, selected?.id, selected?.revision]);
  const latest = selected?.versions?.at(-1)?.revision;
  const adopted = refinements.filter(record => record.status === 'adopted');
  async function openReference(name) { const token = generation.current.value; const value = await call({ action: 'read', id: selected.id, revision: selected.revision, hash: selected.hash, reference: name, limit: 24000 }); if (live(token)) setReference(value); }
  async function loadMore() { const token = generation.current.value; const more = await call({ action: 'catalog', query, includeRetired: retired, offset: nextOffset, limit: 50 }); if (live(token)) { setCatalog(current => [...current, ...more.skills]); setNextOffset(more.nextOffset); } }
  async function retire() { const token = generation.current.value; await call({ action: 'retire', id: selected.id, baseRevision: latest }); if (!live(token)) return; await reload(); if (!live(token)) return; await open(selected.id); if (live(token)) onNotice('Skill retired.'); }
  return <section className="settings-section skill-library" id="settings-skills">
    <div className="section-title"><h2><BookOpen size={18} />Skill library</h2><button className="text-button" disabled={busy || !conversationId} onClick={() => act(reload)}><RefreshCw size={14} />Refresh</button></div>
    <p>Keep useful methods in one library for every AI you use. Instructions and reference notes load when needed. New skills belong to this chat unless you explicitly share them.</p>
    {!conversationId ? <p>Open a saved chat to browse its skills or create one.</p> : <>
      <button className="text-button" disabled={busy} onClick={() => { setImportText(''); setImportPreview(null); }}>Inspect imported instructions</button>
      {importText !== null && <div className="skill-library-form"><label>Paste SKILL.md<textarea aria-label="Import SKILL.md" rows={7} maxLength={24000} value={importText} onChange={event => { setImportText(event.target.value); setImportPreview(null); }} /></label><div className="skill-library-actions"><button className="secondary-button" disabled={busy || !importText.trim()} onClick={() => act(async () => { const token = generation.current.value; const result = await call({ action: 'inspect', files: [{ name: 'SKILL.md', text: importText }] }); if (live(token)) setImportPreview(result); })}>Preview compatibility</button><button className="text-button" onClick={() => { setImportText(null); setImportPreview(null); }}>Close import</button></div>{importPreview && <><p>{importPreview.notice}</p><p>{importPreview.license.notice}</p>{importPreview.flags.map((flag, index) => <p key={index}>{flag}</p>)}{importPreview.requestedTools.map(tool => <p key={tool.name}>{tool.name}: {tool.available ? 'available, permission still required' : 'unavailable'}</p>)}{importPreview.destinationsMentioned.length > 0 && <details><summary>Mentioned destinations</summary><pre>{importPreview.destinationsMentioned.join('\n')}</pre></details>}<button className="secondary-button" disabled={busy} onClick={() => { setDraft({ ...blank(), ...importPreview.candidate }); setImportText(null); setImportPreview(null); }}>Review as new skill</button></>}</div>}
      <div className="skill-library-toolbar"><input aria-label="Search skills" type="search" placeholder="Search names, tags and descriptions" value={query} onChange={event => setQuery(event.target.value)} /><label><input type="checkbox" checked={retired} onChange={event => setRetired(event.target.checked)} />Show retired</label><button className="secondary-button" disabled={busy} onClick={() => { setDraft(blank()); setReference(null); }}><Plus size={14} />New skill</button></div>
      <div className="skill-library-layout"><div className="skill-library-list" aria-label="Skills in this chat">
        {!catalog.length && <p>No skills match this view.</p>}
        {catalog.map(skill => <button key={skill.id} className={selected?.id === skill.id ? 'selected' : ''} disabled={busy} onClick={() => act(() => open(skill.id))}><strong>{skill.name}</strong><span>{skill.description}</span><small>{skill.scope === 'all' ? 'All saved chats' : skill.scope === 'project' ? 'This project' : 'This chat'} · version {skill.revision}{skill.status === 'retired' ? ' · retired' : ''}</small></button>)}
        {nextOffset !== null && <button className="text-button" disabled={busy} onClick={() => act(loadMore)}>Load more skills</button>}
      </div><div className="skill-library-detail">
        {draft ? <form onSubmit={save} className="skill-library-form"><div className="section-title"><h3>{draft.id ? 'New revision' : 'New skill'}</h3><button type="button" className="icon-button" aria-label="Close skill editor" onClick={() => setDraft(null)}><X size={16} /></button></div>
          <label>Name<input required maxLength={80} value={draft.name} onChange={event => change('name', event.target.value)} /></label>
          <label>Description<input required maxLength={400} value={draft.description} onChange={event => change('description', event.target.value)} /></label>
          {!draft.id && <label>Share with<select value={draft.scope} onChange={event => change('scope', event.target.value)}><option value="chat">This chat</option><option value="project">This project</option><option value="all">All saved chats</option></select></label>}
          {draft.scope !== 'chat' && <p className="skill-library-note">Sharing asks you to review the complete contents before saving. Shared memory must be enabled.</p>}
          <label>Use when<input maxLength={500} value={draft.appliesWhen} onChange={event => change('appliesWhen', event.target.value)} /></label>
          <label>Instructions<textarea aria-label="Instructions" required rows={10} maxLength={24000} value={draft.instructions} onChange={event => change('instructions', event.target.value)} /></label>
          <label>Limitations<input maxLength={500} value={draft.caveat} onChange={event => change('caveat', event.target.value)} /></label>
          <label>Tags, separated by commas<input value={draft.tags} onChange={event => change('tags', event.target.value)} /></label>
          <ProcedureEditor value={draft.procedure} onChange={value => change('procedure', value)} />
          <details><summary>Pinned skill inputs ({draft.dependencies?.length || 0})</summary><p>Pin another skill revision as a source. If it changes or access is removed, the procedure needs review.</p>{(draft.dependencies || []).map(dep => <p key={dep.id}>{catalog.find(item => item.id === dep.id)?.name || 'Pinned source'} · version {dep.revision} <button type="button" className="text-button" onClick={() => change('dependencies', draft.dependencies.filter(item => item.id !== dep.id))}>Remove</button></p>)}<select aria-label="Add pinned skill input" value="" onChange={event => { const item = catalog.find(item => item.id === event.target.value); if (item) change('dependencies', [...(draft.dependencies || []), { id: item.id, revision: item.revision, hash: item.hash }]); }}><option value="">Choose a source skill</option>{catalog.filter(item => item.id !== draft.id && !(draft.dependencies || []).some(dep => dep.id === item.id)).map(item => <option key={item.id} value={item.id}>{item.name} · version {item.revision}</option>)}</select></details>
          <details className="skill-library-references" open={draft.references.length > 0}><summary>Reference notes ({draft.references.length})</summary><p>Give each note a simple name, such as details.md. The AI can read it separately when needed.</p>{draft.references.map((ref, index) => <fieldset key={index}><label>Reference name<input required maxLength={80} value={ref.name} onChange={event => change('references', draft.references.map((item, position) => position === index ? { ...item, name: event.target.value } : item))} /></label><label>Reference text<textarea rows={5} maxLength={24000} value={ref.text} onChange={event => change('references', draft.references.map((item, position) => position === index ? { ...item, text: event.target.value } : item))} /></label><button type="button" className="text-button" onClick={() => change('references', draft.references.filter((_, position) => position !== index))}>Remove reference</button></fieldset>)}<button type="button" className="text-button" disabled={draft.references.length >= 12} onClick={() => change('references', [...draft.references, { name: '', text: '' }])}><Plus size={14} />Add reference</button></details>
          {adopted.length > 0 && <label>Link a tested working approach<select value={draft.refinementId} onChange={event => change('refinementId', event.target.value)}><option value="">No comparison linked</option>{adopted.map(record => <option key={record.id} value={record.id}>{record.goal}</option>)}</select></label>}
          <p className="skill-library-note">A new revision keeps the previous version. Earlier comparison evidence is cleared unless you link an adopted approach again.</p>
          <div className="skill-library-actions"><button className="primary-button" disabled={busy}>Save {draft.id ? 'revision' : 'skill'}</button><button type="button" className="text-button" disabled={busy} onClick={() => setDraft(null)}>Cancel</button></div>
        </form> : selected ? <>
          <div className="section-title"><h3>{selected.name}</h3><span className="tag">{selected.status}</span></div><p>{selected.description}</p>
          <label className="skill-library-version">Version<select aria-label="Skill revision" disabled={busy} value={selected.revision} onChange={event => act(() => open(selected.id, Number(event.target.value)))}>{selected.versions.map(version => <option key={version.revision} value={version.revision}>Version {version.revision} · {new Date(version.createdAt).toLocaleDateString()}</option>)}</select></label>
          {selected.appliesWhen && <p><b>Use when:</b> {selected.appliesWhen}</p>}{selected.caveat && <p><b>Limitations:</b> {selected.caveat}</p>}
          <pre className="skill-library-instructions">{selected.text}</pre>
          <button className="text-button" disabled={busy} onClick={() => act(async () => { const token = generation.current.value; const result = await call({ action: 'dependencies', id: selected.id, revision: selected.revision, hash: selected.hash }); if (live(token)) setDependencyView(result); })}>Inspect source dependencies</button>
          {dependencyView?.id === selected.id && dependencyView.revision === selected.revision && <div><p>{dependencyView.status === 'current' ? 'Pinned inputs are current' : 'Inputs need review'}</p>{dependencyView.dependencies.map((row, index) => <p key={index}>{row.dependency.name || 'Source'}: {row.status}</p>)}<p>{dependencyView.notice}</p></div>}
          <ProcedureView key={`${conversationId}:${selected.id}:${selected.revision}`} selected={selected} call={call} act={act} busy={busy} onChanged={async () => { await reload(); await open(selected.id, selected.revision); }} onCreated={async id => { await reload(); await open(id); }} />
          {selected.references.length > 0 && <div className="skill-library-references"><h4>Reference notes</h4>{selected.references.map(ref => <button key={ref.name} className="text-button" disabled={busy} onClick={() => act(() => openReference(ref.name))}>{ref.name} <small>{ref.characters.toLocaleString()} characters</small></button>)}{reference && <details open><summary>{reference.reference}</summary><pre>{reference.text}</pre></details>}</div>}
          {selected.evidence && <details><summary>Linked working approach</summary><p>{selected.evidence.notice}</p>{[...selected.evidence.baseline, ...selected.evidence.candidate].map(item => <p key={item.id}><code>{item.tool}</code> · {item.status} · {new Date(item.completedAt).toLocaleString()}</p>)}</details>}
          <div className="skill-library-actions">{selected.status === 'active' && selected.revision === latest && selected.editable && <button className="secondary-button" disabled={busy} onClick={() => act(() => edit())}>Create revision</button>}<button className="text-button" disabled={busy} onClick={() => act(() => edit(true))}>Copy as new skill</button>{selected.status === 'active' && selected.editable && <button className="text-button" disabled={busy} onClick={() => act(retire)}>Retire</button>}</div>
        </> : <p>Select a skill to read its instructions and version history.</p>}
      </div></div>
    </>}
    <p className="skill-library-note">Skills guide how work is done. Tool permissions still apply. Recorded comparisons support a particular approach and do not guarantee every instruction.</p>
    {conversationId && <VerificationJourneys conversationId={conversationId} invoke={invoke} />}
    {conversationId && <OutcomeArchive key={conversationId} conversationId={conversationId} invoke={invoke} onChanged={async () => { await reload(); if (selected) await open(selected.id, selected.revision); }} />}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
