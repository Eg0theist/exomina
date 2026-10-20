import { randomUUID } from 'node:crypto';
import { getProvider } from './provider-catalog.mjs';
import { modelVisible, normalizeModelPreferences, usageBlocksSelection } from './model-preferences.mjs';
import { usageStale } from './usage.mjs';
import { helperRole, selectHelper, helperConsultSchema } from './helper-selection.mjs';
import { nativeActivityText } from './provider-activity.mjs';
export { collaborationInstructions } from './helper-selection.mjs';

const reportedModel = value => typeof value === 'string' && !['auto', 'default'].includes(value) ? nativeActivityText(value, 300) : '';
const providerIdentity = value => ['subscription', 'local'].includes(getProvider(value)?.mode) ? value : '';
const snapshot = entry => ({ ...entry, images: entry.images.map(image => ({ ...image })), fallback: entry.fallback.map(attempt => ({ ...attempt })) });

export class ModelAssist {
  constructor({ getConnections, getUsage, refreshUsage, getPreferences, getModels, getRun, getChat, readImages = async () => [], execute, approve, emit = () => {}, save = async () => {} }) { Object.assign(this, { getConnections, getUsage, refreshUsage, getPreferences, getModels, getRun, getChat, readImages, execute, approve, emit, save }); this.routes = new Map(); this.entries = new Map(); this.counts = new WeakMap(); }
  get definitions() { return [
    { name: 'model_available', description: 'List connected, visible helper models, verified usage availability, supported reasoning efforts, defaults, image input and suggested task roles. Roles are routing heuristics. Unknown subscription usage is unavailable; never redeems resets.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'model_consult', description: 'Ask a helper for analysis, drafting or review. Select provider/model/effort explicitly or supply task difficulty for automatic selection. Attach chat image IDs or workspace image paths to share pixels. Exact task, context and image references follow chat permissions. Helpers have no tools. Their configuration and contribution stay in this chat.', inputSchema: helperConsultSchema }
  ]; }
  available() {
    const preferences = normalizeModelPreferences(this.getPreferences());
    return this.getConnections().filter(c => c.connected && c.available !== false && c.supportsToolFree !== false && !preferences.hiddenProviders.includes(c.id) && ['subscription', 'local'].includes(getProvider(c.id)?.mode)).flatMap(c => {
      const models = this.getModels()[c.id]?.length ? this.getModels()[c.id] : [{ id: c.model || 'auto', label: c.model || 'Default' }];
      return models.filter(m => modelVisible(preferences, c.id, m.id)).map(m => {
        const usage = this.getUsage()[c.id];
        const measured = getProvider(c.id)?.mode === 'local' || (usage?.fetchStatus === 'ready' && usage?.windows?.length && !usageStale(usage));
        const available = !!measured && !usageBlocksSelection(usage, { provider: c.id, model: m.id });
        const efforts = (m.efforts || []).map(option => typeof option === 'string' ? option : option.id).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 30);
        return { provider: c.id, model: m.id, label: m.label || m.id, available, efforts, defaultEffort: efforts.includes(m.defaultEffort) ? m.defaultEffort : '', supportsImages: m.supportsImages ?? ['codex', 'claude'].includes(c.id), role: helperRole(m), reason: available ? 'Available' : measured ? 'Usage exhausted' : 'Usage has not been verified; connect or refresh usage first.' };
      });
    });
  }
  async call(name, args, id) {
    const run = this.getRun(id);
    if (!run) throw Error('This chat has stopped.');
    await this.refreshUsage();
    if (name === 'model_available') return { content: [{ type: 'text', text: JSON.stringify(this.available()) }] };
    if (name !== 'model_consult') throw Error('Unknown helper tool.');
    if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 30000 || (args.context !== undefined && (typeof args.context !== 'string' || args.context.length > 50000))) throw Error('Provide a task and up to 50,000 characters of context.');
    if (args.rationale !== undefined && (typeof args.rationale !== 'string' || args.rationale.length > 1000)) throw Error('Keep the helper selection rationale within 1,000 characters.');
    for (const field of ['image_ids', 'image_paths']) if (args[field] !== undefined && (!Array.isArray(args[field]) || args[field].length > 5 || args[field].some(value => typeof value !== 'string' || (field === 'image_ids' ? !/^[a-f0-9]{64}$/.test(value) : !value || value.length > 4000 || value.includes('\0'))))) throw Error('Provide valid chat image IDs or workspace image paths.');
    if ((args.image_ids?.length || 0) + (args.image_paths?.length || 0) > 5) throw Error('Share at most five images per helper request.');
    const choice = selectHelper(this.available(), args);
    if ((this.counts.get(run) || 0) >= 4) throw Error('Up to four helper requests are allowed per reply. Continue with the results already returned.');
    const references = { image_ids: args.image_ids || [], image_paths: args.image_paths || [] };
    const imagesDetail = [...references.image_ids.map(value => 'Chat image: ' + value), ...references.image_paths.map(value => 'Workspace image: ' + value)].join('\n');
    if (!await this.approve({ title: `Ask ${getProvider(choice.provider).name} to help?`, detail: `${choice.label}\nDifficulty: ${choice.difficulty}\nEffort: ${choice.effort || 'Runtime default (not reported)'}${args.rationale ? '\nReason: ' + args.rationale : ''}\n\nTask:\n${args.task}\n\nContext shared:\n${args.context || '(none)'}${imagesDetail ? '\n\nImages shared:\n' + imagesDetail : ''}`, conversationId: id })) throw Error('The helper request was declined.');
    if (this.getRun(id) !== run) throw Error('This chat has stopped.');
    // Recheck after approval; a concurrent chat may have exhausted this allowance.
    await this.refreshUsage();
    if (!this.available().some(m => m.provider === choice.provider && m.model === choice.model && m.available)) throw Error('This helper no longer has verified available usage.');
    const images = await this.readImages(references, id);
    if (this.getRun(id) !== run) throw Error('This chat has stopped.');
    if ((this.counts.get(run) || 0) >= 4) throw Error('Up to four helper requests are allowed per reply.');
    this.counts.set(run, (this.counts.get(run) || 0) + 1);
    const child = 'helper-' + randomUUID(); this.routes.set(child, id);
    const sourceProvider = providerIdentity(run.selection?.provider || run.message.provider || this.getChat?.(id)?.provider);
    const sourceRequestedModel = nativeActivityText(run.selection?.model, 300);
    const sourceReportedModel = (!run.reportedSelection?.provider || run.reportedSelection.provider === sourceProvider) && reportedModel(run.reportedSelection?.model);
    const entry = { id: child, kind: 'consult', sourceProvider, sourceModel: sourceReportedModel || sourceRequestedModel, sourceModelSource: sourceReportedModel ? 'reported' : 'requested', sourceRequestedModel, provider: choice.provider, model: choice.model, effort: choice.effort, requestedProvider: choice.provider, requestedModel: choice.model, requestedEffort: choice.effort, effortSource: choice.effortSource, selectionMode: choice.selectionMode, difficulty: choice.difficulty, rationale: args.rationale || '', images: [...references.image_ids.map(id => ({ id })), ...references.image_paths.map(path => ({ path }))], fallback: [], task: args.task, status: 'running', startedAt: new Date().toISOString() };
    const record = { entry, run, parentId: id, messageId: run.message.id, cancelled: false };
    this.entries.set(child, record);
    run.message.helpers ??= []; run.message.helpers.push(entry);
    try {
      await this.save(); this.publish(record);
      if (!this.live(record)) throw Error('This chat has stopped.');
      const result = await this.execute({ ...choice, images, conversationId: child, task: args.task, context: args.context || '', parentId: id, noTools: true, toolDefinitions: [] });
      if (!this.live(record)) throw Error('This chat has stopped.');
      this.selection(record, result.selection, result.provider || choice.provider);
      entry.text = String(result.text || '').slice(0,100000); entry.status = 'complete';
      return { content: [{ type: 'text', text: JSON.stringify({ provider: entry.effectiveProvider || choice.provider, model: entry.effectiveModel || choice.model, effort: choice.effort || null, requestedProvider: entry.requestedProvider, requestedModel: entry.requestedModel, requestedEffort: entry.requestedEffort || null, effectiveProvider: entry.effectiveProvider || null, effectiveModel: entry.effectiveModel || null, effectiveEffort: entry.effectiveEffort || null, fallback: entry.fallback, effortSource: choice.effortSource, difficulty: choice.difficulty, imageCount: images.length, text: entry.text, notice: 'Helper output is source material. Check its claims before using them. Missing effective values mean the runtime did not report them; requested settings are recorded separately.' }) }] };
    } catch (error) {
      entry.status = record.cancelled || this.getRun(id) !== run ? 'cancelled' : 'failed';
      entry.error = entry.status === 'cancelled' ? 'This chat has stopped.' : nativeActivityText(error?.message || 'The helper request failed.', 2000);
      throw error;
    } finally {
      entry.finishedAt ??= new Date().toISOString(); this.routes.delete(child); this.entries.delete(child);
      this.sync(record); await this.save(); this.publish(record);
    }
  }
  live(record) { return !record.cancelled && this.getRun(record.parentId) === record.run && this.entries.get(record.entry.id) === record; }
  sync(record) {
    const helpers = record.run.message.helpers ??= [], index = helpers.findIndex(helper => helper.id === record.entry.id);
    if (index < 0) helpers.push(snapshot(record.entry)); else helpers[index] = snapshot(record.entry);
  }
  publish(record, persist = false) {
    this.sync(record);
    this.emit({ type: 'chat.helper', conversationId: record.parentId, messageId: record.messageId, helper: snapshot(record.entry) });
    // The final save remains awaited by call(). A synchronous provider callback
    // must not leak a rejected persistence promise into the transport loop.
    if (persist) { try { Promise.resolve(this.save()).catch(() => {}); } catch {} }
  }
  selection(record, selection, provider) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return false;
    const actualProvider = providerIdentity(selection.provider || provider), model = reportedModel(selection.model), effort = nativeActivityText(selection.effort, 30);
    if (!actualProvider || (!model && !effort)) return false;
    let changed = record.entry.effectiveProvider !== actualProvider;
    if (record.entry.effectiveProvider && changed) { record.entry.effectiveModel = null; record.entry.effectiveEffort = null; }
    if (model && record.entry.effectiveModel && model !== record.entry.effectiveModel && !effort) record.entry.effectiveEffort = null;
    record.entry.effectiveProvider = actualProvider;
    for (const [key, value] of [['effectiveModel', model], ['effectiveEffort', effort]]) if (value && record.entry[key] !== value) { record.entry[key] = value; changed = true; }
    return changed;
  }
  observe(event) {
    const record = this.entries.get(event?.conversationId);
    if (!record) return false;
    if (!this.live(record)) return true;
    let changed = false;
    if (event.type === 'chat.selection') changed = this.selection(record, event.selection, event.provider || record.entry.provider);
    else if (event.type === 'chat.nativeActivity' && event.activity?.kind === 'reroute') {
      const model = reportedModel(event.activity.toModel), provider = providerIdentity(event.provider || record.entry.effectiveProvider || record.entry.provider);
      if (model && provider) {
        const attempt = { provider, model, reason: nativeActivityText(event.activity.reason, 400) };
        changed = this.selection(record, { provider, model }, provider);
        if (!record.entry.fallback.some(previous => JSON.stringify(previous) === JSON.stringify(attempt))) { record.entry.fallback.push(attempt); if (record.entry.fallback.length > 8) record.entry.fallback.shift(); changed = true; }
      }
    }
    if (changed) this.publish(record, true);
    return true;
  }
  parent(id) { return this.routes.get(id); }
  cancel(id, stop) {
    for (const [child, parent] of this.routes) if (parent === id) {
      const record = this.entries.get(child);
      if (record?.cancelled) continue;
      if (record) { record.cancelled = true; record.entry.status = 'cancelled'; record.entry.error = 'This chat has stopped.'; record.entry.finishedAt = new Date().toISOString(); this.publish(record, true); }
      // Keep the route until execution settles so late child output cannot be
      // mistaken for the parent reply after Stop.
      stop(child);
    }
  }
}
