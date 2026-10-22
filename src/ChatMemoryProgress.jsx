import React, { useEffect, useRef, useState } from 'react';
import { api } from './transport.js';
import './chat-memory-progress.css';

const number = value => Number(value || 0).toLocaleString();
export default function ChatMemoryProgress() {
  const [view, setView] = useState(null), [error, setError] = useState('');
  const [state, setState] = useState('saved'), [chatId, setChatId] = useState(''), [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  // First reading while this view is open; totals alone cannot show whether work is moving.
  const baseline = useRef(null);
  useEffect(() => {
    let disposed = false, loading = false;
    const load = async () => {
      if (loading) return; loading = true;
      try {
        const next = await api.invoke('chatMemory.progress', { state, chatId: chatId || null, offset, limit: 20 });
        if (!disposed) { setView(next); setError(''); }
      } catch (problem) { if (!disposed) setError(problem?.message || String(problem)); }
      finally { loading = false; }
    };
    setView(null); load(); const timer = setInterval(load, 10000);
    return () => { disposed = true; clearInterval(timer); };
  }, [state, chatId, offset, refresh]);
  const totals = view?.totals;
  if (totals && !baseline.current) baseline.current = { at: Date.now(), saved: totals.savedCatchUp };
  const minutes = totals ? Math.floor((Date.now() - baseline.current.at) / 60000) : 0;
  const recent = totals ? Math.max(0, totals.savedCatchUp - baseline.current.saved) : 0;
  return <section className="chat-memory-progress" aria-label="Catch-up progress">
    <div className="chat-memory-progress-heading"><h3>Catch-up progress</h3><button onClick={() => setRefresh(value => value + 1)}>Refresh progress</button></div>
    {error && <p role="alert">Progress unavailable: {error}</p>}
    {!view && !error && <p role="status">Loading saved summaries and pending work…</p>}
    {totals && <>
      <div className="chat-memory-progress-totals" aria-live="polite">
        <span><strong>{number(totals.pending)}</strong> pending</span>
        <span><strong>{number(totals.saved)}</strong> saved summaries</span>
        <span><strong>{number(totals.savedCatchUp)}</strong> saved by catch-up since tracking began</span>
        <span>{number(totals.running)} running · {number(totals.failed)} waiting after failure</span>
        {minutes >= 1 && <span><strong>+{number(recent)}</strong> saved by catch-up in the last {number(minutes)} min</span>}
      </div>
      <p className="settings-help">Counts come from saved memory, across your chats, and survive restarts. Earlier saved summaries include on-demand compression; their origin and save time were not recorded. New parent summaries can add pending work as catch-up progresses. Updates every 10 seconds while this view is open.</p>
      <details><summary>Progress by chat</summary><div className="chat-memory-progress-table"><table><thead><tr><th>Chat</th><th>Pending</th><th>Saved</th><th>Catch-up saved</th></tr></thead><tbody>{view.chats.map(chat => <tr key={chat.chatId}><td><button onClick={() => { setChatId(chat.chatId); setOffset(0); }}>{chat.title}</button></td><td>{number(chat.pending)}</td><td>{number(chat.saved)}</td><td>{number(chat.savedCatchUp)}</td></tr>)}</tbody></table></div></details>
      <div className="chat-memory-progress-filters">
        <label>Show <select aria-label="Summary progress filter" value={state} onChange={event => { setState(event.target.value); setOffset(0); }}><option value="saved">All saved summaries</option><option value="catchup">Saved by catch-up</option><option value="pending">Pending summaries</option></select></label>
        <label>Chat <select aria-label="Summary progress chat" value={chatId} onChange={event => { setChatId(event.target.value); setOffset(0); }}><option value="">All chats</option>{view.chats.map(chat => <option key={chat.chatId} value={chat.chatId}>{chat.title}</option>)}</select></label>
      </div>
      <p>{number(view.total)} matching {state === 'pending' ? 'pending entries' : 'saved summaries'}</p>
      <ol className="chat-memory-progress-entries" aria-label="Summary entries">{view.entries.map(entry => <li key={`${entry.chatId}:${entry.id}:${entry.count}`}>
        <strong>{entry.title}</strong><span> · Records {entry.id}{entry.count > 1 ? `–${entry.id + entry.count - 1}` : ''}</span>
        {state === 'pending' ? <p>{entry.state === 'ready' ? 'Pending' : entry.state === 'running' ? 'Running' : 'Waiting after failure'} · {number(entry.attempts)} job attempts</p> : <><p>{entry.text}</p><small>{entry.savedAt ? `${entry.origin === 'catchup' ? 'Saved by catch-up' : 'Saved on demand'} · ${new Date(entry.savedAt).toLocaleString()} · ${entry.model}` : 'Earlier saved summary · origin and save time not recorded'}</small></>}
      </li>)}</ol>
      {!view.entries.length && <p>No {state === 'pending' ? 'pending entries' : 'saved summaries'} for this selection.</p>}
      <div className="chat-memory-progress-pagination"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous summaries</button><span>{view.total ? `${offset + 1}–${offset + view.entries.length} of ${number(view.total)}` : '0 entries'}</span><button disabled={view.nextOffset === null} onClick={() => setOffset(view.nextOffset)}>Next summaries</button></div>
    </>}
  </section>;
}
