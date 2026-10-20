/** Serialize state reads and combine a burst into one trailing fresh read. */
export function createCoalescedRefresh(work) {
  let pending = null, dirty = false;
  return () => {
    dirty = true;
    // Native IPC notifications arrive in separate event-loop turns. A short
    // frame-sized window combines those too, without losing a trailing change.
    if (!pending) pending = new Promise(resolve=>setTimeout(resolve,16)).then(async () => {
      while (dirty) { dirty = false; await work(); }
    }).finally(() => { pending = null; });
    return pending;
  };
}
