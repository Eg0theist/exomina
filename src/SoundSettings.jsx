import React from 'react';
import { Play, Volume2 } from 'lucide-react';
import { SOUND_EVENTS, SOUND_PRESETS, normalizeSounds } from '../desktop/sound-settings.mjs';
import { playPreset } from './sounds.js';

export default function SoundSettings({ sounds: value, onChange, Toggle, busy = false, notifications = true, onNotificationsChange }) {
  const sounds = normalizeSounds(value);
  const save = patch => onChange({ ...sounds, ...patch });
  return <section className="settings-section" id="settings-sounds">
    <div className="section-title"><h2>Sounds & notifications</h2><span>Short cues when something needs you</span></div>
    {onNotificationsChange && <div className="settings-row"><div><strong>Notify me when an AI needs me</strong><p>Questions and approvals get a Windows notification while Exomina is in the background. Click to open the chat. Up to two reminders follow at three-minute intervals. Alerts and their sound wait during detected demanding apps and Windows quiet states.</p></div><Toggle label="Notify me when an AI needs me" checked={notifications} disabled={busy} onChange={onNotificationsChange} /></div>}
    <div className="settings-row"><div><strong>Play notification sounds</strong><p>Soft sounds made by Exomina itself, no downloads.</p></div><Toggle label="Play notification sounds" checked={sounds.enabled} disabled={busy} onChange={enabled => save({ enabled })} /></div>
    <div className={`settings-row ${sounds.enabled ? '' : 'is-disabled'}`}><div><strong>Volume</strong></div><label className="sound-volume"><Volume2 size={15} /><input type="range" min="0" max="1" step="0.05" value={sounds.volume} disabled={busy || !sounds.enabled} aria-label="Sound volume" onChange={event => save({ volume: Number(event.target.value) })} onMouseUp={() => playPreset(sounds.events.done, sounds.volume)} /><span>{Math.round(sounds.volume * 100)}%</span></label></div>
    <div className={`settings-row ${sounds.enabled ? '' : 'is-disabled'}`}><div><strong>Only when I’m in another window</strong><p>Stay quiet while Exomina is in front.</p></div><Toggle label="Only when I’m in another window" checked={sounds.onlyWhenAway} disabled={busy || !sounds.enabled} onChange={onlyWhenAway => save({ onlyWhenAway })} /></div>
    {SOUND_EVENTS.map(event => <div key={event.id} className={`settings-row sound-event ${sounds.enabled ? '' : 'is-disabled'}`}><div><strong>{event.name}</strong><p>{event.description}</p></div>
      <div className="sound-pick"><select aria-label={`Sound for ${event.name}`} value={sounds.events[event.id]} disabled={busy || !sounds.enabled} onChange={change => { const id = change.target.value; save({ events: { ...sounds.events, [event.id]: id } }); playPreset(id, sounds.volume); }}>{SOUND_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>
        <button type="button" className="icon-button" title="Preview" aria-label={`Preview the ${event.name} sound`} disabled={!sounds.enabled || sounds.events[event.id] === 'none'} onClick={() => playPreset(sounds.events[event.id], sounds.volume)}><Play size={14} /></button></div></div>)}
  </section>;
}
