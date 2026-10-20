export const USAGE_REFRESH_MS = 60_000;

/** Metadata only. Each account refreshes independently; concurrent triggers share a request. */
export class UsagePoller {
  constructor({ providers, tracker, connected, interval = USAGE_REFRESH_MS, timers = globalThis }) {
    Object.assign(this, { providers, tracker, connected, interval, timers });
    this.pending = new Map();
    this.stopped = false;
  }
  start() {
    if (this.timer || this.stopped) return;
    this.refresh();
    this.timer = this.timers.setInterval(() => this.refresh(), this.interval);
    this.timer?.unref?.();
  }
  /** details also reads per-credit reset details (expiry); background polls skip that lookup. */
  async refresh({ details = false } = {}) {
    if (this.stopped) return this.tracker.snapshot();
    const ids = ['claude', 'codex', 'muse-code'].filter(id => this.connected(id) && (id !== 'muse-code' || typeof this.providers.museUsage === 'function'));
    await Promise.allSettled(ids.map(id => this.refreshProvider(id, { details: details && id === 'codex' })));
    return this.tracker.snapshot();
  }
  refreshProvider(id, { details = false } = {}) {
    if (this.stopped) return Promise.resolve();
    const key = details ? `${id}:details` : id;
    if (this.pending.has(key)) return this.pending.get(key);
    this.tracker.refreshing(id);
    const task = Promise.resolve().then(() => id === 'claude' ? this.providers.claudeUsage({ publish: false }) : id === 'muse-code' ? this.providers.museUsage({ publish: false }) : this.providers.codexUsage({ publish: false, ...(details ? { details: true } : {}) }))
      .then(raw => { if (!this.stopped && this.connected(id) && !this.tracker.update(id, raw)) throw new Error('The provider did not return usage percentages.'); })
      .catch(error => { if (!this.stopped && this.connected(id)) this.tracker.failed(id, error); })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  stop() {
    this.stopped = true;
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
  }
}
