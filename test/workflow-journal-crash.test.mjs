import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const childScript = fileURLToPath(new URL('./fixtures/workflow-crash-child.mjs',import.meta.url));
function receive(child, phase) {
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => finish(Error(`Synthetic child did not reach ${phase}.`)),10000);
    const message = value => { if (value?.phase === phase) finish(null,value); };
    const exit = (code,signal) => finish(Error(`Synthetic child exited early (${code}, ${signal}).`));
    function finish(error,value) { clearTimeout(timer); child.off('message',message); child.off('exit',exit); error ? reject(error) : resolve(value); }
    child.on('message',message); child.once('exit',exit); child.once('error',finish);
  });
}

test('real process termination after remote acceptance recovers unknown without a second external effect',{timeout:20000},async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'exomina-workflow-crash-')), children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exit = once(child,'exit'); child.kill('SIGKILL'); await exit; }
    const target = path.resolve(dir), base = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(target.startsWith(base) && path.basename(target).startsWith('exomina-workflow-crash-'));
    await rm(target,{recursive:true,force:true});
  });
  const start = mode => { const child = fork(childScript,[mode,dir],{execArgv:[],windowsHide:true,stdio:['ignore','pipe','pipe','ipc']}); children.push(child); return child; };
  const sender = start('dispatch'), accepted = await receive(sender,'accepted');
  const before = JSON.parse(await readFile(path.join(dir,'state.json'),'utf8'));
  assert.equal(before.workflowRuns[0].id,accepted.runId);
  assert.equal(before.workflowRuns[0].delivery.status,'sending');
  const terminated = once(sender,'exit'); sender.kill('SIGKILL'); await terminated;
  const recovery = start('recover'), recovered = await receive(recovery,'recovered');
  if (recovery.exitCode === null) await once(recovery,'exit');
  assert.equal(recovered.run.id,accepted.runId); assert.equal(recovered.run.delivery.status,'unknown');
  assert.equal(recovered.run.artifact.text,'Synthetic crash report: €42, customer A.');
  assert.equal(recovered.run.delivery.attempts[0].parts[0].status,'dispatching');
  assert.equal(recovered.run.delivery.attempts[0].contract.automaticReplay,false);
  assert.match(recovered.retryError,/Reconcile/);
  const effects = (await readFile(path.join(dir,'synthetic-recipient.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(effects.length,1); assert.equal(effects[0].recipient,'synthetic-customer-a');
  assert.equal(effects[0].text,recovered.run.artifact.text);
  const after = JSON.parse(await readFile(path.join(dir,'state.json'),'utf8'));
  assert.equal(after.workflowRuns[0].delivery.status,'unknown');
});
