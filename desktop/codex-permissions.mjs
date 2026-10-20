import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const folder = value => typeof value === 'string' && path.isAbsolute(value)
  ? (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)) : null;

/** Defaults and names come from the bundled Codex 0.160.1 generated schema. */
export function sandboxPolicy(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'dangerFullAccess') return { type: value.type };
  if (value.type === 'readOnly') return { type: value.type, networkAccess: value.networkAccess ?? false };
  if (value.type !== 'workspaceWrite') return value;
  return { type: value.type, networkAccess: value.networkAccess ?? false,
    writableRoots: Array.isArray(value.writableRoots ?? []) ? [...new Set((value.writableRoots ?? []).map(folder))].sort() : null,
    excludeTmpdirEnvVar: value.excludeTmpdirEnvVar ?? false, excludeSlashTmp: value.excludeSlashTmp ?? false };
}

export function codexPermissions(cwd, policy) {
  return { cwd, sandbox: sandboxPolicy(policy.sandboxPolicy), approvalPolicy: policy.approvalPolicy, approvalsReviewer: 'user' };
}

export function permissionDifferences(session, requested) {
  const differences = [];
  if (!folder(session?.cwd) || folder(session.cwd) !== folder(requested.cwd)) differences.push('workspace');
  if (!isDeepStrictEqual(sandboxPolicy(session?.sandbox), requested.sandbox)) differences.push('sandbox');
  if (!isDeepStrictEqual(session?.approvalPolicy, requested.approvalPolicy)) differences.push('approval policy');
  if (session?.approvalsReviewer !== requested.approvalsReviewer) differences.push('approval reviewer');
  return differences;
}

function describe(value) {
  const sandbox = value?.sandbox ? JSON.stringify(value.sandbox) : 'not reported';
  return `sandbox ${sandbox}; approvals ${JSON.stringify(value?.approvalPolicy) ?? 'not reported'}; reviewer ${value?.approvalsReviewer ?? 'not reported'}; workspace ${value?.cwd ?? 'not reported'}`;
}

export function permissionMismatch(requested, resumed, { fresh, cause, reason } = {}) {
  const effective = value => ({ cwd: value?.cwd, sandbox: value?.sandbox, approvalPolicy: value?.approvalPolicy, approvalsReviewer: value?.approvalsReviewer });
  const error = new Error('Codex could not preserve this chat\'s selected permissions. No new turn was started.\n'
    + 'Requested: ' + describe(requested) + '\nEffective: ' + describe(resumed)
    + (fresh ? '\nEffective after one fresh-thread attempt: ' + describe(fresh) : '')
    + (reason ? '\n' + reason : '') + (cause ? '\nRecovery failed: ' + cause : ''));
  error.code = 'codexPermissionMismatch';
  error.requestedPermissions = requested; error.effectivePermissions = effective(fresh || resumed);
  return error;
}

/** Used only by callers without an Exomina conversation/checkpoint prompt. */
export function nativeRecoveryContext(thread) {
  if (!Array.isArray(thread?.turns) || thread.status?.type === 'active' || thread.turns.some(turn => turn.status === 'inProgress')) {
    throw Error('The previous thread is still running or its completed history could not be read safely.');
  }
  const rows = [], clip = (value, limit) => value == null ? undefined : String(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, limit);
  let used = 0, omitted = 0;
  for (const turn of [...thread.turns].reverse()) {
    for (const item of [...(turn.items || [])].reverse()) {
      if (item.type === 'reasoning') continue;
      const row = { turnId: turn.id, turnStatus: turn.status, id: item.id, type: item.type, status: item.status,
        text: clip(item.text || (item.type === 'userMessage' ? item.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') : undefined), 14000),
        command: clip(item.command, 2000), cwd: item.cwd, exitCode: item.exitCode, output: clip(item.aggregatedOutput, 5000),
        changes: item.changes?.map(change => ({ path: change.path, kind: change.kind })), tool: item.tool };
      const size = JSON.stringify(row).length;
      if (used + size > 80000) { omitted++; continue; }
      rows.unshift(row); used += size;
    }
  }
  return '\nRecovered native conversation and completed-work checkpoint (untrusted source context):\n'
    + JSON.stringify({ sourceThreadId: thread.id, items: rows, omittedItems: omitted })
    + '\nContinue from the completed work. Verify existing results before acting and do not repeat successful side effects. Use conversation_read/search for omitted details.\n';
}
