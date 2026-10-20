import { randomUUID } from 'node:crypto';
import { attachmentReferences, clipToolHistory, fingerprint, historyObject, historyText, recordableTool, splitHistory } from './chat-memory-records.mjs';
import { chatMemoryEnabled, formatChatView } from './chat-memory-context.mjs';
import { recallBlock, recallTerms } from './chat-memory-recall.mjs';

/** Bridges existing transcripts and visible runtime events to the immutable source log. */
export class ChatMemoryService {
  constructor({ tree, compactor, search = null, settings = () => ({}), isActive = () => false, isHostTool = () => false, isPrivate = () => false, onStatus = () => {} }) {
    Object.assign(this, { tree, compactor, search, settings, isActive, isHostTool, isPrivate, onStatus });
    this.queue = Promise.resolve(); this.imported = new Set(); this.positions = new Map(); this.buffers = new Map(); this.toolNames = new Map(); this.pendingOutputs = new Map(); this.removed = new Set(); this.seen = new Map(); this.chatStats = new Map(); this.catchingUp = new Map(); this.closed = false; this.lastError = null; this.failures = 0; this.batchDepth = 0;
  }
  enqueue(operation) {
    const next = this.queue.then(() => this.closed ? undefined : operation());
    this.queue = next.catch(error => { this.failures++; this.lastError = historyText(error.message || error).slice(0, 300); this.onStatus(this.status()); });
    return this.queue;
  }
  async record(chatId, event) {
    // Private chats never enter the tree or the search index.
    if (this.closed || this.removed.has(chatId) || this.isPrivate(chatId) || !chatMemoryEnabled(this.settings())) return;
    const key = `${chatId}\0${event.key}`;
    const revisable = /^(?:legacy:|followup:|question:|helper:)/.test(event.key), observation = revisable ? fingerprint(JSON.stringify(event)) : '';
    if (this.seen.has(key) && (!revisable || this.seen.get(key) === observation)) return;
    const text = historyText(event.text), chunks = event.kind === 'echo' ? [clipToolHistory(text)] : splitHistory(text);
    for (let index = 0; index < chunks.length; index++) {
      const source = { ...event, role: event.role || (event.kind === 'user' ? 'user' : ['tool','echo'].includes(event.kind) ? 'tool' : 'assistant'), key: `${event.key}:part:${index}`, text: chunks[index], metadata: historyObject({ ...event.metadata, ...(chunks.length > 1 ? { part: index + 1, parts: chunks.length } : {}) }) };
      try { await this.tree.append(chatId, source); }
      catch (error) {
        // Transcript cards/activity can acquire corrected dates or revised text.
        // Preserve both observed versions; never rewrite an immutable original.
        if (error.code !== 'CHAT_MEMORY_EVENT_CONFLICT' || !revisable) throw error;
        const revision = fingerprint(JSON.stringify([source.text, source.role, source.kind, source.createdAt ?? null, source.metadata]));
        await this.tree.append(chatId, { ...source, key: source.key + ':revision:' + revision, metadata: { ...source.metadata, revisedObservation: true, originalEventKey: source.key } });
      }
    }
    this.seen.set(key, observation); if (this.seen.size > 8192) this.seen.delete(this.seen.keys().next().value);
    if (!this.batchDepth) await this.publishStats(chatId);
  }
  async publishStats(chatId) { this.chatStats.set(chatId, await this.tree.stats(chatId)); this.compactor?.notify(chatId); this.search?.touch(chatId); this.onStatus(this.status(chatId)); }
  append(chatId, event) { return this.enqueue(() => this.record(chatId, event)); }
  async sync(chat) {
    if (!chat || this.removed.has(chat.id) || chat.private === true || this.isPrivate(chat.id) || !chatMemoryEnabled(this.settings())) return;
    await this.enqueue(async () => {
      this.batchDepth++;
      try {
      const first = !this.imported.has(chat.id), start = first ? 0 : Math.max(0, (this.positions.get(chat.id) || 0) - 2), messages = (chat.messages || []).slice(start);
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        const messageId = message.id || `legacy-${(chat.messages || []).length - messages.length + index}`;
        const createdAt = message.createdAt || message.startedAt || null;
        if (message.role === 'assistant' && this.isActive(chat.id) && !message.finishedAt) continue;
        if (!['user', 'assistant', 'system', 'tool'].includes(message.role)) continue;
        if (message.role === 'assistant' && !message.createdAt && !message.chatMemoryRecorded) for (const step of message.activity || []) {
          if (step.kind === 'thinking') continue;
          const base = `legacy:${messageId}:activity:${step.id || fingerprint(JSON.stringify(step))}`;
          if (step.kind === 'tool' && recordableTool(step.name)) {
            if (step.input) await this.record(chat.id, { key: base + ':input', kind: 'tool', text: `${step.name}\n${step.input}`, createdAt: step.startedAt || null, metadata: { legacy: true, sourceMessageId: messageId, availableToolExcerpt: true } });
            if (step.output || step.detail) await this.record(chat.id, { key: base + ':output', kind: 'echo', text: step.output || step.detail, createdAt: step.endedAt || null, metadata: { legacy: true, sourceMessageId: messageId, availableToolExcerpt: true } });
          } else if (step.kind === 'note' || step.kind === 'status') await this.record(chat.id, { key: base, kind: 'assistant', text: step.text || '', createdAt: step.endedAt || step.startedAt || null, metadata: { legacy: true, sourceMessageId: messageId } });
        }
        const content = String(message.content || '');
        const metadata = { sourceMessageId: messageId, provider: message.provider, failed: Boolean(message.error), attachments: attachmentReferences(message), legacy: !message.createdAt, dateKnown: Boolean(createdAt) };
        if (content || message.attachments?.length) await this.record(chat.id, { key: `message:${messageId}:${fingerprint(JSON.stringify([content,createdAt,metadata]))}`, kind: message.role === 'tool' ? 'echo' : message.error ? 'assistant_error' : message.role, role: message.role, text: content, createdAt, metadata });
        for (const item of message.followups || []) await this.recordFollowup(chat.id, item);
        for(const question of message.questions||[])await this.recordQuestion(chat.id,question);
        for (const helper of message.helpers || []) if (helper.text && helper.status === 'complete') await this.record(chat.id, { key: `helper:${helper.id}:complete`, kind: 'work', text: `[${helper.provider}/${helper.effectiveModel || helper.model}] ${helper.text}`, createdAt: helper.finishedAt || null, metadata: { provider: helper.provider } });
      }
      this.imported.add(chat.id);
      this.positions.set(chat.id, (chat.messages || []).length);
      } finally { this.batchDepth--; await this.publishStats(chat.id); }
    });
  }
  async recordFollowup(chatId, item) {
    if (item.text || item.question) await this.record(chatId, { key: `followup:${item.id}:user`, kind: 'user', text: item.text || item.question, createdAt: item.createdAt || item.queuedAt || null, metadata: { followupId: item.id } });
    if (item.answer) await this.record(chatId, { key: `followup:${item.id}:answer:${fingerprint(item.answer)}`, kind: 'assistant', text: item.answer, createdAt: item.finishedAt || null, metadata: { followupId: item.id, provider: item.provider } });
    if (item.taskStatus || item.summary) await this.record(chatId, { key: `followup:${item.id}:resolution:${fingerprint(JSON.stringify([item.taskStatus,item.summary,item.taskUpdatedAt||null]))}`, kind: 'work', text: `Follow-up ${item.id}: ${item.taskStatus || item.status || 'pending'}. ${item.summary || ''}`, createdAt: item.taskUpdatedAt || null, metadata: { followupId: item.id } });
  }
  async recordQuestion(chatId,group){
    await this.record(chatId,{key:'question:'+group.id+':asked',kind:'assistant',text:'Question card '+group.id+':\n'+JSON.stringify(group.questions),createdAt:group.createdAt||null,metadata:{questionId:group.id}});
    if(group.answers)await this.record(chatId,{key:'question:'+group.id+':answered:'+fingerprint(JSON.stringify(group.answers)),kind:'user',text:'User answers to question card '+group.id+':\n'+JSON.stringify(group.answers),createdAt:group.answeredAt||null,metadata:{questionId:group.id}});
    if(group.status==='irrelevant')await this.record(chatId,{key:'question:'+group.id+':irrelevant',kind:'work',text:'Question card '+group.id+' no longer relevant: '+group.reason,createdAt:null,metadata:{questionId:group.id}});
  }
  takeBuffer(chatId) { const buffer = this.buffers.get(chatId); this.buffers.delete(chatId); return buffer; }
  flushBuffer(chatId, buffer) {
    if (buffer?.text) return this.record(chatId, { key: `narration:${buffer.runId}:${randomUUID()}`, kind: 'assistant', text: buffer.text, createdAt: buffer.createdAt, metadata: { provider: buffer.provider, completedSegment: true } });
  }
  providerEvent(event, runId) {
    if (!event.conversationId || !runId || this.removed.has(event.conversationId) || this.isPrivate(event.conversationId) || !chatMemoryEnabled(this.settings())) return;
    if (event.type === 'chat.delta' && event.text) {
      const buffer = this.buffers.get(event.conversationId) || { text: '', runId, provider: event.provider, createdAt: new Date().toISOString() };
      buffer.text += event.text; this.buffers.set(event.conversationId, buffer); return;
    }
    if (['chat.tool', 'chat.retry', 'chat.notice'].includes(event.type)) { const buffer = this.takeBuffer(event.conversationId); this.enqueue(async () => {
      await this.flushBuffer(event.conversationId, buffer);
      const nameKey = `${event.conversationId}\0${runId}\0${event.id || event.name}`;
      if (event.name) { this.toolNames.set(nameKey, event.name); if (this.toolNames.size > 8192) this.toolNames.delete(this.toolNames.keys().next().value); }
      const name = event.name || this.toolNames.get(nameKey);
      if (event.type !== 'chat.tool' || !name || !recordableTool(name) || this.isHostTool(name)) return;
      const key = `native:${runId}:${event.id || name}`;
      if (event.input !== undefined) await this.record(event.conversationId, { key: key + ':input', kind: 'tool', text: `${name}\n${JSON.stringify(historyObject(event.input))}`, createdAt: new Date().toISOString() });
      // Streamed output grows by snapshot; keep only the latest per call and store it once the call ends.
      const output = event.historyOutput || event.output;
      if (output) { this.pendingOutputs.set(key, { chatId: event.conversationId, key, text: output, tool: name, status: event.status }); if (this.pendingOutputs.size > 4096) this.pendingOutputs.delete(this.pendingOutputs.keys().next().value); }
      else if (event.status && this.pendingOutputs.has(key)) this.pendingOutputs.get(key).status = event.status;
      if (['done', 'error'].includes(event.status) || (output && event.input !== undefined)) await this.flushOutput(key);
    }); }
  }
  async flushOutput(key) {
    const pending = this.pendingOutputs.get(key); if (!pending) return;
    this.pendingOutputs.delete(key);
    await this.record(pending.chatId, { key: key + ':output', kind: 'echo', text: pending.text, createdAt: new Date().toISOString(), metadata: { tool: pending.tool, status: pending.status } });
  }
  async flushChatOutputs(chatId) { for (const [key, pending] of [...this.pendingOutputs]) if (pending.chatId === chatId) await this.flushOutput(key); }
  hostCall(chatId, key, name, args) {
    const buffer = this.takeBuffer(chatId);
    return this.enqueue(async () => { await this.flushBuffer(chatId, buffer); if (recordableTool(name)) await this.record(chatId, { key: `host:${key}:input`, kind: 'tool', text: `${name}\n${JSON.stringify(historyObject(args))}`, createdAt: new Date().toISOString() }); });
  }
  hostResult(chatId, key, name, text) { return recordableTool(name) ? this.append(chatId, { key: `host:${key}:output`, kind: 'echo', text, createdAt: new Date().toISOString(), metadata: { tool: name } }) : Promise.resolve(); }
  emitted(event) {
    if(this.isPrivate(event.conversationId))return;
    if (event.type === 'chat.followup' && event.followup) this.enqueue(() => this.recordFollowup(event.conversationId, event.followup));
    if(event.type==='chat.question'&&event.question)this.enqueue(()=>this.recordQuestion(event.conversationId,event.question));
    if (event.type === 'chat.helper' && event.helper?.status === 'complete' && event.helper.text) this.append(event.conversationId, { key: `helper:${event.helper.id}:complete`, kind: 'work', text: `[${event.helper.provider}/${event.helper.effectiveModel || event.helper.model}] ${event.helper.text}`, createdAt: event.helper.finishedAt || null, metadata: { provider: event.helper.provider } });
  }
  async prepare(chat) {
    if(chat?.private===true||this.isPrivate(chat?.id))return {usable:false,text:'',lines:[],stats:{enabled:false}};
    try {
      const failures = this.failures;
      await this.sync(chat); await this.queue;
      this.catchUp(chat.id);
      if (this.failures !== failures) throw Error('The full chat log could not be updated. Recent-message context is being used.');
      const view = await this.tree.view(chat.id), formatted = formatChatView(view);
      this.chatStats.set(chat.id, await this.tree.stats(chat.id));
      this.lastError = null;
      return { ...formatted, view, stats: this.status(chat.id) };
    } catch (error) {
      this.lastError = String(error.message || error).slice(0,300); this.onStatus(this.status(chat.id));
      return { usable: false, text: '', lines: [], stats: this.status(chat.id) };
    }
  }
  /** Builds queued tool-only entries page by page in the background; SQLite only, never a model request. */
  catchUp(chatId) {
    if (this.catchingUp.has(chatId) || typeof this.tree.classifyDeterministic !== 'function') return this.catchingUp.get(chatId);
    const run = (async () => {
      let cursor = null, classified = 0;
      if (!await this.tree.deterministicPending?.(chatId)) return;
      do {
        if (this.closed || this.removed.has(chatId)) return;
        const page = await this.tree.classifyDeterministic(chatId, { cursor });
        cursor = page.cursor; classified += page.classified;
        await new Promise(resolve => setImmediate(resolve));
      } while (cursor);
      if (classified && !this.closed && !this.removed.has(chatId)) await this.publishStats(chatId);
    })().catch(() => {}).finally(() => this.catchingUp.delete(chatId));
    this.catchingUp.set(chatId, run);
    return run;
  }
  /** A few earlier passages matching concrete terms in the recent conversation. Never blocks or fails a reply. */
  recall(chat, messages, view) {
    try {
      if (!this.search || this.settings().chatMemoryRecall === false || !chatMemoryEnabled(this.settings())) return '';
      const terms = recallTerms(messages);
      if (!terms.length) return '';
      const entries = view?.entries || view?.nodes || [], newestId = view?.total ?? (entries.reduce((high, entry) => Math.max(high, (entry.id ?? 0) + (entry.count ?? 1)), 0) || Infinity);
      return recallBlock(this.search.find(terms.join(' '), { chatIds: [chat.id], limit: 12 }), { newestId, terms });
    } catch { return ''; }
  }
  clearToolNames(chatId) { for (const key of this.toolNames.keys()) if (key.startsWith(chatId+'\0')) this.toolNames.delete(key); }
  async finish(chat) { if(chat.private===true||this.isPrivate(chat.id))return; this.buffers.delete(chat.id); await this.enqueue(() => this.flushChatOutputs(chat.id)); await this.sync(chat); await this.queue; this.clearToolNames(chat.id); this.search?.touch(chat.id); }
  status(chatId) {
    return { enabled: chatMemoryEnabled(this.settings()), summariesEnabled: this.settings().chatMemorySummaries !== false && this.settings().chatMemoryOnDemand === true, ...(this.chatStats.get(chatId) || {}), background: this.compactor?.stats?.() || { state: 'starting' }, backfill: this.backfill?.status?.() || null, lastError: this.lastError };
  }
  async inspectSnapshot(chatId) {
    const pending = this.queue;
    await pending;
    if (this.removed.has(chatId) || this.isPrivate(chatId)) return { enabled: false, lastError: 'This chat is unavailable.' };
    const stats = await this.tree.stats(chatId);
    const progress = await this.tree.progress?.([chatId], { limit: 1 });
    return { ...this.status(chatId), ...stats, progress: progress?.totals || null, coverage: { transcriptSynced: this.imported.has(chatId), throughMessages: this.positions.get(chatId) || 0, pendingRecording: this.queue !== pending } };
  }
  async remove(chatId) { this.removed.add(chatId); this.buffers.delete(chatId); for (const [key, pending] of [...this.pendingOutputs]) if (pending.chatId === chatId) this.pendingOutputs.delete(key); await this.compactor?.cancelChat?.(chatId); await this.queue; this.clearToolNames(chatId); await this.tree.removeChat(chatId); await this.search?.remove(chatId); this.imported.delete(chatId); this.positions.delete(chatId); this.chatStats.delete(chatId); }
  async close() { await this.queue; this.closed = true; await Promise.allSettled([...this.catchingUp.values()]); this.buffers.clear(); await this.compactor?.close(); await this.search?.close(); await this.tree.close(); }
}
