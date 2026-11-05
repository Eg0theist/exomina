import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api } from './transport.js';

const GIB = 1024 ** 3, MIB = 1024 ** 2;
export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  if (bytes >= MIB) return `${Math.round(bytes / MIB)} MB`;
  return bytes > 0 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : '0 KB';
}
const message = failure => (failure.message || String(failure)).replace(/^Error invoking remote method '[^']+': Error: /, '');

export default function DiskSpaceSettings() {
  const [status, setStatus] = useState(null);
  const [usage, setUsage] = useState(null);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    api.invoke('disk.status').then(value => { if (mounted.current) setStatus(value); }).catch(failure => { if (mounted.current) setError(message(failure)); });
    return () => { mounted.current = false; };
  }, []);
  async function measure() {
    setPending('usage'); setError('');
    try { const value = await api.invoke('disk.usage'); if (mounted.current) setUsage(value); }
    catch (failure) { if (mounted.current) setError(message(failure)); }
    finally { if (mounted.current) setPending(''); }
  }
  async function cleanup() {
    setPending('cleanup'); setError(''); setResult('');
    try {
      const value = await api.invoke('disk.cleanup');
      if (!mounted.current) return;
      setStatus(value);
      const done = value.lastCleanup;
      setResult(done?.temporarySkipped ? `Temporary files were kept because a terminal or command is running.${done.removed ? ` Removed ${done.removed} old ${done.removed === 1 ? 'backup' : 'backups'}.` : ''}` : done?.removed ? `Removed ${done.removed} old ${done.removed === 1 ? 'item' : 'items'}, freeing ${formatSize(done.bytes)}.` : 'Nothing old enough to remove.');
      if (usage) setUsage(await api.invoke('disk.usage'));
    } catch (failure) { if (mounted.current) setError(message(failure)); }
    finally { if (mounted.current) setPending(''); }
  }
  const warning = status?.level === 'critical' ? 'Your drive is almost full. Exomina may fail to save new work until you free up space.' : status?.level === 'low' ? 'Your drive is getting full. Large downloads may be refused.' : '';
  return <div className="settings-row disk-space-row"><div>
    <strong>Disk space</strong>
    <p>{status?.freeBytes == null ? 'Checking free space…' : `${formatSize(status.freeBytes)} free where Exomina keeps your data.`} Temporary files unused for 7 days and file backups older than 90 days are removed automatically, as are older backups beyond 1 GB. Chats, notes, sign-ins and project files are never removed.</p>
    {warning && <p role="alert" className="inline-error">{warning}</p>}
    {usage && <ul className="disk-space-folders">{usage.folders.filter(folder => folder.bytes > 0).map(folder => <li key={folder.name}><span>{folder.label}</span> <span>{formatSize(folder.bytes)}</span></li>)}</ul>}
    {usage && !usage.complete && <p>Some folders were too large to measure completely, so these sizes may be low.</p>}
    {result && <p role="status">{result}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div><div className="settings-row-actions">
    <button type="button" className="secondary-button" disabled={!!pending} onClick={measure}>{pending === 'usage' && <LoaderCircle size={14} className="spin" />}Show what uses space</button>
    <button type="button" className="secondary-button" disabled={!!pending} onClick={cleanup}>{pending === 'cleanup' && <LoaderCircle size={14} className="spin" />}Clean up now</button>
  </div></div>;
}
