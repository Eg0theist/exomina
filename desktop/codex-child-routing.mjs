import path from 'node:path';
import {permissionDifferences} from './codex-permissions.mjs';
import {createCodexHelper, nativeHelperFields, nativeHelperTerminal} from './native-helper-activity.mjs';

const id = value => typeof value === 'string' && value.length > 0 && value.length <= 300;
const folder = value => typeof value === 'string' && path.isAbsolute(value)
  ? (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)) : null;

/**
 * Ancestry is admitted only from the manager's owned native transport, never tool
 * arguments. Codex 0.160.1 reapplies the spawning turn's cwd, approval policy,
 * reviewer and permission profile after role overrides (agent/child_config.rs).
 * An explicit settings notification is checked too and revokes mismatches.
 * Every registration is pinned to an actual root state AND its creating turn.
 */
export class CodexChildRouting {
  constructor(active, {maxChildren = 128, maxDepth = 32, onRetire = () => {}, onHelper = () => {}} = {}) {
    this.active = active; this.children = new Map(); this.retiredIds = new Set(); this.pendingMetadata = new Map(); this.maxChildren = maxChildren; this.maxDepth = maxDepth; this.onRetire = onRetire; this.onHelper = onHelper;
  }
  publish(state) {
    if (!state?.nativeHelper) return;
    const signature = JSON.stringify(state.nativeHelper);
    if (state.helperSignature === signature) return;
    state.helperSignature = signature; this.onHelper(state, {...state.nativeHelper});
  }
  helperStatus(state, status, error) {
    if (!state?.nativeHelper || !status) return;
    const changed = state.nativeHelper.status !== status;
    state.nativeHelper.status = status;
    Object.assign(state.nativeHelper, nativeHelperFields({error}));
    if (nativeHelperTerminal(status)) { if (changed || !state.nativeHelper.finishedAt) state.nativeHelper.finishedAt = Date.now(); }
    else { delete state.nativeHelper.finishedAt; delete state.nativeHelper.error; }
    this.publish(state);
  }
  root(threadId) {
    if (!id(threadId)) return undefined;
    const roots = [...this.active.values()].filter(state => state.provider === 'codex' && state.sessionId === threadId);
    return roots.length === 1 ? roots[0] : undefined;
  }
  owns(state) {
    if (!state) return false;
    if (!state.rootState) return this.active.get(state.conversationId) === state && this.root(state.sessionId) === state;
    const root = state.rootState;
    if (this.children.get(state.sessionId) !== state || state.cancelled || state.retired || this.root(state.sessionId)) return false;
    if (this.active.get(root.conversationId) !== root || !root.codexPermissionsVerified || root.cancelled || root.turnEnded || root.turnId !== state.rootTurnId) return false;
    const parent = state.parentState;
    return this.owns(parent) && !parent.cancelled && !parent.turnEnded && parent.turnId === state.parentTurnId;
  }
  resolve(threadId) {
    const root = this.root(threadId);
    if (root) return root;
    const child = this.children.get(threadId);
    if (child && !this.owns(child)) { this.retire(child); return undefined; }
    return child;
  }
  observeThread(thread) {
    if (!thread || !id(thread.id) || this.retiredIds.has(thread.id)) return undefined;
    const spawn = thread.source?.subAgent?.thread_spawn;
    const previous = this.children.get(thread.id);
    if (!spawn || !id(spawn.parent_thread_id) || thread.parentThreadId !== spawn.parent_thread_id
      || !Number.isInteger(spawn.depth) || spawn.depth < 1 || spawn.depth > this.maxDepth
      || (thread.forkedFromId != null && thread.forkedFromId !== spawn.parent_thread_id)) {
      if (previous) this.retire(previous);
      return undefined;
    }
    const parent = this.resolve(spawn.parent_thread_id), root = parent?.rootState || parent;
    if (!parent || this.root(thread.id) || !this.owns(parent) || parent.cancelled || parent.turnEnded || !id(parent.turnId)
      || !parent.codexPermissionsVerified || !root.nativeChildInheritanceVerified || !root.requestedPermissions || !folder(thread.cwd)
      || folder(thread.cwd) !== folder(root.requestedPermissions.cwd) || spawn.depth !== (parent.nativeDepth || 0) + 1) {
      if (previous) this.retire(previous);
      return undefined;
    }
    if (previous) {
      if (previous.rootState !== root || previous.parentState !== parent || previous.parentTurnId !== parent.turnId
        || previous.rootTurnId !== root.turnId || previous.nativeDepth !== spawn.depth) this.retire(previous);
      if (this.owns(previous)) {
        Object.assign(previous.nativeHelper, nativeHelperFields({name: thread.agentNickname || spawn.agent_nickname || spawn.agent_path,
          role: thread.agentRole || spawn.agent_role, configuredModel: thread.model, configuredEffort: thread.reasoningEffort}));
        if (thread.model === null) delete previous.nativeHelper.configuredModel;
        if (thread.reasoningEffort === null) delete previous.nativeHelper.configuredEffort;
        this.publish(previous);
      }
      return this.owns(previous) ? previous : undefined;
    }
    if (this.children.size >= this.maxChildren || this.retiredIds.size >= 10000) return undefined;
    const child = {provider: 'codex', conversationId: root.conversationId, sessionId: thread.id,
      rootState: root, rootTurnId: root.turnId, parentState: parent, parentTurnId: parent.turnId,
      nativeDepth: spawn.depth, nativeLabel: nativeHelperFields({name: spawn.agent_path || spawn.agent_nickname || thread.agentNickname}).name || `Helper ${thread.id.slice(0, 12)}`,
      text: '', messages: new Map(), items: new Map(), imageItems: new Set(), endedTurns: new Set(),
      toolDefinitions: [...root.toolDefinitions], noTools: Boolean(root.noTools), cancelled: false,
      requestedPermissions: structuredClone(root.requestedPermissions), codexPermissionsVerified: true};
    this.children.set(thread.id, child);
    child.nativeHelper = createCodexHelper(child, thread);
    const pending = this.pendingMetadata.get(thread.id);
    if (pending?.parent === parent && pending.turnId === parent.turnId) Object.assign(child.nativeHelper, pending.fields);
    this.pendingMetadata.delete(thread.id); this.publish(child);
    return child;
  }
  observeSettings(state, settings) {
    if (!state?.rootState) return;
    const effective = settings && {...settings, sandbox: settings.sandboxPolicy};
    if (permissionDifferences(effective, state.requestedPermissions).length) this.retire(state);
    else {
      Object.assign(state.nativeHelper, nativeHelperFields({configuredModel: settings.model, configuredEffort: settings.effort}));
      if (settings.effort === null) delete state.nativeHelper.configuredEffort;
      this.publish(state);
    }
  }
  observeCollaboration(state, item) {
    if (!this.owns(state) || !item) return;
    if(item.type==='subAgentActivity'){
      const child=this.children.get(item.agentThreadId);
      if(!this.owns(child)||child.rootState!==(state.rootState||state))return;
      if(!child.nativeHelper.name)Object.assign(child.nativeHelper,nativeHelperFields({name:item.agentPath}));
      const status={started:'running',interrupted:'cancelled',completed:'complete'}[item.kind];
      if(status&&!nativeHelperTerminal(child.nativeHelper.status)&&(!child.turnEnded||nativeHelperTerminal(status)))this.helperStatus(child,status);
      else this.publish(child);
      return;
    }
    if (item.type === 'collabAgentToolCall' && item.senderThreadId === state.sessionId && Array.isArray(item.receiverThreadIds)) {
      for (const threadId of item.receiverThreadIds.slice(0, this.maxChildren)) {
        const child = this.children.get(threadId);
        const taskFields = nativeHelperFields({task: item.prompt, ...(item.tool === 'spawnAgent' ? {requestedModel: item.model, requestedEffort: item.reasoningEffort} : {})});
        if (!child) {
          // Receiver metadata is display-only and cannot register a child.
          if (item.tool === 'spawnAgent' && id(threadId) && this.pendingMetadata.size < this.maxChildren)
            this.pendingMetadata.set(threadId, {parent: state, turnId: state.turnId, fields: taskFields});
          continue;
        }
        if (item.tool === 'spawnAgent' && child.parentState !== state) this.retire(child);
        if (!this.owns(child)) continue;
        if (['spawnAgent', 'sendInput', 'sendMessage', 'followupTask'].includes(item.tool)) Object.assign(child.nativeHelper, taskFields);
        const actual = item.agentsStates?.[threadId];
        const status = {pendingInit: 'waiting', running: 'running', interrupted: 'cancelled', completed: 'complete', errored: 'failed', shutdown: 'cancelled', notFound: 'failed'}[actual?.status];
        if (status && (!child.turnEnded || nativeHelperTerminal(status))) this.helperStatus(child, status, status === 'failed' ? actual.message : undefined);
        else this.publish(child);
        if (item.tool === 'closeAgent' && item.status === 'completed' && child.rootState === (state.rootState || state)) this.retire(child);
      }
    }
  }
  startTurn(state, turnId) {
    if (!state?.rootState || !this.owns(state) || !id(turnId) || state.endedTurns.has(turnId)) return false;
    if (state.turnId === turnId && !state.turnEnded) return true;
    if (state.turnId && !state.turnEnded) return false;
    state.turnId = turnId; state.turnEnded = false; state.text = ''; state.messages.clear(); state.items.clear();
    state.imageItems.clear(); state.dynamicItems = false; state.reasoningSummary = false; state.codexProgress?.clear();
    delete state.nativeHelper.effectiveModel; delete state.nativeHelper.effectiveEffort; delete state.nativeHelper.modelSource;
    this.helperStatus(state, 'running');
    return true;
  }
  endTurn(state, turnId) {
    if (!state?.rootState || turnId !== state.turnId || state.turnEnded) return false;
    state.turnEnded = true; state.endedTurns.add(turnId);
    if (state.endedTurns.size > 100) state.endedTurns.delete(state.endedTurns.values().next().value);
    return true;
  }
  retireDescendants(parent) {
    const retired = [];
    for (const child of [...this.children.values()]) if (child.parentState === parent && this.children.has(child.sessionId)) retired.push(...this.retire(child));
    return retired;
  }
  retire(state) {
    if (!state?.rootState) return [];
    const retired = [];
    for (const child of [...this.children.values()]) if (child.parentState === state) retired.push(...this.retire(child));
    if (this.children.get(state.sessionId) === state) this.children.delete(state.sessionId);
    if (!nativeHelperTerminal(state.nativeHelper?.status)) this.helperStatus(state, 'cancelled');
    this.pendingMetadata.delete(state.sessionId);
    state.cancelled = true; state.retired = true; this.retiredIds.add(state.sessionId); retired.push(state); this.onRetire(state);
    return retired;
  }
  retireRoot(root) {
    const retired = [];
    for (const child of [...this.children.values()]) if (child.rootState === root && this.children.has(child.sessionId)) retired.push(...this.retire(child));
    for (const [threadId, pending] of this.pendingMetadata) if ((pending.parent.rootState || pending.parent) === root) this.pendingMetadata.delete(threadId);
    return retired;
  }
  clear() { for (const child of [...this.children.values()]) if (this.children.has(child.sessionId)) this.retire(child); this.retiredIds.clear(); this.pendingMetadata.clear(); }
}
