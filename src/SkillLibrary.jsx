import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Plus, RefreshCw, X } from 'lucide-react';
import { api } from './transport.js';
import './skill-library.css';

const defaultInvoke = (method, payload) => api.invoke(method, payload);
const blank = () => ({ name: '', description: '', instructions: '', tags: '', appliesWhen: '', caveat: '', scope: 'chat', references: [], refinementId: '' });

/** Desktop owner UI. The host supplies userInitiated; it is never accepted from a tool argument. */
export default function SkillLibrary({ conversationId, invoke = defaultInvoke, onNotice = () => {}, refinements = [] }) {
  const [catalog, setCatalog] = useState([]), [selected, setSelected] = useState(null), [draft, setDraft] = useState(null);
  const [query, setQuery] = useState(''), [retired, setRetired] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [nextOffset, setNextOffset] = useState(null);
  const [reference, setReference] = useState(null);
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
      const args = { action: draft.id ? 'revise' : 'create', ...(draft.id ? { id: draft.id, baseRevision: draft.revision } : { scope: draft.scope }), name: draft.name, description: draft.description, instructions: draft.instructions, tags: draft.tags.split(',').map(tag => tag.trim()).filter(Boolean), appliesWhen: draft.appliesWhen, caveat: draft.caveat, references: draft.references, ...(draft.refinementId ? { refinementId: draft.refinementId } : {}) };
      const result = await call(args); if (!live(token)) return; await reload(); if (!live(token)) return; await open(result.skill.id); if (live(token)) onNotice('Skill revision saved.');
    });
  }
  const change = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const latest = selected?.versions?.at(-1)?.revision;
  const adopted = refinements.filter(record => record.status === 'adopted');
  async function openReference(name) { const token = generation.current.value; const value = await call({ action: 'read', id: selected.id, revision: selected.revision, hash: selected.hash, reference: name, limit: 24000 }); if (live(token)) setReference(value); }
  async function loadMore() { const token = generation.current.value; const more = await call({ action: 'catalog', query, includeRetired: retired, offset: nextOffset, limit: 50 }); if (live(token)) { setCatalog(current => [...current, ...more.skills]); setNextOffset(more.nextOffset); } }
  async function retire() { const token = generation.current.value; await call({ action: 'retire', id: selected.id, baseRevision: latest }); if (!live(token)) return; await reload(); if (!live(token)) return; await open(selected.id); if (live(token)) onNotice('Skill retired.'); }
  return <section className="settings-section skill-library" id="settings-skills">
    <div className="section-title"><h2><BookOpen size={18} />Skill library</h2><button className="text-button" disabled={busy || !conversationId} onClick={() => act(reload)}><RefreshCw size={14} />Refresh</button></div>
    <p>Keep useful methods in one library for every AI you use. Instructions and reference notes load when needed. New skills belong to this chat unless you explicitly share them.</p>
    {!conversationId ? <p>Open a saved chat to browse its skills or create one.</p> : <>
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
          <label>Instructions<textarea required rows={10} maxLength={24000} value={draft.instructions} onChange={event => change('instructions', event.target.value)} /></label>
          <label>Limitations<input maxLength={500} value={draft.caveat} onChange={event => change('caveat', event.target.value)} /></label>
          <label>Tags, separated by commas<input value={draft.tags} onChange={event => change('tags', event.target.value)} /></label>
          <details className="skill-library-references" open={draft.references.length > 0}><summary>Reference notes ({draft.references.length})</summary><p>Give each note a simple name, such as details.md. The AI can read it separately when needed.</p>{draft.references.map((ref, index) => <fieldset key={index}><label>Reference name<input required maxLength={80} value={ref.name} onChange={event => change('references', draft.references.map((item, position) => position === index ? { ...item, name: event.target.value } : item))} /></label><label>Reference text<textarea rows={5} maxLength={24000} value={ref.text} onChange={event => change('references', draft.references.map((item, position) => position === index ? { ...item, text: event.target.value } : item))} /></label><button type="button" className="text-button" onClick={() => change('references', draft.references.filter((_, position) => position !== index))}>Remove reference</button></fieldset>)}<button type="button" className="text-button" disabled={draft.references.length >= 12} onClick={() => change('references', [...draft.references, { name: '', text: '' }])}><Plus size={14} />Add reference</button></details>
          {adopted.length > 0 && <label>Link a tested working approach<select value={draft.refinementId} onChange={event => change('refinementId', event.target.value)}><option value="">No comparison linked</option>{adopted.map(record => <option key={record.id} value={record.id}>{record.goal}</option>)}</select></label>}
          <p className="skill-library-note">A new revision keeps the previous version. Earlier comparison evidence is cleared unless you link an adopted approach again.</p>
          <div className="skill-library-actions"><button className="primary-button" disabled={busy}>Save {draft.id ? 'revision' : 'skill'}</button><button type="button" className="text-button" disabled={busy} onClick={() => setDraft(null)}>Cancel</button></div>
        </form> : selected ? <>
          <div className="section-title"><h3>{selected.name}</h3><span className="tag">{selected.status}</span></div><p>{selected.description}</p>
          <label className="skill-library-version">Version<select aria-label="Skill revision" disabled={busy} value={selected.revision} onChange={event => act(() => open(selected.id, Number(event.target.value)))}>{selected.versions.map(version => <option key={version.revision} value={version.revision}>Version {version.revision} · {new Date(version.createdAt).toLocaleDateString()}</option>)}</select></label>
          {selected.appliesWhen && <p><b>Use when:</b> {selected.appliesWhen}</p>}{selected.caveat && <p><b>Limitations:</b> {selected.caveat}</p>}
          <pre className="skill-library-instructions">{selected.text}</pre>
          {selected.references.length > 0 && <div className="skill-library-references"><h4>Reference notes</h4>{selected.references.map(ref => <button key={ref.name} className="text-button" disabled={busy} onClick={() => act(() => openReference(ref.name))}>{ref.name} <small>{ref.characters.toLocaleString()} characters</small></button>)}{reference && <details open><summary>{reference.reference}</summary><pre>{reference.text}</pre></details>}</div>}
          {selected.evidence && <details><summary>Linked working approach</summary><p>{selected.evidence.notice}</p>{[...selected.evidence.baseline, ...selected.evidence.candidate].map(item => <p key={item.id}><code>{item.tool}</code> · {item.status} · {new Date(item.completedAt).toLocaleString()}</p>)}</details>}
          <div className="skill-library-actions">{selected.status === 'active' && selected.revision === latest && selected.editable && <button className="secondary-button" disabled={busy} onClick={() => act(() => edit())}>Create revision</button>}<button className="text-button" disabled={busy} onClick={() => act(() => edit(true))}>Copy as new skill</button>{selected.status === 'active' && selected.editable && <button className="text-button" disabled={busy} onClick={() => act(retire)}>Retire</button>}</div>
        </> : <p>Select a skill to read its instructions and version history.</p>}
      </div></div>
    </>}
    <p className="skill-library-note">Skills guide how work is done. Tool permissions still apply. Recorded comparisons support a particular approach and do not guarantee every instruction.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
