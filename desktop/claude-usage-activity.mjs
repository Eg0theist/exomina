import { NATIVE_ACTIVITY_LIMITS, nativeActivityText } from './provider-activity.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sum = values => values.every(value => count(value) !== null) && Number.isSafeInteger(values.reduce((total, value) => total + value, 0))
  ? values.reduce((total, value) => total + value, 0) : null;
const unknown = () => ({ inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null, reasoningOutputTokens: null, totalTokens: null });

/** Pinned Claude stream usage: message_start/delta describe one API request;
 * terminal modelUsage is a replacement snapshot of cumulative pipeline usage.
 * Never substitute the latter for the latest request's input/context size.
 */
export class ClaudeUsageActivity {
  constructor({ turnId, sessionId }) {
    Object.assign(this, { turnId, sessionId });
    this.raw = null; this.model = null; this.total = unknown(); this.windows = new Map();
  }

  last() {
    if (!this.raw) return unknown();
    const input = count(this.raw.input_tokens), cached = count(this.raw.cache_read_input_tokens), written = count(this.raw.cache_creation_input_tokens);
    return { inputTokens: sum([input, cached, written]), cachedInputTokens: cached, cacheWriteInputTokens: written,
      outputTokens: count(this.raw.output_tokens), reasoningOutputTokens: count(this.raw.output_tokens_details?.thinking_tokens), totalTokens: null };
  }

  totals(modelUsage) {
    this.total = unknown(); this.windows.clear();
    if (!object(modelUsage)) return;
    const rows = Object.entries(modelUsage);
    if (!rows.length || rows.length > 128 || rows.some(([, value]) => !object(value))) return;
    for (const [model, usage] of rows) if (typeof model === 'string' && model.length <= NATIVE_ACTIVITY_LIMITS.model && count(usage.contextWindow) > 0)
      this.windows.set(model, usage.contextWindow);
    this.total = { inputTokens: sum(rows.map(([, row]) => sum([row.inputTokens, row.cacheReadInputTokens, row.cacheCreationInputTokens]))),
      cachedInputTokens: sum(rows.map(([, row]) => row.cacheReadInputTokens)), cacheWriteInputTokens: sum(rows.map(([, row]) => row.cacheCreationInputTokens)),
      outputTokens: sum(rows.map(([, row]) => row.outputTokens)),
      // Claude warns that thinkingTokens can be partial after an old session is
      // resumed. It is not a complete cumulative reasoning-output measurement.
      reasoningOutputTokens: null, totalTokens: null };
  }

  observe(event) {
    if (!object(event) || event.parent_tool_use_id != null) return null;
    const threadId = nativeActivityText(this.sessionId(), NATIVE_ACTIVITY_LIMITS.id);
    if (!threadId || (event.session_id && event.session_id !== threadId)) return null;
    if (event.type === 'stream_event' && event.event?.type === 'message_start') {
      const message = event.event.message;
      if (!object(message)) return null;
      this.raw = object(message.usage) ? { ...message.usage } : {};
      this.model = typeof message.model === 'string' && message.model.length <= NATIVE_ACTIVITY_LIMITS.model ? message.model : null;
    } else if (event.type === 'stream_event' && event.event?.type === 'message_delta') {
      if (!this.raw || !object(event.event.usage)) return null;
      this.raw = { ...this.raw, ...event.event.usage };
    } else if (event.type === 'result') this.totals(event.modelUsage);
    // Assistant frames may represent one completed content block with partial
    // usage, and result.usage can aggregate several requests: neither is last.
    else return null;
    return { kind: 'usage', provider: 'claude', totalScope: 'providerRun', threadId,
      turnId: this.turnId, last: this.last(), total: { ...this.total }, modelContextWindow: this.model ? this.windows.get(this.model) || null : null };
  }
}
