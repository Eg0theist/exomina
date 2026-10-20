import React, { useEffect, useRef, useState } from 'react';
import { PhoneRemote } from './remote-transport.js';
import { QuestionAnswerForm, QuestionDraftContext, needsQuestionAnswer } from './QuestionCards.jsx';
import { AmbitionBar, FurtherActions } from './Ambition.jsx';
import PhoneNotebook from './PhoneNotebook.jsx';
import { phoneFollowupLabel } from '../desktop/phone-work.mjs';
import { phoneDraftKey, loadPhoneSession, savePhoneSession, clearPhoneSession } from './phone-session.js';

const emptyState = () => ({ conversations: [], approvals: [], activeRuns: [], queues: {} });
function tabStorage() { try { return globalThis.sessionStorage; } catch { return null; } }

export default function RemoteApp({ pairingLink }) {
  const remote = useRef(null), link = useRef(pairingLink), selected = useRef(null), refreshTimer = useRef(null);
  const alive = useRef(false), refreshing = useRef(null), refreshWanted = useRef(false), drafts = useRef({}), sessionDevice = useRef(null), actionLocked = useRef(false);
  const questionLocks = useRef(new Set());
  const [ready, setReady] = useState(false), [record, setRecord] = useState(null), [name, setName] = useState('My phone');
  const [state, setState] = useState(emptyState), [chat, setChat] = useState(null);
  const [draft, setDraft] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [online, setOnline] = useState(false);
  const [tab, setTab] = useState('chats'), [syncError, setSyncError] = useState(''), [lastSync, setLastSync] = useState(null), [notice, setNotice] = useState('');
  const [draftSaved, setDraftSaved] = useState(true), [questionDrafts, setQuestionDrafts] = useState({}), [followupMode, setFollowupMode] = useState('live');
  const [questionSending, setQuestionSending] = useState([]);
  function persistDrafts() {
    if (sessionDevice.current) setDraftSaved(savePhoneSession(tabStorage(), sessionDevice.current, selected.current, drafts.current));
  }
  function changeDraft(value) {
    const next = typeof value === 'function' ? value(drafts.current[phoneDraftKey(selected.current)] || '') : value;
    const key = phoneDraftKey(selected.current), updated = { ...drafts.current }; delete updated[key]; updated[key] = next;
    drafts.current = updated; setDraft(next); persistDrafts();
  }
  function clearLocal() {
    if (sessionDevice.current) clearPhoneSession(tabStorage(), sessionDevice.current);
    sessionDevice.current = null; selected.current = null; drafts.current = {}; refreshWanted.current = false;
    setRecord(null); setChat(null); setState(emptyState()); setDraft(''); setQuestionDrafts({}); setOnline(false); setLastSync(null); setNotice('');
  }
  async function refresh() {
    if (!remote.current?.record || remote.current.record.pending) return;
    refreshWanted.current = true;
    if (refreshing.current) return refreshing.current;
    refreshing.current = (async () => {
      while (refreshWanted.current && alive.current && remote.current.record) {
        refreshWanted.current = false;
        const device = remote.current.record.deviceId;
        try {
          if (!remote.current.running && !await remote.current.activate()) throw Error('Waiting for computer approval.');
          const next = await remote.current.invoke('bootstrap');
          if (!alive.current || remote.current.record?.deviceId !== device) return;
          setState(next); setOnline(true); setSyncError(''); setLastSync(Date.now());
          const id = selected.current;
          if (id && !next.conversations.some(item => item.id === id)) {
            selected.current = null; setChat(null); setDraft(drafts.current.$new || ''); persistDrafts();
            setError('This conversation is no longer available on your phone.');
          } else if (id) {
            try {
              const latest = await remote.current.invoke('conversations.get', { id });
              if (alive.current && remote.current.record?.deviceId === device && selected.current === id) setChat(latest);
            } catch (failure) {
              if (failure.code !== 'remote_refused') throw failure;
              if (alive.current && selected.current === id) {
                selected.current = null; setChat(null); setDraft(drafts.current.$new || ''); persistDrafts(); setError(failure.message);
              }
            }
          }
        } catch (failure) {
          if (!alive.current) return;
          setOnline(false); setSyncError(failure.message);
          if (!remote.current.record) clearLocal();
          // Retry reads on the next event, wake or interval. Actions are never replayed.
          refreshWanted.current = false;
        }
      }
    })();
    try { await refreshing.current; } finally { refreshing.current = null; }
  }
  useEffect(() => {
    let disposed = false; alive.current = true;
    try { remote.current = new PhoneRemote(); } catch (failure) { setError(failure.message); setReady(true); return; }
    const off = remote.current.onEvent(event => {
      if (event.type === 'remote.revoked') { clearLocal(); setError('This phone was removed. Pair again from your computer.'); return; }
      if (event.type === 'transport.offline') { setOnline(false); return; }
      if (event.type === 'transport.error') { setSyncError(event.error); return; }
      if (!refreshTimer.current) refreshTimer.current = setTimeout(() => { refreshTimer.current = null; refresh(); }, 500);
    });
    remote.current.init().then(async saved => {
      if (disposed) return;
      setRecord(saved);
      if (saved) {
        sessionDevice.current = saved.deviceId;
        const session = loadPhoneSession(tabStorage(), saved.deviceId);
        selected.current = session.selectedId; drafts.current = session.drafts; setDraft(session.drafts[phoneDraftKey(session.selectedId)] || '');
      }
      if (saved && !saved.pending && await remote.current.activate()) refresh();
    }).catch(failure => {setSyncError(failure.message);if(!remote.current.record)clearLocal();}).finally(() => setReady(true));
    navigator.serviceWorker?.getRegistrations().then(items => items.forEach(item => item.unregister())).catch(() => {});
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    const offline = () => setOnline(false);
    document.addEventListener('visibilitychange', visible);
    globalThis.addEventListener('online', visible); globalThis.addEventListener('offline', offline);
    const poll = setInterval(visible, 15000);
    return () => { disposed = true; alive.current = false; off(); remote.current?.stop(); clearTimeout(refreshTimer.current); clearInterval(poll); document.removeEventListener('visibilitychange', visible); globalThis.removeEventListener('online', visible); globalThis.removeEventListener('offline', offline); };
  }, []);
  useEffect(() => {
    if (!record?.pending) return;
    let checking = false, disposed = false;
    const check = async () => {
      if (checking) return; checking = true;
      try { if (await remote.current.activate() && !disposed) { setRecord(remote.current.record); refresh(); } }
      catch (failure) { if (!disposed) { setError(failure.message); if (!remote.current.record) clearLocal(); } }
      finally { checking = false; }
    };
    check(); const timer = setInterval(check, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [record?.pending]);
  async function perform(action) { if (actionLocked.current) return; actionLocked.current = true; setBusy(true); setError(''); setNotice(''); try { await action(); } catch (failure) { setError(failure.message); } finally { actionLocked.current = false; setBusy(false); } }
  async function pair() {
    if (!link.current) throw Error('Scan a new pairing code from Settings → Phone access on your computer.');
    try { const paired = await remote.current.pair(link.current, name); sessionDevice.current = paired.deviceId; setRecord(paired); }
    catch (failure) { if (failure.code === 'bad_ticket') throw Error('This code was used or expired. Do not approve a different phone on the computer; show a new QR code.'); throw failure; }
    finally { link.current = ''; }
  }
  async function openChat(id) {
    selected.current = id || null; setChat(null); setDraft(drafts.current[phoneDraftKey(id)] || ''); persistDrafts(); setTab('chats');
    await refresh();
  }
  async function forget() { await remote.current.forget(); clearLocal(); }
  async function questionAction(method, id, payload = {}) {
    if (questionLocks.current.has(id)) return;
    questionLocks.current.add(id); setQuestionSending([...questionLocks.current]);
    try { const result = await remote.current.invoke(method, { conversationId: chat.id, id, ...payload }); await refresh(); return result; }
    finally { questionLocks.current.delete(id); if (alive.current) setQuestionSending([...questionLocks.current]); }
  }
  const running = state.activeRuns.some(run => run.conversationId === chat?.id);
  const questions = chat?.pendingQuestions || (chat?.messages || []).flatMap(message => message.questions || []).filter(needsQuestionAnswer);
  const queued = state.queues?.[chat?.id] || [];
  const work = state.conversations.map(item => ({ ...item, run: state.activeRuns.find(run => run.conversationId === item.id), approvals: state.approvals.filter(approval => approval.conversationId === item.id).length, queued: state.queues?.[item.id]?.length || 0 }))
    .filter(item => item.run || item.approvals || item.queued || item.pendingQuestions || item.pendingFollowups || item.blockedFollowups)
    .sort((a, b) => Number(!!(b.approvals || b.pendingQuestions || b.blockedFollowups)) - Number(!!(a.approvals || a.pendingQuestions || a.blockedFollowups)) || Number(!!b.run) - Number(!!a.run));
  async function send() {
    const text = draft.trim(); if (!text) return;
    if (selected.current && chat?.id !== selected.current) throw Error('Wait for this conversation to load.');
    const key = phoneDraftKey(selected.current), sentDraft = draft;
    const result = await remote.current.invoke('chat.send', { ...(chat ? { conversationId: chat.id } : {}), text, provider: chat?.provider || state.settings?.provider, ...(running ? { followupMode } : {}) });
    if (drafts.current[key] === sentDraft) delete drafts.current[key];
    else if (!selected.current && drafts.current[key]) { drafts.current[result.conversationId] = drafts.current[key]; delete drafts.current[key]; }
    selected.current = result.conversationId; setDraft(drafts.current[phoneDraftKey(selected.current)] || ''); persistDrafts();
    setNotice(result.queued ? 'Message queued after the current reply.' : result.followup ? 'Follow-up accepted. Its answer and task status appear below.' : 'Message accepted by your computer.');
    await refresh();
  }
  const questionSession = { drafts: questionDrafts, sending: questionSending, change: (id, update, initial) => setQuestionDrafts(previous => ({ ...previous, [id]: update(previous[id] || initial) })) };
  return <QuestionDraftContext.Provider value={questionSession}><main className="phone-app"><header><strong>Exomina <small>on your computer</small></strong>{record && !record.pending && <span role="status">{online ? 'Computer connected' : 'Computer not responding'}</span>}</header>
    {error && <div className="phone-error" role="alert">{error}</div>}
    {syncError && <div className="phone-error" role="alert">{syncError}</div>}
    {notice && <p className="phone-draft-status" role="status">{notice}</p>}
    {!ready ? <p>Opening private phone access…</p> : !record ? <section className="phone-card"><h1>Pair with your computer</h1><p>In Exomina, open Settings → Connections &amp; sync → Phone access. Connect your private relay, turn on phone control and scan its QR code.</p><label>Name this phone<input aria-label="Phone name" value={name} maxLength={60} onChange={e => setName(e.target.value)}/></label><button className="primary-button" disabled={busy || !link.current} onClick={() => perform(pair)}>Pair this phone</button><p>Use a relay you control. The site operator can change the code running on this phone. Device keys stay in this browser; clearing its storage removes this pairing.</p></section> : record.pending ? <section className="phone-card"><h1>Confirm on your computer</h1><p>Compare this code with the one shown next to your phone’s name:</p><strong className="phone-confirmation">{record.confirmation}</strong><p>Approve only if both codes match. This phone cannot access chats until you approve it there.</p><button disabled={busy} onClick={() => perform(forget)}>Cancel pairing</button></section> : <>
      <nav className="phone-tabs" aria-label="Phone sections">{['chats', 'work', 'notes', 'usage'].map(value => <button key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}>{value[0].toUpperCase() + value.slice(1)}{value === 'work' && work.length > 0 ? ` (${work.length})` : ''}</button>)}<button onClick={() => refresh()}>Refresh</button></nav>
      {lastSync && <p className="phone-sync-time">{online ? 'Updated' : 'Showing the last update from'} {new Date(lastSync).toLocaleTimeString()}{!online && '. Reconnecting when this phone is online. Your computer must stay awake.'}</p>}
      {tab === 'work' && <section className="phone-work" aria-label="Work on your computer"><h1>Work on your computer</h1><p>{state.activeRuns.length} running · {state.approvals.length} approvals · {state.conversations.reduce((sum, item) => sum + (item.pendingQuestions || 0), 0)} questions</p>{!work.length && <p>No running tasks or saved requests needing attention.</p>}{work.map(item => <article className="phone-card" key={item.id}><h2>{item.title || 'Untitled chat'}</h2><p>{[item.run && 'Running', item.approvals > 0 && `${item.approvals} approval${item.approvals === 1 ? '' : 's'}`, item.pendingQuestions > 0 && `${item.pendingQuestions} question${item.pendingQuestions === 1 ? '' : 's'} awaiting your answer`, item.queued > 0 && `${item.queued} message${item.queued === 1 ? '' : 's'} queued`, item.pendingFollowups > 0 && `${item.pendingFollowups} follow-up${item.pendingFollowups === 1 ? '' : 's'} with the task`, item.blockedFollowups > 0 && `${item.blockedFollowups} follow-up${item.blockedFollowups === 1 ? '' : 's'} needing attention`].filter(Boolean).join(' · ')}</p><button disabled={busy || !online} aria-label={'Open task: ' + (item.title || 'Untitled chat')} onClick={() => perform(() => openChat(item.id))}>Open task</button></article>)}</section>}
      {state.approvals.map(approval => <section className="phone-card phone-approval" key={approval.id}><h2>{approval.explain?.headline || approval.title || 'Approval needed'}</h2><p>{typeof approval.explain === 'string' ? approval.explain : [approval.explain?.action, approval.explain?.reason, approval.explain?.why].filter(Boolean).join(' ')}</p><pre>{[approval.tool, approval.target, approval.detail].filter(Boolean).join('\n\n')}</pre>{approval.desktopOnly ? <p>Approve this change on your computer; its full preview is unavailable here.</p> : <button className="primary-button" disabled={busy || !online} onClick={() => perform(async () => { await remote.current.invoke('approval.respond', { id: approval.id, digest: approval.digest, decision: 'once' }); await refresh(); })}>Allow once</button>}<button disabled={busy || !online} onClick={() => perform(async () => { await remote.current.invoke('approval.respond', { id: approval.id, digest: approval.digest, decision: 'deny' }); await refresh(); })}>Deny</button></section>)}
      {tab === 'chats' && <><div className="phone-chat-select"><label>Conversation<select aria-label="Conversation" disabled={busy} value={selected.current || ''} onChange={e => { const id = e.target.value; perform(() => openChat(id)); }}><option value="">New chat</option>{state.conversations.map(item => <option value={item.id} key={item.id}>{item.title || 'Untitled chat'}</option>)}</select></label></div>
        {selected.current && !chat && <p role="status">Loading conversation…</p>}
        {chat?.earlierOmitted > 0 && <p className="phone-history-limit">Showing recent messages; {chat.earlierOmitted} earlier messages remain on your computer.</p>}
        {queued.length > 0 && <section className="phone-card" aria-label="Messages waiting for the reply"><h2>Waiting for the current reply</h2>{queued.map(item => <p key={item.id}>{item.text}</p>)}</section>}
        <div className="phone-messages" aria-live="polite">{(chat?.messages || []).map((message, index) => <article key={message.id || index} className={'phone-message ' + message.role}><strong>{message.role === 'user' ? 'You' : 'Exomina'}</strong><p>{message.content || (running && index === chat.messages.length - 1 ? 'Working on your computer…' : '')}</p>{message.activity?.length > 0 && <details><summary>Work details</summary><pre>{message.activity.map(item => [item.title || item.kind, item.status, item.output || item.text || ''].join('\n')).join('\n\n')}</pre></details>}{message.followups?.length > 0 && <section aria-label="Follow-ups during this task">{message.followups.map(item => <div className="phone-followup" key={item.id}><strong>{item.text || 'Follow-up'}</strong><p className="phone-followup-status">{phoneFollowupLabel(item)}</p>{item.summary && <p>{item.summary}</p>}{item.answer && (item.summary ? <details><summary>Earlier answer while work continued</summary><p>{item.answer}</p></details> : <p>{item.answer}</p>)}{item.error && item.taskStatus !== 'handled' && <p className="phone-error">{item.error}</p>}</div>)}</section>}</article>)}</div>
        {chat?.pendingQuestionsOmitted > 0 && <p>{chat.pendingQuestionsOmitted} more questions need reviewing on your computer.</p>}
        {questions.map(group => <section key={group.id} className="phone-card"><QuestionAnswerForm group={group} onAnswer={online ? (id, answers) => questionAction('chat.question.answer', id, { answers }) : undefined} onContinue={online ? id => questionAction('chat.question.continue', id) : undefined}/></section>)}
        {chat?.messages?.at(-1)?.role === 'assistant' && !running && <FurtherActions onPick={text => { if (!actionLocked.current) changeDraft(value => value.trim() ? value + '\n\n' + text : text); }}/ >}
        <form className="phone-composer" onSubmit={e => { e.preventDefault(); perform(send); }}><AmbitionBar draft={draft} onChange={changeDraft} disabled={busy}/><textarea aria-label="Message" rows={3} maxLength={100000} readOnly={busy} placeholder={running ? 'Ask a question while work continues…' : 'What do you want to get done?'} value={draft} onChange={e => changeDraft(e.target.value)}/>{draft && <p className="phone-note-hint">{draftSaved ? 'Draft kept in this phone tab, including after a reload.' : 'Tab storage is unavailable. Keep this page open to retain your draft.'}</p>}{running && <label>Send during work<select aria-label="Send during work" value={followupMode} onChange={e => setFollowupMode(e.target.value)} disabled={busy}><option value="live">Join the current task</option><option value="queue">Wait until this reply finishes</option></select></label>}<div><button className="primary-button" disabled={busy || !online || !draft.trim() || !!selected.current && chat?.id !== selected.current}>Send message</button>{running && <button type="button" disabled={busy || !online} onClick={() => perform(async () => { await remote.current.invoke('chat.cancel', { conversationId: chat.id }); await refresh(); })}>Stop reply</button>}</div></form></>}
      <PhoneNotebook remote={remote.current} active={tab==='notes'} online={online} onUse={text=>{if(actionLocked.current)return;changeDraft(current=>current.trim()?current+'\n\n'+text:text);setTab('chats');setTimeout(()=>document.querySelector('.phone-composer textarea')?.focus(),0);}}/>
      {tab === 'usage' && <section className="phone-card"><h1>Usage</h1><p>Reported by your computer. Reset credits and billing changes stay on the computer.</p>{Object.entries(state.usage || {}).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value)).map(([provider, value]) => <div key={provider}><h2>{state.providers?.find(p => p.id === provider)?.name || provider}</h2>{value.windows?.length ? value.windows.map(window => <p key={window.id}>{window.label}: {Number.isFinite(window.usedPercent) ? Math.round(window.usedPercent) + '% used' : 'usage unknown'}{window.resetsAt ? ' · resets ' + new Date(window.resetsAt).toLocaleString() : ''}</p>) : <p>No current usage estimate reported.</p>}</div>)}</section>}
      <footer><p>Tools run on your computer with its existing permissions. It must remain awake. After a lost reply, check Work and your conversation before retrying.</p><button disabled={busy} onClick={() => perform(forget)}>Forget this phone</button><p>This also clears chat drafts from this tab. To revoke access, remove this phone in your computer’s Settings.</p></footer>
    </>}
  </main></QuestionDraftContext.Provider>;
}
