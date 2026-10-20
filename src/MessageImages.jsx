import React, { useEffect, useState } from 'react';
import { Download, Image as ImageIcon, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from './transport.js';
import { mediaAttachment, mediaBlob } from './image-assets.js';
import './message-images.css';

const message = error => String(error?.message || 'The media could not be loaded.').replace(/^Error invoking remote method '[^']+': Error: /, '');
function MessageImage({ attachment, index }) {
  const isVideo = attachment.kind === 'video', label = isVideo ? 'Video' : 'Image';
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    let canceled = false, objectUrl;
    setUrl(''); setError(''); setSaved(''); setSaveError('');
    (async () => {
      try {
        const metadata = mediaAttachment(attachment);
        const result = await api.invoke('asset.read', { id: metadata.id });
        if (canceled) return;
        const blob = await mediaBlob(result, metadata);
        if (canceled) return;
        objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
      } catch (failure) { if (!canceled) setError(message(failure)); }
    })();
    return () => { canceled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachment.id, attachment.sha256, attachment.mimeType, attachment.bytes, attempt]);
  async function save() {
    setSaving(true); setSaveError(''); setSaved('');
    try {
      const result = await api.invoke('asset.save', { id: attachment.id });
      if (result.path) setSaved(`Saved to ${result.path}`);
      else if (result.downloaded) setSaved(`Downloaded ${result.filename}`);
    } catch (failure) { setSaveError(message(failure)); }
    finally { setSaving(false); }
  }
  return <figure className="message-image" aria-label={`${label} ${index + 1}`}>
    {error ? <div className="image-placeholder image-failure"><ImageIcon size={24} /><p role="alert">{error}</p><button className="text-button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} />Retry {label.toLowerCase()}</button></div>
      : url ? isVideo?<video src={url} controls preload="metadata" playsInline aria-label={`Generated video ${index+1}`} onError={()=>{setError('This video could not be played. Try loading it again.');setUrl('');}}/>:<img src={url} alt={`Image ${index + 1} attached to this message`} decoding="async" onError={() => { setError('This image could not be displayed. Try loading it again.'); setUrl(''); }} />
        : <div className="image-placeholder" role="status"><LoaderCircle className="spin" size={22} /><span>Loading {label.toLowerCase()}…</span></div>}
    <figcaption><span>{attachment.mimeType?.replace(/^(image|video)\//, '').toUpperCase() || label.toUpperCase()}{Number.isFinite(attachment.bytes) ? ` · ${attachment.bytes < 1024 * 1024 ? `${Math.max(1, Math.round(attachment.bytes / 1024))} KB` : `${(attachment.bytes / (1024 * 1024)).toFixed(1)} MB`}` : ''}</span><button className="text-button" disabled={!url || !!error || saving} onClick={save}>{saving ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}{saving ? 'Saving…' : `Save ${label.toLowerCase()}`}</button></figcaption>
    {saved && <p className="image-save-status" role="status">{saved}</p>}
    {saveError && <p className="image-save-error" role="alert">{saveError}</p>}
  </figure>;
}

export default function MessageImages({ attachments }) {
  if (!Array.isArray(attachments) || !attachments.length) return null;
  return <div className="message-images">{attachments.filter(item => ['image','video'].includes(item?.kind)).map((attachment, index) => <MessageImage key={attachment.id || index} attachment={attachment} index={index} />)}</div>;
}
