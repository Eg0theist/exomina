import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, LoaderCircle, X } from 'lucide-react';
import { api,isDesktop } from './transport.js';
import DataTransfer from './DataTransfer.jsx';

export default function DataExport({ conversationId, onModalChange, onNotice, compact = false }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState(conversationId ? 'chat' : 'all');
  const [format, setFormat] = useState('json');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) onModalChange(true); return () => { if (open) onModalChange(false); }; }, [open, onModalChange]);
  async function download(event) {
    event.preventDefault(); setPending(true); setError('');
    try {
      const result = await api.invoke('data.export', { scope, format, ...(scope === 'chat' ? { conversationId } : {}) });
      if (result?.path || result?.downloaded) { onNotice(result.path ? `Exported to ${result.path}` : `Downloaded ${result.filename}`); setOpen(false); }
    } catch (err) { setError(err.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { setPending(false); }
  }
  return <>{!compact&&isDesktop&&<DataTransfer onModalChange={onModalChange} onNotice={onNotice}/>}<button className={compact ? 'icon-button export-chat-button' : 'secondary-button'} aria-label={compact ? 'Export current chat' : undefined} title={compact ? 'Export current chat' : undefined} onClick={() => { setOpen(true); setScope(conversationId ? 'chat' : 'all'); setError(''); }}><Download size={compact ? 17 : 15} />{!compact && 'Export data'}</button>{open && createPortal(<div className="modal-backdrop"><section className="modal export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title"><button className="modal-close icon-button" aria-label="Close export" disabled={pending} onClick={() => setOpen(false)}><X size={18} /></button><div className="modal-icon"><Download size={23} /></div><h2 id="export-title">Export your data</h2><p>Download a copy of your chats and saved context.</p><p className="export-privacy-note">Readable export — keep this file private.</p><form onSubmit={download}><label className="input-label" htmlFor="export-scope">Include</label><select id="export-scope" value={scope} onChange={event => setScope(event.target.value)}>{conversationId && <option value="chat">Current chat</option>}<option value="chats">All chats</option><option value="memory">Saved memory and context</option><option value="all">Chats, memory, and context</option></select><label className="input-label" htmlFor="export-format">Format</label><select id="export-format" value={format} onChange={event => setFormat(event.target.value)}><option value="json">JSON · full structured data</option><option value="markdown">Markdown · readable text</option></select>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button className="secondary-button" type="button" disabled={pending} onClick={() => setOpen(false)}>Cancel</button><button className="primary-button" disabled={pending}>{pending ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}Export</button></div></form></section></div>, document.body)}</>;
}
