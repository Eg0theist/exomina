import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

const KEY = 'exomina.composerHeight';
const MIN = 46;
const autoLimit = () => Math.round(window.innerHeight * 0.4);
const manualLimit = () => Math.round(window.innerHeight * 0.7);
const stored = () => { try { const value = Number(localStorage.getItem(KEY)); return Number.isFinite(value) && value >= MIN ? value : 0; } catch { return 0; } };

/** The message box grows with its text up to 40% of the window; dragging the
 * handle fixes its height (up to 70%), kept across restarts. Double-click resets. */
export default function useComposerSize(ref, value) {
  const [manual, setManual] = useState(stored);

  const fit = useCallback(() => {
    const area = ref.current; if (!area) return;
    const limit = manual ? manualLimit() : autoLimit();
    area.style.maxHeight = limit + 'px';
    area.style.height = 'auto';
    // A chosen height is kept as chosen; longer text scrolls inside it.
    const wanted = manual || Math.max(area.scrollHeight, MIN);
    area.style.height = Math.min(wanted, limit) + 'px';
  }, [ref, manual]);

  useLayoutEffect(fit, [fit, value]);
  useEffect(() => { window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit); }, [fit]);

  const save = height => {
    setManual(height);
    try { height ? localStorage.setItem(KEY, String(height)) : localStorage.removeItem(KEY); } catch {}
  };

  const onPointerDown = event => {
    const area = ref.current; if (!area || event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY, startHeight = area.getBoundingClientRect().height;
    const handle = event.currentTarget; handle.setPointerCapture?.(event.pointerId);
    let next = startHeight;
    const move = e => {
      next = Math.max(MIN, Math.min(manualLimit(), Math.round(startHeight + startY - e.clientY)));
      area.style.maxHeight = manualLimit() + 'px'; area.style.height = next + 'px';
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); save(next); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  };
  const onKeyDown = event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const current = ref.current?.getBoundingClientRect().height || MIN;
    save(Math.max(MIN, Math.min(manualLimit(), Math.round(current + (event.key === 'ArrowUp' ? 40 : -40)))));
  };

  return {
    manual: !!manual,
    handleProps: {
      role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize message box', tabIndex: 0,
      title: manual ? 'Drag to resize · double-click to size automatically' : 'Drag to resize the message box',
      onPointerDown, onKeyDown, onDoubleClick: () => save(0),
    },
  };
}
