import React from 'react';
import './memory-controls.css';

export default function MemoryCaptureControl({ value, onChange, disabled = false }) {
  return <div className="settings-row memory-capture-control">
    <div><strong>Save new memories</strong><p>Keep useful, lasting details as you chat, or review each note before it is saved.</p></div>
    <select aria-label="Save new memories" value={value === 'ask' ? 'ask' : 'automatic'} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="automatic">Automatically (default)</option>
      <option value="ask">Ask me first</option>
    </select>
  </div>;
}

export function MemoryContextControl({ value, onChange, disabled = false }) {
  return <div className="settings-row memory-capture-control">
    <div><strong>Memories sent with each message</strong><p>Send notes that match your request, with outdated ones flagged against newer notes and Exomina's own checks, or send the newest notes in order. The AI can search everything else either way.</p></div>
    <select aria-label="Memories sent with each message" value={value === 'chronological' ? 'chronological' : 'relevant'} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="relevant">Matching this request (default)</option>
      <option value="chronological">Newest first</option>
    </select>
  </div>;
}
