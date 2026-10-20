import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, FileText, FolderOpen, Globe2, Paperclip, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { AttachmentDraft } from './ChatAttachments.jsx';
import { UsageBanner } from './Usage.jsx';
import { usageBlocksSelection } from '../desktop/model-preferences.mjs';
import { buildTaskRequest, taskStartProblem, reusableTaskStarter } from '../desktop/task-guide.mjs';
import './task-start.css';

const sources = [['text', FileText, 'Text or description'], ['files', Paperclip, 'Files'], ['website', Globe2, 'Website'], ['folder', FolderOpen, 'Project folder']];
export default function TaskStart({ initial = {}, onSetupChange, attachments, onAddFiles, onRemoveFile, uploading, projects = [], onChooseFolder, catalog, provider, model, usage, permissionLabel, providerName, ready, canUseConnection, connections, onPickProvider, settings, capabilities, onControls, onConnections, onCancel, onReview }) {
  const [sourceKind, setSourceKind] = useState(initial.sourceKind || 'text');
  const [goal, setGoal] = useState(initial.goal || ''), [material, setMaterial] = useState(initial.material || ''), [url, setUrl] = useState(initial.url || '');
  const [projectId, setProjectId] = useState(initial.projectId || ''), [choosing, setChoosing] = useState(false), [error, setError] = useState('');
  const [purpose,setPurpose]=useState(initial.purpose||'task'),[rewriteLevel,setRewriteLevel]=useState(initial.rewriteLevel||'light'),[voiceSample,setVoiceSample]=useState(initial.voiceSample||'');
  const input = useRef(null), aiInput = useRef(null), project = projects.find(item => item.id === projectId);
  useEffect(() => { onSetupChange({sourceKind,goal,material,url,projectId,purpose,rewriteLevel,voiceSample}); }, [sourceKind,goal,material,url,projectId,purpose,rewriteLevel,voiceSample,onSetupChange]);
  const problem = taskStartProblem({ sourceKind, material, url, project, attachments, ...capabilities, browserEnabled: settings.browserEnabled });
  const limited=usageBlocksSelection(usage?.[provider],{provider,model});
  async function chooseFolder() {
    setError(''); setChoosing(true);
    try { const result = await onChooseFolder(); if (result?.id) setProjectId(result.id); } catch (err) { setError(err.message); } finally { setChoosing(false); }
  }
  function review(event) {
    event.preventDefault();
    if (problem || !ready || limited || uploading || choosing) return;
    const setup = { sourceKind, goal: goal.trim(), material: material.trim(), url, projectId: sourceKind === 'folder' ? projectId : '',purpose:sourceKind==='text'?purpose:'task',rewriteLevel,voiceSample };
    onReview(setup, buildTaskRequest({ ...setup, project, attachments }));
  }
  return <section className="task-start" aria-labelledby="task-start-title">
    <div className="task-start-heading"><div><div className="eyebrow">START WITH REAL WORK</div><h1 id="task-start-title">Bring your own task</h1><p>Bring a document, website, project or everyday problem. Describe the result you want, or explore what would be useful.</p></div><button type="button" className="icon-button" aria-label="Close task setup" onClick={onCancel}><X size={18}/></button></div>
    <form onSubmit={review}>
      <label className="task-field">What would make this useful?<input aria-label="Desired task outcome" value={goal} onChange={event => setGoal(event.target.value)} maxLength={1000} placeholder="For example: find mistakes, improve a proposal, or compare options"/><small>Optional. Leave this blank to get suggestions based on the material.</small></label>
      <fieldset className="task-source-picker"><legend>What are we working with?</legend>{sources.map(([id, Icon, label]) => <button type="button" key={id} aria-pressed={sourceKind === id} className={sourceKind === id ? 'selected' : ''} onClick={() => setSourceKind(id)}><Icon size={16}/>{label}</button>)}</fieldset>
      {sourceKind === 'files' && <div className="task-material"><input type="file" multiple hidden ref={input} onChange={event => { onAddFiles(event.target.files); event.target.value = ''; }}/><button type="button" className="secondary-button" disabled={!capabilities.localFiles || uploading} onClick={() => input.current?.click()}><Paperclip size={15}/>{uploading ? 'Adding files…' : 'Attach working files'}</button><p>Up to 10 files, 20 MiB total. Text, CSV and images work directly; other formats need a compatible reader available to your AI.</p><AttachmentDraft attachments={attachments} onRemove={onRemoveFile}/></div>}
      {sourceKind === 'website' && <label className="task-field">Website address<input aria-label="Task website address" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com" maxLength={4000}/><small>Uses the browser selected in Tools. Sign-ins may need your help there.</small></label>}
      {sourceKind === 'folder' && <div className="task-material"><label className="task-field">Project folder<select aria-label="Task project folder" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Choose a project</option>{projects.filter(item => item.folder).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" className="secondary-button" disabled={!capabilities.localFiles || choosing} onClick={chooseFolder}><FolderOpen size={15}/>{choosing ? 'Choosing…' : 'Choose a new folder'}</button>{project?.folder && <p className="path-text">{project.folder}</p>}<p>This task uses the project’s folder and instructions. Your default workspace stays the same.</p>{attachments.length > 0 && <AttachmentDraft attachments={attachments} onRemove={onRemoveFile}/>}</div>}
      <label className="task-field">{sourceKind === 'text' ? 'Working text or description' : 'Context or instructions (optional)'}<textarea aria-label="Task material and context" value={material} onChange={event => setMaterial(event.target.value)} rows={sourceKind === 'text' ? 5 : 2} maxLength={30000} placeholder={sourceKind === 'text' ? 'Paste their text, a sample of their data, or describe the work they do…' : 'Add audience, constraints or anything the AI should know…'}/></label>
      {sourceKind==='text'&&<><label className="task-field">How to use this text<select aria-label="Text task" value={purpose} onChange={event=>setPurpose(event.target.value)}><option value="task">Work on a task</option><option value="rewrite">Rewrite while keeping my voice</option></select></label>{purpose==='rewrite'&&<><label className="task-field">Editing freedom<select aria-label="Rewrite freedom" value={rewriteLevel} onChange={event=>setRewriteLevel(event.target.value)}><option value="light">Light edit · stay close to my wording</option><option value="full">Full rewrite · pursue the intended effect</option></select></label><label className="task-field">Voice reference (optional)<textarea aria-label="Rewrite voice reference" value={voiceSample} onChange={event=>setVoiceSample(event.target.value)} maxLength={5000} rows={3} placeholder="Paste a short sample of your own writing…"/><small>Used only when you send this request. Review the revised text in chat before using it.</small></label></>}</>}
      {sourceKind !== 'files' && sourceKind !== 'folder' && attachments.length > 0 && <div className="task-material"><p>These files will also be sent with the request.</p><AttachmentDraft attachments={attachments} onRemove={onRemoveFile}/></div>}
      <div className="task-access" aria-label="Task access"><label>AI for this task<select ref={aiInput} aria-label="Task AI" value={provider} onChange={event => onPickProvider(event.target.value)}>{catalog.map(item => <option value={item.id} key={item.id}>{item.name}{canUseConnection(connections.find(c => c.id === item.id)) ? '' : ' · needs connection'}</option>)}</select></label><span className={ready ? 'task-ready' : ''}>{ready ? <Check size={14}/> : <X size={14}/>} {ready ? `${providerName} connected` : 'Connection needed'}</span>{!ready && <button type="button" className="text-button" onClick={onConnections}>Connections</button>}<button type="button" className="text-button" onClick={onControls}>Tool controls</button></div>
      <p className="task-storage">Permissions: {permissionLabel || 'current settings'}. Browser: {settings.browserSource==='connected'?'your connected browser':'built-in'} · tools {settings.browserEnabled?'on':'off'}. Computer use: {settings.desktopEnabled?'on':'off'}.</p>
      <UsageBanner provider={provider} usage={usage} onSwitch={()=>aiInput.current?.focus()}/>
      {limited && <p className="task-hint" role="status">The selected AI reports its usage limit has been reached. Choose another connected AI, or wait for the limit to reset.</p>}
      <p className="task-storage">Uses your selected AI account and existing tool permissions. Chats and files are saved. Shared memory is {settings.memoryEnabled ? 'on' : 'off'}{settings.memoryEnabled ? '; recalled context can be sent to the AI' : ''}.</p>
      {(problem || error) && <p className={error ? 'inline-error' : 'task-hint'} role="status">{error || problem}</p>}
      <div className="task-start-actions"><button type="button" className="secondary-button" onClick={onCancel}>Back to chat</button><button className="primary-button" disabled={!!problem || !ready || limited || uploading || choosing}>Review task request<ArrowRight size={15}/></button></div>
    </form>
  </section>;
}

export function TaskActions({ guide, draft, messages = [], running, onEdit, onCheck, onRepeat, onSave, onModalChange }) {
  const [form, setForm] = useState(null), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const dialog = useRef(null), savingRef = useRef(false);savingRef.current=saving;
  const reply = messages.at(-1), complete = reply?.role === 'assistant' && !!reply.content?.trim() && !reply.error && !reply.continuationError && !running;
  const candidateReplies=messages.map((message,index)=>({message,index})).filter(({message})=>message.role==='assistant'&&message.content?.trim()&&!message.error&&!message.continuationError);
  useEffect(()=>{
    if(!form)return;
    const previous=document.activeElement;
    dialog.current?.querySelector('input')?.focus();
    const key=event=>{
      if(event.key==='Escape'&&!savingRef.current){event.preventDefault();setForm(null);onModalChange(false);}
      if(event.key==='Tab'){
        const items=[...(dialog.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')||[])];
        const first=items[0],last=items.at(-1);
        if(!items.includes(document.activeElement)||event.shiftKey&&document.activeElement===first){event.preventDefault();(event.shiftKey?last:first)?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('keydown',key);if(previous?.isConnected)previous.focus();};
  },[!!form]);
  function openSave() {
    const latest=candidateReplies.at(-1);
    setForm({ name: '', shortcut: '', text: latest?.message.content || reusableTaskStarter(guide),source:latest?String(latest.index):'template' }); setError(''); onModalChange(true);
  }
  function close() { if (saving) return; setForm(null); onModalChange(false); }
  async function save(event) {
    event.preventDefault(); setSaving(true); setError('');
    try { await onSave({name:form.name,shortcut:form.shortcut,text:form.text}); setForm(null); onModalChange(false); } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  return <><div className="task-actions" aria-label="Task next steps"><div><strong>{draft ? 'Your task request is ready' : guide.goal || 'Work with your material'}</strong><small>{draft ? 'Edit it below, then send when ready.' : running ? 'Working · result review comes next' : 'Review the result, then reuse the accepted process.'}</small></div>{draft ? <button type="button" className="text-button" onClick={onEdit}>Edit setup</button> : <><button type="button" className="text-button" disabled={!complete} onClick={onCheck}>Check result</button><button type="button" className="text-button" disabled={!complete} onClick={onRepeat}>Make repeatable</button><button type="button" className="text-button" disabled={!complete} onClick={openSave}>Save reusable prompt</button></>}</div>
    {form && createPortal(<div className="modal-backdrop"><section ref={dialog} className="modal wide task-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="task-prompt-title"><button className="modal-close icon-button" aria-label="Close reusable prompt" disabled={saving} onClick={close}><X size={18}/></button><h2 id="task-prompt-title">Save a reusable prompt</h2><p>Review the procedure and replace specific names, data and paths with input placeholders. Find it later under Projects &amp; prompts, or type / in chat.</p><form onSubmit={save}><label className="task-field">Starting text<select aria-label="Reusable prompt starting text" value={form.source} onChange={event=>{const source=event.target.value;setForm({...form,source,text:source==='template'?reusableTaskStarter(guide):messages[Number(source)].content});}}><option value="template">Blank procedure template</option>{candidateReplies.map(({message,index})=><option key={index} value={String(index)}>Reply {index+1}: {message.content.replace(/\s+/g,' ').slice(0,75)}</option>)}</select></label><label className="task-field">Name<input aria-label="Reusable task name" value={form.name} required maxLength={80} onChange={event => setForm({ ...form, name: event.target.value })}/></label><label className="task-field">Shortcut<input aria-label="Reusable task shortcut" value={form.shortcut} required maxLength={30} placeholder="review-proposal" onChange={event => setForm({ ...form, shortcut: event.target.value })}/></label><label className="task-field">Reusable instructions<textarea aria-label="Reusable task instructions" value={form.text} required maxLength={100000} rows={8} onChange={event => setForm({ ...form, text: event.target.value })}/></label>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={saving} onClick={close}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? 'Saving…' : 'Save prompt'}</button></div></form></section></div>, document.body)}</>;
}
