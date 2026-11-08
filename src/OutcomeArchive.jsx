import React, { useEffect, useRef, useState } from 'react';

export default function OutcomeArchive({ conversationId, invoke, onChanged = async () => {} }) {
  const [page, setPage] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [through, setThrough] = useState(''), [exportText, setExportText] = useState('');
  const generation = useRef(0);
  useEffect(() => { generation.current++; setPage(null); setError(''); setThrough(''); setExportText(''); setBusy(false); }, [conversationId]);
  async function run(args) {
    const token = generation.current; setBusy(true); setError('');
    try {
      const result = await invoke('outcomes.archive', { conversationId, args });
      if (token !== generation.current) return;
      if (args.action === 'view') setPage(result);
      else { setPage(await invoke('outcomes.archive', { conversationId, args: { action: 'view', limit: 20, export: true } })); await onChanged(); }
      setExportText('');
    } catch (failure) { if (token === generation.current) setError(failure.message); }
    finally { if (token === generation.current) setBusy(false); }
  }
  return <details className="outcome-archive"><summary>Outcome history</summary><p>Recent checks stay in the chat. The local archive retains earlier receipts until you explicitly prune or delete them. A consistent hash chain detects damaged records; it cannot prove authenticity against someone who controls this computer.</p>
    <button type="button" className="text-button" disabled={busy} onClick={() => run({ action: 'view', limit: 20, export: true })}>Inspect outcome archive</button>
    {page && <><p>{page.total} retained receipts · {page.archive?.integrity?.status || page.archive?.status || 'recent history'}{page.archive?.retainedFrom ? ` · starts at sequence ${page.archive.retainedFrom}` : ''}</p>
      <div className="skill-library-references">{page.marks.map((mark, index) => <details key={mark.id}><summary>{mark.status} · {mark.claim}</summary><p>{mark.kind} · {mark.subject} · {new Date(mark.at).toLocaleString()}</p><p>Mark ID: <code>{mark.id}</code>{page.archive?.rows?.[index]?.sequence ? ` · sequence ${page.archive.rows[index].sequence}` : ''}</p><pre>{JSON.stringify(mark.observed || { reason: mark.reason }, null, 2)}</pre></details>)}</div>
      <div className="skill-library-actions"><button type="button" className="text-button" disabled={busy || !(page.offset > 0)} onClick={() => run({ action: 'view', offset: Math.max(0, page.offset - 20), limit: 20, export: true })}>Newer receipts</button><button type="button" className="text-button" disabled={busy || page.nextOffset === null || page.nextOffset === undefined} onClick={() => run({ action: 'view', offset: page.nextOffset, limit: 20, export: true })}>Older receipts</button><button type="button" className="text-button" disabled={busy} onClick={() => setExportText(JSON.stringify(page, null, 2))}>Export visible page as text</button></div>
      {exportText && <label>Outcome export<textarea aria-label="Outcome export" readOnly rows={8} value={exportText} /></label>}
      {page.archive?.integrity && page.total > 0 && <><label>Remove receipts through sequence<input aria-label="Prune outcome sequence" type="number" min={1} value={through} onChange={event => setThrough(event.target.value)} /></label><div className="skill-library-actions"><button type="button" className="text-button" disabled={busy || !Number.isSafeInteger(Number(through)) || Number(through) < 1} onClick={() => run({ action: 'prune', throughSequence: Number(through) })}>Review pruning</button><button type="button" className="text-button" disabled={busy} onClick={() => run({ action: 'delete' })}>Review archive deletion</button></div><p>Removing evidence can invalidate learned procedures. These changes require review through the host approval control.</p></>}
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </details>;
}
