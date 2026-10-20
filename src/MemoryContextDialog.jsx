import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, Layers3, LoaderCircle, X } from 'lucide-react';
import SelectableText from './SelectableText.jsx';
import './memory-context.css';

function readPage(result) {
  if (result?.error) throw Error(result.detail || 'Memory context could not be read.');
  const text = result?.text || 'No memory context is available yet.';
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data?.notes)) return { data };
  } catch { /* Older hosts may return plain text. */ }
  return { text };
}

export default function MemoryContextDialog({ result, api, onClose }) {
  const [pages, setPages] = useState(() => [readPage(result)]);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const preview = useRef(null);
  const first = pages[0].data, last = pages.at(-1).data;
  const text = first ? JSON.stringify({ ...last, notes: pages.flatMap(page => page.data.notes) }, null, 2) : pages[0].text;
  useEffect(() => {
    const previous = document.activeElement;
    preview.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  async function loadEarlier() {
    if (loading || !last?.nextPart) return;
    setLoading(true); setError('');
    try {
      const page = readPage(await api.invoke('memory.wake', { part: last.nextPart, snapshot: first.snapshot, cursor: last.nextCursor }));
      if (!page.data || page.data.snapshot !== first.snapshot) throw Error('The memory preview changed. Close it and open it again to refresh.');
      setPages(previous => [...previous, page]);
    } catch (error) { setError(error.message || String(error)); }
    finally { setLoading(false); }
  }
  return <div className="modal-backdrop"><section className="modal wide memory-context-dialog" role="dialog" aria-modal="true" aria-labelledby="context-dialog-title" aria-describedby="context-dialog-description">
    <button className="modal-close icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
    <div className="modal-icon"><Layers3 size={23} /></div><h2 id="context-dialog-title">Saved memory context</h2>
    <p id="context-dialog-description">Chats receive a compact first page of saved short notes, with tools to read earlier pages. Older notes may appear as summaries; the original notes stay available in the notes list and search.</p>
    <p className="memory-context-help">Whole-chat memory and imported conversations are separate and are not shown here. Click the preview and press Ctrl+A (⌘A on Mac) to select its text.</p>
    {first && <p className="memory-context-status" role="status">{pages.length} context {pages.length === 1 ? 'page' : 'pages'} loaded · {first.total} saved short {first.total === 1 ? 'note' : 'notes'}{!last.nextPart ? ' · All context pages loaded' : ''}</p>}
    <SelectableText ref={preview} className="context-preview" aria-label="Saved memory context text">{text}</SelectableText>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="modal-actions">{last?.nextPart && <button className="secondary-button" disabled={loading} onClick={loadEarlier}>{loading ? <LoaderCircle size={15} className="spin" /> : <ArrowDown size={15} />}Load earlier context</button>}<button className="primary-button" onClick={onClose}>Done</button></div>
  </section></div>;
}
