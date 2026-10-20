// Foundation of the always-on agent: event triggers that start an existing Workbench task.
// A trigger watches a folder the user chose. Changes are collected for a short while,
// then the local decision layer (Tier 1/2, processor only) may skip clearly irrelevant
// events, a daily budget caps how many runs can start, and everything lands in a review
// inbox where the user's feedback becomes the decision layer's training data.
// Off by default. Runs are ordinary background tasks: they cannot approve risky actions.
import {randomUUID} from 'node:crypto';
import {watch as fsWatch} from 'node:fs';
import path from 'node:path';
import {normalizeAgentSettings} from './decision-settings.mjs';

const SETTLE_MS = 30_000;       // collect a burst of file changes (a copy, a save) into one event
const MAX_BATCH_MS = 120_000;  // continuously changing folders still produce a bounded batch
const MAX_FILES = 40;           // names listed per event
const INBOX_MAX = 200;
const MAX_TRIGGERS = 20;
const SKIP_CONFIDENCE = 0.85;   // the local check may only skip an event when it is this sure
const IGNORED = /(^|[\\/])(~\$|\.~lock|desktop\.ini$|thumbs\.db$)|\.(tmp|part|crdownload|swp)$/i;

const line = (value, max) => String(value || '').replace(/[\r\n\x00-\x1f]+/g, ' ').trim().slice(0, max);
const dayKey = date => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
export const agentGate = trigger => `agent.${trigger.id}`;

/** "*.pdf, *.docx" -> matcher. Empty pattern matches every file. Pure. */
export function fileFilter(pattern) {
  const parts = String(pattern || '').split(/[,;]/).map(part => part.trim()).filter(Boolean);
  if (!parts.length) return () => true;
  const regexes = parts.map(part => new RegExp('^' + part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'));
  return name => regexes.some(regex => regex.test(path.basename(name)));
}

export function validateTrigger(input, {schedules = []} = {}) {
  const name = line(input.name, 80);
  if (!name) throw Error('Name the trigger.');
  if (typeof input.folder !== 'string' || !path.isAbsolute(input.folder)) throw Error('Choose a folder to watch.');
  if (!schedules.some(task => task.id === input.taskId)) throw Error('Choose the Workbench task this trigger starts.');
  return {name, folder: input.folder, taskId: input.taskId, filter: line(input.filter, 200), condition: line(input.condition, 300), enabled: input.enabled !== false};
}

/** The text the decision layer and the task see for one event. Pure. */
export function describeEvent(trigger, files) {
  const shown = files.slice(0, MAX_FILES);
  return `Files changed in ${trigger.folder}:\n${shown.map(file => '- ' + file).join('\n')}${files.length > shown.length ? `\n(and ${files.length - shown.length} more)` : ''}`;
}

export class AgentTriggers {
  /**
   * @param {object} options
   * @param {object} options.store App store (settings.agent, agentTriggers, agentInbox, schedules).
   * @param {Function} options.runTask (taskId, extraPrompt) => {conversationId, error}
   * @param {Function} [options.decisions] () => DecisionLayer, or null when local decisions are off.
   */
  constructor({store, runTask, decisions = () => null, cleanup = decisions, emit = () => {}, watch = fsWatch, clock = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout}) {
    Object.assign(this, {store, runTask, decisions, cleanup, emit, watch, clock, setTimer, clearTimer});
    this.watchers = new Map();   // trigger id -> {watcher, files:Set, timer}
    this.mutations = Promise.resolve();
  }

  settings() { return normalizeAgentSettings(this.store.state.settings.agent); }
  triggers() { return this.store.state.agentTriggers ||= []; }
  inbox() { return this.store.state.agentInbox ||= []; }
  view() { return {settings: this.settings(), triggers: this.triggers(), inbox: this.inbox().slice(0, 50), runsToday: this.runsToday(), watching: [...this.watchers.keys()]}; }

  runsToday() {
    const today = dayKey(this.clock());
    return this.store.state.agentUsage?.day === today ? this.store.state.agentUsage.started : 0;
  }

  async save() { await this.store.save(); this.emit({type: 'agent.changed'}); }

  mutate(work) { const result = this.mutations.catch(() => {}).then(work); this.mutations = result; return result; }
  saveTrigger(input) { return this.mutate(() => this.updateTrigger(input)); }
  async updateTrigger(input) {
    const previous = input.id ? this.triggers().find(item => item.id === input.id) : null;
    if (input.id && !previous) throw Error('Trigger not found.');
    if (!previous && this.triggers().length >= MAX_TRIGGERS) throw Error(`Use at most ${MAX_TRIGGERS} triggers.`);
    const item = {...previous, ...validateTrigger(input, {schedules: this.store.state.schedules || []}), id: previous?.id || randomUUID(), version:randomUUID()};
    if (previous && (previous.condition !== item.condition || previous.filter !== item.filter || previous.folder !== item.folder))
      await this.cleanup()?.forgetSource('agent:' + item.id);
    this.store.state.agentTriggers = [...this.triggers().filter(other => other.id !== item.id), item];
    await this.save(); this.refresh();
    return item;
  }

  removeTrigger(id) { return this.mutate(() => this.deleteTrigger(id)); }
  async deleteTrigger(id) {
    await this.cleanup()?.forgetSource('agent:' + id);
    this.store.state.agentTriggers = this.triggers().filter(item => item.id !== id);
    await this.save(); this.refresh();
  }

  /** Starts or stops folder watchers to match the settings. Safe to call any time. */
  refresh() {
    const on = this.settings().enabled;
    const wanted = new Map(on ? this.triggers().filter(item => item.enabled).map(item => [item.id, item]) : []);
    for (const [id, entry] of this.watchers) {
      const trigger = wanted.get(id);
      if (!trigger || trigger !== entry.trigger) { this.stopWatcher(id); }
    }
    for (const [id, trigger] of wanted) {
      if (this.watchers.has(id)) continue;
      try {
        const entry = {folder: trigger.folder, trigger, files: new Set(), omitted:false, firstAt:null, timer: null, watcher: null};
        entry.watcher = this.watch(trigger.folder, {recursive: true, persistent: false}, (_type, name) => this.noticed(id, name));
        entry.watcher.on?.('error', error => this.watchFailed(id, error));
        this.watchers.set(id, entry);
      } catch (error) { this.watchFailed(id, error); }
    }
  }

  stopWatcher(id) {
    const entry = this.watchers.get(id);
    if (!entry) return;
    if (entry.timer) this.clearTimer(entry.timer);
    try { entry.watcher?.close(); } catch {}
    this.watchers.delete(id);
  }

  stop() { for (const id of [...this.watchers.keys()]) this.stopWatcher(id); }

  watchFailed(id, error) {
    this.stopWatcher(id);
    const trigger = this.triggers().find(item => item.id === id);
    if (trigger) this.addInbox({triggerId: id, triggerName: trigger.name, status: 'failed', reason: `Could not watch the folder: ${error.message}`}).catch(() => {});
  }

  noticed(id, name) {
    const entry = this.watchers.get(id);
    const trigger = this.triggers().find(item => item.id === id);
    if (!entry || !trigger || !name) return;
    const file = String(name);
    if (IGNORED.test(file) || !fileFilter(trigger.filter)(file)) return;
    if (entry.files.size < MAX_FILES || entry.files.has(file)) entry.files.add(file); else entry.omitted=true;
    entry.firstAt ??= +this.clock();
    if (entry.timer) this.clearTimer(entry.timer);
    const delay = Math.max(0,Math.min(SETTLE_MS, MAX_BATCH_MS-(+this.clock()-entry.firstAt)));
    entry.timer = this.setTimer(() => { entry.timer = null; const files = [...entry.files], omitted=entry.omitted;entry.files.clear();entry.firstAt=null;entry.omitted=false;const current = this.triggers().find(item => item.id === id); if (current?.enabled) this.handle(current, files, {omitted}).catch(() => {}); }, delay);
    entry.timer?.unref?.();
  }

  async addInbox(item) {
    const entry = {id: randomUUID(), at: this.clock().toISOString(), ...item};
    this.store.state.agentInbox = [entry, ...this.inbox()].slice(0, INBOX_MAX);
    await this.save();
    return entry;
  }

  /** One collected event: local check, budget, then the Workbench task. */
  async handle(trigger, files, {omitted=false}={}) {
    if (!files.length || !this.settings().enabled) return null;
    const input = describeEvent(trigger, files)+(omitted ? '\nAdditional changed files were omitted from this bounded list.' : '');
    const base = {triggerId: trigger.id, triggerVersion:trigger.version, triggerName: trigger.name, files: files.slice(0, MAX_FILES), input};
    const layer = this.decisions();
    if (layer && !omitted && input.length <= 4000) {
      // Processor tiers only: an always-on agent must never wake a model on the graphics card for this.
      const verdict = await layer.ask({gate: agentGate(trigger), kind: 'noul', input, hypothesis: trigger.condition, question: trigger.condition, threshold: SKIP_CONFIDENCE, background: true, maxTier: 2}).catch(() => null);
      if (verdict && !verdict.abstained && verdict.answer === false)
        return this.addInbox({...base, status: 'skipped', reason: `The local check judged this event irrelevant (Tier ${verdict.tier}). Review it here if it should have run.`});
    }
    // Settings or the trigger may have changed while a local decision was in flight.
    const current = this.triggers().find(item => item.id === trigger.id);
    if (!this.settings().enabled || !current?.enabled || current !== trigger) return null;
    const {dailyBudget} = this.settings();
    if (this.runsToday() >= dailyBudget)
      return this.addInbox({...base, status: 'over-budget', reason: `Today's limit of ${dailyBudget} automatic runs is reached. Nothing was sent.`});
    // Claim synchronously before any await. Failed and interrupted starts count too;
    // trimming the inbox must never reset the budget.
    this.store.state.agentUsage = {day: dayKey(this.clock()), started: this.runsToday() + 1};
    const entry = await this.addInbox({...base, status: 'running', runStarted: true});
    if (!this.settings().enabled || this.triggers().find(item=>item.id===trigger.id) !== trigger || !trigger.enabled) {
      Object.assign(entry,{status:'cancelled',reason:'The agent or trigger changed before this run could start.'});await this.save();return entry;
    }
    try {
      const result = await this.runTask(trigger.taskId, `Started automatically by the trigger “${trigger.name}”.\n${input}`);
      const success = result?.status === 'complete' && !result.error;
      Object.assign(entry, success ? {status: 'ran'} : {status: 'failed', reason: result?.error || 'The task did not complete.'}, {conversationId: result?.conversationId});
    } catch (error) { Object.assign(entry, {status: 'failed', reason: error.message}); }
    await this.save();
    return entry;
  }

  /** "Should this have run?" from the inbox. The answer trains the trigger's local check. */
  feedback(id, shouldRun) { return this.mutate(() => this.saveFeedback(id, shouldRun)); }
  async saveFeedback(id, shouldRun) {
    const entry = this.inbox().find(item => item.id === id);
    if (!entry?.input) throw Error('This inbox entry cannot be rated.');
    if (typeof shouldRun !== 'boolean') throw Error('Choose yes or no.');
    const trigger = this.triggers().find(item => item.id === entry.triggerId);
    if (!trigger) throw Error('The trigger was removed.');
    if (entry.triggerVersion !== trigger.version) throw Error('This trigger changed after the event. New events can teach its updated check.');
    await this.decisions()?.record({gate: agentGate(trigger), kind: 'noul', input: entry.input, answer: shouldRun, source: 'agent:' + trigger.id, key:entry.id});
    entry.feedback = shouldRun;
    await this.save();
    return entry;
  }

  start() {
    // Runs interrupted by a restart are not repeated automatically.
    for (const item of this.inbox()) if (item.status === 'running') Object.assign(item, {status: 'failed', reason: 'Exomina closed during this run. Open its chat to check the result.'});
    this.refresh();
  }
}
