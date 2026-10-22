import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const KEY = 'exomina.composerHeight';
const MIN = 46;
const autoLimit = () => Math.round(window.innerHeight * 0.4);
const manualLimit = () => Math.round(window.innerHeight * 0.7);
const stored = () => { try { const value = Number(localStorage.getItem(KEY)); return Number.isFinite(value) && value >= MIN ? value : 0; } catch { return 0; } };

/** The message box grows with its text up to 40% of the window; dragging the
 * handle fixes its height (up to 70%), kept across restarts. Double-click resets. */
export default function useComposerSize(ref, value) {
  const [manual, setManual] = useState(stored);
  const measureRef = useRef(null);
  const nativeSizing = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');

  const fit = useCallback(() => {
    const area = ref.current; if (!area) return;
    if (nativeSizing) {
      // Let layout wrap the actual editor once, without copying and measuring
      // the whole draft during each input event. Empty suggestions must not
      // determine the editor's height.
      const content = !manual && !!area.value;
      const sizing = content ? 'content' : 'fixed';
      const maximum = manual ? '70vh' : '40vh';
      const height = manual ? `min(${manual}px, 70vh)` : content ? 'auto' : MIN + 'px';
      if (area.style.fieldSizing !== sizing) area.style.fieldSizing = sizing;
      if (area.style.maxHeight !== maximum) area.style.maxHeight = maximum;
      if (area.style.height !== height) area.style.height = height;
      return;
    }
    const limit = manual ? manualLimit() : autoLimit();
    let wanted = manual;
    if (!manual) {
      // Measure outside the chat's flex layout. Collapsing the live editor to
      // `auto` made the reply viewport expand and contract on every keystroke.
      let measure = measureRef.current;
      if (!measure) {
        measure = document.createElement('textarea');
        measure.dataset.composerMeasure = ''; measure.setAttribute('aria-hidden', 'true');
        measure.tabIndex = -1; measure.readOnly = true; measure.inert = true;
        measure.style.cssText = 'position:fixed;left:-10000px;top:0;height:0;min-height:0;max-height:none;visibility:hidden;pointer-events:none;overflow:hidden;resize:none;box-sizing:border-box;';
        document.body.appendChild(measure); measureRef.current = measure;
      }
      const style = getComputedStyle(area);
      for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'lineHeight', 'letterSpacing', 'textIndent', 'textTransform', 'wordSpacing', 'tabSize', 'whiteSpace', 'wordBreak', 'overflowWrap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle', 'scrollbarGutter']) measure.style[property] = style[property];
      measure.style.width = area.getBoundingClientRect().width + 'px';
      measure.value = area.value;
      wanted = Math.max(measure.scrollHeight + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0), MIN);
    }
    // A chosen height is kept as chosen; longer text scrolls inside it.
    const maximum = limit + 'px', height = Math.min(wanted, limit) + 'px';
    if (area.style.maxHeight !== maximum) area.style.maxHeight = maximum;
    if (area.style.height !== height) area.style.height = height;
  }, [ref, manual, nativeSizing]);

  useLayoutEffect(fit, [fit, nativeSizing ? !!value : value]);
  useEffect(() => {
    if (nativeSizing) return;
    const area = ref.current; let width = area?.getBoundingClientRect().width;
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.target.getBoundingClientRect().width;
      if (next !== undefined && Math.abs(next - width) > .5) { width = next; fit(); }
    });
    if (area) observer.observe(area);
    window.addEventListener('resize', fit);
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); };
  }, [fit, ref, nativeSizing]);
  useEffect(() => () => { measureRef.current?.remove(); measureRef.current = null; }, []);

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
