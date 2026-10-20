/** Short stream batches reduce redraws; questions, approvals and completion flush immediately. */
export function createChatEventBuffer(deliver, { delay = 40, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer, closed = false, pending = [];
  const flush = () => {
    if (timer !== undefined) clearTimer(timer); timer = undefined;
    const events = pending; pending = [];
    if (!closed) for (const event of events) deliver(event);
  };
  return {
    accept(event) {
      if (closed) return;
      if (!['chat.delta', 'chat.activity'].includes(event.type)) { flush(); deliver(event); return; }
      const last = pending.at(-1);
      if (event.type === 'chat.delta' && last?.type === event.type && last.conversationId === event.conversationId) last.text += event.text || '';
      else pending.push({ ...event });
      if (pending.length >= 256) flush();
      else if (timer === undefined) timer = setTimer(flush, delay);
    },
    flush,
    close() { closed = true; if (timer !== undefined) clearTimer(timer); timer = undefined; pending = []; },
  };
}
