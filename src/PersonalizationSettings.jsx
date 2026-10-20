import React, { useEffect, useState } from 'react';
import { FileText, LoaderCircle, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { TONES, SOUL_ESSENCE, SOUL_NAME, normalizePersonalization, soulBudget } from '../desktop/personalization.mjs';
import { api } from './transport.js';
import { CompanionSettings } from './Companion.jsx';
import CharacterProfile from './CharacterProfile.jsx';

const SCOPES = [{ id: 'both', name: 'Chats and documents' }, { id: 'chat', name: 'Chat replies' }, { id: 'documents', name: 'Documents and files' }];
const clean = error => (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');

/** Saves a text field when it loses focus, so typing never fights the save. */
function Field({ label, hint, value, onSave, rows = 3, placeholder, max }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <label className="persona-field"><strong>{label}</strong>{hint && <small>{hint}</small>}
    <textarea rows={rows} value={draft} maxLength={max} placeholder={placeholder} onChange={event => setDraft(event.target.value)} onBlur={() => draft !== value && onSave(draft)} /></label>;
}

/** Learns a writing style from samples: pasted text, text files, mail (.eml/.mbox) or a Slack export. */
function StyleEditor({ style, onClose, onSaved, personalization, save }) {
  const [name, setName] = useState(style?.name || 'My style');
  const [appliesTo, setAppliesTo] = useState(style?.appliesTo || 'both');
  const [pasted, setPasted] = useState('');
  const [files, setFiles] = useState(null);
  const [author, setAuthor] = useState('');
  const [guide, setGuide] = useState(style?.guide || '');
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const needsAuthor = files?.files.some(file => /\.(mbox|json)$/i.test(file.name));
  async function choose() { setError(''); try { const result = await api.invoke('style.chooseFiles'); if (result.token) setFiles(result); } catch (failure) { setError(clean(failure)); } }
  async function learn() {
    setBusy('learn'); setError('');
    try { const next = await api.invoke('style.learn', { styleId: style?.id, name: name.trim() || 'My style', appliesTo, pasted, token: files?.token, author }); const saved = next.styles.find(item => item.name === (name.trim() || 'My style')) || next.styles.at(-1); setGuide(saved?.guide || ''); setFiles(null); setPasted(''); onSaved(next, saved); }
    catch (failure) { setError(clean(failure)); } finally { setBusy(''); }
  }
  async function saveGuide() {
    const current = normalizePersonalization(personalization);
    const id = style?.id || `style-${Date.now()}`;
    current.styles = [...current.styles.filter(item => item.id !== id), { ...(style || {}), id, name: name.trim() || 'My style', appliesTo, guide, enabled: true, sources: style?.sources || [], updatedAt: new Date().toISOString() }];
    await save(current); onClose();
  }
  return <div className="style-editor">
    <div className="style-editor-head"><strong>{style ? 'Edit writing style' : 'New writing style'}</strong><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={15} /></button></div>
    <div className="style-row"><label>Name<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
      <label>Use for<select value={appliesTo} onChange={event => setAppliesTo(event.target.value)}>{SCOPES.map(scope => <option key={scope.id} value={scope.id}>{scope.name}</option>)}</select></label></div>
    <p className="style-help">Give Exomina some of your own writing. A connected AI turns it into a short style guide; only the guide is sent with your messages, not the samples.</p>
    <textarea className="style-paste" rows={5} value={pasted} onChange={event => setPasted(event.target.value)} placeholder="Paste a few things you wrote: emails, posts, a chapter…" />
    <div className="style-files"><button type="button" className="secondary-button small" onClick={choose}><FileText size={14} />Add files</button><span>Text, Markdown, e-mail (.eml, .mbox from Gmail Takeout or Outlook) or a Slack export (.json)</span></div>
    {files?.files?.length > 0 && <ul className="style-file-list">{files.files.map(file => <li key={file.name}>{file.name}<small>{file.error || `${Math.round(file.characters / 1000)}k characters`}</small></li>)}</ul>}
    {needsAuthor && <label className="style-author">Only my messages: my name or e-mail address<input value={author} onChange={event => setAuthor(event.target.value)} placeholder="you@example.com" /></label>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="style-actions"><button type="button" className="primary-button small" disabled={!!busy || (!pasted.trim() && !files?.token)} onClick={learn}>{busy === 'learn' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}{busy === 'learn' ? 'Learning your style…' : 'Learn my style'}</button></div>
    <label className="persona-field"><strong>Style guide</strong><small>What the AIs follow. Edit it freely, or write your own.</small><textarea rows={8} value={guide} onChange={event => setGuide(event.target.value)} placeholder="- Short sentences, dry humour…" /></label>
    <div className="style-actions"><button type="button" className="secondary-button small" onClick={onClose}>Cancel</button><button type="button" className="primary-button small" disabled={!guide.trim()} onClick={saveGuide}>Save style</button></div>
  </div>;
}

/** The shared character every AI here plays, and what it has learned about meeting you. */
function SoulSettings({ soul, onChanged }) {
  const [name, setName] = useState(soul.name);
  const [error, setError] = useState('');
  useEffect(() => setName(soul.name), [soul.name]);
  const update = patch => reflect({ action: 'patch', patch });
  const budget = soulBudget(soul);
  const reflect = async args => {
    try { const result = await api.invoke('soul.change', args); setError(''); onChanged(result); }
    catch (cause) { setError(clean(cause)); }
  };
  const changed = soul.name !== SOUL_NAME || soul.essence !== SOUL_ESSENCE;
  return <div className="persona-styles persona-soul">
    <div className="persona-styles-head"><div><strong>Soul</strong><small>One character for every AI here. It learns how you like to be met and grows into yours.</small></div>
      <button type="button" role="switch" aria-checked={soul.enabled} aria-label="Use the soul" className={`toggle ${soul.enabled ? 'on' : ''}`} onClick={() => update({ enabled: !soul.enabled })}><span /></button></div>
    {soul.enabled && <>
      <label className="persona-field"><strong>Name</strong><input value={name} maxLength={40} onChange={event => setName(event.target.value)} onBlur={() => name.trim() && name.trim() !== soul.name && update({ name: name.trim() })} /></label>
      <Field label="Character" hint="Who it is, in its own words. Private chats get only the name and this." value={soul.essence} rows={5} max={1200} onSave={essence => update({ essence })} />
      <div className="persona-field"><strong>What it has learned about you</strong><small>It learns and combines overlapping observations quietly as you work together. Your stated preferences carry more weight than its inferences. You can correct or delete anything.</small>
        <small>{budget.used.toLocaleString()} / {budget.budget.toLocaleString()} characters used. {budget.needsConsolidation ? 'The AIs are asked to consolidate overlapping observations to make room.' : 'Room remains for it to grow.'}</small></div>
      {error && <p role="alert" className="error-text">{error}</p>}
      {soul.traits.map(trait => <div className="persona-style" key={trait.id}>
        <div><strong>{trait.text}</strong><small>{trait.source === 'stated' ? 'You said so' : 'Noticed'} · confirmed {trait.confirmedAt}</small>{trait.evidence && <p>{trait.evidence}</p>}
          <details><summary>Edit observation</summary><Field label="Observation" value={trait.text} max={2000} onSave={text => reflect({ action: 'revise', id: trait.id, text })} /></details>
          {Boolean(trait.lineage?.length) && <details><summary>Original observations</summary>{trait.lineage.map((original,index) => <p key={`${original.id}-${index}`}>{original.text} ({original.source})</p>)}</details>}
        </div>
        <div className="persona-style-actions"><button type="button" className="icon-button" title="Permanently delete, including saved evidence and recovery copies" aria-label={`Forget: ${trait.text}`} onClick={() => reflect({ action: 'harddelete', id: trait.id })}><Trash2 size={14} /></button></div>
      </div>)}
      {!soul.traits.length && <p className="persona-empty">Nothing yet. It learns from how you talk with it, and you can always tell it directly.</p>}
      {soul.seededAt
        ? <div className="persona-field"><small>Seeded once from your history on {soul.seededAt}.</small><div className="style-actions"><button type="button" className="secondary-button small" onClick={() => update({ seededAt: null })}>Allow seeding again</button></div></div>
        : <div className="persona-field"><small>You can ask any AI to seed it from your history once. After that, it keeps learning through ordinary conversations without asking you to manage it.</small></div>}
      {Boolean(soul.history?.length) && <details className="persona-field"><summary>Recent changes and recovery</summary><small>Last 100 changes kept for recovery. Rolling back replaces the learned observations and drops later changes. Permanently deleted observations stay deleted.</small>
        {[...soul.history].reverse().map(change => <div className="persona-style" key={change.id}><div><strong>{change.action}</strong><small>{change.at}</small><p>{change.evidence}</p></div><button type="button" className="secondary-button small" onClick={() => reflect({ action: 'restore', historyId: change.id })}>Roll back to before this change</button></div>)}
      </details>}
      {changed && <div className="style-actions"><button type="button" className="secondary-button small" onClick={() => update({ name: SOUL_NAME, essence: SOUL_ESSENCE })}>Restore {SOUL_NAME}</button></div>}
    </>}
  </div>;
}

export default function PersonalizationSettings({ personalization: value, onChange, appearance, onAppearanceChange }) {
  const personalization = normalizePersonalization(value);
  const [editing, setEditing] = useState(null);
  const save = patch => onChange({ ...personalization, ...patch });
  return <section className="settings-section" id="settings-personalization">
    <div className="section-title"><h2>Personalisation</h2><span>How every AI here talks to you</span></div>
    <p className="persona-intro">These apply to all chats, including ones already running, from their next message. In any chat you can also just say how you want it (“be more concise from now on”), for that chat or for all of them.</p>
    <SoulSettings soul={personalization.soul} onChanged={next => onChange(next, { local: true })} />
    {onAppearanceChange && <CompanionSettings appearance={appearance} onChange={onAppearanceChange} name={personalization.soul.name} />}
    {onAppearanceChange&&<CharacterProfile/>}
    <div className="settings-row persona-tone"><div><strong>Tone</strong><p>The overall manner of replies.</p></div>
      <div className="segmented" role="radiogroup" aria-label="Tone">{TONES.map(tone => <button type="button" role="radio" key={tone.id} aria-checked={personalization.tone === tone.id} className={personalization.tone === tone.id ? 'selected' : ''} onClick={() => save({ tone: tone.id })} title={tone.text || 'No particular tone'}>{tone.name}</button>)}</div></div>
    <Field label="About you" hint="What the AIs should know about you: role, interests, how you like things explained." value={personalization.about} max={2000} onSave={about => save({ about })} placeholder="Share your role, interests and how you like things explained…" />
    <Field label="Instructions" hint="Standing rules for every reply." value={personalization.instructions} rows={4} max={4000} onSave={instructions => save({ instructions })} placeholder="Answer in the language I write in. Avoid lists unless I ask for them…" />
    <div className="persona-styles"><div className="persona-styles-head"><div><strong>Writing styles</strong><small>Learned from your own writing, for chat replies, documents and files, or both.</small></div><button type="button" className="secondary-button small" onClick={() => setEditing('new')}><Plus size={14} />Add style</button></div>
      {personalization.styles.map(style => <div className="persona-style" key={style.id}>
        <div><strong>{style.name}</strong><small>{SCOPES.find(scope => scope.id === style.appliesTo)?.name} · {style.sources.length ? `${style.sources.length} ${style.sources.length === 1 ? 'source' : 'sources'}` : 'written by hand'}</small><p>{style.guide.slice(0, 180)}{style.guide.length > 180 ? '…' : ''}</p></div>
        <div className="persona-style-actions"><button type="button" role="switch" aria-checked={style.enabled} aria-label={`Use ${style.name}`} className={`toggle ${style.enabled ? 'on' : ''}`} onClick={() => save({ styles: personalization.styles.map(item => item.id === style.id ? { ...item, enabled: !item.enabled } : item) })}><span /></button>
          <button type="button" className="icon-button" aria-label={`Edit ${style.name}`} onClick={() => setEditing(style)}><Pencil size={14} /></button>
          <button type="button" className="icon-button" aria-label={`Delete ${style.name}`} onClick={() => save({ styles: personalization.styles.filter(item => item.id !== style.id) })}><Trash2 size={14} /></button></div>
      </div>)}
      {!personalization.styles.length && !editing && <p className="persona-empty">No styles yet. Add one so letters, posts or documents the AIs write for you sound like you.</p>}
      {editing && <StyleEditor key={editing === 'new' ? 'new' : editing.id} style={editing === 'new' ? null : editing} personalization={personalization} save={onChange} onClose={() => setEditing(null)} onSaved={(next, saved) => { onChange(next, { local: true }); setEditing(saved || null); }} />}
    </div>
  </section>;
}
