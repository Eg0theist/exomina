import { randomUUID } from 'node:crypto';

/** Global permission levels, ordered from most to least restrictive. Each level
 * maps to a decision for every action kind; deny rules always win, and allow
 * rules or per-chat grants can only remove a prompt, never bypass a deny rule.
 */
export const PERMISSION_MODES = [
  { id: 'read-only', label: 'Read only', short: 'Read only', description: 'Agents can read and research. Edits, commands, browser and desktop actions are blocked without asking.' },
  { id: 'ask', label: 'Ask before acting', short: 'Ask', description: 'Reads in your workspace run freely. Every edit, command, browser or desktop action asks first.' },
  { id: 'auto-edit', label: 'Auto-accept edits', short: 'Auto-edit', description: 'File edits in your workspace are applied without asking. Commands, network, browser and desktop actions still ask.' },
  { id: 'full', label: 'Full access', short: 'Full access', description: 'Actions run with your account permissions, without routine prompts. Codex still asks for actions that require native confirmation. Deny rules still apply.' },
];
export const DEFAULT_PERMISSION_MODE = 'ask';
export const ACTION_KINDS = ['read', 'write', 'execute', 'network', 'browser', 'desktop', 'external', 'image', 'elevate', 'memory', 'restart', 'other'];
const MODE_IDS = new Set(PERMISSION_MODES.map(mode => mode.id));
const MATRIX = {
  'read-only': { read: 'allow', write: 'deny', execute: 'deny', network: 'deny', browser: 'deny', desktop: 'deny', external: 'deny', image: 'deny', elevate: 'deny', other: 'deny' },
  ask: { read: 'allow' },
  'auto-edit': { read: 'allow', write: 'allow' },
  full: { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', browser: 'allow', desktop: 'allow', external: 'allow', image: 'allow', elevate: 'allow', other: 'allow' },
};
const MAX_RULES = 200;

export const isPermissionMode = value => MODE_IDS.has(value);
export const permissionMode = value => isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE;

function wildcard(pattern, value) {
  const source = String(pattern).toLowerCase().split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`, 's').test(String(value).toLowerCase());
}
// Reusable command prefixes cover one literal invocation. Anything requiring
// shell parsing stays exact: separators, expansion, quoting, redirection,
// comments and escapes can otherwise run a second operation under the first.
const simpleCommand = value => /^[^\s"'`$;&|<>(){}#^%!]+(?:[ \t]+[^\s"'`$;&|<>(){}#^%!]+)*$/.test(value);
// Browser suggestions store "https://host/*" (earlier: "https://host*"). Match their parsed
// origin so a suffix host or a different port cannot reuse that permission.
// Deliberately authored host/path globs retain their normal wildcard meaning.
function browserOriginGrant(pattern, target) {
  if (!/^https?:\/\/[^/?#*]+\/?\*$/i.test(pattern)) return null;
  try {
    const allowed = new URL(pattern.slice(0, -1)), requested = new URL(target);
    if (allowed.username || allowed.password) return null;
    return !requested.username && !requested.password && requested.origin === allowed.origin;
  } catch { return false; }
}
/** A rule's match is a prefix unless it contains a wildcard; empty matches the whole tool. */
function matches(rule, action) {
  if (!wildcard(rule.tool, action.tool || '')) return false;
  if (!rule.match) return true;
  const target = String(action.target || '').trim();
  if (action.kind === 'browser' && rule.effect !== 'deny') {
    const sameOrigin = browserOriginGrant(rule.match, target);
    if (sameOrigin !== null) return sameOrigin;
  }
  if (action.kind === 'execute' && rule.effect !== 'deny') {
    const match = rule.match.trim();
    if (!simpleCommand(match)) return target === match;
    // An explicit wildcard is deliberately broader, including a whole-tool '*'.
    if (match.includes('*')) return wildcard(match, target);
    if (!simpleCommand(target)) return false;
    const command = target.toLowerCase(), prefix = match.toLowerCase();
    return command === prefix || command.startsWith(prefix + ' ') || command.startsWith(prefix + '\t');
  }
  return rule.match.includes('*') ? wildcard(rule.match, target) : target.toLowerCase().startsWith(rule.match.toLowerCase());
}
export {matches as permissionRuleMatches};

export function normalizeRule(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid permission rule.');
  const effect = value.effect === 'deny' ? 'deny' : value.effect === 'allow' ? 'allow' : null;
  const tool = typeof value.tool === 'string' ? value.tool.trim() : '';
  const match = typeof value.match === 'string' ? value.match.trim() : '';
  if (!effect) throw new Error('A permission rule must allow or deny.');
  if (!tool || tool.length > 120 || /[\x00-\x1f]/.test(tool)) throw new Error('Name the tool a permission rule applies to (wildcards like browser_* are allowed).');
  if (match.length > 500 || /[\x00-\x1f]/.test(match)) throw new Error('A permission rule match must be a single line of up to 500 characters.');
  if (effect === 'allow' && tool === '*' && !match) throw new Error('Use the Full access level instead of an allow-everything rule.');
  return { id: typeof value.id === 'string' && /^[\w-]{1,64}$/.test(value.id) ? value.id : randomUUID(), effect, tool, match,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt.slice(0, 40) : new Date().toISOString() };
}
export function normalizeRules(rules) {
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new Error(`Provide at most ${MAX_RULES} permission rules.`);
  return rules.map(normalizeRule);
}

/** First word(s) of a shell command, so "Always allow" covers `npm test --watch`
 * after approving `npm test` without also allowing every other npm command.
 */
export function commandPrefix(command) {
  const target = String(command || '').trim();
  if (target && !simpleCommand(target)) return target;
  const words = target.split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const head = words[0].replace(/^["']|["']$/g, '');
  const subcommand = words[1] && /^[a-z][\w:-]*$/i.test(words[1]) ? ` ${words[1]}` : '';
  return head + subcommand;
}

/** Suggested rule pattern for "Allow for this chat" / "Always allow". */
export function suggestRule(action = {}) {
  const tool = action.tool || 'unknown';
  if (action.kind === 'execute' && action.target) return { tool, match: commandPrefix(action.target), label: `${commandPrefix(action.target)} commands` };
  if (action.kind === 'network' && action.target) return { tool, match: action.target, label: action.target };
  if (action.kind === 'browser' && action.target && /^https?:\/\//i.test(action.target)) {
    try { const origin = new URL(action.target).origin; return { tool, match: origin + '/*', label: new URL(action.target).host }; } catch { /* fall through */ }
  }
  return { tool, match: '', label: action.toolLabel || tool };
}

export class PermissionPolicy {
  /** `getChatMode(conversationId)` returns a chat's own level, or nothing to follow the global default. */
  constructor({ getSettings, getChatMode = () => null }) {
    this.getSettings = getSettings;
    this.getChatMode = getChatMode;
    this.grants = new Map();
  }
  /** The global default level, changed only from Settings. */
  get mode() { return permissionMode(this.getSettings()?.permissionMode); }
  /** The level in force for one chat: its own level if set, otherwise the default. */
  modeFor(conversationId) {
    const own = conversationId ? this.getChatMode(conversationId) : null;
    return isPermissionMode(own) ? own : this.mode;
  }
  get rules() { return Array.isArray(this.getSettings()?.permissionRules) ? this.getSettings().permissionRules : []; }

  /** @returns {{decision:'allow'|'deny'|'ask', reason:string, rule?:object}} */
  evaluate(action = {}, conversationId, { requireConfirmation = false } = {}) {
    const verdict = this.#evaluate(action, conversationId);
    // A native approval request cannot be satisfied by Full access, a saved
    // host rule, or a host chat grant. Native session grants are handled by
    // the runtime after the user explicitly chooses that scope.
    return requireConfirmation && verdict.decision === 'allow'
      ? { decision: 'ask', mode: this.modeFor(conversationId), reason: 'The native runtime requires your confirmation.' }
      : verdict;
  }
  #evaluate(action, conversationId) {
    const kind = ACTION_KINDS.includes(action.kind) ? action.kind : 'other';
    const deny = this.rules.find(rule => rule.effect === 'deny' && matches(rule, action));
    if (deny) return { decision: 'deny', reason: `Blocked by your rule: ${deny.tool}${deny.match ? ` ${deny.match}` : ''}`, rule: deny };
    // An explicit "ask me" preference (memory review) is never upgraded.
    if (kind === 'memory') return { decision: 'ask', reason: 'Memory review is on.' };
    // Restarting ends every chat's run and installs a new program, so it is never automatic.
    if (kind === 'restart') return { decision: 'ask', reason: 'Restarting Exomina always asks.' };
    const allow = this.rules.find(rule => rule.effect === 'allow' && matches(rule, action));
    if (allow) return { decision: 'allow', reason: `Allowed by your rule: ${allow.tool}${allow.match ? ` ${allow.match}` : ''}`, rule: allow };
    if (conversationId && (this.grants.get(conversationId) || []).some(grant => matches(grant, action))) return { decision: 'allow', reason: 'Allowed for this chat.' };
    const mode = this.modeFor(conversationId);
    const decision = MATRIX[mode][kind] || 'ask';
    const label = PERMISSION_MODES.find(item => item.id === mode).label;
    const scope = mode === this.mode ? '' : ' for this chat';
    return { decision, mode, reason: decision === 'deny' ? `${label} mode${scope} blocks this action.` : decision === 'allow' ? `${label} mode${scope} allows this action.` : `${label} mode${scope} asks first.` };
  }
  grant(conversationId, rule) {
    if (!conversationId) return;
    const list = this.grants.get(conversationId) || [];
    list.push({ tool: rule.tool, match: rule.match || '' });
    this.grants.set(conversationId, list.slice(-100));
  }
  chatGrants(conversationId) { return [...(this.grants.get(conversationId) || [])]; }
  clearChat(conversationId) { this.grants.delete(conversationId); }
}

/** Classification for the tools Exomina itself hosts. */
export function hostAction(name, args = {}) {
  const tool = String(name || '');
  if(tool==='skill_library')return {kind:['catalog','read'].includes(args.action)?'read':'write',tool,target:String(args.id||args.scope||'chat')};
  if(tool==='worker_run')return {kind:args.action==='list'?'read':'execute',tool,target:String(args.id||'')};
  if(tool==='tool_pipeline')return {kind:'read',tool,target:String(args.action||'run')};
  if(tool==='spending_preview')return {kind:'read',tool,target:String(args.merchant||'')};
  if (tool === 'app_inspect') return { kind: 'read', tool, target: String(args.section || 'overview') };
  if (tool === 'model_available') return { kind: 'read', tool, target: '' };
  if (tool === 'task_refine') return {kind:'read',tool,target:String(args.action||'view')}; // Chat bookkeeping only; probes keep their own permissions.
  if (tool === 'disk_delete') return {kind:'write',tool,target:String(args.id||'local drives')};
  if (tool.startsWith('disk_')) return {kind:'read',tool,target:String(args.drive||args.id||'local drives')};
  if (tool === 'model_consult') return { kind: 'other', tool, target: String(args.provider || '') };
  if (tool === 'workspace_list' || tool === 'workspace_read') return { kind: 'read', tool, target: String(args.path || '.') };
  if (tool.startsWith('ghidra_')) return { kind: tool === 'ghidra_edit' ? 'write' : 'read', tool, target: '' };
  if (tool.startsWith('analysis_')) return { kind: 'read', tool, target: String(args.path || args.id || '') };
  if (tool === 'workspace_write') return { kind: 'write', tool, target: String(args.path || '') };
  if (tool === 'notes_remove_completed' || tool === 'notes_annotate') return { kind: 'write', tool, target: String(args.id || '') };
  if (tool === 'notes_overview_cleanup') return { kind: 'write', tool, target: 'applied notebook overview' };
  if (tool === 'notes_overview') return { kind: 'read', tool, target: 'notebook overview' };
  if (tool === 'notes_list' || tool === 'notes_read') return { kind: 'read', tool, target: String(args.id || '') };
  if (tool === 'workspace_shell') return { kind: 'execute', tool, target: String(args.command || '') };
  if (tool.startsWith('browser_')) return { kind: 'browser', tool, target: String(args.url || args.selector || args.key || '') };
  if (tool.startsWith('desktop_')) return { kind: 'desktop', tool, target: '' };
  if (tool.startsWith('external_')) return { kind: 'external', tool, target: '' };
  if (tool === 'image_generate') return { kind: 'image', tool, target: '' };
  if (tool === 'memory_note') return { kind: 'memory', tool, target: '' };
  if (tool === 'soul_reflect') return { kind: args.action === 'inspect' ? 'read' : 'memory', tool, target: String(args.action || '') };
  if (['conversation_zoom','conversation_date','conversation_find'].includes(tool)) return { kind: 'read', tool, target: String(args.conversationId || '') };
  if (tool === 'extension_add') return { kind: 'execute', tool, target: [args.command, ...(Array.isArray(args.args) ? args.args : [])].map(String).join(' ') };
  if (tool === 'github_write') return { kind: 'network', tool, target: `${args.repo || ''}${args.number ? '#' + args.number : ''}` };
  if (tool.startsWith('github_')) return { kind: 'read', tool, target: String(args.repo || args.query || '') };
  if (tool === 'app_update_status') return { kind: 'read', tool, target: '' };
  if (tool === 'app_update_verify') return {kind:'execute',tool,target:'isolated update workspace'};
  if (tool === 'app_update_prepare' || tool === 'app_update_resolve') return {kind:'write',tool,target:'isolated update workspace'};
  if (tool === 'app_restart_to_update') return { kind: 'restart', tool, target: '' };
  return { kind: 'other', tool, target: '' };
}

const CLAUDE_READ = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'Task', 'Agent', 'TaskOutput', 'ListMcpResources', 'ReadMcpResource', 'ToolSearch', 'EnterPlanMode']);
const CLAUDE_WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CLAUDE_EXECUTE = new Set(['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash']);
const CLAUDE_NETWORK = new Set(['WebFetch', 'WebSearch']);
/** Claude Code's --permission-prompt-tool request. */
export function claudeAction(toolName, input = {}) {
  const name = String(toolName || '').slice(0, 100);
  const tool = `claude.${name}`;
  if (name.startsWith('mcp__exomina__')) return { kind: 'read', tool, target: '', host: true };
  if (CLAUDE_READ.has(name)) return { kind: 'read', tool, target: String(input.file_path || input.path || input.pattern || '') };
  if (CLAUDE_WRITE.has(name)) return { kind: 'write', tool, target: String(input.file_path || input.notebook_path || '') };
  if (CLAUDE_EXECUTE.has(name)) return { kind: 'execute', tool, target: String(input.command || '') };
  if (CLAUDE_NETWORK.has(name)) { let host = ''; try { host = input.url ? new URL(input.url).host : String(input.query || ''); } catch { host = String(input.url || ''); } return { kind: 'network', tool, target: host }; }
  if (name === 'ExitPlanMode') return { kind: 'other', tool, target: '', plan: true };
  return { kind: 'other', tool, target: '' };
}

const ACP_KINDS = { read: 'read', search: 'read', think: 'read', edit: 'write', delete: 'write', move: 'write', execute: 'execute', fetch: 'network' };
export function acpAction(provider, call = {}) {
  const kind = ACP_KINDS[call.kind] || 'other';
  const input = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  const target = String(input.command || input.file_path || input.path || input.url || call.locations?.[0]?.path || call.title || '').slice(0, 2000);
  return { kind, tool: `${provider}.${call.kind || 'tool'}`, target };
}

/** Native runtime settings for each permission level. */
export function codexPolicy(mode) {
  switch (permissionMode(mode)) {
    case 'read-only': return { sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never', effective: 'readOnly' };
    case 'auto-edit': return { sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'on-request', effective: 'workspaceWrite' };
    // `never` rejects commands the runtime flags as dangerous, even without
    // a filesystem sandbox. Keep its supported native confirmation route.
    case 'full': return { sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'on-request', effective: 'dangerFullAccess' };
    default: return { sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'untrusted', effective: 'workspaceWrite' };
  }
}
/** Claude always routes prompts through Exomina's permission tool, so rules and
 * per-chat grants apply. Read only additionally switches the model into planning.
 * Plan mode also refuses every Exomina tool, so a follow-up (host read tools
 * only, no native tools) keeps the normal mode; its gateway scope enforces read only.
 */
export function claudePermissionMode(mode, { nativeTools = true } = {}) { return permissionMode(mode) === 'read-only' && nativeTools ? 'plan' : 'manual'; }
