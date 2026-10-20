import { randomUUID } from 'node:crypto';
import { FOLLOWUP_READ_INSTRUCTIONS, readFollowupTool } from './followup-tools.mjs';

export const followupInstructions = 'The user sent a follow-up during ongoing work. Answer questions and status requests briefly now, then continue the original task. Incorporate corrections, clarifications and additional work into the task before finishing. Call followup_update with the supplied id when you start handling it, and again with handled plus a concrete summary once answered or completed and verified. Use blocked with the reason if user input or an external limitation prevents completion. Keep unfinished original work active unless the user explicitly asks to stop or replace it.\n';

export const FOLLOWUP_TOOL = {
  name: 'followup_update',
  description: 'Track a user follow-up received during this task. Mark working when you pick it up; mark handled only after answering the question or doing and verifying the requested work. Supply a concrete summary. If required input, permission or an external limitation prevents completion, mark blocked and explain it. A parallel answer alone does not complete a request for changes. Resolve every supplied follow-up id before your final reply.',
  inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 100 }, status: { type: 'string', enum: ['working', 'handled', 'blocked'] }, summary: { type: 'string', maxLength: 2000 } }, required: ['id', 'status'], additionalProperties: false },
};
const terminal = item => ['handled', 'blocked', 'cancelled'].includes(item.taskStatus);

export function followupTranscript(message) {
  return (message.followups || []).map(item => ({ id: item.id, question: item.text, provider: item.provider, model: item.model, mode: item.mode, status: item.status, answer: item.answer, error: item.error, taskStatus: item.taskStatus, summary: item.summary }));
}

/** Directions reach the native task while a brief read-only reply runs alongside it. */
export class LiveFollowups {
  constructor({ getRun, getChat, prepare, steer, execute, stop, save, emit, settled = () => {} }) {
    Object.assign(this, { getRun, getChat, prepare, steer, execute, stop, save, emit, settled });
    this.routes = new Map(); this.pending = new Map(); this.inputs = new Map();
  }
  get busy() { return this.pending.size > 0; }
  parent(id) { return this.routes.get(id); }
  readScope(id) {
    const work = this.pending.get(id);
    return work && this.routes.get(id) === work.parent ? work : null;
  }
  liveRead(work) { return !work.cancelled && !work.run.cancelled && this.getRun(work.parent) === work.run && work.item.status === 'answering'; }
  async read(id, name, args, dispatch) {
    const work = this.readScope(id);
    if (!work) throw Error('This follow-up answer has stopped.');
    return readFollowupTool(work, name, args, { live: () => this.liveRead(work), dispatch: (tool, input) => dispatch(tool, input, work.parent), publish: () => this.publish(work.parent, work.run.message, work.item) });
  }
  publish(parent, message, item) {
    this.emit({ type: 'chat.followup', conversationId: parent, messageId: message.id, followup: structuredClone(item) });
  }
  async send(payload) {
    const parent = payload.conversationId, run = this.getRun(parent);
    if (!run || run.cancelled || run.acceptingFollowups === false) throw Error('The task has finished. Send your message again as a normal reply.');
    if ([...this.pending.values()].filter(item => item.parent === parent).length >= 10) throw Error('Up to ten follow-ups can be in progress at once.');
    if (this.pending.size >= 6) throw Error('Wait for one of the current follow-up answers to finish.');
    const item = { id: randomUUID(), text: payload.text.trim(), provider: payload.provider, model: payload.model,
      createdAt: new Date().toISOString(), status: 'sending', taskStatus: 'pending', attachments: [], ...(payload.questionId ? { questionId: payload.questionId } : {}) };
    run.message.followups ??= []; run.message.followups.push(item);
    const work = { parent, run, item, cancelled: false };
    // Reserve before asynchronous attachment preparation: finishing must wait for accepted input.
    work.done = new Promise(resolve => { work.release = resolve; });
    this.pending.set(item.id, work);
    let prepared;
    try {
      prepared = await this.prepare(payload, run);
      if (this.getRun(parent) !== run || run.cancelled) throw Error('The task stopped while preparing your message. Send it again.');
      Object.assign(item, { provider: prepared.selection.provider, model: prepared.selection.model, attachments: prepared.attachments || [] });
      this.inputs.set(item.id, prepared);
      await this.save();
    } catch (error) {
      this.pending.delete(item.id); this.inputs.delete(item.id); work.release();
      run.message.followups = run.message.followups.filter(entry => entry !== item); throw error;
    }
    this.publish(parent, run.message, item);
    work.promise = this.perform(work, prepared).finally(() => { this.pending.delete(item.id); this.routes.delete(item.id); work.release(); this.settled(); });
    work.promise.catch(() => {});
    return { conversationId: parent, followup: item.id };
  }
  async perform(work, prepared) {
    const { parent, run, item } = work;
    try {
      if (work.cancelled || run.cancelled) throw Error('Stopped.');
      const delivery = Promise.resolve().then(() => this.steer(parent, prepared, item.id)).then(delivered => {
        item.deliveredToMain = !!delivered; if (!work.cancelled && !run.cancelled) this.publish(parent, run.message, item);
      }, error => { item.deliveryError = String(error.message || error).slice(0, 1000); });
      // Delivery and the answer are independent: a slow native steer must not
      // hold up a question. Only the main task can perform or verify changes.
      item.mode = 'parallel'; item.status = 'answering';
        this.routes.set(item.id, parent);
        await this.save(); this.publish(parent, run.message, item);
        const snapshot = this.snapshot(this.getChat(parent), run.message);
        const answer = Promise.resolve().then(() => this.execute({ ...prepared, conversationId: item.id, parentId: parent, prompt:
          'Answer the user\'s follow-up while their original task continues. ' + (prepared.readOnlyTools === false ? 'This provider supports tool-free side answers only. ' : FOLLOWUP_READ_INSTRUCTIONS) + 'Use the supplied conversation and visible work as source material; do not invent completed actions or hidden runtime state. Answer briefly and directly. Requests to change or extend the work are also tracked for the main task to handle before it finishes; explain this when relevant, without claiming the changes are already done.\nConversation and work snapshot:\n' + snapshot + '\nUser follow-up:\n' + prepared.prompt })).then(result => {
            if (!work.cancelled && !run.cancelled) { item.answer = String(result.text || '').slice(0, 100000); item.status = 'answered'; this.publish(parent, run.message, item); }
            return result;
          });
        const [reply] = await Promise.allSettled([answer, delivery]);
        if (reply.status === 'rejected') throw reply.reason;
        if (work.cancelled || run.cancelled) throw Error('Stopped.');
    } catch (error) {
      item.status = 'failed'; item.error = String(error.message || error).slice(0, 1000);
    } finally {
      item.finishedAt = new Date().toISOString();
      await this.save(); this.publish(parent, run.message, item);
    }
  }
  unresolved(run) { return (run.message.followups || []).filter(item => item.taskStatus && !terminal(item)); }
  async update(parent, { id, status, summary }) {
    const run = this.getRun(parent), item = run?.message.followups?.find(entry => entry.id === id);
    if (!run || run.cancelled || !item) throw Error('This follow-up does not belong to the active task.');
    if (!['working', 'handled', 'blocked'].includes(status)) throw Error('Choose working, handled or blocked.');
    if (item.taskStatus === 'cancelled') throw Error('This follow-up was stopped.');
    if (typeof summary !== 'undefined' && (typeof summary !== 'string' || summary.length > 2000)) throw Error('Use a short follow-up summary.');
    if (status !== 'working' && !summary?.trim()) throw Error('Explain what was completed or what prevents completion.');
    // The first pickup anchors the card at this point in the timeline, above subsequent work.
    if (!item.activityId) {
      item.activityId = 'followup:' + item.id;
      const step = { id: item.activityId, kind: 'followup', followupId: item.id, status: 'running', startedAt: new Date().toISOString() };
      if (run.activity) { run.activity.cut(); run.activity.add(step); }
      else { run.message.activity ??= []; run.message.activity.push(step); }
    }
    item.taskStatus = status;
    if (summary?.trim()) item.summary = summary.trim();
    if (status !== 'working') {
      item.handledAt = new Date().toISOString();
      const step = run.message.activity?.find(entry => entry.id === item.activityId);
      if (step) { step.status = status === 'handled' ? 'done' : 'denied'; step.endedAt = item.handledAt; run.activity?.send(step); }
    }
    await this.save(); this.publish(parent, run.message, item);
    return { id, status, summary: item.summary };
  }
  async settle(parent) {
    for (;;) {
      const work = [...this.pending.values()].filter(entry => entry.parent === parent);
      if (!work.length) return;
      await Promise.all(work.map(entry => entry.done));
    }
  }
  async failed(parent, reason) {
    const run = this.getRun(parent);
    if (!run) return;
    await this.settle(parent); run.acceptingFollowups = false;
    for (const item of this.unresolved(run)) await this.update(parent, { id: item.id, status: 'blocked', summary: 'The main task could not continue: ' + String(reason || 'Unknown error').slice(0,1000) + '. Continue this task to retry the follow-up.' });
    for (const item of run.message.followups || []) this.inputs.delete(item.id);
  }
  batch(items) {
    const selected = []; let chars = 0, bytes = 0, files = 0;
    for (const item of items) {
      const prepared = this.inputs.get(item.id), size = (prepared?.prompt || item.text || '').length;
      const attached = prepared?.attachments || item.attachments || [], addedBytes = attached.reduce((n, file) => n + (file.bytes || 0), 0);
      if (selected.length && (chars + size > 120000 || files + attached.length > 10 || bytes + addedBytes > 20 * 1024 * 1024 || selected.length >= 10)) break;
      selected.push(item); chars += size; files += attached.length; bytes += addedBytes;
    }
    return selected;
  }
  /** A provider turn ending is not task completion while a user's follow-up is outstanding. */
  async beforeComplete(parent, result, resume) {
    const run = this.getRun(parent), attempts = new Map();
    if (!run) throw Error('The task has stopped.');
    for (;;) {
      run.completedResult = result;
      await this.settle(parent);
      if (run.cancelled) throw Error('Stopped.');
      const outstanding = this.unresolved(run);
      if (!outstanding.length) {
        // No asynchronous gap between the last check and closing admission.
        run.acceptingFollowups = false;
        for (const item of run.message.followups || []) this.inputs.delete(item.id);
        const blocked = (run.message.followups || []).filter(item => item.taskStatus === 'blocked');
        if (blocked.length) result = { ...result, text: String(result.text || '') + '\n\nFollow-ups needing attention:\n' + blocked.map(item => '- ' + item.text.slice(0,200) + ': ' + item.summary).join('\n') };
        return result;
      }
      const items = this.batch(outstanding);
      for (const item of items) { attempts.set(item.id, (attempts.get(item.id) || 0) + 1); await this.update(parent, { id: item.id, status: 'working' }); }
      const prepared = items.map(item => this.inputs.get(item.id));
      const prompt = 'Continue the original task before issuing its final answer. These user follow-ups were accepted while work was active and still need disposition from the main task. Incorporate requested changes and verify them. Brief questions already answered alongside the task may simply be confirmed; a parallel answer does not implement requested changes. Do not repeat completed actions. For each id call followup_update with handled and a concrete result, or blocked and the precise limitation. Then give one final answer covering the original task and these follow-ups.\nFollow-ups:\n' + JSON.stringify(items.map((item, index) => ({ id: item.id, request: prepared[index]?.prompt || item.text, parallelAnswer: item.answer, previousSummary: item.summary }))) + '\nVisible work checkpoint:\n' + this.snapshot(this.getChat(parent), run.message);
      result = await resume({ items, prompt, images: prepared.flatMap(input => input?.images || []), files: prepared.flatMap(input => input?.files || []), attachments: items.flatMap(item => item.attachments || []) });
      if (run.cancelled) throw Error('Stopped.');
      for (const item of items) if (!terminal(item) && attempts.get(item.id) >= 2) await this.update(parent, { id: item.id, status: 'blocked', summary: 'The model ended without confirming completion of this follow-up. Continue the task to retry it.' });
    }
  }
  snapshot(chat, message) {
    const work = (message.activity || []).filter(step => ['note', 'tool', 'status'].includes(step.kind)).slice(-12)
      .map(({ kind, status, name, title, text, output }) => ({ kind, status, name, title, text: text?.slice(-1000), output: output?.slice(-1500) }));
    const messages = []; let used = JSON.stringify({ work }).length;
    for (const m of (chat.messages || []).slice(-12).reverse()) {
      const entry = { role: m.role, content: String(m.content || '').slice(-9000), followups: followupTranscript(m).slice(-4)
        .map(item => ({ ...item, question: item.question?.slice(-2000), answer: item.answer?.slice(-2500) })) };
      const size = JSON.stringify(entry).length;
      if (used + size > 78000) break;
      messages.unshift(entry); used += size;
    }
    return JSON.stringify({ messages, work });
  }
  handle(event) {
    const parent = this.routes.get(event.conversationId), work = this.pending.get(event.conversationId);
    if (!parent || !work) return false;
    if (event.type === 'chat.delta' && !work.cancelled) {
      work.item.answer = ((work.item.answer || '') + event.text).slice(0, 100000);
      this.publish(parent, work.run.message, work.item);
    }
    return event.type !== 'usage';
  }
  cancel(parent) {
    for (const work of this.pending.values()) if (work.parent === parent) { work.cancelled = true; this.stop(work.item.id); }
    const run = this.getRun(parent);
    for (const item of run?.message.followups || []) { if (!terminal(item)) { item.taskStatus = 'cancelled'; this.publish(parent, run.message, item); } this.inputs.delete(item.id); }
  }
  cancelOne(parent, id) {
    const work = this.pending.get(id);
    if (!work || work.parent !== parent || work.item.mode !== 'parallel' || work.item.status !== 'answering') return false;
    work.cancelled = true;
    // Stopping a side answer cannot withdraw a direction already delivered to
    // the main task (or a native delivery that is still being confirmed).
    if (work.item.deliveredToMain === false) { work.item.taskStatus = 'cancelled'; this.inputs.delete(id); }
    this.stop(id); return true;
  }
  close() { this.inputs.clear(); for (const work of this.pending.values()) { work.cancelled = true; this.stop(work.item.id); } }
}
