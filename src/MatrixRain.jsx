import React, { useEffect, useRef, useState } from 'react';
import { resolveTheme } from '../desktop/themes.mjs';
import { startMatrixRain } from './matrix-rain.js';
import './matrix-theme.css';

export default function MatrixRain({ appearance }) {
  const canvas = useRef(null);
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const theme = resolveTheme(appearance, dark);
  const active = theme.effect === 'matrix';
  useEffect(() => {
    if (active && canvas.current) return startMatrixRain(canvas.current, {
      motion: appearance.motion, green: theme.colors.accent, bright: theme.colors.ink,
      subscribeVisibility: callback => window.studio?.onEvent(event => {
        if (event.type === 'companion.visibility') callback(event.visible === true);
      }),
    });
  }, [active, appearance.motion, theme.colors.accent, theme.colors.ink]);
  return active ? <canvas ref={canvas} className="matrix-rain" aria-hidden="true" /> : null;
}
