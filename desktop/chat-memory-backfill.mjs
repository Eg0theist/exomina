import { readFile } from 'node:fs/promises';
import { durableReplace } from './durable-state.mjs';
import { usageStale } from './usage.mjs';

export const BACKFILL_PROVIDER = 'codex';
// Subscriptions whose usage windows Exomina can read; the spare-allowance guard needs them.
export const BACKFILL_PROVIDERS = ['codex', 'claude', 'muse-code'];
// Recommended starts light; repeated invalid output on one source may use the balanced fallback.
export const BACKFILL_MODELS = ['gpt-6-luna', 'gpt-6.1-sol'];
export const BACKFILL_EFFORT = 'high';
export const BACKFILL_DAILY_CAP = 1500;
export const BACKFILL_MAX_DAILY_CAP = 20000;
export const BACKFILL_HOURLY_CAP = 300;
export const BACKFILL_MAX_HOURLY_CAP = 20000;
/** Rolling hourly dispatch limit, independent of other background work. */
export function backfillHourlyCap(settings = {}) {
  const value = settings.chatMemoryBackfillHourlyCap;
  return value === null ? null : Number.isInteger(value) && value >= 1 && value <= BACKFILL_MAX_HOURLY_CAP ? value : BACKFILL_HOURLY_CAP;
}
// Default pause threshold; null in settings disables the percentage guard.
export const BACKFILL_USAGE_CEILING = 50;
const REFRESH_INTERVAL_MS = 10 * 60_000;

// On unless switched off: the owner chose capped ChatGPT catch-up on 2026-10-20.
export function backfillEnabled(settings = {}) { return settings.chatMemoryEnabled !== false && settings.chatMemoryBackfill !== false; }
/** null means no daily limit; a missing or invalid value means the default. */
export function backfillCap(settings = {}) {
  if (settings.chatMemoryBackfillDailyCap === null) return Infinity;
  const cap = settings.chatMemoryBackfillDailyCap;
  return Number.isInteger(cap) && cap >= 0 && cap <= BACKFILL_MAX_DAILY_CAP ? cap : BACKFILL_DAILY_CAP;
}
export function backfillUsageCeiling(settings = {}) {
  const value = settings.chatMemoryBackfillUsageCeiling;
  if (value === null) return null;
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : BACKFILL_USAGE_CEILING;
}
/** A chosen {provider, model, effort}, or null for the default. */
export function backfillChoice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { provider, model, effort = '' } = value;
  if (!BACKFILL_PROVIDERS.includes(provider) || typeof model !== 'string' || !model || model.length > 300 || typeof effort !== 'string' || effort.length > 30) return null;
  return { provider, model, effort };
}
export function backfillProvider(settings = {}) { return backfillChoice(settings.chatMemoryBackfillModel)?.provider || BACKFILL_PROVIDER; }
export function localDay(now = Date.now()) {
  const date = new Date(now), pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function chooseBackfillModel(models, choice = null) {
  if (!Array.isArray(models)) return null;
  const chosen = backfillChoice(choice);
  if (chosen) {
    // An explicit choice never silently falls back to another model or provider.
    const model = models.find(item => item.available && item.provider === chosen.provider && item.model === chosen.model);
    if (!model) return null;
    if (chosen.effort && !model.efforts?.includes(chosen.effort)) return null;
    const effort = chosen.effort || model.defaultEffort || '';
    return { ...model, effort };
  }
  const codex = models.filter(model => model.available && model.provider === BACKFILL_PROVIDER);
  for (const id of BACKFILL_MODELS) {
    const model = codex.find(item => item.model === id);
    if (model) return { ...model, effort: model.efforts?.includes(BACKFILL_EFFORT) ? BACKFILL_EFFORT : model.defaultEffort || '' };
  }
  return null;
}

/** Why backfill may not spend ChatGPT allowance now, or '' when it may. */
export function backfillUsageBlock(entry, now = Date.now(), ceiling = BACKFILL_USAGE_CEILING) {
  // Disabling the percentage guard does not bypass reported provider limits.
  if (entry?.ordinaryUsageAllowed === false) return 'usage-limit';
  if (ceiling === null) return '';
  if (!entry || usageStale(entry, now) || !Array.isArray(entry.windows) || !entry.windows.length) return 'usage-unknown';
  if (entry.windows.some(item => !item || !Number.isFinite(item.usedPercent) || item.usedPercent < 0 || item.usedPercent > 100 || (item.resetsAt && !Number.isFinite(Date.parse(item.resetsAt))))) return 'usage-unknown';
  if (entry.windows.some(item => item.resetsAt && Date.parse(item.resetsAt) <= now)) return 'usage-unknown';
  return entry.windows.some(item => !(item.usedPercent < ceiling)) ? 'usage-high' : '';
}

/**
 * Idle catch-up of older chat-memory summaries on a subscription (ChatGPT by
 * default). Every model request, including retries, is counted against a daily
 * cap that survives restarts. Requests stop while any usage window of the chosen
 * provider is at or above the ceiling, or while usage cannot be verified.
 */
export class ChatMemoryBackfill {
  constructor({ file, getSettings, getUsage, getRequestAvailability = () => ({ blocked: false }), refreshUsage = () => {}, onUsageRefreshed = () => {}, now = Date.now, writeCounter = durableReplace }) {
    Object.assign(this, { file, getSettings, getUsage, getRequestAvailability, refreshUsage, onUsageRefreshed, now, writeCounter });
    this.counter = { day: localDay(now()), requests: 0 };
    this.reason = ''; this.lastRefresh = 0; this.storageFailedDay = ''; this.writing = Promise.resolve();
  }
  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(saved?.day) || !Number.isSafeInteger(saved.requests) || saved.requests < 0) throw new Error('Invalid catch-up counter.');
      this.counter = { day: saved.day, requests: saved.requests };
    } catch (error) { if (error.code !== 'ENOENT') this.storageFailedDay = localDay(this.now()); }
    return this;
  }
  #today() {
    const day = localDay(this.now());
    if (this.counter.day !== day) this.counter = { day, requests: 0 };
    return this.counter;
  }
  blocked({ refresh = true } = {}) {
    const settings = this.getSettings();
    if (!backfillEnabled(settings)) return 'off';
    const counter = this.#today();
    if (this.storageFailedDay === counter.day) return 'storage';
    if (counter.requests >= backfillCap(settings)) return 'daily-cap';
    const safety = this.getRequestAvailability(backfillProvider(settings));
    if (safety?.blocked) return safety.reason === 'storage' ? 'safety-storage' : safety.window === 'day' ? 'safety-day' : 'safety-hour';
    const provider = backfillProvider(settings), entry = this.getUsage()?.[provider], reason = backfillUsageBlock(entry, this.now(), backfillUsageCeiling(settings));
    if (refresh && (reason === 'usage-unknown' || !entry || usageStale(entry, this.now())) && this.now() - this.lastRefresh >= REFRESH_INTERVAL_MS) {
      this.lastRefresh = this.now();
      // Usage is stale after minutes; wake right after the refresh instead of at the next timer.
      Promise.resolve().then(() => this.refreshUsage(provider)).then(() => this.onUsageRefreshed()).catch(() => {});
    }
    return reason;
  }
  async choose(models) {
    this.reason = this.blocked();
    if (this.reason) return null;
    const model = chooseBackfillModel(models, this.getSettings().chatMemoryBackfillModel);
    if (!model) { this.reason = 'unavailable'; return null; }
    return { ...model, backfill: true };
  }
  fallback(models, current) {
    // Explicit selections remain exact. Recommended may adapt only within the
    // same subscription, under the ordinary usage/reservation checks.
    if (backfillChoice(this.getSettings().chatMemoryBackfillModel) || this.blocked() || !current?.backfill || current.provider !== BACKFILL_PROVIDER || current.model !== BACKFILL_MODELS[0]) return null;
    const model = chooseBackfillModel(models.filter(item => item.model === BACKFILL_MODELS[1]));
    return model ? { ...model, backfill: true } : null;
  }
  authorized(model) {
    const settings = this.getSettings(), choice = backfillChoice(settings.chatMemoryBackfillModel);
    if (!model?.backfill || !backfillEnabled(settings) || model.provider !== backfillProvider(settings) || this.storageFailedDay === localDay(this.now())) return false;
    if (this.getRequestAvailability(model.provider)?.blocked) return false;
    if (this.#today().requests > backfillCap(settings)) return false;
    if (choice ? choice.model !== model.model || (choice.effort && choice.effort !== model.effort) : !BACKFILL_MODELS.includes(model.model)) return false;
    return !backfillUsageBlock(this.getUsage()?.[model.provider], this.now(), backfillUsageCeiling(settings));
  }
  async reserve(job, model) {
    if (!model?.backfill) return false;
    this.reason = this.blocked();
    if (this.reason || !this.authorized(model)) return false;
    const choice = backfillChoice(this.getSettings().chatMemoryBackfillModel);
    const counter = this.#today();
    counter.requests++;
    const text = JSON.stringify(counter);
    // Count before the request; a failed write must not let requests run uncounted.
    this.writing = this.writing.catch(() => {}).then(() => this.writeCounter(this.file, text));
    try { await this.writing; } catch { this.storageFailedDay = counter.day; this.reason = 'storage'; return false; }
    // A settings edit or quota refresh can arrive while the durable write waits.
    // Keep the reservation counted, but never start a newly paused/changed run.
    const settings = this.getSettings(), currentChoice = backfillChoice(settings.chatMemoryBackfillModel);
    return this.authorized(model) && JSON.stringify(choice) === JSON.stringify(currentChoice) && counter.day === localDay(this.now()) && counter.requests <= backfillCap(settings);
  }
  status() {
    const settings = this.getSettings(), counter = this.#today(), cap = backfillCap(settings), choice = backfillChoice(settings.chatMemoryBackfillModel);
    const gate = this.getRequestAvailability(backfillProvider(settings)), safety = gate?.blocked ? { blocked: true, reason: gate.reason, window: gate.window, used: gate.used, max: gate.max, retryAt: gate.retryAt } : { blocked: false };
    return { enabled: backfillEnabled(settings), day: counter.day, requests: counter.requests, hourlyCap: backfillHourlyCap(settings), cap: Number.isFinite(cap) ? cap : null, unlimited: !Number.isFinite(cap), provider: choice?.provider || BACKFILL_PROVIDER, model: choice?.model || '', effort: choice?.effort || '', ceiling: backfillUsageCeiling(settings), safety, reason: this.blocked({ refresh: false }) || (this.reason === 'unavailable' ? 'unavailable' : '') };
  }
}
