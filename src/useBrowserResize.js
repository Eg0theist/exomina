import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const WIDTH_KEY = 'exomina.browser.width';
const DEFAULT_WIDTH = 440;
const DIVIDER_WIDTH = 8;
const MIN_BROWSER_WIDTH = 300;
const MIN_CHAT_WIDTH = 360;
const MIN_SPLIT_WIDTH = MIN_BROWSER_WIDTH + MIN_CHAT_WIDTH + DIVIDER_WIDTH;

function savedWidth() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(value) && value > 0) return value;
  } catch { /* local storage unavailable */ }
  return DEFAULT_WIDTH;
}

function rememberWidth(value) {
  try { localStorage.setItem(WIDTH_KEY, String(Math.round(value))); } catch { /* local storage unavailable */ }
}

function widthLimits(available, overlay) {
  const max = Math.max(1, Math.floor(available - (overlay ? 48 : MIN_CHAT_WIDTH + DIVIDER_WIDTH)));
  return { min: Math.min(MIN_BROWSER_WIDTH, max), max };
}

export default function useBrowserResize(enabled) {
  const shellRef = useRef(null);
  const drag = useRef(null);
  const [preferredWidth, setPreferredWidth] = useState(savedWidth);
  const preferredRef = useRef(preferredWidth);
  preferredRef.current = preferredWidth;
  const [resizing, setResizing] = useState(false);
  const [layout, setLayout] = useState(() => ({ available: window.innerWidth, overlay: window.innerWidth < MIN_SPLIT_WIDTH }));
  const limits = widthLimits(layout.available, layout.overlay);
  const width = Math.min(limits.max, Math.max(limits.min, preferredWidth));
  const limitsRef = useRef(limits);
  limitsRef.current = limits;

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const sidebar = shell.querySelector(':scope > .sidebar');
    const measure = () => {
      const position = sidebar && getComputedStyle(sidebar).position;
      const sidebarWidth = sidebar && position !== 'fixed' && position !== 'absolute' ? sidebar.getBoundingClientRect().width : 0;
      const available = Math.max(1, shell.getBoundingClientRect().width - sidebarWidth);
      const overlay = available < MIN_SPLIT_WIDTH;
      setLayout(previous => previous.available === available && previous.overlay === overlay ? previous : { available, overlay });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    if (sidebar) observer.observe(sidebar);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  const finishDrag = useCallback((cancel = false) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (cancel) {
      preferredRef.current = active.preferredWidth;
      setPreferredWidth(active.preferredWidth);
    } else rememberWidth(preferredRef.current);
    if (active.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    setResizing(false);
  }, []);

  useLayoutEffect(() => {
    if (!enabled) finishDrag();
  }, [enabled, finishDrag]);

  useLayoutEffect(() => {
    if (!resizing) return;
    const stop = () => finishDrag();
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); finishDrag(true); } };
    const onVisibility = () => { if (document.hidden) finishDrag(); };
    window.addEventListener('blur', stop);
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', stop);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [resizing, finishDrag]);

  useLayoutEffect(() => () => {
    const active = drag.current;
    drag.current = null;
    if (active) {
      rememberWidth(preferredRef.current);
      if (active.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    }
  }, []);

  const resizeTo = value => {
    const current = limitsRef.current;
    const next = Math.round(Math.min(current.max, Math.max(current.min, value)));
    preferredRef.current = next;
    setPreferredWidth(next);
    return next;
  };
  const reset = () => {
    finishDrag();
    preferredRef.current = DEFAULT_WIDTH;
    setPreferredWidth(DEFAULT_WIDTH);
    rememberWidth(DEFAULT_WIDTH);
  };
  const separatorProps = {
    role: 'separator',
    tabIndex: 0,
    'aria-label': 'Resize browser',
    'aria-orientation': 'vertical',
    'aria-controls': 'browser-panel',
    'aria-valuemin': limits.min,
    'aria-valuemax': limits.max,
    'aria-valuenow': Math.round(width),
    'aria-valuetext': `${Math.round(width)} pixels wide`,
    title: 'Drag to resize browser. Left and Right arrows resize; double-click resets.',
    onPointerDown: event => {
      if (!enabled || event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, element: event.currentTarget, startX: event.clientX, width, preferredWidth: preferredRef.current };
      setResizing(true);
    },
    onPointerMove: event => {
      const active = drag.current;
      if (active && event.pointerId === active.pointerId) resizeTo(active.width + active.startX - event.clientX);
    },
    onPointerUp: event => {
      if (drag.current?.pointerId !== event.pointerId) return;
      resizeTo(drag.current.width + drag.current.startX - event.clientX);
      finishDrag();
    },
    onPointerCancel: event => { if (drag.current?.pointerId === event.pointerId) finishDrag(); },
    onLostPointerCapture: event => { if (drag.current?.pointerId === event.pointerId) finishDrag(); },
    onDoubleClick: reset,
    onKeyDown: event => {
      if (!enabled || drag.current) return;
      const step = event.shiftKey ? 96 : 32;
      let next;
      if (event.key === 'ArrowLeft') next = width + step;
      else if (event.key === 'ArrowRight') next = width - step;
      else if (event.key === 'Home') next = limits.min;
      else if (event.key === 'End') next = limits.max;
      else if (event.key === 'Enter') { event.preventDefault(); reset(); return; }
      else return;
      event.preventDefault();
      rememberWidth(resizeTo(next));
    },
  };
  return { shellRef, width, overlay: layout.overlay, resizing, separatorProps };
}
