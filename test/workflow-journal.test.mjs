import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../desktop/store.mjs';
import { WorkflowJournal, workflowUnresolved } from '../desktop/workflow-journal.mjs';

const REPORT = 'Monthly report\nRevenue: €1,234.\nKeep the original customer name: Müller.';
const task = () => ({id:'report-task',name:'Monthly report',prompt:'Prepare the monthly report.',provider:'codex',model:'auto',projectId:'project-a',delivery:'telegram',recipient:'paired-customer-a'});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };

test('older-backup recovery cannot discard an unknown external effect as interrupted generation',async t=>{
  const f=await fixture(t),run=f.journal.begin(task(),'planned');await f.journal.commit();
  f.store.recovery={backup:'synthetic-old-generation'};await f.journal.restore();
  assert.equal(run.status,'interrupted');assert.equal(run.delivery.status,'unknown');
  await assert.rejects(f.journal.cancel(run.id),/uncertain/);
  await f.journal.resolve(run.id,{resolution:'not_sent',evidence:'Checked destination history for the full planned time window.'});
  await f.journal.cancel(run.id);assert.equal(run.status,'cancelled');assert.equal(f.sends,0);
});

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'exomina-workflow-test-'));
  t.after(async () => {
    const target = path.resolve(dir), base = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(target.startsWith(base) && path.basename(target).startsWith('exomina-workflow-test-'));
    await rm(target,{recursive:true,force:true});
  });
  const store = new Store(dir); await store.init(); store.state.schedules = [task()];
  const f = {store,dir,sends:0,approvals:0,scope:'scope-v1',beforeSave:null,afterSave:null,...overrides};
  f.makeJournal = activeStore => new WorkflowJournal({
    store:activeStore,
    save:async () => { await f.beforeSave?.(activeStore); await activeStore.save(); await f.afterSave?.(activeStore); },
    check:() => { if (f.revoked) throw Error('Permission revoked.'); return f.scope; },
    approve:async request => { f.approvals++; f.preview = request; return f.approve ? f.approve(request) : true; },
    deliver:async (destination,text) => { f.sends++; f.delivered = {destination,text}; if (f.deliver) await f.deliver(destination,text); },
    now:() => new Date('2026-11-07T22:00:00Z'),
  });
  f.journal = f.makeJournal(store);
  f.ready = async () => { const run = f.journal.begin(store.state.schedules[0],'2026-11-07T21:59:00Z'); await f.journal.commit(); await f.journal.generated(run,{text:REPORT,conversationId:'report-chat'}); return run; };
  f.restart = async () => { const restored = new Store(dir); await restored.init(); return {store:restored,journal:f.makeJournal(restored)}; };
  return f;
}

test('report bytes, destination and timeline survive a real durable-store reload without sending',async t => {
  const f = await fixture(t), run = await f.ready(), restored = await f.restart();
  const saved = restored.journal.get(run.id);
  assert.equal(saved.artifact.text,REPORT); assert.equal(saved.artifact.bytes,Buffer.byteLength(REPORT,'utf8'));
  assert.equal(saved.artifact.sha256,createHash('sha256').update(REPORT).digest('hex'));
  assert.equal(saved.delivery.recipient,'paired-customer-a'); assert.equal(saved.status,'ready');
  assert.deepEqual(saved.events.map(event => event.type),['generation_started','artifact_recorded']);
  assert.equal(f.sends,0); assert.equal(f.approvals,0);
});

test('interrupted generation is retained and blocks another run until explicitly cancelled',async t => {
  const f = await fixture(t), run = f.journal.begin(task(),'planned'); await f.journal.commit();
  const restored = await f.restart(); await restored.journal.restore();
  assert.equal(restored.journal.get(run.id).status,'interrupted');
  assert.throws(() => restored.journal.begin(task(),'next'),/unfinished/);
  await restored.journal.cancel(run.id); assert.equal(workflowUnresolved(restored.journal.get(run.id)),false);
  assert.doesNotThrow(() => restored.journal.begin(task(),'next')); assert.equal(f.sends,0);
});

test('ready report resumes after restart with the exact reviewed bytes and no generation step',async t => {
  const f = await fixture(t), run = await f.ready(), restored = await f.restart(); await restored.journal.restore();
  const sent = await restored.journal.resume(run.id);
  assert.equal(sent.status,'complete'); assert.equal(sent.delivery.status,'sent');
  assert.equal(f.preview.text,REPORT); assert.equal(f.preview.sha256,sent.artifact.sha256);
  assert.equal(f.delivered.text,REPORT); assert.equal(f.delivered.destination.recipient,'paired-customer-a');
  assert.equal(f.sends,1); assert.equal(sent.delivery.receipt.type,'connector_acknowledgment');
  const twice = await f.restart(); await twice.journal.restore();
  await assert.rejects(twice.journal.resume(run.id),/cannot be retried/); assert.equal(f.sends,1);
});

test('dispatch is durable before connector invocation, and concurrent resume cannot send twice',async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t,{deliver:async () => {
    const disk = JSON.parse(await readFile(path.join(f.dir,'state.json'),'utf8'));
    assert.equal(disk.workflowRuns[0].delivery.status,'sending'); entered.resolve(); await finish.promise;
  }}), run = await f.ready();
  const first = f.journal.resume(run.id); await entered.promise;
  await assert.rejects(f.journal.resume(run.id),/already/); finish.resolve(); await first; assert.equal(f.sends,1);
});

test('failed dispatch checkpoint performs no send and poisons further actions until reload',async t => {
  const f = await fixture(t), run = await f.ready();
  f.beforeSave = store => { if (store.state.workflowRuns[0].delivery.status === 'sending') throw Error('Synthetic disk full.'); };
  await assert.rejects(f.journal.resume(run.id),/disk full/); assert.equal(f.sends,0);
  await assert.rejects(f.journal.resume(run.id),/storage failed/);
  f.beforeSave = null; const restored = await f.restart(); await restored.journal.restore();
  assert.equal(restored.journal.get(run.id).delivery.status,'pending');
  await restored.journal.resume(run.id); assert.equal(f.sends,1); assert.equal(f.approvals,2);
});

test('remote acceptance followed by acknowledgment-save failure restores unknown and never resends',async t => {
  const f = await fixture(t), run = await f.ready();
  f.beforeSave = store => { if (store.state.workflowRuns[0].delivery.status === 'sent') throw Error('Synthetic power loss after remote acceptance.'); };
  await assert.rejects(f.journal.resume(run.id),/power loss/); assert.equal(f.sends,1);
  f.beforeSave = null; const restored = await f.restart(); await restored.journal.restore();
  assert.equal(restored.journal.get(run.id).delivery.status,'unknown');
  await assert.rejects(restored.journal.resume(run.id),/Reconcile/);
  await assert.rejects(restored.journal.cancel(run.id),/uncertain/);
  assert.throws(() => restored.journal.begin(task(),'next'),/unfinished/); assert.equal(f.sends,1);
});

test('lost connector acknowledgment becomes unknown even when the connector throws',async t => {
  const f = await fixture(t,{deliver:async () => { throw Error('Connection reset after submit.'); }}), run = await f.ready();
  const result = await f.journal.resume(run.id);
  assert.equal(result.delivery.status,'unknown'); assert.equal(result.artifact.text,REPORT);
  await assert.rejects(f.journal.resume(run.id),/Reconcile/); assert.equal(f.sends,1);
});

test('declined exact delivery stays blocked and preserves the report for later review',async t => {
  const f = await fixture(t,{approve:async () => false}), run = await f.ready();
  const result = await f.journal.resume(run.id);
  assert.equal(result.delivery.status,'blocked'); assert.equal(result.artifact.text,REPORT); assert.equal(f.sends,0);
});

test('permission revocation during approval blocks the previously reviewed delivery',async t => {
  const waiting = deferred(), answer = deferred();
  const f = await fixture(t,{approve:async () => { waiting.resolve(); await answer.promise; return true; }}), run = await f.ready();
  const resume = f.journal.resume(run.id); await waiting.promise; f.revoked = true; answer.resolve();
  const result = await resume; assert.equal(result.delivery.status,'blocked'); assert.match(result.delivery.error,/revoked/); assert.equal(f.sends,0);
});

test('changed authorization scope invalidates pending approval even when the new scope permits sends',async t => {
  const f = await fixture(t,{approve:async () => { f.scope = 'new-policy-or-connector'; return true; }}), run = await f.ready();
  const result = await f.journal.resume(run.id);
  assert.equal(result.delivery.status,'blocked'); assert.match(result.delivery.error,/scope or permissions changed/); assert.equal(f.sends,0);
});

test('permission changes during durable dispatch commit are checked again before network dispatch',async t => {
  const f = await fixture(t), run = await f.ready();
  f.afterSave = store => { if (store.state.workflowRuns[0].delivery.status === 'sending') f.revoked = true; };
  const result = await f.journal.resume(run.id);
  assert.equal(result.delivery.status,'blocked'); assert.equal(f.sends,0);
  const restored = await f.restart(); assert.equal(restored.journal.get(run.id).delivery.status,'blocked');
});

test('recipient or task changes during approval cannot redirect a report',async t => {
  const f = await fixture(t,{approve:async () => { f.store.state.schedules[0].recipient = 'other-customer'; return true; }}), run = await f.ready();
  const result = await f.journal.resume(run.id);
  assert.equal(result.delivery.status,'blocked'); assert.match(result.delivery.error,/task or destination changed/); assert.equal(f.sends,0);
});

test('changed artifact bytes are rejected before approval or connector execution',async t => {
  const f = await fixture(t), run = await f.ready(); run.artifact.text += '\nUnreviewed attachment.';
  const result = await f.journal.resume(run.id);
  assert.equal(result.delivery.status,'blocked'); assert.match(result.delivery.error,/report changed/); assert.equal(f.approvals,0); assert.equal(f.sends,0);
});

test('self-consistent report replacement during dispatch commit cannot reuse the old approval',async t => {
  const f = await fixture(t), run = await f.ready();
  f.afterSave = store => {
    const current = store.state.workflowRuns[0];
    if (current.delivery.status !== 'sending') return;
    const text = 'Changed after approval: send private customer data instead.';
    current.artifact = {text,bytes:Buffer.byteLength(text,'utf8'),sha256:createHash('sha256').update(text).digest('hex')};
  };
  const result = await f.journal.resume(run.id);
  assert.equal(result.delivery.status,'blocked'); assert.equal(f.sends,0);
});

test('human delivered reconciliation is labelled separately from connector evidence and never sends',async t => {
  const f = await fixture(t,{deliver:async () => { throw Error('Acknowledgment lost.'); }}), run = await f.ready(); await f.journal.resume(run.id);
  await assert.rejects(f.journal.resolve(run.id,{resolution:'delivered',evidence:'yes'}),/Record what/);
  const result = await f.journal.resolve(run.id,{resolution:'delivered',evidence:'Checked paired recipient: report is visible with matching figures.'});
  assert.equal(result.status,'complete'); assert.equal(result.delivery.status,'confirmed'); assert.equal(result.delivery.receipt.type,'human_report');
  assert.equal(f.sends,1); await assert.rejects(f.journal.resume(run.id),/cannot be retried/);
});

test('human not-sent reconciliation enables review but performs no automatic replay',async t => {
  const f = await fixture(t,{deliver:async () => { throw Error('No acknowledgment.'); }}), run = await f.ready(); await f.journal.resume(run.id);
  const result = await f.journal.resolve(run.id,{resolution:'not_sent',evidence:'Checked recipient and provider history: no report exists.'});
  assert.equal(result.delivery.status,'pending'); assert.equal(f.sends,1); assert.equal(f.approvals,1);
  f.deliver = null; await f.journal.resume(run.id); assert.equal(f.sends,2); assert.equal(f.approvals,2);
  assert.equal(run.events.filter(event => event.type === 'human_reconciliation').length,1);
});

test('empty, oversized and errored reports never become deliverable artifacts',async t => {
  for (const result of [{text:''},{text:'€'.repeat(100000)},{text:REPORT,error:'Generation failed.'}]) {
    const f = await fixture(t), run = f.journal.begin(task(),'planned'); await f.journal.commit(); await f.journal.generated(run,result);
    assert.equal(run.status,'failed'); assert.equal(run.artifact,undefined);
    await assert.rejects(f.journal.resume(run.id),/cannot be retried/); assert.equal(f.sends,0);
  }
});

test('desktop reports finish locally without any outbound approval or delivery',async t => {
  const f = await fixture(t); f.store.state.schedules[0].delivery = 'desktop'; const run = await f.ready();
  assert.equal(run.status,'complete'); assert.equal(run.delivery.status,'not_required'); assert.equal(f.approvals,0); assert.equal(f.sends,0);
});
