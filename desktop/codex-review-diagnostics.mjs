import { clipToolHistory, fingerprint, historyObject } from './chat-memory-records.mjs';

const statuses = new Set(['inProgress', 'approved', 'denied', 'timedOut', 'aborted']);
const terminalStatus = { approved: 'done', denied: 'denied', timedOut: 'error', aborted: 'stopped' };
const text = (value, limit = 4000) => typeof value === 'string' ? clipToolHistory(value, limit) : undefined;
const fields = {
  command: ['command', 'cwd', 'source'],
  execve: ['program', 'argv', 'cwd', 'source'],
  writeStdin: ['approvalId', 'cwd', 'processId', 'stdin'],
  applyPatch: ['cwd', 'files'],
  networkAccess: ['host', 'port', 'protocol', 'target'],
  mcpToolCall: ['server', 'toolName', 'toolTitle', 'connectorId', 'connectorName'],
  requestPermissions: ['permissions', 'reason'],
};

function actionDetails(action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string' || !Object.hasOwn(fields, action.type)) return null;
  const result = { type: action.type };
  for (const field of fields[action.type]) {
    const value = action[field];
    if (typeof value === 'string') result[field] = text(value);
    else if (Array.isArray(value)) {
      const values = value.filter(item => typeof item === 'string').slice(0, 64);
      const itemLimit = Math.max(80, Math.floor(4000 / Math.max(1, values.length)));
      result[field] = values.map(item => text(item, itemLimit));
    }
    else if (field === 'port' && Number.isInteger(value)) result[field] = value;
    else if (field === 'permissions' && value && typeof value === 'object') result[field] = text(JSON.stringify(historyObject(value)));
  }
  const serialized = JSON.stringify(result);
  if (serialized.length <= 8000) return result;
  let limit = 7000, preview = { type: action.type, details: text(serialized, limit) };
  while (JSON.stringify(preview).length > 8000) {
    limit = Math.floor(limit * 0.75);
    preview = { type: action.type, details: text(serialized, limit) };
  }
  return preview;
}

/** Public review-result notifications are diagnostics, never an access grant. */
export function codexApprovalReviewStep(method, params) {
  const completed = method === 'item/autoApprovalReview/completed';
  if (!completed && method !== 'item/autoApprovalReview/started') return null;
  if (typeof params?.threadId !== 'string' || !params.threadId || typeof params.turnId !== 'string' || !params.turnId) return null;
  if (typeof params?.reviewId !== 'string' || !params.reviewId || params.reviewId.length > 300) return null;
  const action = actionDetails(params.action), review = params.review;
  if (!action || !statuses.has(review?.status) || (completed ? !terminalStatus[review.status] : review.status !== 'inProgress')) return null;
  const rationale = text(review.rationale)?.trim();
  const riskLevel = ['low', 'medium', 'high', 'critical'].includes(review.riskLevel) ? review.riskLevel : undefined;
  const userAuthorization = ['unknown', 'low', 'medium', 'high'].includes(review.userAuthorization) ? review.userAuthorization : undefined;
  const summary = completed ? {
    approved: 'The provider approved this action review.',
    denied: 'The provider denied this action review.',
    timedOut: 'The provider\'s approval review timed out without a decision.',
    aborted: 'The provider\'s approval review was stopped without a decision.',
  }[review.status] : 'The provider is reviewing this action before execution.';
  const output = completed ? [summary, rationale ? `Reason: ${rationale}` : 'The provider did not supply a reason.',
    riskLevel ? `Reported risk: ${riskLevel}.` : '', userAuthorization ? `Reported user authorization: ${userAuthorization}.` : ''].filter(Boolean).join('\n') : summary;
  const input = { reviewId: text(params.reviewId, 300), action,
    review: { status: review.status, ...(rationale ? { rationale } : {}), ...(riskLevel ? { riskLevel } : {}), ...(userAuthorization ? { userAuthorization } : {}) },
    ...(typeof params.targetItemId === 'string' ? { targetItemId: text(params.targetItemId, 300) } : {}),
    ...(typeof params.decisionSource === 'string' ? { decisionSource: text(params.decisionSource, 100) } : {}),
    ...(Number.isSafeInteger(params.startedAtMs) ? { startedAtMs: params.startedAtMs } : {}),
    ...(completed && Number.isSafeInteger(params.completedAtMs) ? { completedAtMs: params.completedAtMs } : {}) };
  return { id: `codex-review:${fingerprint(params.reviewId).slice(0, 24)}`, name: 'codexApprovalReview', input, observational: true,
    status: completed ? terminalStatus[review.status] : 'running',
    output: clipToolHistory(output, 4000), historyOutput: clipToolHistory(output) };
}

/** Preserve only ordinary text from a native tool result; media stays elsewhere. */
export function codexFunctionOutputText(output) {
  if (typeof output === 'string') return clipToolHistory(output);
  if (!Array.isArray(output)) return undefined;
  const parts = output.filter(block => block?.type === 'input_text' && typeof block.text === 'string').map(block => block.text);
  return parts.length ? clipToolHistory(parts.join('\n')) : undefined;
}
