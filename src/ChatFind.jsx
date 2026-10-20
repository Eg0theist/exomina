import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { findChatMatches } from './chat-search.js';
import './ChatFind.css';

export default function ChatFind({ messages, query, onQuery, onHit, onClose }) {
  const inputId = useId(), input = useRef(null), hitCallback = useRef(onHit);
  const [selection, setSelection] = useState({ query: '', index: 0 });
  const matches = useMemo(() => findChatMatches({ messages: messages || [] }, query), [messages, query]);
  const index = selection.query === query ? Math.min(selection.index, Math.max(0, matches.length - 1)) : 0;
  const current = matches[index];
  hitCallback.current = onHit;

  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => { setSelection({ query, index: 0 }); }, [query]);
  useEffect(() => {
    if (current) hitCallback.current?.({ ...current, matchIndex: index, total: matches.length });
    // Coordinates, rather than the caller's array/callback identity, prevent
    // repeated scrolling when an unrelated parent state changes.
  }, [query, index, current?.messageIndex, current?.start, current?.end]);

  function move(direction) {
    if (!matches.length) return;
    const next = (index + direction + matches.length) % matches.length;
    if (next === index) hitCallback.current?.({ ...matches[next], matchIndex: next, total: matches.length });
    else setSelection({ query, index: next });
  }
  const count = !query.trim() ? 'Type to find' : matches.length ? `${index + 1} of ${matches.length}${matches.truncated ? '+' : ''}` : 'No matches';
  return <form className="chat-find-bar" role="search" aria-label="Find in current chat" onSubmit={event => { event.preventDefault(); move(1); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <Search size={16} aria-hidden="true" />
    <label className="chat-find-label" htmlFor={inputId}>Find in this chat</label>
    <input ref={input} id={inputId} type="search" value={query} onChange={event => onQuery(event.target.value)} maxLength={1000} placeholder="Find in this chat…" autoComplete="off" spellCheck={false} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1); }
    }} />
    <span className={`chat-find-count${query.trim() && !matches.length ? ' empty' : ''}`} aria-live="polite" aria-atomic="true">{count}</span>
    <div className="chat-find-actions">
      <button type="button" className="icon-button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => move(-1)}><ChevronUp size={17} /></button>
      <button type="button" className="icon-button" aria-label="Next match" title="Next match (Enter)" disabled={!matches.length} onClick={() => move(1)}><ChevronDown size={17} /></button>
      <button type="button" className="icon-button" aria-label="Close chat search" title="Close search (Escape)" onClick={onClose}><X size={17} /></button>
    </div>
  </form>;
}
