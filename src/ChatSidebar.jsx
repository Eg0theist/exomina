import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, ArrowUp, ArrowDown, Check, GripVertical, LoaderCircle, MoreHorizontal, Pencil, Pin, PinOff, Search, Sparkles, Trash2, X } from 'lucide-react';
import './chat-sidebar.css';
import { findTextMatches, searchChats } from './chat-search.js';
import { compareChats } from '../desktop/chat-management.mjs';
import {sidebarWindow,SIDEBAR_PAGE_SIZE} from './sidebar-window.js';

const titleOf = chat => chat.title || 'New chat';
const normalTitle = value => value.trim().replace(/\s+/g, ' ');
const DAY = 86400000;
function dateBucket(value, now = new Date()) {
  const time = new Date(value || 0).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= today) return 'TODAY';
  if (time >= today - DAY) return 'YESTERDAY';
  if (time >= today - 6 * DAY) return 'PREVIOUS 7 DAYS';
  if (time >= today - 29 * DAY) return 'PREVIOUS 30 DAYS';
  return 'OLDER';
}
function MatchText({ text, query }) {
  const hit = findTextMatches(text, query, 1)[0];
  if (!hit) return text;
  return <>{text.slice(0, hit.start)}<mark>{text.slice(hit.start, hit.end)}</mark>{text.slice(hit.end)}</>;
}

export default function ChatSidebar({ conversations, selectedId, activeIds = [], unreadIds = [], titlesPending = [], onSelect, onUpdate, onRetitle, onDelete, onModalChange }) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('active');
  const [rowLimit,setRowLimit]=useState(SIDEBAR_PAGE_SIZE);
  const [menu, setMenu] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [draggedId, setDraggedId] = useState(null);
  const [dropHint, setDropHint] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const dragRef = useRef(null);
  const movingRef = useRef(false);
  const searchRef = useRef(null);
  const titleRef = useRef(null);
  const areaRef = useRef(null);
  const term = query.trim();
  const sorted = useMemo(() => [...conversations].sort(compareChats), [conversations]);
  const scoped = useMemo(() => sorted.filter(chat => scope === 'all' || !!chat.archived === (scope === 'archived')), [sorted, scope]);
  const pinned = useMemo(() => scoped.filter(chat => chat.pinned), [scoped]);
  const windowed=useMemo(()=>sidebarWindow(scoped,rowLimit,selectedId),[scoped,rowLimit,selectedId]);
  useEffect(()=>setRowLimit(SIDEBAR_PAGE_SIZE),[scope,term]);
  // Search always covers archived chats too; their rows carry the archive icon.
  const hits = useMemo(() => searchChats(sorted, { query: term, scope: 'all', limit: 100 }), [sorted, term]);
  const groups = useMemo(() => {
    if (term) return [];
    const result = [];
    if (scope === 'archived') return [...result, { label: 'ARCHIVED', chats: windowed.chats }];
    for (const chat of windowed.chats) {
      const label = dateBucket(chat.updatedAt);
      const group = result.find(item => item.label === label) || result[result.push({ label, chats: [] }) - 1];
      group.chats.push(chat);
    }
    return result;
  }, [term, windowed, scope]);

  useEffect(() => { onModalChange?.(!!renaming); return () => onModalChange?.(false); }, [!!renaming, onModalChange]);
  useEffect(() => { if (renaming) { titleRef.current?.focus(); titleRef.current?.select(); } }, [renaming]);
  useEffect(() => {
    const outside = event => { if (!areaRef.current?.contains(event.target)) setMenu(null); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);

  async function update(method, payload) {
    if (movingRef.current) return false;
    movingRef.current = true;
    setPending(true); setError('');
    try { await onUpdate(method, payload); setMenu(null); return true; }
    catch (failure) { setError(failure.message || String(failure)); return false; }
    finally { movingRef.current = false; setPending(false); }
  }
  async function rename(event) {
    event.preventDefault();
    if (!normalTitle(title)) { setError('Enter a name for this chat.'); return; }
    if (await update('conversations.rename', { id: renaming.id, title: normalTitle(title) })) setRenaming(null);
  }
  async function retitle(chat) {
    setPending(true); setError('');
    try { await onRetitle(chat); setMenu(null); }
    catch (failure) { setError(failure.message || String(failure)); }
    finally { setPending(false); }
  }
  function openRename(chat) { setMenu(null); setError(''); setTitle(titleOf(chat)); setRenaming(chat); }
  function clearDrag() { dragRef.current = null; setDraggedId(null); setDropHint(null); }
  function dragTarget(event, chat) {
    const source = pinned.find(item => item.id === dragRef.current);
    if (pending || term || !source || !chat.pinned || source.id === chat.id || !!source.archived !== !!chat.archived) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    return { id: source.id, targetId: chat.id, placement: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' };
  }
  async function movePin(chat, payload, focusedHandle) {
    const list = pinned.filter(item => !!item.archived === !!chat.archived);
    if (payload.direction && !list[list.indexOf(chat) + (payload.direction === 'up' ? -1 : 1)]) return;
    if (await update('conversations.movePinned', { id: chat.id, ...payload })) {
      setAnnouncement(`Moved ${titleOf(chat)} ${payload.direction || payload.placement + ' ' + titleOf(pinned.find(item => item.id === payload.targetId))}.`);
      if (focusedHandle) requestAnimationFrame(() => {
        // Moving a keyed row can blur its button. Keep keyboard focus with that chat.
        if (document.activeElement !== document.body && document.activeElement !== focusedHandle) return;
        const entry = [...(areaRef.current?.querySelectorAll('[data-chat-id]') || [])].find(item => item.dataset.chatId === chat.id);
        entry?.querySelector('.chat-drag-handle')?.focus();
      });
    }
  }
  function row(chat, hit) {
    const isActive = activeIds.includes(chat.id);
    const reorderable = chat.pinned && !term;
    return <div className={`chat-list-entry ${selectedId === chat.id ? 'selected' : ''} ${draggedId === chat.id ? 'is-dragging' : ''} ${dropHint?.targetId === chat.id ? 'drop-' + dropHint.placement : ''}`} key={chat.id} data-chat-id={chat.id}
      onDragOver={event => { const target = dragTarget(event, chat); if (target) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropHint(target); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropHint(current => current?.targetId === chat.id ? null : current); }}
      onDrop={event => { const target = dragTarget(event, chat); if (!target) return; event.preventDefault(); event.stopPropagation(); const source = pinned.find(item => item.id === target.id); clearDrag(); movePin(source, target); }}>
      <div className="chat-list-row">{reorderable && <button className="chat-drag-handle" aria-label={`Reorder ${titleOf(chat)}`} aria-describedby="pinned-reorder-help" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" aria-haspopup="menu" aria-expanded={menu === chat.id} aria-controls={menu === chat.id ? `chat-menu-${chat.id}` : undefined} title="Drag to reorder, or use Alt+Up / Alt+Down" disabled={pending} draggable={!pending}
        onClick={() => { setError(''); setMenu(menu === chat.id ? null : chat.id); }}
        onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); movePin(chat, { direction: event.key === 'ArrowUp' ? 'up' : 'down' }, event.currentTarget); } }}
        onDragStart={event => { if (pending) { event.preventDefault(); return; } dragRef.current = chat.id; setDraggedId(chat.id); setMenu(null); setDropHint(null); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-exomina-pinned-chat', chat.id); }} onDragEnd={clearDrag}><GripVertical size={14} /></button>}<button className="chat-open" onClick={() => { setMenu(null); onSelect(chat, Number.isInteger(hit?.messageIndex) ? { messageIndex: hit.messageIndex, query: term } : null); }} title={titleOf(chat)}>{/* Replying: a pulse. Finished while you were elsewhere: unread. Otherwise nothing. */}<span className={`chat-state ${isActive ? 'replying' : unreadIds.includes(chat.id) ? 'unread' : ''}`} aria-label={isActive ? 'Replying' : unreadIds.includes(chat.id) ? 'New reply' : undefined} /><span className="chat-row-text"><strong className={titlesPending.includes(chat.id) ? 'is-naming' : undefined}><MatchText text={titleOf(chat)} query={term} /></strong>{hit?.snippet && <span className="chat-search-snippet"><MatchText text={hit.snippet} query={term} /></span>}</span>{chat.archived && <Archive size={11} className="chat-archived-icon" aria-label="Archived" />}</button><button className="chat-more" aria-label={`More options for ${titleOf(chat)}`} aria-expanded={menu === chat.id} aria-controls={menu === chat.id ? `chat-menu-${chat.id}` : undefined} onClick={() => { setError(''); setMenu(menu === chat.id ? null : chat.id); }}><MoreHorizontal size={16} /></button></div>
      {menu === chat.id && <div className="chat-actions-menu" id={`chat-menu-${chat.id}`} role="menu" aria-label={`Options for ${titleOf(chat)}`}>
        <button role="menuitem" onClick={() => openRename(chat)}><Pencil size={13} />Rename</button>
        {onRetitle && <button role="menuitem" disabled={pending || isActive || titlesPending.includes(chat.id)} onClick={() => retitle(chat)}><Sparkles size={13} />Generate title</button>}
        <button role="menuitem" disabled={pending} onClick={() => update('conversations.pin', { id: chat.id, pinned: !chat.pinned })}>{chat.pinned ? <PinOff size={13} /> : <Pin size={13} />}{chat.pinned ? 'Unpin' : 'Pin'}</button>
        {chat.pinned && ['up', 'down'].map(direction => <button key={direction} role="menuitem" disabled={pending || (direction === 'up' ? pinned[0]?.id === chat.id : pinned.at(-1)?.id === chat.id)} onClick={() => movePin(chat, {direction})}>{direction === 'up' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}Move {direction}</button>)}
        <button role="menuitem" disabled={pending || (isActive && !chat.archived)} title={isActive && !chat.archived ? 'Stop this chat before archiving it.' : undefined} onClick={() => update('conversations.archive', { id: chat.id, archived: !chat.archived })}>{chat.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}{chat.archived ? 'Restore' : 'Archive'}</button>
        <button role="menuitem" className="chat-delete-action" disabled={isActive || pending} onClick={() => { setMenu(null); onDelete(chat); }}><Trash2 size={13} />Delete</button>
      </div>}
    </div>;
  }
  return <section className="chat-sidebar" aria-label="Your chats" ref={areaRef} onKeyDown={event => { if (event.key === 'Escape') { setMenu(null); if (renaming && !pending) setRenaming(null); else if (query) { setQuery(''); searchRef.current?.focus(); } } }}>
    <span className="chat-reorder-help" id="pinned-reorder-help">Drag to reorder pinned chats. Use Alt+Up or Alt+Down, or open chat options for Move up and Move down.</span>
    <span className="chat-reorder-help" role="status" aria-live="polite">{announcement}</span>
    <div className="chat-search-row"><div className="chat-search-field"><Search size={14} /><input ref={searchRef} type="search" maxLength={1000} value={query} onChange={event => { setQuery(event.target.value); setMenu(null); }} placeholder="Search chats…" aria-label="Search chats" />{query && <button aria-label="Clear chat search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={13} /></button>}</div>
    <button type="button" className="chat-archive-toggle" aria-label="Show archived chats" aria-pressed={scope === 'archived'} title={scope === 'archived' ? 'Back to recent chats' : 'Show archived chats'} onClick={() => { setScope(scope === 'archived' ? 'active' : 'archived'); setMenu(null); }}><Archive size={14} /></button></div>
    {error && !renaming && <p className="chat-list-error" role="alert">{error}</p>}
    {!term && pinned.length > 0 && <div className="chat-pinned-section" role="region" aria-label="Pinned chats"><div className="chat-group-heading"><Pin size={10} />PINNED</div><div className="chat-pinned-list">{pinned.map(chat => row(chat))}</div></div>}
    <div className="chat-list-scroll" role="region" aria-label={term ? 'Chat search results' : 'Recent chats'}>{term ? <div className="chat-search-results"><div className="chat-group-heading" role="status">{hits.length}{hits.truncated ? '+' : ''} {hits.length === 1 ? 'RESULT' : 'RESULTS'}</div>{hits.map(hit => row(hit.chat, hit))}{!hits.length && <p className="recent-empty">No matching chats. Try another phrase.</p>}</div> : scoped.length ? <>{groups.filter(group => group.chats.length).map(group => <div className="chat-list-group" key={group.label}><div className="chat-group-heading">{group.label}</div>{group.chats.map(chat => row(chat))}</div>)}{windowed.remaining>0&&<button type="button" className="text-button chat-show-more" onClick={()=>setRowLimit(n=>n+SIDEBAR_PAGE_SIZE)}>Show more chats ({windowed.remaining} more)</button>}</> : <p className="recent-empty">{scope === 'archived' ? 'No archived chats.' : 'Your chats will appear here.'}</p>}</div>
    {renaming && createPortal(<div className="modal-backdrop"><section className="modal chat-rename-modal" role="dialog" aria-modal="true" aria-labelledby="rename-chat-title" onKeyDown={event => { if (event.key === 'Escape' && !pending) setRenaming(null); }}><button className="modal-close icon-button" aria-label="Close rename" disabled={pending} onClick={() => setRenaming(null)}><X size={18} /></button><div className="modal-icon"><Pencil size={21} /></div><h2 id="rename-chat-title">Rename chat</h2><form onSubmit={rename}><label className="input-label" htmlFor="chat-title">Chat name</label><input id="chat-title" ref={titleRef} value={title} maxLength={80} onChange={event => { setTitle(event.target.value); setError(''); }} disabled={pending} autoComplete="off" />{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button className="secondary-button" type="button" disabled={pending} onClick={() => setRenaming(null)}>Cancel</button><button className="primary-button" disabled={pending}>{pending ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Save name</button></div></form></section></div>, document.body)}
  </section>;
}
