/** Subscription usage as each runtime reports it, in one shape:
 * {provider, plan, status, windows:[{id,label,usedPercent,resetsAt}], updatedAt}.
 * Claude answers get_usage and sends rate_limit_event with replies; Codex
 * answers account/rateLimits/read and pushes account/rateLimits/updated.
 * Only reported percentages are displayed; fetch failures retain stale readings.
 */
export const USAGE_WARNING_PERCENT = 90;
const CLAUDE_WINDOWS = { five_hour: '5-hour session', seven_day: 'Weekly', seven_day_oauth_apps: 'Weekly (connected apps)', seven_day_opus: 'Weekly (Opus)', seven_day_sonnet: 'Weekly (Sonnet)', seven_day_overage_included: 'Weekly (extra usage)', overage: 'Extra usage' };
export const USAGE_STALE_MS = 3 * 60_000;
export const percentageText = value => `${Math.round(Math.max(0, value) * 10) / 10}%`;
export const usageStale = (entry, now = Date.now()) => entry?.stale === true || !Number.isFinite(Date.parse(entry?.updatedAt)) || now - Date.parse(entry.updatedAt) > USAGE_STALE_MS || ['error', 'cached'].includes(entry.fetchStatus);

const percent = (value, fractional = false) => { if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null; const number = Number(value); if (!Number.isFinite(number) || number < 0) return null; return Math.min(100, Math.round(number * (fractional ? 100 : 1) * 10) / 10); };
const time = value => { if (value === null || value === undefined || value === '') return null; const number = Number(value); const ms = Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : Date.parse(value); const date = new Date(ms); return Number.isFinite(date.getTime()) ? date.toISOString() : null; };
function windowLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return 'Usage';
  if (value <= 360) return `${Math.round(value / 60)}-hour session`;
  if (value >= 9000 && value <= 11000) return 'Weekly';
  if (value >= 40000) return 'Monthly';
  return value % 1440 === 0 ? `${value / 1440}-day` : `${Math.round(value / 60)}-hour`;
}

/** Claude Code rate_limit_info → windows. Merges into what was known before, since one event may name one window. */
export function claudeUsage(info = {}, previous = null) {
  const fetched = Object.hasOwn(info, 'rate_limits');
  const windows = new Map((fetched ? [] : previous?.windows || []).map(item => [item.id, item]));
  if (fetched) {
    const limits = info.rate_limits;
    if (!limits || typeof limits !== 'object') return null;
    const rows = Array.isArray(limits.limits) && limits.limits.length > 0 ? limits.limits : null;
    for (const [id, label] of rows ? [] : Object.entries(CLAUDE_WINDOWS)) {
      const item = limits[id], used = percent(item?.utilization);
      if (used !== null) windows.set(id, { id, label, usedPercent: used, resetsAt: time(item.resets_at) });
    }
    for (const item of rows || !Array.isArray(limits.model_scoped) ? [] : limits.model_scoped) {
      const used = percent(item?.utilization), label = String(item?.display_name || '').slice(0, 128);
      if (used !== null && label) windows.set(`model:${label}`, { id: `model:${label}`, label: `Weekly (${label})`, modelScope: label, usedPercent: used, resetsAt: time(item.resets_at) });
    }
    // New runtimes can carry the endpoint's full list instead of fixed buckets.
    if (rows) for (const item of rows) {
      const used = percent(item?.percent), kind = String(item?.kind || '').slice(0, 128);
      const scope = [item?.scope?.model?.display_name, item?.scope?.surface?.display_name].filter(Boolean).map(value => String(value).slice(0, 128)).join(', ');
      const id = kind === 'session' && !scope ? 'five_hour' : kind === 'weekly_all' && !scope ? 'seven_day' : `limit:${kind}:${scope}`;
      if (used !== null && kind) windows.set(id, { id, label: `${kind === 'session' ? '5-hour session' : kind.startsWith('weekly') ? 'Weekly' : kind.replace(/_/g, ' ')}${scope ? ` (${scope})` : ''}`, modelScope: item?.scope?.model?.display_name || '', usedPercent: used, resetsAt: time(item.resets_at), active: item.is_active === true });
    }
    if (!windows.size) return null;
    const extra = limits.extra_usage;
    return { provider: 'claude', plan: typeof info.subscription_type === 'string' ? info.subscription_type : previous?.plan || null,
      status: [...windows.values()].some(item => item.usedPercent >= 100) ? 'rejected' : 'allowed', windows: [...windows.values()],
      extraUsage: extra?.is_enabled ? { enabled: true, usedCredits: Number.isFinite(extra.used_credits) ? extra.used_credits : null, monthlyLimit: Number.isFinite(extra.monthly_limit) ? extra.monthly_limit : null, currency: /^[A-Z]{3}$/.test(extra.currency) ? extra.currency : 'USD' } : null,
      source: 'Claude Code /usage', fetchStatus: 'ready', updatedAt: new Date().toISOString() };
  }
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
  for (const [id, value] of Object.entries(unified)) {
    const used = percent(value?.utilization, true);
    if (used !== null) windows.set(id, { id, label: CLAUDE_WINDOWS[id] || id.replace(/_/g, ' '), usedPercent: used, resetsAt: time(value.resetsAt) });
  }
  if (info.rateLimitType && percent(info.utilization, true) !== null) windows.set(info.rateLimitType, { id: info.rateLimitType, label: CLAUDE_WINDOWS[info.rateLimitType] || info.rateLimitType, usedPercent: percent(info.utilization, true), resetsAt: time(info.resetsAt) });
  // A rejection without numbers still means that window is used up.
  if (info.status === 'rejected' && info.rateLimitType) windows.set(info.rateLimitType, { id: info.rateLimitType, label: CLAUDE_WINDOWS[info.rateLimitType] || info.rateLimitType, usedPercent: 100, resetsAt: time(info.resetsAt) });
  if (!windows.size && !info.status) return previous;
  const numeric = Object.values(unified).some(value => percent(value?.utilization, true) !== null) || percent(info.utilization, true) !== null || info.status === 'rejected';
  return { ...previous, provider: 'claude', plan: previous?.plan || null, status: info.status || previous?.status || 'allowed', overage: info.isUsingOverage === true, windows: [...windows.values()], ...(numeric ? { fetchStatus: 'ready', stale: false, error: null, updatedAt: new Date().toISOString() } : {}) };
}

/** Availability of a reported reset credit. A missing expiry is unknown;
 * the provider explicitly reports null for a credit that does not expire. */
export function resetCreditUnavailableReason(credit, now = Date.now()) {
  if (typeof credit?.id !== 'string' || !credit.id.trim()) return 'Missing reset identifier';
  if (credit.status === 'redeeming') return 'Redemption in progress';
  if (credit.status === 'redeemed') return 'Already used';
  if (credit.status !== 'available') return 'Availability not confirmed';
  if (credit.resetType !== 'codexRateLimits') return 'Unsupported reset type';
  if (credit.expiryKnown !== true) return 'Expiry not supplied';
  if (credit.expiresAt !== null && (!Number.isFinite(Date.parse(credit.expiresAt)) || Date.parse(credit.expiresAt) <= now)) return 'Expired';
  return null;
}

function resetCreditAvailability(credit, now) {
  const unavailableReason = resetCreditUnavailableReason(credit, now), usable = unavailableReason === null;
  return credit.usable === usable && credit.unavailableReason === unavailableReason ? credit : { ...credit, usable, unavailableReason };
}

function sortedResetCredits(credits, now) {
  const sorted = credits.map(credit => resetCreditAvailability(credit, now)).sort((a, b) => Number(b.usable) - Number(a.usable)
    || (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity));
  return sorted.every((credit, index) => credit === credits[index]) ? credits : sorted;
}

/** Keep identifiers so the user's choice can reach the provider unchanged.
 * Count-only background reads retain prior details only while the count agrees;
 * the provider can return fewer detail rows than its available count. */
export function resetCreditDetails(summary, previous, now = Date.now()) {
  if (!Array.isArray(summary.credits)) return previous?.availableCount === summary.availableCount && Array.isArray(previous?.credits) ? sortedResetCredits(previous.credits, now) : null;
  return sortedResetCredits(summary.credits.filter(item => item && typeof item === 'object').map(item => ({
    id: typeof item.id === 'string' && item.id.trim() ? item.id : null,
    status: ['available', 'redeeming', 'redeemed', 'unknown'].includes(item.status) ? item.status : 'unknown',
    resetType: item.resetType === 'codexRateLimits' ? item.resetType : 'unknown',
    title: typeof item.title === 'string' ? item.title.slice(0, 150) : null,
    description: typeof item.description === 'string' ? item.description.slice(0, 300) : null,
    grantedAt: time(item.grantedAt),
    expiresAt: time(item.expiresAt),
    expiryKnown: item.expiresAt === null || (Number.isSafeInteger(item.expiresAt) && time(item.expiresAt) !== null)
  })), now);
}

/** Codex rateLimits ({primary, secondary, planType}) → windows. */
export function codexUsage(value = {}, previous = null) {
  const limits = value?.rateLimitsByLimitId?.codex || value?.rateLimits || value;
  if (!limits || typeof limits !== 'object') return null;
  const windows = [];
  for (const id of ['primary', 'secondary']) {
    const item = limits[id];
    const used = percent(item?.usedPercent ?? item?.used_percent);
    if (!item || used === null) continue;
    windows.push({ id, label: windowLabel(item.windowDurationMins ?? item.window_minutes), usedPercent: used, resetsAt: time(item.resetsAt ?? item.resets_at) });
  }
  const summary = value.rateLimitResetCredits;
  const resetCredits = Number.isSafeInteger(summary?.availableCount) && summary.availableCount >= 0 ? {
    availableCount: summary.availableCount,
    credits: resetCreditDetails(summary, previous?.resetCredits),
    detailsPartial: Array.isArray(summary.credits) ? summary.credits.filter(credit => credit?.status === 'available').length < summary.availableCount
      : previous?.resetCredits?.availableCount === summary.availableCount && previous.resetCredits.detailsPartial === true
  } : previous?.resetCredits || null;
  const ordinaryUsageAllowed = typeof value.ordinaryUsageAllowed === 'boolean' ? value.ordinaryUsageAllowed : previous?.ordinaryUsageAllowed ?? null;
  if (!windows.length && !resetCredits && ordinaryUsageAllowed === null) return null;
  const modelLimits = value.rateLimitsByLimitId && typeof value.rateLimitsByLimitId === 'object' ? Object.entries(value.rateLimitsByLimitId).map(([id, item]) => {
    const prior = previous?.modelLimits?.find(limit => limit.id === id);
    const spendControlReached = typeof item?.spendControlReached === 'boolean' ? item.spendControlReached : prior?.spendControlReached ?? null;
    const active = [item?.primary, item?.secondary].filter(win => percent(win?.usedPercent) !== null && (!time(win?.resetsAt) || Date.parse(time(win.resetsAt)) > Date.now()));
    return { id, model: typeof item?.normalModelSlug === 'string' ? item.normalModelSlug.slice(0, 150) : prior?.model || null, label: String(item?.limitName || prior?.label || id).slice(0, 150), spendControlReached, knownAvailable: active.length > 0, blocked: spendControlReached === true || active.some(win => percent(win.usedPercent) >= 100) };
  }) : previous?.modelLimits || [];
  const savedWindows = windows.length ? windows : previous?.windows || [];
  const numeric = windows.length > 0 || !savedWindows.length;
  return { provider: 'codex', plan: typeof limits.planType === 'string' ? limits.planType : previous?.plan || null, status: ordinaryUsageAllowed === false || savedWindows.some(item => item.usedPercent >= 100) ? 'rejected' : savedWindows.some(item => item.usedPercent >= USAGE_WARNING_PERCENT) ? 'allowed_warning' : 'allowed', windows: savedWindows, ordinaryUsageAllowed, resetCredits, modelLimits, source: 'ChatGPT account limits', fetchStatus: numeric ? 'ready' : previous?.fetchStatus || 'cached', stale: numeric ? false : previous?.stale, updatedAt: numeric ? new Date().toISOString() : previous?.updatedAt };
}

/** Whitelist the official Muse MSP quota payload; never retain account/token fields. */
export function museQuota(value){
  if(!value||typeof value!=='object')return null;
  const integer=(n,max)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
  if(!integer(value.observedAtMs,8640000000000000)||!value.observedAtMs||typeof value.tier!=='string'||value.tier.length>128)return null;
  const window=value.window,weekly=value.weekly;if(!window||!weekly||!integer(window.usedPercent,1e9)||!integer(weekly.usedPercent,1e9)||!integer(window.resetsAtMs,8640000000000000)||!integer(weekly.resetsAtMs,8640000000000000)||!integer(window.windowDurationMins,1e7)||window.windowDurationMins===0)return null;
  return {observedAtMs:value.observedAtMs,tier:value.tier,window:{usedPercent:window.usedPercent,windowDurationMins:window.windowDurationMins,resetsAtMs:window.resetsAtMs},weekly:{usedPercent:weekly.usedPercent,resetsAtMs:weekly.resetsAtMs}};
}
/** Muse reports point-in-time subscription percentages, not token-count estimates. */
export function museUsage(value={},previous=null){
  const quota=museQuota(value.usage||value);if(!quota)return null;
  if(previous&&Date.parse(previous.updatedAt)>quota.observedAtMs)return previous;
  const windows=[{id:'window',label:windowLabel(quota.window.windowDurationMins),usedPercent:quota.window.usedPercent,resetsAt:new Date(quota.window.resetsAtMs).toISOString()},{id:'weekly',label:'Weekly',usedPercent:quota.weekly.usedPercent,resetsAt:new Date(quota.weekly.resetsAtMs).toISOString()}];
  // An opaque numeric tier is not a plan name. Do not display or guess one.
  const plan=/^[a-z][a-z -]{0,60}$/i.test(quota.tier)?quota.tier:null;
  return {provider:'muse-code',plan,status:windows.some(w=>w.usedPercent>=100)?'rejected':windows.some(w=>w.usedPercent>=USAGE_WARNING_PERCENT)?'allowed_warning':'allowed',windows,source:'Muse Code subscription limits',reportedAfterRequest:true,fetchStatus:value.fromCache?'cached':'ready',stale:value.fromCache===true,updatedAt:new Date(quota.observedAtMs).toISOString()};
}

/** Windows past the warning line that have not reset yet. */
export function usageWarnings(entry, now = Date.now()) {
  return (entry?.windows || []).filter(item => item.usedPercent >= USAGE_WARNING_PERCENT && (!item.resetsAt || Date.parse(item.resetsAt) > now));
}

export class UsageTracker {
  constructor({ emit = () => {}, initial = {}, onUpdate = () => {} } = {}) { this.emit = emit; this.onUpdate = onUpdate; this.entries = Object.fromEntries(Object.entries(initial).map(([id, entry]) => [id, { ...entry, fetchStatus: 'cached' }])); }
  update(provider, raw) {
    const next = provider === 'claude' ? claudeUsage(raw, this.entries.claude) : provider === 'codex' ? codexUsage(raw, this.entries.codex) : provider === 'muse-code' ? museUsage(raw, this.entries['muse-code']) : null;
    if (!next) return null;
    const previous = this.entries[provider];
    this.entries[provider] = next;
    // A repeated Muse observation changes fetch status in the UI, not its quota.
    // Avoid serializing the full chat store for the same counters every minute.
    if (provider !== 'muse-code' || !previous || next.updatedAt !== previous.updatedAt || next.plan !== previous.plan || JSON.stringify(next.windows) !== JSON.stringify(previous.windows)) this.onUpdate(this.entries);
    this.emit({ type: 'usage', usage: this.snapshot() });
    return next;
  }
  /** A signed-out account has no allowance to show; its numbers must not linger. */
  forget(provider) {
    if (!Object.hasOwn(this.entries, provider)) return false;
    delete this.entries[provider];
    this.onUpdate(this.entries, { immediate: true });
    this.emit({ type: 'usage', usage: this.snapshot() });
    return true;
  }
  refreshing(provider) {
    this.entries[provider] = { provider, windows: [], ...this.entries[provider], stale: usageStale(this.entries[provider]), fetchStatus: 'refreshing' };
    this.emit({ type: 'usage', usage: this.snapshot() });
  }
  failed(provider, error) {
    this.entries[provider] = { provider, windows: [], ...this.entries[provider], stale: true, fetchStatus: 'error', checkedAt: new Date().toISOString(), error: String(error?.message || 'Usage refresh failed.').slice(0, 500) };
    this.emit({ type: 'usage', usage: this.snapshot() });
  }
  /** Drops windows that have reset since they were reported. */
  snapshot(now = Date.now()) {
    return Object.fromEntries(Object.entries(this.entries).map(([id, entry]) => [id, { ...entry, ...(Array.isArray(entry.resetCredits?.credits) ? { resetCredits: { ...entry.resetCredits, credits: sortedResetCredits(entry.resetCredits.credits, now) } } : {}), windows: (entry.windows || []).filter(item => !item.resetsAt || Date.parse(item.resetsAt) > now) }]));
  }
}
