import { useLayoutEffect, useRef, useState } from 'react';

/** Follow a growing inner scroll pane until the reader moves away from its bottom. */
export default function useFollowScroll(active, resetKey) {
  const ref = useRef(null), following = useRef(true);
  const [paused, setPaused] = useState(false);
  const onScroll = event => {
    const el = event.currentTarget;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    setPaused(!following.current);
  };
  const resume = () => {
    following.current = true; setPaused(false);
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  };
  useLayoutEffect(() => { resume(); }, [resetKey]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const follow = () => { if (following.current) el.scrollTop = el.scrollHeight; };
    follow();
    const resize = new ResizeObserver(follow);
    for (const child of el.children) resize.observe(child);
    const mutations = new MutationObserver(() => { for (const child of el.children) resize.observe(child); follow(); });
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { resize.disconnect(); mutations.disconnect(); };
  }, [active]);
  return { ref, onScroll, paused, resume };
}
