import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Palette } from 'lucide-react';
import { TONES } from '../desktop/personalization.mjs';
import useDismiss from './useDismiss.js';

/** Composer chip: this chat's tone and instructions on top of the Settings defaults. */
export default function ChatStyle({ chat, defaultTone = 'balanced', onChange, onManage, disabled }) {
  const [open, setOpen] = useState(false);
  const own = chat?.personalization || null;
  const [draft, setDraft] = useState(own?.instructions || '');
  const area = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(area, open, close);
  useEffect(() => { setDraft(own?.instructions || ''); }, [chat?.id, own?.instructions]);
  const tone = own?.tone || defaultTone;
  const label = TONES.find(item => item.id === tone)?.name || 'Balanced';
  const save = patch => onChange({ ...(own || {}), ...patch });
  return <div className="permission-picker chat-style" ref={area}>
    <button type="button" className={`composer-chip ${own ? 'is-own' : ''}`} aria-label={`Chat style: ${label}`} disabled={disabled || !chat} onClick={() => setOpen(!open)} aria-expanded={open} title={chat ? `Chat style: ${label}` : 'Send a message first to give this chat its own style'}>
      <Palette size={14} /><span>{label}</span><ChevronDown size={12} className="chip-caret" />
    </button>
    {open && <div className="popover permission-popover chat-style-popover" role="dialog" aria-label="How this chat responds">
      <div className="popover-label">THIS CHAT</div>
      <div className="chat-style-tones">{TONES.map(item => <button type="button" key={item.id} className={tone === item.id ? 'selected' : ''} aria-pressed={tone === item.id} onClick={() => save({ tone: item.id === defaultTone ? undefined : item.id })}>{item.name}</button>)}</div>
      <label className="chat-style-field">Instructions for this chat<textarea rows={3} value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => draft !== (own?.instructions || '') && save({ instructions: draft })} placeholder="Keep replies concise. Explain unfamiliar terms…" /></label>
      <label className="chat-style-check"><input type="checkbox" checked={own?.styles !== false} onChange={event => save({ styles: event.target.checked ? undefined : false })} />Use my writing styles here</label>
      <p className="popover-hint">You can also tell the AI directly, for example “be more casual from now on”.</p>
      <div className="chat-style-foot">{own && <button type="button" className="text-button" onClick={() => { onChange(null); close(); }}>Use the defaults</button>}<button type="button" className="text-button" onClick={() => { close(); onManage(); }}>Defaults and styles…</button></div>
    </div>}
  </div>;
}
