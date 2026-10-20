import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const HOUR = 3600_000, DAY = 24 * HOUR;
const MAX_LIMIT = 100000, MAX_TOKENS = 1_000_000_000, MINUTE = 60_000;
export const REQUEST_KINDS = Object.freeze(['reply', 'background', 'catchup']);
/** Per account. A reply is something you asked for in a chat; background is everything Exomina starts itself (helpers, summaries, titles, scheduled work). */
export const DEFAULT_REQUEST_LIMITS = Object.freeze({ enabled: true, reply: Object.freeze({ hour: 120, day: 600 }), background: Object.freeze({ hour: 30, day: 150 }),
  /** Estimated tokens sent to and received from pay-per-use API connections, per connection. Subscriptions are limited by request count only. */
  tokens: Object.freeze({ hour: 1_000_000, day: 5_000_000 }) });

const whole = (value, fallback, max = MAX_LIMIT) => Number.isSafeInteger(value) && value >= 1 && value <= max ? value : fallback;
export function normalizeRequestLimits(value) {
  const input = value && typeof value === 'object' ? value : {};
  const result = { enabled: input.enabled !== false };
  for (const kind of ['reply', 'background']) {
    const hour = whole(input[kind]?.hour, DEFAULT_REQUEST_LIMITS[kind].hour);
    result[kind] = { hour, day: Math.max(hour, whole(input[kind]?.day, DEFAULT_REQUEST_LIMITS[kind].day)) };
  }
  const hour = whole(input.tokens?.hour, DEFAULT_REQUEST_LIMITS.tokens.hour, MAX_TOKENS);
  result.tokens = { hour, day: Math.max(hour, whole(input.tokens?.day, DEFAULT_REQUEST_LIMITS.tokens.day, MAX_TOKENS)) };
  return result;
}

export class RequestLimitError extends Error {
  constructor(message, details) { super(message); this.name = 'RequestLimitError'; this.code = 'requestLimit'; Object.assign(this, details); }
}

/** Counts every model request Exomina starts and refuses further ones past a rolling hourly or daily limit,
 * so a bug can never quietly spend an account's allowance. Counts survive restarts. */
export class RequestGuard {
  constructor({ file, getLimits = () => DEFAULT_REQUEST_LIMITS, getCatchUpLimit = () => 300, now = Date.now, emit = () => {}, nameOf = id => id, writeDelay = 1000 } = {}) {
    Object.assign(this, { file, getLimits, getCatchUpLimit, now, emit, nameOf, writeDelay });
    this.events = new Map(); this.spent = new Map(); this.notified = new Map(); this.dirty = false; this.timer = null; this.writing = Promise.resolve(); this.closed = false;
  }
  async init() {
    if (!this.file) return this;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if(saved?.version!==1||!saved.events||typeof saved.events!=='object'||Array.isArray(saved.events))throw Error('Invalid request counter file.');
      if (saved?.version === 1 && saved.events && typeof saved.events === 'object') {
        const cutoff = this.now() - DAY;
        for (const [key, times] of Object.entries(saved.events)) {
          const recent = Array.isArray(times) ? times.filter(time => Number.isFinite(time) && time > cutoff && time <= this.now() + 60000) : [];
          if (recent.length && /^[\w-]+:(reply|background|catchup)$/.test(key)) this.events.set(key, recent);
        }
      }
      if (saved?.version === 1 && saved.spent && typeof saved.spent === 'object') {
        const cutoff = this.now() - DAY;
        for (const [provider, rows] of Object.entries(saved.spent)) {
          const recent = Array.isArray(rows) ? rows.filter(row => Array.isArray(row) && Number.isFinite(row[0]) && row[0] > cutoff && row[0] <= this.now() + 60000 && Number.isFinite(row[1]) && row[1] > 0) : [];
          if (recent.length && /^[\w-]+$/.test(provider)) this.spent.set(provider, recent.map(row => [row[0], row[1]]));
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') { this.persistenceError='The saved safety counters could not be read. Requests are paused to prevent resetting your budget. Restore the counter file or explicitly turn off safety limits in Settings → Usage.'; } }
    return this;
  }
  #recent(key, window) { const cutoff = this.now() - window, times = (this.events.get(key) || []).filter(time => time > cutoff); return times; }
  /** Read the effective request gate without counting, persisting or notifying. */
  availability({ provider, kind = 'reply' } = {}) {
    if (typeof provider !== 'string' || !REQUEST_KINDS.includes(kind)) throw new TypeError('A provider and request kind are required.');
    const limits = normalizeRequestLimits(this.getLimits());
    if (!limits.enabled && kind !== 'catchup') return { blocked: false };
    if (this.persistenceError) return { blocked: true, reason: 'storage', retryAt: null };
    const times = this.#recent(`${provider}:${kind}`, DAY), blocks = [];
    for (const [window, span] of [['hour', HOUR], ['day', DAY]]) {
      const recent = times.filter(time => time > this.now() - span).sort((a, b) => a - b), max = kind === 'catchup' ? (window === 'hour' ? this.getCatchUpLimit() : null) : limits[kind][window];
      if (max === null) continue;
      if (recent.length >= max) blocks.push({ blocked: true, reason: window, window, used: recent.length, max, retryAt: recent[recent.length - max] + span });
    }
    return blocks.sort((a, b) => b.retryAt - a.retryAt)[0] || { blocked: false };
  }
  /** Records one request, or throws RequestLimitError without recording it. */
  check({ provider, kind = 'reply' } = {}) {
    if (typeof provider !== 'string' || !REQUEST_KINDS.includes(kind)) throw new TypeError('A provider and request kind are required.');
    const key = `${provider}:${kind}`, block = this.availability({ provider, kind });
    if(block.reason === 'storage')throw new RequestLimitError(this.persistenceError,{provider,kind});
    const times = this.#recent(key, DAY);
    if (block.blocked) {
      const { window, used, max, retryAt } = block, label = window === 'hour' ? 'in the last hour' : 'in the last 24 hours';
      const name = this.nameOf(provider), what = kind === 'reply' ? 'chat replies' : kind === 'catchup' ? 'memory catch-up requests' : 'background requests';
      const location = kind === 'catchup' ? 'Settings → Privacy & data → Memory & privacy' : 'Settings → Usage → Safety limits';
      const error = new RequestLimitError(`Exomina paused ${what} to ${name}: ${used} were started ${label} and the safety limit is ${max}. This is Exomina's own safeguard, not your plan's limit. Raise it under ${location} if this was intended.`, { provider, kind, window, used, max, retryAt });
      const stamp = `${key}:${window}`;
      if (this.now() - (this.notified.get(stamp) || 0) > HOUR) { this.notified.set(stamp, this.now()); this.emit({ type: 'guard.tripped', provider, kind, window, used, max, message: error.message }); }
      throw error;
    }
    times.push(this.now()); this.events.set(key, times); this.#schedule();
  }
  #tokens(provider, window) { const cutoff = this.now() - window; return (this.spent.get(provider) || []).filter(row => row[0] > cutoff).reduce((sum, row) => sum + row[1], 0); }
  /** Refuses to start another API round once the estimated tokens already spent pass the hourly or daily limit. */
  checkTokens(provider, pending = 0) {
    if (typeof provider !== 'string') throw new TypeError('A provider is required.');
    const limits = normalizeRequestLimits(this.getLimits());
    if (!limits.enabled) return;
    if(this.persistenceError)throw new RequestLimitError(this.persistenceError,{provider,kind:'tokens'});
    for (const [window, span, max, label] of [['hour', HOUR, limits.tokens.hour, 'in the last hour'], ['day', DAY, limits.tokens.day, 'in the last 24 hours']]) {
      const used = this.#tokens(provider, span);
      if (used >= max || used + pending > max) {
        const name = this.nameOf(provider);
        const error = new RequestLimitError(`Exomina paused ${name}: ${used.toLocaleString('en-US')} estimated tokens are already reserved ${label}${pending ? `; the next round needs ${Math.ceil(pending).toLocaleString('en-US')} more` : ''}. The safety limit is ${max.toLocaleString('en-US')}. Raise it under Settings → Usage → Safety limits if this was intended.`, { provider, kind: 'tokens', window, used, max });
        const stamp = `${provider}:tokens:${window}`;
        if (this.now() - (this.notified.get(stamp) || 0) > HOUR) { this.notified.set(stamp, this.now()); this.emit({ type: 'guard.tripped', provider, kind: 'tokens', window, used, max, message: error.message }); }
        throw error;
      }
    }
  }
  /** Reserve the next API round before sending it. Persistence failure stops dispatch; concurrent rounds share the cap. */
  async reserveTokens(provider, tokens) {
    this.checkTokens(provider,tokens);
    this.addTokens(provider,tokens);
    await this.flush();
  }
  async checkAndPersist(request) { this.check(request); await this.flush(); }
  /** Adds an estimate of tokens sent or received. Always recorded, even with the limits off, so the display stays honest. */
  addTokens(provider, tokens) {
    if (typeof provider !== 'string' || !Number.isFinite(tokens) || tokens <= 0) return;
    const rows = this.spent.get(provider) || [], stamp = Math.floor(this.now() / MINUTE) * MINUTE, last = rows[rows.length - 1];
    if (last && last[0] === stamp) last[1] += Math.ceil(tokens); else rows.push([stamp, Math.ceil(tokens)]);
    this.spent.set(provider, rows); this.#schedule();
  }
  /** Counts for display, newest window first. */
  view() {
    const limits = normalizeRequestLimits(this.getLimits()), used = {};
    for (const key of this.events.keys()) {
      const [provider, kind] = key.split(':');
      (used[provider] ||= {})[kind] = { hour: this.#recent(key, HOUR).length, day: this.#recent(key, DAY).length };
    }
    const tokens = {};
    for (const provider of this.spent.keys()) tokens[provider] = { hour: this.#tokens(provider, HOUR), day: this.#tokens(provider, DAY) };
    return { limits, defaults: normalizeRequestLimits(null), catchUp: { hour: this.getCatchUpLimit(), day: null }, used, tokens, error:this.persistenceError||'' };
  }
  #schedule() {
    this.dirty = true;
    if (this.timer || !this.file || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.writeDelay);
    this.timer.unref?.();
  }
  flush() {
    if(this.persistenceError&&normalizeRequestLimits(this.getLimits()).enabled)return Promise.reject(new RequestLimitError(this.persistenceError,{}));
    if (!this.file || !this.dirty) return this.writing;
    this.dirty = false;
    const cutoff = this.now() - DAY, events = {};
    for (const [key, times] of this.events) { const recent = times.filter(time => time > cutoff); if (recent.length) events[key] = recent; else this.events.delete(key); }
    const spent = {};
    for (const [provider, rows] of this.spent) { const recent = rows.filter(row => row[0] > cutoff); if (recent.length) spent[provider] = recent; else this.spent.delete(provider); }
    const text = JSON.stringify({ version: 1, events, spent });
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, text, { mode: 0o600 }); await rename(temp, this.file);
    });
    return this.writing;
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.timer = null; this.dirty = true; await this.flush().catch(() => {}); }
}
