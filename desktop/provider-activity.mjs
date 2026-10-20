/** Native Codex activity snapshots, using the bundled 0.160.1 app-server schema.
 * This module is deliberately pure: notifications never become tool authority.
 * Keep only fields needed for the work display and bound provider-supplied text.
 */
export const NATIVE_ACTIVITY_LIMITS = Object.freeze({ planSteps: 80, planText: 1000, explanation: 4000, diff: 48000, id: 200, model: 160 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const statuses = new Set(['pending', 'inProgress', 'completed']);

export function nativeActivityText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.slice(0, Math.max(limit * 2, 12000))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[private key redacted]')
    .replace(/\b(?:sk-[\w-]+|eyJ[\w.-]{30,})\b/g, '[credential redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [credential redacted]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|password|client[_-]?secret)["'\s:=]+)[^\s,}"']+/gi, '$1[credential redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[credential redacted]@')
    .replace(/([?&](?:token|key|code|api[_-]?key|access[_-]?token|session[_-]?token)=)[^&#\s]+/gi, '$1[credential redacted]')
    .slice(0, limit);
}

function breakdown(value) {
  if (!object(value)) return null;
  const result = {};
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']) {
    const count = number(value[key]);
    if (count === null) return null;
    result[key] = count;
  }
  if (number(value.cacheWriteInputTokens) !== null) result.cacheWriteInputTokens = value.cacheWriteInputTokens;
  return result;
}

export function normalizeCodexActivity(method, params) {
  if (!['turn/plan/updated', 'turn/diff/updated', 'thread/tokenUsage/updated', 'model/rerouted'].includes(method) || !object(params)) return null;
  const threadId = nativeActivityText(params.threadId, NATIVE_ACTIVITY_LIMITS.id), turnId = nativeActivityText(params.turnId, NATIVE_ACTIVITY_LIMITS.id);
  if (!threadId || !turnId) return null;
  const scope = { threadId, turnId };
  if (method === 'turn/plan/updated') {
    if (!Array.isArray(params.plan)) return null;
    const rows = params.plan.slice(0, NATIVE_ACTIVITY_LIMITS.planSteps);
    const steps = rows.filter(row => object(row) && typeof row.step === 'string' && statuses.has(row.status)).map(row => ({ text: nativeActivityText(row.step, NATIVE_ACTIVITY_LIMITS.planText), status: row.status }));
    return { kind: 'plan', ...scope, explanation: nativeActivityText(params.explanation, NATIVE_ACTIVITY_LIMITS.explanation), steps,
      truncated: params.plan.length > rows.length || rows.length > steps.length || rows.some(row => typeof row?.step === 'string' && row.step.length > NATIVE_ACTIVITY_LIMITS.planText) || (typeof params.explanation === 'string' && params.explanation.length > NATIVE_ACTIVITY_LIMITS.explanation) };
  }
  if (method === 'turn/diff/updated') {
    if (typeof params.diff !== 'string') return null;
    return { kind: 'diff', ...scope, text: nativeActivityText(params.diff, NATIVE_ACTIVITY_LIMITS.diff), truncated: params.diff.length > NATIVE_ACTIVITY_LIMITS.diff };
  }
  if (method === 'thread/tokenUsage/updated') {
    const usage = params.tokenUsage;
    if (!object(usage)) return null;
    const last = breakdown(usage.last), total = breakdown(usage.total);
    if (!last || !total) return null;
    return { kind: 'usage', ...scope, last, total, modelContextWindow: number(usage.modelContextWindow) || null };
  }
  if (typeof params.fromModel !== 'string' || typeof params.toModel !== 'string' || typeof params.reason !== 'string') return null;
  return { kind: 'reroute', ...scope, fromModel: nativeActivityText(params.fromModel, NATIVE_ACTIVITY_LIMITS.model), toModel: nativeActivityText(params.toModel, NATIVE_ACTIVITY_LIMITS.model), reason: nativeActivityText(params.reason, 200) };
}
