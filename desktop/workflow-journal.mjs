import { createHash, randomUUID } from 'node:crypto';
import { deliveryContract, recordDeliveryProgress } from './delivery-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_REPORT_BYTES = 256 * 1024, MAX_RUNS = 200;
export const taskDigest = task => hash(JSON.stringify(['name','prompt','provider','model','projectId','delivery','recipient'].map(key => task[key] || '')));
export const workflowUnresolved = run => !['complete','failed','cancelled'].includes(run.status);
const copy = value => structuredClone(value);

/** Pilot for scheduled reports. The store's flushed, atomic save is the commit
 * boundary. No remote effect is retried unless the owner reconciles its result.
 * Report hashes check byte integrity, not factual correctness. */
export class WorkflowJournal {
  constructor({ store, save, deliver, approve = async () => false, check = () => { throw Error('Delivery authorization is unavailable.'); }, now = () => new Date() }) {
    Object.assign(this, { store, save, deliver, approve, check, now });
    this.busy = new Set(); this.writeFailed = false;
  }
  runs() { return this.store.state.workflowRuns || []; }
  get(id) { const run = this.runs().find(item => item.id === id); if (!run) throw Error('Workflow run not found.'); return run; }
  event(run, type, detail) { run.events.push({ at: this.now().toISOString(), type, ...(detail ? { detail: String(detail).slice(0,2000) } : {}) }); }
  assertWritable() { if (this.writeFailed) throw Error('Workflow storage failed. Restart and inspect the saved run before continuing.'); }
  async commit() { this.assertWritable(); try { await this.save(); } catch (error) { this.writeFailed = true; throw error; } }
  begin(task, planned) {
    this.assertWritable();
    if (this.runs().some(run => run.taskId === task.id && workflowUnresolved(run))) throw Error('Resolve the unfinished workflow run before running this task again.');
    // Never discard uncertain effects to make space. Completed history is bounded.
    let runs = this.runs();
    if (runs.length >= MAX_RUNS) runs = runs.filter(run => workflowUnresolved(run));
    if (runs.length >= MAX_RUNS) throw Error('Resolve unfinished workflow runs before starting more.');
    const run = { id: randomUUID(), taskId: task.id, taskDigest: taskDigest(task), name: task.name,
      status: 'generating', planned, startedAt: this.now().toISOString(),
      delivery: { channel: task.delivery, recipient: task.recipient || '', status: task.delivery === 'desktop' ? 'not_required' : 'pending' }, events: [] };
    this.event(run, 'generation_started'); this.store.state.workflowRuns = [...runs, run]; return run;
  }
  async generated(run, result) {
    if (result.error) return this.failed(run, result.error);
    if (typeof result.text !== 'string' || !result.text.trim()) return this.failed(run, 'The report is empty; nothing will be delivered.');
    const bytes = Buffer.byteLength(result.text, 'utf8');
    if (bytes > MAX_REPORT_BYTES) return this.failed(run, 'The report exceeds the 256 KiB pilot limit. Inspect its chat; nothing will be delivered.');
    run.artifact = { text: result.text, bytes, sha256: hash(result.text) };
    run.conversationId = result.conversationId;
    run.status = run.delivery.channel === 'desktop' ? 'complete' : 'ready';
    if (run.status === 'complete') run.finishedAt = this.now().toISOString();
    this.event(run, 'artifact_recorded', 'SHA-256 and size recorded. Content requires review.');
    await this.commit(); return run;
  }
  async failed(run, error) { run.status = 'failed'; run.error = String(error).slice(0,2000); run.finishedAt = this.now().toISOString(); this.event(run,'generation_failed',run.error); await this.commit(); return run; }
  async restore() {
    let changed = false;
    for (const run of this.runs()) {
      if (run.status === 'generating') { run.status = 'interrupted'; this.event(run,'generation_interrupted','Inspect the result chat before starting new work.'); changed = true; }
      if (run.delivery.status === 'sending') { run.delivery.status = 'unknown'; this.event(run,'delivery_unknown','Exomina stopped after dispatch was committed. Inspect the recipient before reconciling.'); changed = true; }
      if (this.store.recovery && workflowUnresolved(run) && run.delivery.channel !== 'desktop' && run.delivery.status !== 'unknown') {
        run.delivery.status = 'unknown'; this.event(run,'delivery_unknown','The library was recovered from an older snapshot. Reconcile external effects before proceeding.'); changed = true;
      }
    }
    if (changed) await this.commit();
  }
  async exclusive(id, fn) {
    this.assertWritable(); if (this.busy.has(id)) throw Error('This workflow is already being handled.');
    this.busy.add(id); try { return await fn(this.get(id)); } finally { this.busy.delete(id); }
  }
  assertArtifact(run) {
    const a = run.artifact;
    if (!a || typeof a.text !== 'string' || a.sha256 !== hash(a.text) || a.bytes !== Buffer.byteLength(a.text,'utf8')) throw Error('The report changed. Delivery is blocked.');
    const task = (this.store.state.schedules || []).find(task => task.id === run.taskId);
    if(task?.recoveryRequired)throw Error('Recovered history may omit earlier deliveries. Review the task destination first.');
    if (!task || taskDigest(task) !== run.taskDigest) throw Error('The task or destination changed. Cancel this pending run and generate a new report.');
    if (run.name !== task.name || run.delivery.channel !== task.delivery || run.delivery.recipient !== (task.recipient || '')) throw Error('The delivery binding changed.');
  }
  binding(run) { return { runId:run.id, taskId:run.taskId, name:run.name, channel:run.delivery.channel, recipient:run.delivery.recipient, sha256:run.artifact.sha256, bytes:run.artifact.bytes }; }
  async resume(id) { return this.exclusive(id, async run => {
    if (run.status !== 'ready' || !['pending','blocked'].includes(run.delivery.status)) throw Error('This delivery cannot be retried. Reconcile an unknown result first.');
    if(run.events.length>=196)throw Error('This run reached its review limit. Cancel it and inspect its chat before starting new work.');
    if((run.delivery.attempts||[]).length>=16)throw Error('This run reached its delivery-attempt limit. Inspect its history and cancel it before generating a new report.');
    try {
      this.assertArtifact(run);
      const binding = this.binding(run), signature = JSON.stringify(binding), reviewedText = run.artifact.text;
      const authorization = this.check(copy(binding));
      if (!await this.approve({ ...copy(binding), text:run.artifact.text })) {
        run.delivery.status = 'blocked'; run.delivery.error = 'Delivery was not approved.'; this.event(run,'delivery_blocked',run.delivery.error); await this.commit(); return copy(run);
      }
      // Approval covers these exact bytes and target, never an alias or a later edit.
      this.assertArtifact(run);
      if (JSON.stringify(this.binding(run)) !== signature || this.check(copy(binding)) !== authorization) throw Error('Delivery scope or permissions changed. Review it again.');
      run.delivery.status = 'sending'; delete run.delivery.error;
      run.delivery.attemptId = randomUUID(); this.event(run,'dispatch_committed',run.delivery.attemptId);
      const attempt={id:run.delivery.attemptId,channel:binding.channel,contract:deliveryContract(binding.channel),startedAt:this.now().toISOString(),parts:[]};
      run.delivery.attempts=[...(run.delivery.attempts||[]),attempt];
      await this.commit(); // must finish before any network call
      this.assertArtifact(run);
      if (JSON.stringify(this.binding(run)) !== signature) throw Error('The approved report or destination changed before dispatch.');
      if (this.check(copy(binding)) !== authorization) throw Error('Delivery scope or permissions changed before dispatch.');
      // No await between the final check and invoking the connector. The connector
      // validates pairing too. Once invoked, every thrown error is ambiguous.
      let acceptingProgress=true;
      const task = { id:run.taskId, name:run.name, delivery:binding.channel, recipient:binding.recipient, binding:copy(binding), authorization,
        recordProgress:async progress=>{
          if(!acceptingProgress||run.delivery.status!=='sending')throw Error('This delivery attempt has ended.');
          recordDeliveryProgress(attempt,progress,this.now().toISOString());
          await this.commit();
        } };
      try {
        await this.deliver(task, reviewedText);
      } catch (error) {
        acceptingProgress=false;
        run.delivery.status = 'unknown'; run.delivery.error = String(error.message || error).slice(0,2000);
        this.event(run,'delivery_unknown','The connector may have accepted some or all of the report. No automatic retry.');
        await this.commit(); return copy(run);
      }
      acceptingProgress=false;
      run.delivery.status = 'sent'; run.delivery.receipt = { type:'connector_acknowledgment', attemptId:run.delivery.attemptId, at:this.now().toISOString() };
      run.status = 'complete'; run.finishedAt = this.now().toISOString(); this.event(run,'delivery_acknowledged');
      await this.commit(); return copy(run);
    } catch (error) {
      // A failed commit poisons this instance: do not overwrite an uncertain
      // durable checkpoint or allow a second action in this process.
      if (this.writeFailed) throw error;
      run.delivery.status = 'blocked'; run.delivery.error = String(error.message || error).slice(0,2000);
      this.event(run,'delivery_blocked',run.delivery.error); await this.commit(); return copy(run);
    }
  }); }
  async resolve(id, { resolution, evidence }) { return this.exclusive(id, async run => {
    if (run.delivery.status !== 'unknown') throw Error('Only an unknown delivery needs reconciliation.');
    if (!['delivered','not_sent'].includes(resolution) || typeof evidence !== 'string' || evidence.trim().length < 8 || evidence.length > 2000) throw Error('Record what you checked at the recipient (8–2,000 characters).');
    this.event(run,'human_reconciliation',JSON.stringify({resolution,evidence:evidence.trim()}));
    run.delivery.receipt = { type:'human_report', resolution, evidence:evidence.trim(), at:this.now().toISOString() };
    delete run.delivery.error;
    if (resolution === 'delivered') { run.delivery.status = 'confirmed'; run.status = 'complete'; run.finishedAt = this.now().toISOString(); }
    else run.delivery.status = 'pending'; // requires another explicit approval, never sends here
    await this.commit(); return copy(run);
  }); }
  async cancel(id) { return this.exclusive(id, async run => {
    if (['unknown','sending'].includes(run.delivery.status) || !(run.status === 'interrupted' || run.status === 'ready' && ['pending','blocked'].includes(run.delivery.status))) throw Error('An uncertain or active workflow cannot be discarded.');
    run.status = 'cancelled'; run.delivery.status = 'cancelled'; run.finishedAt = this.now().toISOString(); this.event(run,'cancelled'); await this.commit(); return copy(run);
  }); }
}
