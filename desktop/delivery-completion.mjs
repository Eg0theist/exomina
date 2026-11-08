import path from 'node:path';

// This guard recognizes one deliberately narrow preference. It does not infer
// permissions from memory, model prose, shell commands or historical outcomes.
const text = value => typeof value === 'string' ? value : '';
const PAIR = /\bpackage\s+(?:and|&)\s+install\b/i;
// Activation deliberately recognizes the English package-and-install clause.
// Common English/German opt-outs remain conservative higher-priority limits.
const RESTRICTION = /\b(?:do\s+not|don't|dont|never)\s+(?:automatically\s+)?(?:package|install)\b|\bno\s+(?:packaging|installation|installing|package|install)\b|\b(?:source[ -]only|only\s+(?:the\s+)?source\s+(?:changes|edits)|(?:just|only)\s+(?:edit|change|modify)\s+(?:the\s+)?source)\b|\b(?:nicht|niemals)\s+(?:(?:automatisch|neu)\s+)?(?:installieren|paketieren|verpacken|packen)\b|\b(?:keine?\s+(?:Installation|Installationen|Pakete?|Paketierung)|nur\s+(?:den\s+)?(?:Quellcode|Source)(?:[ -](?:Änderungen|changes))?)\b/iu;
const sentences = value => text(value).match(/[^.!?\n]+(?:[.!?]|$)/g) || [];

/** Only explicit personalization instructions are eligible. Chat restrictions
 * override the global rule; unrelated chat preferences do not erase it. */
export function deliveryInstruction(globalPersonalization, chatPersonalization) {
  const own = text(chatPersonalization?.instructions);
  if (RESTRICTION.test(own)) return null;
  for (const [source, value] of [['chat', own], ['standing', text(globalPersonalization?.instructions)]]) {
    for (const sentence of sentences(value)) {
      if (PAIR.test(sentence) && !RESTRICTION.test(sentence)) return {clause: sentence.trim(), source};
    }
  }
  return null;
}

function absolute(value, workspace) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) return null;
  // Reject parent traversal even when normalization would return inside a root.
  if (value.split(/[\\/]/).includes('..') || /^(?:\\\\[?.]\\|\/\/\?\/)/.test(value)) return null;
  const windows = /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]/.test(value) || /^[a-z]:[\\/]/i.test(workspace || '');
  const api = windows ? path.win32 : path.posix;
  // Drive-relative paths are not anchored to the provided workspace.
  if (windows && /^[a-z]:[^\\/]/i.test(value)) return null;
  if (!api.isAbsolute(value) && (!workspace || !api.isAbsolute(workspace))) return null;
  const resolved = api.normalize(api.isAbsolute(value) ? value : api.resolve(workspace, value));
  if (windows && /:/.test(resolved.slice(2))) return null; // alternate data streams
  return {value: resolved.replace(/[\\/]+$/, ''), windows, api};
}

function insideSource(value, sourceRoots, workspace) {
  const candidate = absolute(value, workspace);
  if (!candidate) return null;
  for (const rootValue of sourceRoots || []) {
    const root = absolute(rootValue);
    if (!root || root.windows !== candidate.windows) continue;
    const normal = item => candidate.windows ? item.toLowerCase() : item;
    const relative = candidate.api.relative(normal(root.value), normal(candidate.value));
    if (relative && relative !== '..' && !relative.startsWith('..' + candidate.api.sep) && !candidate.api.isAbsolute(relative)) return candidate.value;
  }
  return null;
}

function inputObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length > 200000) return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}

/** Completed host/native edit receipts only. This is a syntactic source-boundary
 * check, not filesystem authorization or proof of symlink identity. */
export function completedSourceEdits(message, {sourceRoots = [], workspace} = {}) {
  const found = new Set();
  for (const step of message?.activity || []) {
    if (step.kind !== 'tool' || step.status !== 'done' || step.outcomeConfirmed !== true || step.observational === true) continue;
    const input = inputObject(step.input), name = text(step.name);
    if (!input) continue;
    let candidates = [];
    if (name === 'fileChange') candidates = (Array.isArray(input.changes) ? input.changes : []).filter(change => ['add', 'update', 'delete'].includes(change?.kind)).map(change => change.path);
    else if (['Write', 'Edit', 'MultiEdit'].includes(name)) candidates = [input.file_path];
    else if (/(?:^|__)workspace_write$/.test(name)) candidates = [input.path];
    for (const candidate of candidates) {
      const file = insideSource(candidate, sourceRoots, workspace);
      if (file) found.add(file);
    }
  }
  return [...found];
}

export const DELIVERY_INCOMPLETE_NOTICE = 'Exomina delivery check: incomplete. The requested packaging and installation workflow remains unfinished; this reply does not establish completion.';

/** One bounded model continuation, never a command runner or approval grant.
 * Dispositions must come from this run's host operations, not reply text. */
export class DeliveryCompletionGuard {
  constructor({globalPersonalization, chatPersonalization, request = '', sourceRoots = [], workspace, scope = {}} = {}) {
    this.instruction = deliveryInstruction(globalPersonalization, chatPersonalization);
    this.request = text(request);
    this.sourceRoots = sourceRoots;
    this.workspace = workspace;
    this.exempt = Object.entries(scope).some(([key, value]) => ['privateChat', 'background', 'review', 'replyReview', 'discovery', 'discoveryRun', 'noteTask'].includes(key) && value === true) || RESTRICTION.test(this.request);
    this.continued = false;
    this.paths = new Set();
    this.pending = new Map();
  }

  /** Observe normalized host/provider tool events before display clipping.
   * Pending paths do not count as edits until their exact receipt completes. */
  observe(event) {
    if (this.exempt || !this.instruction || !event || typeof event !== 'object') return;
    const id = typeof event.id === 'string' && event.id.length <= 300 ? event.id : text(event.name) ? 'name:' + event.name : null;
    const earlier = id ? this.pending.get(id) : null;
    const observational = event.observational === true || earlier?.observational === true;
    const candidates = event.input === undefined ? earlier?.paths || [] : completedSourceEdits({activity: [{kind: 'tool', name: event.name || earlier?.name, input: event.input, status: 'done', outcomeConfirmed: true, observational}]}, this).slice(0, 100);
    if (event.status === 'done') {
      if (event.outcomeConfirmed === true && !observational) for (const candidate of candidates) {
        if (this.paths.size >= 100) break;
        this.paths.add(candidate);
      }
      if (id) this.pending.delete(id);
    } else if (['error', 'denied', 'stopped', 'cancelled'].includes(event.status)) {
      if (id) this.pending.delete(id);
    } else if (id && (candidates.length || earlier)) {
      this.pending.set(id, {name: event.name || earlier?.name, paths: candidates, observational});
      if (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value);
    }
  }

  check({message, disposition = {}} = {}) {
    if (this.exempt || !this.instruction) return {status: 'irrelevant'};
    // Directions accepted during the run have the same precedence as a current
    // request; a standing default cannot override a later source-only boundary.
    if((message?.followups||[]).some(item=>item.taskStatus!=='cancelled'&&RESTRICTION.test(text(item.text))))return {status:'irrelevant'};
    const paths = [...new Set([...this.paths, ...completedSourceEdits(message, this)])].slice(0, 100);
    if (!paths.length) return {status: 'irrelevant'};
    const common = {clause: this.instruction.clause, paths};
    if (disposition.permissionDenied === true) return {...common, status: 'blocked', reason: text(disposition.reason) || 'A required operation was declined through the permission controls.'};
    if (disposition.restartApproved === true) return {...common, status: 'suspended', reason: 'Restart was approved. Installation and running-build verification remain pending until after this reply.'};
    if (typeof disposition.blocker === 'string' && disposition.blocker.trim()) return {...common, status: 'blocked', reason: disposition.blocker.trim()};
    if (this.continued) return {...common, status: 'incomplete', reason: DELIVERY_INCOMPLETE_NOTICE};
    this.continued = true;
    return {...common, status: 'continue', prompt:
      'Exomina observed completed source edits in this task and an applicable explicit user instruction. Continue the authorized task before giving its final answer.\n' +
      'Exact user instruction (' + this.instruction.source + '):\n' + this.instruction.clause + '\n' +
      'Observed edited source files (bounded): ' + JSON.stringify(paths.slice(0, 8)) + '\n' +
      'Packaging/install completion or an approved restart has not been recorded for this run. Complete the existing package and installation workflow through its normal tool approval controls, or report the concrete blocker. Do not ask the user to reaffirm an existing instruction. Do not repeat completed effects, run commands automatically from this notice, bypass approvals, or claim installation from an old outcome mark. If restart approval is granted, finish the reply so it can proceed and leave installed-build verification pending. This is one completion check, not permission for any additional action.\n' +
      'Current user request, unchanged:\n' + this.request};
  }

  finish(result, assessment) {
    if (assessment?.status !== 'incomplete') return result;
    const answer = text(result?.text);
    return {...result, text: answer.includes(DELIVERY_INCOMPLETE_NOTICE) ? answer : answer + (answer ? '\n\n' : '') + DELIVERY_INCOMPLETE_NOTICE};
  }
}
