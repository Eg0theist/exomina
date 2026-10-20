import {findTextQuestions, textQuestionGroup} from './text-questions.mjs';

export function toolActivityState(step) {
  if (['running', 'error', 'denied', 'stopped'].includes(step.status)) return step.status;
  if (step.status === 'done' && step.outcomeConfirmed === true) return 'done';
  // Older saved rows did not carry execution evidence. Keep their records quiet
  // without promoting them to proof of either success or failure.
  if (step.status === 'done' && step.outcomeConfirmed === undefined) return 'recorded';
  return step.observational === true ? 'recorded' : 'unknown';
}
export const activityProblem = step => step.kind === 'tool' && ['error', 'denied', 'stopped', 'unknown'].includes(toolActivityState(step));
export function toolActivityTitle(step) {
  const state = toolActivityState(step), title = step.title || step.name || 'Tool';
  if (state === 'done') return step.doneTitle || title;
  return title + ({error: ' (failed)', denied: ' (not allowed)', stopped: ' (completion not confirmed)', unknown: ' (result not confirmed)', recorded: ' (recorded)'}[state] || '');
}
const needsAnswer = group => group && (['waiting', 'open'].includes(group.status) || group.status === 'answered' && ['failed', 'sending'].includes(group.deliveryState));

/** Presentation only. An exact later success can quiet an earlier failed attempt,
 * but an unrelated tool, final prose or a closed stream cannot prove recovery.
 * Keys are generated from full inputs before the saved display text is clipped.
 * Older logs without explicit outcome evidence remain visible conservatively.
 */
export function recoveredActivity(steps = []) {
  const successes = new Set(), recovered = new Set();
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (step.kind !== 'tool' || !step.operationKey) continue;
    if (activityProblem(step) && successes.has(step.operationKey)) recovered.add(step.id);
    if (step.status === 'done' && step.outcomeConfirmed === true) successes.add(step.operationKey);
  }
  return recovered;
}

/** Keep controls and unresolved problems outside the disclosure. Standard keeps
 * the latest narration while work continues; history and technical diagnostics
 * remain available in the same disclosure. Advanced retains the full step log.
 */
export function activityVisibility(message, {standard = false, running = false} = {}) {
  const steps = Array.isArray(message?.activity) ? message.activity : [];
  const recovered = recoveredActivity(steps);
  if (!standard) return {
    updates: steps.filter(step => ['note', 'status', 'followup', 'question', 'reroute'].includes(step.kind) || activityProblem(step)),
    details: steps.filter(step => ['tool', 'thinking', 'native'].includes(step.kind)), recovered,
  };
  const latestNote = running ? steps.findLast(step => step.kind === 'note') : null;
  const updates = steps.filter(step => {
    if (['followup', 'question'].includes(step.kind)) return true;
    if (activityProblem(step)) return !recovered.has(step.id);
    if (step.kind === 'status') return step.notice === 'handoff' || ['error', 'denied', 'stopped', 'running'].includes(step.status);
    if (step.kind !== 'note') return false;
    if (step === latestNote) return true;
    // Questions recovered from assistant prose are embedded in their note. They
    // must remain answerable even when later progress replaces that narration.
    return findTextQuestions(step.text).some(question => needsAnswer(textQuestionGroup(message, step.id, question)));
  });
  const visible = new Set(updates);
  return {updates, details: steps.filter(step => ['tool', 'thinking', 'native', 'note', 'status', 'reroute'].includes(step.kind) && (!visible.has(step) || step.kind === 'tool')), recovered};
}
