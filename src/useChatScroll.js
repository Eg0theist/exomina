import { useCallback, useLayoutEffect, useRef } from 'react';

const TRACE_MS = 8000, TRACE_LIMIT = 300;
/** Records how the chat moved while it opened. Positions and event kinds only, never message text. */
function createOpenTrace(el, stickRef, report) {
  const started = performance.now(), entries = [];
  let userMoved = false, done = false, last = '';
  const element = node => node instanceof Element ? [node.tagName.toLowerCase(), node.id && `#${node.id}`, typeof node.className === 'string' && node.className.trim() && `.${node.className.trim().split(/\s+/).slice(0, 3).join('.')}`].filter(Boolean).join('') : '';
  const visibleMessage = () => { const box = el.getBoundingClientRect(); return el.ownerDocument.elementFromPoint?.(box.left + box.width / 2, box.top + Math.min(box.height / 2, 80))?.closest?.('[data-message-index]')?.dataset.messageIndex ?? null; };
  const note = (kind, extra = {}) => {
    if (done) return;
    const entry = { t: Math.round(performance.now() - started), kind, top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), height: el.scrollHeight, stick: !!stickRef.current, ...extra };
    const key = `${entry.kind}:${entry.top}:${entry.height}:${entry.stick}`;
    if (key === last && !Object.keys(extra).length) return;
    last = key; if (entries.length < TRACE_LIMIT) entries.push(entry);
  };
  const finish = () => {
    if (done) return;
    note('end', { message: visibleMessage(), messages: el.querySelectorAll('[data-message-index]').length });
    done = true;
    const end = entries[entries.length - 1];
    if (!userMoved && end && end.gap > 48) report?.({ at: new Date().toISOString(), durationMs: TRACE_MS, entries });
  };
  const timer = setTimeout(finish, TRACE_MS);
  return {
    note, active: () => !done,
    // Moving toward the latest message does not explain ending up above it.
    user: kind => { if (!['wheel-down', 'bottom-button', 'key-ArrowDown', 'key-PageDown', 'key-End', 'key- '].includes(kind)) userMoved = true; note('user', { input: kind }); },
    focus: () => note('focus', { target: element(el.ownerDocument.activeElement) }),
    stop: () => { clearTimeout(timer); finish(); },
  };
}

/** Finds what sits at the top of the visible chat: the deepest element there, plus its message as a fallback. */
function captureAnchor(el) {
  const view = el.getBoundingClientRect(), messages = el.querySelectorAll('[data-message-index]');
  if (!messages.length) return null;
  let node = el.ownerDocument.elementFromPoint?.(view.left + view.width / 2, view.top + 2) || null;
  let message = node?.closest?.('[data-message-index]');
  if (!message || !el.contains(message)) {
    // Something floats over the chat there; take the first message reaching below the top edge.
    let low = 0, high = messages.length - 1;
    while (low < high) { const mid = (low + high) >> 1; if (messages[mid].getBoundingClientRect().bottom > view.top) high = mid; else low = mid + 1; }
    message = messages[low]; node = null;
  }
  // Screen positions, so a bar appearing or leaving above the chat does not move the text either.
  return { node: node && message.contains(node) ? node : message, index: message.dataset.messageIndex, offset: (node && message.contains(node) ? node : message).getBoundingClientRect().top, messageOffset: message.getBoundingClientRect().top };
}

/** Moves the chat so the remembered element is back where it was. Returns how far it moved. */
function restoreAnchor(el, anchor) {
  const shown = node => node?.isConnected && el.contains(node) && node.getClientRects().length > 0;
  let target = anchor.node, offset = anchor.offset;
  if (!shown(target)) { target = el.querySelector(`[data-message-index="${anchor.index}"]`); offset = anchor.messageOffset; }
  if (!shown(target)) return 0;
  const delta = target.getBoundingClientRect().top - offset;
  if (Math.abs(delta) < 1) return 0;
  const before = el.scrollTop;
  el.scrollTop = before + delta;
  return el.scrollTop - before;
}

/**
 * Layout changes cannot unpin the chat. Only user scrolling or search does.
 * While unpinned, layout changes keep the text you are reading in place
 * (the browser's own scroll anchoring is off because it fights the bottom pin).
 */
export default function useChatScroll({ scrollRef, stickRef, viewKey, openEpoch, enabled, pendingHit, searchQuery, report }) {
  const interaction = useRef(0);
  const searching = useRef(searchQuery);
  const trace = useRef(null);
  const reporter = useRef(report);
  const anchor = useRef(null);
  searching.current = searchQuery;
  reporter.current = report;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;
    let frame = 0;
    const opening = trace.current = !pendingHit.current ? createOpenTrace(el, stickRef, value => reporter.current?.(value)) : null;
    anchor.current = null;
    const pin = reason => {
      if (stickRef.current && !pendingHit.current && !searching.current) el.scrollTop = el.scrollHeight;
      else {
        if (!stickRef.current && !pendingHit.current && !searching.current) {
          if (!anchor.current) anchor.current = captureAnchor(el);
          else { const moved = restoreAnchor(el, anchor.current); if (moved && opening?.active()) opening.note('anchor-kept', { reason, moved: Math.round(moved) }); }
        }
        if (opening?.active()) opening.note('pin-skipped', { reason, pendingHit: !!pendingHit.current, searching: !!searching.current });
      }
    };
    const follow = () => {
      // A backgrounded Electron window can defer animation frames. Pin during
      // layout/resize too, and let one frame settle any remaining child layout.
      pin('layout');
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; pin('frame'); opening?.note('layout'); });
    };
    if (!pendingHit.current) { stickRef.current = true; interaction.current = 0; el.scrollTop = el.scrollHeight; follow(); opening?.note('open'); }
    const innerConsumes = event => {
      for (let target = event.target instanceof Element ? event.target : event.target?.parentElement; target && target !== el; target = target.parentElement) {
        if (target.scrollHeight - target.clientHeight <= 1 || !/auto|scroll/.test(getComputedStyle(target).overflowY)) continue;
        if (event.type !== 'wheel' || (event.deltaY < 0 ? target.scrollTop > 0 : target.scrollHeight - target.scrollTop - target.clientHeight > 1)) return true;
      }
      return false;
    };
    const intent = event => {
      if (event.type === 'pointerdown' && event.target !== el) return;
      if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab'].includes(event.key)) return;
      if (event.type === 'keydown' && event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]')) return;
      if (innerConsumes(event)) return;
      interaction.current = performance.now() + 1000;
      opening?.user(event.type === 'wheel' ? (event.deltaY < 0 ? 'wheel-up' : 'wheel-down') : event.type === 'keydown' ? `key-${event.key}` : event.type);
      if (event.type === 'wheel' && event.deltaY < 0 || event.type === 'touchstart' || event.type === 'pointerdown' || event.type === 'keydown' && ['ArrowUp', 'PageUp', 'Home', 'Tab'].includes(event.key)) stickRef.current = false;
    };
    const resize = new ResizeObserver(follow), observed = new Set();
    const observe = () => {
      const current = new Set([el, ...el.children]);
      for (const child of observed) if (!current.has(child)) { resize.unobserve(child); observed.delete(child); }
      for (const child of current) if (!observed.has(child)) { resize.observe(child); observed.add(child); }
      follow();
    };
    const mutation = new MutationObserver(observe);
    mutation.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'src', 'width', 'height', 'hidden', 'open'] });
    observe();
    const focused = () => opening?.focus();
    el.addEventListener('load', follow, true);
    el.addEventListener('focusin', focused);
    document.fonts?.addEventListener('loadingdone', follow);
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) el.addEventListener(type, intent, { passive: true });
    return () => { opening?.stop(); if (trace.current === opening) trace.current = null; resize.disconnect(); mutation.disconnect(); cancelAnimationFrame(frame); el.removeEventListener('load', follow, true); el.removeEventListener('focusin', focused); document.fonts?.removeEventListener('loadingdone', follow); for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) el.removeEventListener(type, intent); };
  }, [viewKey, openEpoch, enabled]);
  const onScroll = useCallback(event => {
    const el = event.currentTarget, opening = trace.current?.active() ? trace.current : null;
    // A search move is not a reading position to restore afterwards.
    if (pendingHit.current || searching.current) { anchor.current = null; opening?.note('scroll-ignored', { pendingHit: !!pendingHit.current, searching: !!searching.current }); return; }
    if (el !== scrollRef.current) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight, wasStuck = stickRef.current;
    if (!stickRef.current || performance.now() < interaction.current) stickRef.current = gap <= 48;
    // Native focus restoration and other programmatic scrolls can happen after
    // the opening layout has settled, without another resize or mutation.
    else if (gap > 1) el.scrollTop = el.scrollHeight;
    anchor.current = stickRef.current ? null : captureAnchor(el);
    opening?.note(wasStuck && !stickRef.current ? 'unpinned-by-scroll' : 'scroll', wasStuck && !stickRef.current ? { recentInput: performance.now() < interaction.current } : {});
  }, []);
  /** Lets the app record its own deliberate moves (search hits, Top/Bottom) in the opening trace. */
  const note = useCallback((kind, extra) => { if (trace.current?.active()) trace.current.note(kind, extra); }, []);
  onScroll.note = note;
  onScroll.user = useCallback(kind => { if (trace.current?.active()) trace.current.user(kind); }, []);
  return onScroll;
}
