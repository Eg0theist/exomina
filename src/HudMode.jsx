import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import './hud.css';

const HUD_KEY = 'exomina.hudHidden';

// A presentation preference for this device only: hiding the HUD never changes chats, tools or permissions.
export function useHud() {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HUD_KEY) === '1'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(HUD_KEY, hidden ? '1' : '0'); } catch { /* Still works for this session. */ } }, [hidden]);
  return [hidden, setHidden];
}

const PEEK_ZONE = 56, PEEK_RELEASE = 110;

/** Clears the native caption strip while the HUD is hidden; the window buttons fade in only near the top edge. */
export function useHudChrome(active, invoke) {
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (!active) { setPeek(false); return; }
    const move = event => setPeek(value => event.clientY <= PEEK_ZONE ? true : event.clientY > PEEK_RELEASE ? false : value);
    const leave = () => setPeek(false);
    window.addEventListener('mousemove', move, { passive: true }); window.addEventListener('blur', leave);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('blur', leave); };
  }, [active]);
  const mode = active ? (peek ? 'peek' : 'hidden') : null;
  useEffect(() => { if (invoke) invoke('window.hud', { mode }).catch(() => {}); }, [mode, invoke]);
  return active && peek;
}

export const isHudShortcut = event => (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'h';

export function HudToggle({ hidden, onToggle }) {
  const label = hidden ? 'Show HUD' : 'Hide HUD';
  const Icon = hidden ? Eye : EyeOff;
  return <button type="button" className="icon-button hud-toggle" aria-label={label} aria-pressed={hidden} title={`${label} (Ctrl+Shift+H)`} onClick={onToggle}><Icon size={16} /></button>;
}

export function HudPulse({ label }) {
  return <div className="hud-pulse" role="status" aria-label={`${label} is working`}><i /><i /><i /></div>;
}
