import { chooseCompactionModel } from './chat-memory-compactor.mjs';

export const CHAT_MEMORY_REQUEST_LIMIT = 4;

// A lease belongs to one visible reply, never to a background queue or account.
export class ChatMemoryDemand {
  constructor({ getRun, getStats, enabled, requestLimit = CHAT_MEMORY_REQUEST_LIMIT }) {
    Object.assign(this, { getRun, getStats, enabled, requestLimit });
    this.spent = new WeakMap();
  }
  async eligible(chatId, expected) {
    if (!chatId || !this.enabled()) return null;
    const run = this.getRun(chatId);
    if (!run || run.cancelled || (expected && run !== expected) || (this.spent.get(run) || 0) >= this.requestLimit) return null;
    const stats = await this.getStats(chatId);
    // Maintenance's smaller compaction view is not a reason to spend allowance.
    if (!Number.isFinite(stats?.viewBytes) || !Number.isFinite(stats?.turnHigh) || stats.viewBytes <= stats.turnHigh) return null;
    return this.enabled() && this.getRun(chatId) === run && !run.cancelled ? run : null;
  }
  async choose(models, chatId) {
    const run = await this.eligible(chatId);
    if (!run) return null;
    const model = chooseCompactionModel(models.filter(model => model.provider === run.selection?.provider));
    return model ? { ...model, compactionTurn: run } : null;
  }
  async reserve(job, model) {
    const run = await this.eligible(job.chatId, model.compactionTurn);
    if (!run || run.selection?.provider !== model.provider) return false;
    const spent = this.spent.get(run) || 0;
    if (spent >= this.requestLimit) return false;
    this.spent.set(run, spent + 1);
    return true;
  }
}
