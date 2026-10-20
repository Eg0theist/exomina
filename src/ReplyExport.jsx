import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { replyExportInfo } from '../desktop/reply-export.mjs';
import { api } from './transport.js';
import useDismiss from './useDismiss.js';
import './reply-export.css';

export default function ReplyExport({ text }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [result, setResult] = useState(''), [error, setError] = useState('');
  const [position, setPosition] = useState(null);
  const area = useRef(null), menu = useRef(null), trigger = useRef(null), alive = useRef(true), pending = useRef(false);
  const reasonId = useId();
  const info = useMemo(() => replyExportInfo(text), [text]);
  const ownsFocus = element => area.current?.contains(element) || menu.current?.contains(element);
  useDismiss(area, open, () => { setOpen(false); if (ownsFocus(document.activeElement)) trigger.current?.focus({ preventScroll: true }); }, { ignore: menu });
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(); if (!anchor || !menu.current) return;
      const pane = trigger.current.closest('.chat-scroll')?.getBoundingClientRect();
      const leftEdge = Math.max(16, (pane?.left || 0) + 8), rightEdge = Math.min(innerWidth - 16, pane?.right || innerWidth - 8);
      const width = Math.max(1, Math.min(284, rightEdge - leftEdge)), height = Math.min(menu.current.getBoundingClientRect().height || menu.current.scrollHeight, innerHeight - 32);
      const desiredTop = innerHeight - anchor.bottom - 16 >= height ? anchor.bottom + 8 : anchor.top - height - 8;
      const next = { width, left: Math.max(leftEdge, Math.min(anchor.left, rightEdge - width)), top: Math.max(16, Math.min(desiredTop, innerHeight - height - 16)), maxHeight: innerHeight - 32 };
      setPosition(previous => previous && Object.keys(next).every(key => previous[key] === next[key]) ? previous : next);
    };
    place(); const observer = new ResizeObserver(place); observer.observe(menu.current); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => { if (open && position) menu.current?.querySelector('[role="menuitem"]')?.focus(); }, [open, !!position]);
  async function save(format) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setResult(''); setOpen(false);
    try {
      const saved = await api.invoke('reply.export', { text, format });
      if (alive.current && saved?.path) setResult(saved.path);
    } catch (failure) { if (alive.current) setError(String(failure.message || failure).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { pending.current = false; if (alive.current) { setBusy(false); trigger.current?.focus({ preventScroll: true }); } }
  }
  return <span className="reply-export" ref={area} onBlur={event => { if (!ownsFocus(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (event.key === 'Tab' && open) { setOpen(false); trigger.current?.focus(); return; }
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const items = [...menu.current.querySelectorAll('[role="menuitem"]')], current = items.indexOf(document.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[index]?.focus();
    }
  }}>
    <button ref={trigger} className="copy-button" type="button" aria-label="Save reply as a file" aria-describedby={!info.available ? reasonId : undefined} title="Save this reply as Word, Excel, Markdown or text" aria-haspopup="menu" aria-expanded={open} aria-disabled={busy || !info.available} disabled={busy} onClick={() => { if (!info.available) return; setError(''); setOpen(value => !value); }}><Download size={13}/><span>{busy ? 'Saving…' : 'Save reply'}</span></button>
    {open && createPortal(<span ref={menu} style={position || { visibility: 'hidden' }} className="popover reply-export-menu" role="menu" aria-label="Reply file format">
      <button type="button" role="menuitem" onClick={() => save('docx')}><FileText size={16}/><span><strong>Word document</strong><small>Formatted reply · .docx</small></span></button>
      <button type="button" role="menuitem" aria-disabled={!info.tables} onClick={() => { if (info.tables) save('xlsx'); }}><FileSpreadsheet size={16}/><span><strong>Excel workbook</strong><small>{info.tables ? `${info.tables} ${info.tables === 1 ? 'table' : 'tables'} · one sheet each · .xlsx` : 'Ask for a table in the reply first'}</small></span></button>
      <button type="button" role="menuitem" onClick={() => save('md')}><FileText size={16}/><span><strong>Markdown</strong><small>Keep the original formatting · .md</small></span></button>
      <button type="button" role="menuitem" onClick={() => save('txt')}><FileText size={16}/><span><strong>Plain text</strong><small>Readable text · .txt</small></span></button>
      <span className="reply-export-note">Reply text only; attachments stay in chat. Excel exports values, without formulas. Numbers with units or special formatting may remain text.</span>
    </span>, document.body)}
    {result && <span className="reply-export-status" role="status" title={result}>Saved</span>}
    {!info.available && info.reason && <span id={reasonId} className="reply-export-status">{info.reason}</span>}
    {error && <span className="reply-export-error" role="alert">{error}</span>}
  </span>;
}
