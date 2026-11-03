import React, { useLayoutEffect } from 'react';
import { chatSearchExcerpt } from './chat-search.js';

/** Nearby placeholders can expand after a search scroll. Keep the chosen match
 * visible during those layouts, until the user deliberately moves away.
 */
export function useChatSearchReveal(rowRef, hit) {
  useLayoutEffect(() => {
    const row = rowRef.current, viewport = row?.closest('.chat-scroll');
    if (!viewport || !hit) return;
    let stopped = false;
    const reveal = () => {
      if (stopped) return;
      const mark = row.querySelector(`${hit.source ? '.chat-search-excerpt ' : ''}[data-search-start="${hit.start}"]`);
      if (!mark) return;
      const bounds = mark.getBoundingClientRect(), view = viewport.getBoundingClientRect();
      if (bounds.top < view.top || bounds.bottom > view.bottom) mark.scrollIntoView({ block: 'center' });
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(row.closest('.messages') || row);
    observer.observe(row);
    const stop = () => { stopped = true; observer.disconnect(); };
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) viewport.addEventListener(event, stop, { passive: true });
    reveal();
    return () => {
      observer.disconnect();
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) viewport.removeEventListener(event, stop);
    };
  }, [rowRef, hit?.messageIndex, hit?.source, hit?.start, hit?.end]);
}

export default function ChatSearchExcerpt({ message, hit }) {
  const excerpt = chatSearchExcerpt(message, hit);
  if (!excerpt) return null;
  return <div className="chat-search-excerpt message-content" role="note" aria-label={`Search match in ${excerpt.label.toLowerCase()}`}>
    <small>{excerpt.label}</small>
    <p>{excerpt.before}<mark className="chat-match current" data-search-start={hit.start}>{excerpt.match}</mark>{excerpt.after}</p>
  </div>;
}
