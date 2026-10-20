import {nativeActivityText} from './provider-activity.mjs';

const text = (value, limit = 2000) => typeof value === 'string' ? nativeActivityText(value, limit).trim() : '';
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\x00-\x1f\x7f]/.test(value);
const terminal = new Set(['complete', 'failed', 'cancelled']);
export const nativeHelperTerminal = status => terminal.has(status);
export function nativeHelperFields(values) {
  const result = {};
  for (const key of ['name', 'role', 'task', 'requestedModel', 'requestedEffort', 'configuredModel', 'configuredEffort', 'effectiveModel', 'effectiveEffort', 'sourceModel', 'summary', 'error']) {
    const value = text(values?.[key], ['task', 'summary', 'error'].includes(key) ? 2000 : 200);
    if (value) result[key] = value;
  }
  if (typeof values?.task === 'string') result.taskTruncated = values.task.length > 2000;
  return result;
}

/** Display metadata only. These fields never grant native child tool authority. */
export function createCodexHelper(state, thread, now = Date.now()) {
  const parent = state.parentState;
  const spawn = thread.source?.subAgent?.thread_spawn;
  const sourceModel = parent.nativeHelper?.effectiveModel || parent.nativeHelper?.configuredModel || parent.runtimeSelection?.model;
  const sourceModelSource = parent.nativeHelper?.effectiveModel ? 'reported' : parent.nativeHelper?.configuredModel || parent.runtimeSelection?.modelSource === 'runtimeConfig' ? 'configured' : 'reported';
  return {id: `native-helper:codex:${state.sessionId}`, kind: 'native', provider: 'codex', effectiveProvider: 'codex',
    sourceProvider: parent.provider, nativeThreadId: state.sessionId, parentThreadId: parent.sessionId,
    status: 'waiting', startedAt: now,
    ...nativeHelperFields({name: thread.agentNickname || spawn?.agent_nickname || spawn?.agent_path,
      role: thread.agentRole || spawn?.agent_role, task: thread.preview,
      sourceModel, configuredModel: thread.model, configuredEffort: thread.reasoningEffort}), sourceModelSource};
}

/** Claude task bookkeeping uses reported IDs and task_type, never guessed models.
 * Main-loop tool_use IDs join task bookends and parent_tool_use_id child streams.
 * Local bash, MCP, workflow and housekeeping tasks are not counted as helpers.
 */
export class ClaudeHelperActivity {
  constructor({turnId, sourceModel = () => undefined, sourceModelSource = () => 'reported', emit = () => {}, now = Date.now, maxHelpers = 128} = {}) {
    this.turnId = turnId; this.sourceModel = sourceModel; this.sourceModelSource = sourceModelSource; this.emit = emit; this.now = now; this.maxHelpers = maxHelpers;
    this.helpers = new Map(); this.toolIds = new Map(); this.taskIds = new Map(); this.seen = new Map(); this.closed = false;
  }
  publish(helper) {
    const signature = JSON.stringify(helper);
    if (this.seen.get(helper.id) === signature) return;
    this.seen.set(helper.id, signature); this.emit({...helper});
  }
  register({toolId, taskId, name, task, role, requestedModel, requestedEffort, parent}) {
    if ((toolId != null && !id(toolId)) || (taskId != null && !id(taskId))) return null;
    let helper = (toolId && this.toolIds.get(toolId)) || (taskId && this.taskIds.get(taskId));
    if (!helper) {
      if (this.helpers.size >= this.maxHelpers) return null;
      const nativeId = text(toolId || taskId, 300);
      if (!nativeId) return null;
      helper = {id: `native-helper:claude:${this.turnId}:${nativeId}`, kind: 'native', provider: 'claude', effectiveProvider: 'claude',
        sourceProvider: 'claude', sourceModelSource: parent ? 'reported' : this.sourceModelSource(), ...nativeHelperFields({sourceModel: parent ? parent.effectiveModel : this.sourceModel()}),
        ...(parent ? {parentHelperId: parent.id} : {}), ...(toolId?{nativeToolUseId:toolId}:{}), status: 'running', startedAt: this.now()};
      this.helpers.set(helper.id, helper);
    }
    if (toolId && (this.toolIds.has(toolId) || this.toolIds.size < this.maxHelpers * 2)) this.toolIds.set(toolId, helper);
    if (taskId && (this.taskIds.has(taskId) || this.taskIds.size < this.maxHelpers * 2)) { this.taskIds.set(taskId, helper); helper.nativeTaskId = text(taskId, 300); }
    Object.assign(helper, nativeHelperFields({name, task, role, requestedModel, requestedEffort}));
    return helper;
  }
  toolUses(event, parent) {
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return;
    for (const block of event.message.content) {
      if (block?.type !== 'tool_use' || !['Task', 'Agent'].includes(block.name) || typeof block.id !== 'string') continue;
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      const helper = this.register({toolId: block.id, name: input.name || input.description, role: input.subagent_type,
        task: input.prompt, requestedModel: input.model, requestedEffort: input.effort, parent});
      if (helper) { if (input.run_in_background === true) helper.background = true; this.publish(helper); }
    }
  }
  toolResults(event) {
    if (event.type !== 'user' || event.isReplay || !Array.isArray(event.message?.content)) return;
    for (const block of event.message.content) {
      if (block?.type !== 'tool_result') continue;
      const helper = this.toolIds.get(block.tool_use_id);
      if (!helper || terminal.has(helper.status)) continue;
      if (block.is_error) this.setStatus(helper, 'failed');
      else if (helper.background !== true) this.setStatus(helper, 'complete');
      this.publish(helper);
    }
  }
  setStatus(helper, status) {
    if (!helper || !status) return;
    helper.status = status;
    if (terminal.has(status)) helper.finishedAt = this.now();
    else delete helper.finishedAt;
  }
  observe(event) {
    if (this.closed || !event || typeof event !== 'object') return false;
    if (event.parent_tool_use_id != null) {
      const helper = this.toolIds.get(event.parent_tool_use_id);
      if (helper && !terminal.has(helper.status)) {
        const message = event.type === 'stream_event' && event.event?.type === 'message_start' ? event.event.message
          : event.type === 'assistant' ? event.message : null;
        const model = text(message?.model, 200);
        if (model) { helper.effectiveModel = model; helper.modelSource = 'execution'; this.publish(helper); }
        this.toolUses(event, helper); this.toolResults(event);
      }
      // Child streams must not contaminate the root answer, even if bookends
      // were missed and that child is not yet recognizable by this tracker.
      return true;
    }
    this.toolUses(event);
    if (event.type === 'system' && event.subtype === 'task_started' && typeof event.task_id === 'string') {
      const known = typeof event.tool_use_id === 'string' && this.toolIds.get(event.tool_use_id);
      if (event.task_type && event.task_type !== 'local_agent') return false;
      if (!known && event.task_type !== 'local_agent' && !event.subagent_type) return false;
      const helper = this.register({toolId: event.tool_use_id, taskId: event.task_id,
        name: event.description, task: event.prompt, role: event.subagent_type});
      if (helper) { if (typeof event.is_backgrounded === 'boolean') helper.background = event.is_backgrounded; this.publish(helper); }
    } else if (event.type === 'system' && ['task_progress', 'task_updated', 'task_notification'].includes(event.subtype)) {
      const helper = this.taskIds.get(event.task_id) || this.toolIds.get(event.tool_use_id);
      if (!helper) return false;
      if (terminal.has(helper.status)) return false;
      const patch = event.subtype === 'task_updated' && event.patch && typeof event.patch === 'object' ? event.patch : {};
      Object.assign(helper, nativeHelperFields({summary: event.summary, name: patch.description, error: patch.error}));
      if (typeof patch.is_backgrounded === 'boolean') helper.background = patch.is_backgrounded;
      const status = {pending: 'waiting', running: 'running', completed: 'complete', failed: 'failed', killed: 'cancelled', paused: 'waiting', stopped: 'cancelled'}[event.subtype === 'task_notification' ? event.status : patch.status];
      this.setStatus(helper, status); this.publish(helper);
    }
    this.toolResults(event);
    return false;
  }
  close(status = 'cancelled') {
    if (this.closed) return; this.closed = true;
    for (const helper of this.helpers.values()) if (!terminal.has(helper.status)) {
      this.setStatus(helper, status);
      if (status === 'cancelled') helper.summary = 'The owning native run ended before a helper completion was reported.';
      this.publish(helper);
    }
    this.toolIds.clear(); this.taskIds.clear();
  }
}
