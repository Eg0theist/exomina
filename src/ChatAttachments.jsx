import React from 'react';
import { File, X } from 'lucide-react';
import MessageImages from './MessageImages.jsx';
import './chat-attachments.css';

export function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}
export function AttachmentDraft({ attachments, onRemove }) {
  if (!attachments.length) return null;
  return <div className="attachment-draft" aria-label="Files to send">{attachments.map(item => <div className="attachment-chip" key={item.uploadId}><File size={15} /><span title={item.name}>{item.name}</span><small>{Math.max(1, Math.round(item.bytes / 1024))} KB</small><button type="button" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.uploadId)}><X size={14} /></button></div>)}<MessageImages attachments={attachments.filter(item => item.kind === 'image')} /></div>;
}
export function MessageFiles({ attachments }) {
  const files = (attachments || []).filter(item => item.kind === 'file');
  if (!files.length) return null;
  return <div className="message-files">{files.map((item, index) => <span className="attachment-chip" key={item.uploadId || item.id || index} title={item.relativePath ? `In project folder: ${item.relativePath}` : item.name}><File size={15} /><span>{item.name}</span><small>{Math.max(1, Math.round(item.bytes / 1024))} KB</small></span>)}</div>;
}
