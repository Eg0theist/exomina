// Pending questions and approvals remain actionable when the app is hidden.
// All quiet-state checks and timers are local; no model requests are made here.
const clip = (value, max) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > max ? text.slice(0, max - 1) + '…' : text; };

export function attentionFor(event, chatTitle = '') {
  const where = clip(chatTitle, 60);
  if (event?.type === 'chat.question') {
    const group = event.question;
    if (!group || !['waiting', 'open'].includes(group.status)) return null;
    const count = (group.questions || []).length;
    return {key: 'question:' + group.id, conversationId: event.conversationId, title: where ? 'Question in “' + where + '”' : 'An AI has a question',
      body: clip(group.questions?.[0]?.question || 'An AI is waiting for your answer.', 180) + (count > 1 ? ' (+' + (count - 1) + ' more)' : '')};
  }
  if (event?.type === 'approval' && event.id)
    return {key: 'approval:' + event.id, conversationId: event.conversationId, title: where ? 'Approval needed in “' + where + '”' : 'Approval needed', body: clip(event.title || 'An AI is asking for permission.', 180)};
  return null;
}

export function createAttentionNotifier({attended, enabled, show, sound = () => {}, quiet = async () => false, titleOf = () => '', setTimer = setTimeout, clearTimer = clearTimeout, reminderMs = 180_000, retryMs = 30_000}) {
  const pending = new Map();
  const cancel = key => { const item = pending.get(key); if (item?.timer) clearTimer(item.timer); if(typeof item?.dismiss==='function')item.dismiss();pending.delete(key); };
  function schedule(item, delay) {
    item.timer = setTimer(() => deliver(item), delay);
    item.timer?.unref?.();
  }
  async function deliver(item) {
    item.timer = null;
    if (pending.get(item.note.key) !== item) return;
    try {
      if (await quiet()) { if (pending.get(item.note.key) === item) schedule(item, retryMs); return; }
      if (pending.get(item.note.key) !== item) return;
      const focused = attended();
      if (enabled() && !focused) { if(typeof item.dismiss==='function')item.dismiss();item.dismiss=show({...item.note, reminder: item.delivered > 0}); }
      sound({...item.note, focused, reminder: item.delivered > 0});
    } catch {
      // Failed OS delivery is not a delivered reminder. Retry for up to ten minutes.
      item.failures=(item.failures||0)+1;
      if(pending.get(item.note.key)===item && item.failures<=20)schedule(item,retryMs);
      return;
    }
    if (pending.get(item.note.key) !== item) return;
    item.delivered++;
    if (item.delivered < 3) schedule(item, reminderMs);
  }
  function onEvent(event) {
    if (event?.type === 'approval.resolved') { cancel('approval:' + event.id); return; }
    if (event?.type === 'chat.question' && !['waiting', 'open'].includes(event.question?.status)) { cancel('question:' + event.question?.id); return; }
    const note = attentionFor(event, event?.conversationId ? titleOf(event.conversationId) : '');
    if (!note || pending.has(note.key)) return;
    if (pending.size >= 200) cancel(pending.keys().next().value);
    const item = {note, delivered: 0, timer: null};
    pending.set(note.key, item);
    schedule(item, 0);
    return note;
  }
  onEvent.close = () => { for (const key of [...pending.keys()]) cancel(key); };
  onEvent.cancelChat = id => { for (const [key, item] of pending) if (item.note.conversationId === id) cancel(key); };
  return onEvent;
}
