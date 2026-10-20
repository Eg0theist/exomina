import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, HardDrive, LoaderCircle, Trash2 } from 'lucide-react';
import './memory-notes.css';
import SelectableText from './SelectableText.jsx';

const PAGE_SIZE = 12;
const preview = text => String(text || '').replace(/\s+/g, ' ').trim() || 'Empty note';

/** Presentation only: notes and review state still come from the existing memory APIs. */
export default function MemoryNotes({ memories, busyAction, searching, isWeb, dateLabel, byteCount, onReview, onDelete }) {
  const [page, setPage] = useState(0), [expanded, setExpanded] = useState(null);
  const area = useRef(null), previousPage = useRef(0), detailId = useId();
  const pages = Math.max(1, Math.ceil(memories.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const start = currentPage * PAGE_SIZE, visible = memories.slice(start, start + PAGE_SIZE);
  const newIds = visible.filter(memory => memory.reviewed === false && memory.id).map(memory => memory.id);
  const busy = !!busyAction || searching;
  useLayoutEffect(() => {
    if (page !== currentPage) setPage(currentPage);
    if (previousPage.current !== currentPage) {
      previousPage.current = currentPage;
      area.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [currentPage, page]);
  function move(next) { setExpanded(null); setPage(Math.max(0, Math.min(pages - 1, next))); }
  return <section className="memory-notes" aria-label="Saved memory notes" aria-busy={searching} ref={area}>
    <div className="memory-notes-heading">
      <span className="memory-note-range" role="status">{start + 1}–{start + visible.length} of {memories.length} {memories.length === 1 ? 'note' : 'notes'}</span>
      {memories.some(memory=>memory.match)&&<small title="Coverage of your search terms, then phrase match; newest breaks ties. No memory was edited.">Sorted by relevance</small>}
      {newIds.length > 0 && <button className="text-button memory-review-all" disabled={busy} onClick={() => onReview(newIds)}>{busyAction === 'memory-review' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Mark shown as viewed</button>}
    </div>
    <div className="memory-note-list">
      {visible.map((memory, index) => {
        const key = memory.id || `${currentPage}:${index}`, open = expanded === key;
        const date = memory.date || memory.createdAt, fullDate = date && Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleString() : '';
        const contentId = `${detailId}-${index}`;
        return <article className={`memory-card memory-note-row ${memory.reviewed === false ? 'is-new' : ''} ${open ? 'is-expanded' : ''}`} key={key} data-memory-id={memory.id}>
          <div className="memory-note-summary">
            <button type="button" className="memory-note-toggle" aria-expanded={open} aria-controls={contentId} aria-label={`${open ? 'Collapse' : 'Expand'} memory: ${preview(memory.text).slice(0, 100)}`} onClick={() => setExpanded(open ? null : key)}>
              <ChevronRight size={15} className="memory-note-caret" />
              <span className="memory-note-preview">{open ? 'Saved memory' : preview(memory.text)}</span>
              {memory.reviewed === false && <span className="memory-new-label">New</span>}
              {date && <time className="memory-note-date" title={fullDate || undefined}>{dateLabel(date)}</time>}
            </button>
            <div className="memory-note-actions">
              {memory.reviewed === false && <button type="button" className="text-button memory-review-note" aria-label="Mark viewed" title="Mark this note as viewed" disabled={busy || !memory.id} onClick={() => onReview([memory.id])}><Check size={14} /><span>Mark viewed</span></button>}
              <button type="button" className="icon-button memory-delete" aria-label="Delete memory" title="Delete memory" disabled={busy || !memory.id} onClick={() => onDelete(memory)}><Trash2 size={14} /></button>
            </div>
          </div>
          {open && <div className="memory-note-details" id={contentId}>
            {memory.match&&<p className="connection-small">Matched: {memory.match.terms.join(', ')}{memory.match.phrase?' · exact phrase':''} · {memory.match.kind} (automatic label)</p>}
            <SelectableText as="p">{memory.text}</SelectableText>
            <div className="memory-card-bottom"><HardDrive size={12} /><span>{isWeb ? 'Private workspace' : 'Stored on this device'}{fullDate ? ` · ${fullDate}` : ''}</span><span>{byteCount(memory.text || '')} bytes</span></div>
          </div>}
        </article>;
      })}
    </div>
    {pages > 1 && <nav className="memory-pagination" aria-label="Memory note pages">
      <button type="button" className="memory-page-button" aria-label="Previous page of memories" disabled={busy || currentPage === 0} onClick={() => move(currentPage - 1)}><ChevronLeft size={15} />Previous</button>
      <span>Page {currentPage + 1} of {pages}</span>
      <button type="button" className="memory-page-button" aria-label="Next page of memories" disabled={busy || currentPage >= pages - 1} onClick={() => move(currentPage + 1)}>Next<ChevronRight size={15} /></button>
    </nav>}
  </section>;
}
