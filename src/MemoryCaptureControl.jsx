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
