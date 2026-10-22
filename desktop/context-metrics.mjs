/** Measurements of text Exomina assembled, separate from provider token usage.
 * No prompt text, hashes, account state or inferred token/cost values are saved.
 * This module is shared by the host and renderer and has no Node-only imports.
 */
export const MAX_CONTEXT_SNAPSHOTS = 16;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const bytes = value => new TextEncoder().encode(value).length;
const providerId = value => typeof value === 'string' && /^[a-z][a-z0-9._:-]{0,79}$/i.test(value) ? value : 'unknown';
const timestamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;

function snapshotView(value) {
  if (!value || count(value.sequence) === null || value.sequence < 1 || count(value.promptBytes) === null) return null;
  return {
    sequence: value.sequence, capturedAt: timestamp(value.capturedAt), provider: providerId(value.provider),
    lane: ['chat', 'tools'].includes(value.lane) ? value.lane : 'unknown', resumedSession: value.resumedSession === true,
    promptBytes: value.promptBytes, treeViewBytes: count(value.treeViewBytes),
    cacheMarkedBlocks: count(value.cacheMarkedBlocks), cacheMarkedBytes: count(value.cacheMarkedBytes),
  };
}

/** Whitelisted, bounded projection for diagnostics and app_inspect. */
export function contextMetricsView(value) {
  if (value?.format !== 1 || !Array.isArray(value.snapshots)) return null;
  const snapshots = value.snapshots.slice(-MAX_CONTEXT_SNAPSHOTS).map(snapshotView).filter(Boolean);
  if (!snapshots.length) return null;
  const requests = Math.max(count(value.requests) ?? snapshots.length, snapshots.length, snapshots.at(-1).sequence);
  return { format: 1, requests, omitted: Math.max(0, requests - snapshots.length), snapshots };
}

/** Call immediately before a provider attempt, after assembling its final prompt.
 * Cache markers count host hints only. They do not establish a provider hit.
 * Missing or mismatched blocks stay unknown instead of implying zero reuse.
 */
export function recordContextMetrics(message, { prompt, provider, lane, resumedSession = false, promptBlocks, treeViewBytes = null, capturedAt = new Date().toISOString() } = {}) {
  if (!message || typeof message !== 'object' || typeof prompt !== 'string') return null;
  const previous = contextMetricsView(message.contextMetrics), sequence = Math.min(Number.MAX_SAFE_INTEGER, (previous?.requests || 0) + 1);
  const validBlocks = Array.isArray(promptBlocks) && promptBlocks.length <= 10000 && promptBlocks.every(block => typeof block?.text === 'string') && promptBlocks.map(block => block.text).join('') === prompt;
  const marked = validBlocks ? promptBlocks.filter(block => block.cache === true) : null;
  const snapshot = snapshotView({ sequence, capturedAt, provider, lane, resumedSession, promptBytes: bytes(prompt), treeViewBytes,
    cacheMarkedBlocks: marked?.length ?? null, cacheMarkedBytes: marked ? marked.reduce((sum, block) => sum + bytes(block.text), 0) : null });
  const snapshots = [...(previous?.snapshots || []), snapshot].slice(-MAX_CONTEXT_SNAPSHOTS);
  return message.contextMetrics = { format: 1, requests: sequence, omitted: Math.max(0, sequence - snapshots.length), snapshots };
}

/** A cache-read fraction is meaningful only for one valid reported denominator.
 * Never substitute host bytes, cumulative totals or missing counters for it.
 */
export function reportedCacheRate(usage) {
  const input = count(usage?.inputTokens), cached = count(usage?.cachedInputTokens);
  return input !== null && input > 0 && cached !== null && cached <= input ? cached / input : null;
}

/** Counts recorded comparison states and distinct receipt IDs, not improvement. */
export function refinementMetrics(records) {
  const totals = { recorded: 0, open: 0, compared: 0, adopted: 0, rejected: 0, retired: 0, evidence: 0, failedEvidence: 0 };
  const statuses = new Set(['proposed', 'compared', 'adopted', 'rejected', 'retired']), evidence = new Map();
  for (const record of Array.isArray(records) ? records.slice(0, 500) : []) {
    if (!statuses.has(record?.status)) continue;
    totals.recorded++;
    if (record.status === 'proposed') totals.open++;
    else totals[record.status]++;
    for (const group of ['baselineEvidence', 'candidateEvidence', 'probeEvidence']) {
      for (const receipt of Array.isArray(record[group]) ? record[group].slice(0, 32) : []) {
        if (typeof receipt?.id !== 'string' || !receipt.id || !['completed', 'failed'].includes(receipt.status)) continue;
        evidence.set(receipt.id, receipt.status === 'failed' || evidence.get(receipt.id) === 'failed' ? 'failed' : 'completed');
      }
    }
  }
  totals.evidence = evidence.size;
  totals.failedEvidence = [...evidence.values()].filter(status => status === 'failed').length;
  return totals;
}
