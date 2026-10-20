import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Braces, Check, Cpu, Download, FileCode2, FileSearch, FolderOpen, Layers3, LoaderCircle, MessageSquare, RefreshCw, Settings2, ShieldCheck, Square, X } from 'lucide-react';
import { api } from './transport.js';
import GhidraWorkspace from './GhidraWorkspace.jsx';
import SelectableText from './SelectableText.jsx';
import './app-analysis.css';

const emptyStatus = { target: null, running: null, reports: [], version: '', nativeDependencies: null };
const reportLimit = 16000;
const operations = [
  { id: 'javascript', title: 'JavaScript / Electron', description: 'Inspect scripts, packages and Electron app contents.', Icon: Braces },
  { id: 'managed', title: '.NET metadata', description: 'Read assembly identity, references and type information.', Icon: Layers3 },
  { id: 'managed-members', title: '.NET members', description: 'Inspect methods, fields and their signatures.', Icon: FileCode2 },
  { id: 'managed-native', title: '.NET native boundaries', description: 'Find native imports and managed-to-native connections.', Icon: ShieldCheck },
  { id: 'native', title: 'Native executable overview', description: 'Find functions, strings and references in a Windows x86/x64 EXE with Ghidra.', Icon: Cpu, native: true },
  { id: 'native-functions', title: 'Native function decompilation', description: 'Read a bounded selection of reconstructed functions from a Windows x86/x64 EXE.', Icon: FileCode2, native: true },
  { id: 'inventory', title: 'File inventory', description: 'List the files and formats available for inspection.', Icon: FileSearch },
];

function errorMessage(error) {
  const message = error?.message || String(error || 'The request could not be completed.');
  return message.replace(/^Error invoking remote method ['"]studio:invoke['"]: (?:Error: )?/, '');
}
function operationTitle(operation) { return operation === 'native-query' ? 'Native binary query' : operations.find(item => item.id === operation)?.title || operation || 'Inspection'; }
function sizeLabel(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function AppAnalysis({ conversationId, conversationTitle, onOpenChat }) {
  const [status, setStatus] = useState(emptyStatus);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [report, setReport] = useState(null);
  const [nativeProcedure, setNativeProcedure] = useState('');
  const [mode, setMode] = useState('reports');
  const scope = useRef(0);
  const statusRequest = useRef(0);
  const reportRequest = useRef(0);

  const refresh = useCallback(async () => {
    const currentScope = scope.current;
    const request = ++statusRequest.current;
    try {
      const value = await api.invoke('analysis.status', { conversationId });
      if (currentScope === scope.current && request === statusRequest.current) {
        setStatus({ ...emptyStatus, ...value, reports: Array.isArray(value?.reports) ? value.reports : [] });
        setLoading(false);
      }
    } catch (failure) {
      if (currentScope === scope.current && request === statusRequest.current) {
        setError(errorMessage(failure));
        setLoading(false);
      }
    }
  }, [conversationId]);

  useEffect(() => {
    ++scope.current;
    ++reportRequest.current;
    setStatus(emptyStatus);
    setReport(null);
    setNativeProcedure('');
    setMode('reports');
    setBusy('');
    setCanceling(false);
    setError('');
    setNotice('');
    setLoading(true);
    refresh();
    const unsubscribe = api.onEvent(event => {
      const eventConversation = event.conversationId || event.data?.conversationId;
      if (event.type?.startsWith('analysis.') && (!eventConversation || eventConversation === conversationId)) refresh();
    });
    return () => { ++scope.current; ++reportRequest.current; unsubscribe?.(); };
  }, [conversationId, refresh]);

  useEffect(() => {
    if (!conversationId || (!status.running && !busy.startsWith('run-'))) return undefined;
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, [conversationId, !!status.running, busy, refresh]);

  async function action(name, work) {
    const currentScope = scope.current;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      await work();
      if (currentScope === scope.current) await refresh();
    } catch (failure) {
      if (currentScope === scope.current) setError(errorMessage(failure));
    } finally {
      if (currentScope === scope.current) setBusy('');
    }
  }

  function choose(kind) {
    action(`choose-${kind}`, async () => {
      await api.invoke('analysis.choose', { conversationId, kind });
    });
  }

  function configureNative(kind) {
    action(`setup-${kind}`, async () => {
      const result = await api.invoke('analysis.configureNative', { kind });
      if (result?.cancelled || result?.canceled) return;
    });
  }

  function checkNativeSetup() {
    const currentScope = scope.current;
    action('setup-check', async () => {
      const nativeDependencies = await api.invoke('analysis.nativeDependencies');
      if (currentScope === scope.current) setStatus(existing => ({ ...existing, nativeDependencies }));
    });
  }

  function clearTarget() {
    const currentScope = scope.current;
    action('clear', async () => {
      await api.invoke('analysis.clear', { conversationId });
      if (currentScope !== scope.current) return;
      ++reportRequest.current;
      setReport(null);
    });
  }

  async function cancel() {
    const currentScope = scope.current;
    setCanceling(true);
    setError('');
    try {
      await api.invoke('analysis.cancel', { conversationId });
      if (currentScope === scope.current) await refresh();
    } catch (failure) {
      if (currentScope === scope.current) setError(errorMessage(failure));
    } finally {
      if (currentScope === scope.current) setCanceling(false);
    }
  }

  async function readReport(id, offset = 0, previous = []) {
    const currentScope = scope.current;
    const request = ++reportRequest.current;
    setError('');
    setReport(existing => ({ ...(existing?.id === id ? existing : { text: '', offset: 0, previous: [], nextOffset: null }), id, loading: true }));
    try {
      const value = await api.invoke('analysis.report', { conversationId, id, offset, limit: reportLimit });
      if (currentScope !== scope.current || request !== reportRequest.current) return;
      const text = typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : typeof value?.content === 'string' ? value.content : JSON.stringify(value, null, 2);
      setReport({ id, text: (text || '').slice(0, reportLimit), offset, previous, nextOffset: typeof value?.nextOffset === 'number' ? value.nextOffset : null, total: value?.totalCharacters ?? value?.total, loading: false });
    } catch (failure) {
      if (currentScope === scope.current && request === reportRequest.current) {
        setReport(existing => existing?.id === id ? { ...existing, loading: false } : existing);
        setError(errorMessage(failure));
      }
    }
  }

  function exportReport(id) {
    const currentScope = scope.current;
    action(`export-${id}`, async () => {
      const result = await api.invoke('analysis.export', { conversationId, id });
      if (currentScope !== scope.current || result?.canceled || result?.cancelled) return;
      if (result?.saved || result?.path || result?.downloaded) setNotice(result.path ? `Report saved to ${result.path}` : 'Report saved.');
    });
  }

  const disabled = !!busy || loading || !!status.running;
  const nativeDependencies = status.nativeDependencies;
  const nativeAvailable = nativeDependencies?.available === true;
  const nativeDetails = Array.isArray(nativeDependencies?.details) ? nativeDependencies.details.join(' ') : typeof nativeDependencies?.details === 'string' ? nativeDependencies.details : '';
  const selectedReport = status.reports.find(item => item.id === report?.id);
  const running = status.running || (busy.startsWith('run-') ? { operation: busy.slice(4), phase: 'Starting inspection…' } : null);

  const nativeSetup = <div className="app-analysis-native-setup">
        <div className="app-analysis-native-heading"><Settings2 size={17} aria-hidden="true" /><h3>Native analysis setup</h3><span className={nativeAvailable ? 'app-analysis-native-ready' : ''}>{loading ? 'Checking setup' : nativeAvailable ? 'Ready' : 'Setup needed'}</span></div>
        <p>Both native inspection reports and Ghidra projects use this Ghidra and Java JDK setup. Choose their installation folders below. Exomina currently supports native Windows x86/x64 EXEs experimentally; native DLLs, other binary formats and other architectures are not yet integrated and verified. Ghidra itself supports more formats.</p>
        <dl>
          <div><dt>Ghidra</dt><dd>{nativeDependencies?.ghidraPath || 'No installation found'}</dd></div>
          <div><dt>Java JDK</dt><dd>{nativeDependencies?.javaPath || 'No installation found'}</dd></div>
        </dl>
        {nativeDetails && <p className="app-analysis-native-details" role="status">{nativeDetails}</p>}
        <div className="app-analysis-actions">
          <button className="secondary-button" disabled={disabled} onClick={() => configureNative('ghidra')}><FolderOpen size={14} aria-hidden="true" />{busy === 'setup-ghidra' ? 'Choosing Ghidra…' : 'Choose Ghidra folder'}</button>
          <button className="secondary-button" disabled={disabled} onClick={() => configureNative('java')}><FolderOpen size={14} aria-hidden="true" />{busy === 'setup-java' ? 'Choosing JDK…' : 'Choose JDK folder'}</button>
          <button className="text-button" disabled={disabled} onClick={checkNativeSetup}><RefreshCw size={14} aria-hidden="true" />{busy === 'setup-check' ? 'Checking…' : 'Recheck setup'}</button>
        </div>
      </div>;

  return <section className="app-analysis" aria-labelledby="app-analysis-heading">
    <div className="app-analysis-heading">
      <FileSearch size={21} aria-hidden="true" />
      <h2 id="app-analysis-heading">App analysis</h2>
    </div>
    <p>Understand how an app works, then discuss the findings with your AI. Choose inspection reports for a first look, or a Ghidra project for ongoing work on a Windows EXE. Both read a copy without running or changing the original app.</p>

    {!conversationId ? <div className="app-analysis-empty">
      <p>Open or start a chat, then choose the app you want to inspect.</p>
      {onOpenChat && <button className="secondary-button" disabled={!!busy} onClick={() => action('new-chat', async () => {
        const chat = await api.invoke('analysis.newChat');
        onOpenChat(chat);
      })}><MessageSquare size={15} aria-hidden="true" />{busy === 'new-chat' ? 'Starting chat…' : 'Start analysis chat'}</button>}
      {nativeSetup}
    </div> : <>
      <p className="app-analysis-scope">Selected files are available to this chat: <strong>{conversationTitle || 'Current chat'}</strong>.</p>
      <div className="app-analysis-target">
        <FolderOpen size={20} aria-hidden="true" />
        <div className="app-analysis-target-name">
          <strong>{status.target?.name || 'Choose an app or a folder'}</strong>
          {status.target?.path && <span title={status.target.path}>{status.target.path}</span>}
          {!status.target && <span>Select the files you want this chat to inspect.</span>}
        </div>
        {loading && <LoaderCircle className="app-analysis-spinner" size={17} aria-label="Loading app analysis" />}
        {status.target && <button className="text-button" disabled={disabled} onClick={clearTarget}>Clear selection</button>}
      </div>
      <div className="app-analysis-actions">
        <button className="secondary-button" disabled={disabled} onClick={() => choose('file')}><FileCode2 size={15} aria-hidden="true" />{busy === 'choose-file' ? 'Choosing file…' : 'Choose file'}</button>
        <button className="secondary-button" disabled={disabled} onClick={() => choose('folder')}><FolderOpen size={15} aria-hidden="true" />{busy === 'choose-folder' ? 'Choosing folder…' : 'Choose folder'}</button>
        {status.target && onOpenChat && <button className="text-button" onClick={() => onOpenChat()}><MessageSquare size={15} aria-hidden="true" />Ask in this chat</button>}
      </div>
      <p className="app-analysis-shared-selection">Both modes use this selection and the native analysis setup below. Switching modes keeps your reports and saved Ghidra project. Changing or clearing the selection stops a running Ghidra project.</p>

      {running && <div className="app-analysis-progress" role="status" aria-live="polite">
        <LoaderCircle className="app-analysis-spinner" size={18} aria-hidden="true" />
        <div><strong>{operationTitle(running.operation)}</strong><span>{running.phase || 'Inspecting selected files…'}</span></div>
        <button className="secondary-button" disabled={canceling} onClick={cancel}><Square size={13} aria-hidden="true" />{canceling ? 'Stopping…' : 'Cancel'}</button>
      </div>}

      <div className="app-analysis-modes" role="tablist" aria-label="App analysis mode" onKeyDown={event => {
        const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
        const current = tabs.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length : null;
        if (next == null) return;
        event.preventDefault();
        tabs[next].click();
        tabs[next].focus();
      }}>
        <button type="button" role="tab" id="app-analysis-reports-tab" aria-controls="app-analysis-reports-panel" aria-selected={mode === 'reports'} tabIndex={mode === 'reports' ? 0 : -1} onClick={() => setMode('reports')}><FileSearch size={18} aria-hidden="true" /><span><strong>Inspection reports</strong><small>Read-only findings from app files</small></span></button>
        <button type="button" role="tab" id="app-analysis-project-tab" aria-controls="app-analysis-project-panel" aria-selected={mode === 'project'} tabIndex={mode === 'project' ? 0 : -1} onClick={() => setMode('project')}><Cpu size={18} aria-hidden="true" /><span><strong>Ghidra project</strong><small>Saved EXE analysis with notes and names</small></span></button>
      </div>

      <div id="app-analysis-reports-panel" role="tabpanel" aria-labelledby="app-analysis-reports-tab" hidden={mode !== 'reports'} tabIndex={0}>
      <div className="app-analysis-mode-heading"><h3>Inspect files and save a report</h3>{status.version && <span className="app-analysis-version">REA {status.version}</span>}</div>
      <p className="app-analysis-mode-description">Start here for JavaScript/Electron apps, .NET assemblies or a native EXE overview. Each inspection saves a read-only report. Native reports use Ghidra too, but do not include names, comments or types saved in your Ghidra project.</p>
      <div className="app-analysis-native-procedure">
        <label htmlFor="app-analysis-native-procedure">Function to decompile (optional)</label>
        <input id="app-analysis-native-procedure" aria-describedby="app-analysis-native-procedure-help" value={nativeProcedure} maxLength={200} disabled={disabled} onChange={event => setNativeProcedure(event.target.value)} placeholder="Function name or address from the overview" />
        <span id="app-analysis-native-procedure-help">Used only by Native function decompilation below. Leave empty for a bounded selection. Reconstructed code can be incomplete.</span>
      </div>

      <div className="app-analysis-operations">
        {operations.map(({ id, title, description, Icon, native }) => <button key={id} className="app-analysis-operation" disabled={disabled || !status.target || (native && !nativeAvailable)} onClick={() => action(`run-${id}`, () => api.invoke('analysis.run', { conversationId, operation: id, ...(id === 'native-functions' && nativeProcedure.trim() ? { procedure: nativeProcedure.trim() } : {}) }))}>
          <Icon size={19} aria-hidden="true" /><span><strong>{title}</strong><span>{description}{native && !nativeAvailable ? ' Complete native analysis setup to use this inspection.' : ''}</span></span>
        </button>)}
      </div>

      {status.reports.length > 0 && <div className="app-analysis-reports">
        <h3>Recent reports</h3>
        <ul>{status.reports.map(item => <li key={item.id}>
          <div className="app-analysis-report-summary"><strong>{operationTitle(item.operation)}</strong><span>{[dateLabel(item.createdAt), sizeLabel(item.bytes), item.status].filter(Boolean).join(' · ')}</span></div>
          <button className="text-button" disabled={!!report?.loading} onClick={() => readReport(item.id)}>View report</button>
          <button className="text-button" disabled={!!busy} onClick={() => exportReport(item.id)}><Download size={14} aria-hidden="true" />Save JSON</button>
        </li>)}</ul>
      </div>}

      {report && <div className="app-analysis-report-viewer" aria-busy={report.loading}>
        <div className="app-analysis-report-heading"><h3>{operationTitle(selectedReport?.operation)} report</h3><button className="text-button" aria-label="Close report" onClick={() => { ++reportRequest.current; setReport(null); }}><X size={17} /></button></div>
        {report.loading ? <p className="app-analysis-report-loading"><LoaderCircle className="app-analysis-spinner" size={16} aria-hidden="true" />Loading report…</p> : <SelectableText>{report.text}</SelectableText>}
        <div className="app-analysis-report-paging">
          <span>{typeof report.total === 'number' ? report.total > 0 ? `${report.offset + 1}–${Math.min(report.offset + (report.text?.length || 0), report.total)} of ${report.total.toLocaleString()} characters` : 'Empty report' : 'Report text'}</span>
          <button className="text-button" disabled={report.loading || !report.previous?.length} onClick={() => readReport(report.id, report.previous.at(-1), report.previous.slice(0, -1))}><ArrowLeft size={14} aria-hidden="true" />Previous</button>
          <button className="text-button" disabled={report.loading || report.nextOffset == null} onClick={() => readReport(report.id, report.nextOffset, [...(report.previous || []), report.offset])}>Next<ArrowRight size={14} aria-hidden="true" /></button>
        </div>
      </div>}
      </div>
      <div id="app-analysis-project-panel" role="tabpanel" aria-labelledby="app-analysis-project-tab" hidden={mode !== 'project'} tabIndex={0}>
        <GhidraWorkspace conversationId={conversationId} />
      </div>
      {nativeSetup}
    </>}
    {notice && <p className="app-analysis-notice" role="status"><Check size={15} aria-hidden="true" />{notice}</p>}
    {error && <p className="inline-error app-analysis-error" role="alert">{error}</p>}
  </section>;
}
