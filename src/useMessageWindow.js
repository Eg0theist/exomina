import {useLayoutEffect, useRef, useState} from 'react';

// One observer pair per chat viewport, rather than a pair per saved message.
const viewports = new WeakMap();
function viewportFor(root) {
  let viewport = viewports.get(root);
  if (viewport) return viewport;
  const entries = new Map();
  const intersection = new IntersectionObserver(changes => {
    for (const change of changes) entries.get(change.target)?.intersect(change.isIntersecting);
  }, {root, rootMargin: '1200px 0px'});
  const resize = new ResizeObserver(changes => {
    for (const change of changes) entries.get(change.target)?.measure();
  });
  viewport = {entries, intersection, resize};
  viewports.set(root, viewport);
  return viewport;
}

/** Keep scroll positions for old messages without retaining their Markdown DOM.
 * Search and live replies mount immediately. Question drafts live in App, and
 * focused editors or selected text are never removed by a scroll observation.
 */
export default function useMessageWindow({eager = false, active = false, estimate = 240}) {
  const ref = useRef(null), height = useRef(estimate), mounted = useRef(true);
  const [nearby, setNearby] = useState(false);
  const visible = eager || active || nearby;
  mounted.current = visible;
  useLayoutEffect(() => {
    const element = ref.current, root = element?.closest('.chat-scroll');
    if (!element || !root || !globalThis.IntersectionObserver) { setNearby(true); return; }
    const viewport = viewportFor(root);
    const entry = {
      measure() { if (mounted.current) height.current = element.getBoundingClientRect().height; },
      intersect(value) {
        if (!value) {
          const selection = element.ownerDocument.getSelection();
          if (element.contains(element.ownerDocument.activeElement) ||
              selection && !selection.isCollapsed && (element.contains(selection.anchorNode) || element.contains(selection.focusNode))) return;
        }
        setNearby(value);
      },
    };
    viewport.entries.set(element, entry);
    viewport.intersection.observe(element); viewport.resize.observe(element); entry.measure();
    return () => {
      viewport.intersection.unobserve(element); viewport.resize.unobserve(element); viewport.entries.delete(element);
      if (!viewport.entries.size) { viewport.intersection.disconnect(); viewport.resize.disconnect(); viewports.delete(root); }
    };
  }, []);
  // Capture real geometry before a row becomes a placeholder, including HUD,
  // theme, width and expanded work-detail changes.
  useLayoutEffect(() => { if (visible && ref.current) height.current = ref.current.getBoundingClientRect().height; });
  return {ref, visible, height: height.current};
}
