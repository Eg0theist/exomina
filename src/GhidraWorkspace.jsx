import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu, FolderOpen, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import { api } from './transport.js';
import './ghidra-workspace.css';

export default function GhidraWorkspace({ conversationId }) {
  const [status, setStatus] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const scope = useRef(0);
  const statusRequest = useRef(0);
  const refresh = useCallback(async () => {
    const currentScope = scope.current;
    const request = ++statusRequest.current;
    const value = await api.invoke('ghidra.status', { conversationId });
    if (currentScope === scope.current && request === statusRequest.current) setStatus(value);
  }, [conversationId]);

  useEffect(() => {
    ++scope.current;
    setStatus({});
    setBusy('');
    setError('');
    const currentScope = scope.current;
    refresh().catch(failure => { if (currentScope === scope.current) setError(failure.message); });
    const unsubscribe = api.onEvent(event => {
      if ((event.type === 'ghidra.changed' || event.type?.startsWith('analysis.')) && (!event.conversationId || event.conversationId === conversationId)) refresh().catch(() => {});
    });
    return () => { ++scope.current; unsubscribe?.(); };
  }, [refresh, conversationId]);

  async function action(name, work) {
    const currentScope = scope.current;
    setBusy(name);
    setError('');
    try {
      await work();
      if (currentScope === scope.current) await refresh();
    } catch (failure) {
      if (currentScope === scope.current) {
        setError((failure.message || String(failure)).replace(/^Error invoking remote method '[^']+': Error: /, ''));
        await refresh().catch(() => {});
      }
    } finally {
      if (currentScope === scope.current) setBusy('');
    }
  }

  const [now, setNow] = useState(Date.now());
  const job = status.job;
  const jobActive = !!job?.active;
  useEffect(() => {
    if (!jobActive) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [jobActive]);
  const elapsed = job ? Math.max(0, Math.round(((job.active ? now : Date.parse(job.startedAt) + job.elapsedSeconds * 1000) - Date.parse(job.startedAt)) / 1000)) : 0;
  const clock = seconds => seconds >= 3600 ? Math.floor(seconds / 3600) + ' h ' + String(Math.floor(seconds % 3600 / 60)).padStart(2, '0') + ' min' : Math.floor(seconds / 60) + ' min ' + String(seconds % 60).padStart(2, '0') + ' s';

  const isExe = status.target?.kind === 'file' && /\.exe$/i.test(status.target.name || '');
  const running = status.state === 'connected' || status.state === 'starting' || busy === 'start';
  const stateLabel = status.state === 'connected' ? 'Connected' : status.state === 'starting' || busy === 'start' ? (job?.label || 'Analyzing') + '…' : status.project ? 'Project saved' : 'Not started';

  return <section className="ghidra-workspace" aria-label="Ghidra project">
    <div className="ghidra-heading"><div><h3>Keep working in a saved analysis project</h3><p>Deeper Windows EXE analysis with GhidraMCP 2.0.</p></div><span className="tag" role="status">{stateLabel}</span></div>
    <p className="ghidra-description">Ask your AI to trace functions and references, then save clearer names, comments and type information in the project. Your work is kept between sessions for this chat and binary. Inspection reports are separate and do not contain these project edits.</p>
    {!isExe && <p className="ghidra-selection-help">Choose a single Windows x86/x64 EXE with <strong>Choose file</strong> above to use this mode. For a folder, JavaScript/Electron app or .NET inspection, use <strong>Inspection reports</strong>.</p>}
    <div className="ghidra-actions">
      <button type="button" className="primary-button" disabled={!!busy || !isExe || running} onClick={() => action('start', () => api.invoke('ghidra.start', { conversationId }))}>{busy === 'start' ? <LoaderCircle className="spin" size={14} /> : <Cpu size={14} />}{status.project ? 'Resume project' : 'Start project'}</button>
      {running && <button type="button" className="secondary-button" disabled={busy === 'stop'} onClick={() => action('stop', () => api.invoke('ghidra.stop', { conversationId }))}><Square size={13} />{busy === 'stop' ? 'Stopping…' : jobActive && status.state === 'starting' ? 'Cancel analysis' : 'Save & stop'}</button>}
      <button type="button" className="secondary-button" disabled={!!busy || !isExe || running} title="Reuse a project analysed outside Exomina, for example a headless Ghidra run" onClick={() => action('adopt', () => api.invoke('ghidra.adopt', { conversationId }))}><FolderOpen size={13} />Use finished project…</button>
      <button type="button" className="icon-button" aria-label="Refresh Ghidra project" disabled={!!busy} onClick={() => action('refresh', refresh)}><RefreshCw size={14} /></button>
    </div>
    {job && (jobActive || job.error) && <div className="ghidra-job" role="status" aria-live="polite">
      <strong>{job.label}</strong>
      <span>{clock(elapsed)}{jobActive ? ' · stops after ' + job.limitMinutes + ' min' : ''}</span>
      {jobActive && <small>A large game executable can take an hour or more. You can keep using Exomina; the app keeps running this analysis{job.notifiesWhenDone ? ' and will message your AI when it finishes.' : '.'}</small>}
      {job.detail && jobActive && <code title="Latest Ghidra log line">{job.detail}</code>}
      {job.error && !jobActive && <p className="inline-error">{job.error}</p>}
    </div>}
    <label className="ghidra-edit-toggle"><input type="checkbox" checked={!!status.editing} disabled={!conversationId || !isExe || !!busy} onChange={event => { const enabled = event.target.checked; action('editing', () => api.invoke('ghidra.editing', { conversationId, enabled })); }} /><span>Allow project edits in this chat<small>Edits change analysis names, comments and types. Each edit asks for approval and saves a recovery checkpoint first. The original EXE stays unchanged.</small></span></label>
    {status.program && <div className="ghidra-program"><strong>{status.program.name || status.target?.name}</strong><span>{status.program.language_id || status.program.languageId || ''}</span>{status.sha256 && <code title="Selected binary SHA-256">{status.sha256}</code>}<button type="button" className="text-button" onClick={() => action('show', () => api.invoke('ghidra.showProject', { conversationId }))}><FolderOpen size={13} />Project & checkpoints</button></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <p className="ghidra-note">Uses the shared selection above and native analysis setup below. Verified for Windows x86/x64 EXEs. The EXE is never run or changed.</p>
  </section>;
}
