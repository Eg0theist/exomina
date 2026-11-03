import React, { useEffect, useRef, useState } from 'react';
import { resolveTheme } from '../desktop/themes.mjs';
import { startPalimpsest } from './palimpsest.js';
import './palimpsest-theme.css';

/** The Palimpsest theme's underwriting. The lantern reads app state; it never changes it. */
export default function Palimpsest({ appearance, working = false, waiting = false }) {
  const canvas = useRef(null), engine = useRef(null);
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const theme = resolveTheme(appearance, dark);
  const active = theme.effect === 'palimpsest';
  const mode = waiting ? 'waiting' : working ? 'working' : 'idle', modeNow = useRef(mode);
  modeNow.current = mode;
  useEffect(() => {
    if (!active || !canvas.current) return;
    const run = startPalimpsest(canvas.current, {
      motion: appearance.motion, accent: theme.colors.accent, ink: theme.colors.ink, lilac: theme.colors.lilac,
      subscribeVisibility: callback => window.studio?.onEvent(event => {
        if (event.type === 'companion.visibility') callback(event.visible === true);
      }),
    });
    run.setMode(modeNow.current); engine.current = run;
    return () => { run.stop(); engine.current = null; };
  }, [active, appearance.motion, theme.colors.accent, theme.colors.ink, theme.colors.lilac]);
  useEffect(() => { engine.current?.setMode(mode); }, [mode]);
  return active ? <canvas ref={canvas} className="palimpsest-field" aria-hidden="true" /> : null;
}
