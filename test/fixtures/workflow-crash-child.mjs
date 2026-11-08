// Synthetic process-death harness. Its only effect is a flushed receipt file
// under the test's temporary directory; no messaging service is contacted.
import { open } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../../desktop/store.mjs';
import { WorkflowJournal } from '../../desktop/workflow-journal.mjs';
import { deliveryPart } from '../../desktop/delivery-contract.mjs';

const [mode, dir] = process.argv.slice(2);
if (!['dispatch','recover'].includes(mode) || !dir || !path.basename(dir).startsWith('exomina-workflow-crash-')) throw Error('Invalid synthetic crash harness arguments.');
const store = new Store(dir); await store.init();
const text = 'Synthetic crash report: €42, customer A.';
const journal = new WorkflowJournal({
  store, save:() => store.save(), check:() => 'synthetic-allowed-scope', approve:async () => true,
  deliver:async (task, report) => {
    await task.recordProgress({...deliveryPart(report,0,1),status:'dispatching'});
    const receipt = await open(path.join(dir,'synthetic-recipient.jsonl'),'a',0o600);
    try { await receipt.writeFile(JSON.stringify({recipient:task.recipient,text:report})+'\n','utf8'); await receipt.sync(); }
    finally { await receipt.close(); }
    process.send({phase:'accepted',runId:journal.runs()[0].id});
    // Simulates a provider accepting the write while its acknowledgment is lost.
    // The parent force-terminates this owned child before this promise resolves.
    setInterval(() => {},1000);
    await new Promise(() => {});
  },
});
if (mode === 'dispatch') {
  const task = {id:'crash-report',name:'Crash report',prompt:'Produce a synthetic report.',provider:'codex',model:'auto',delivery:'telegram',recipient:'synthetic-customer-a'};
  store.state.schedules = [task];
  const run = journal.begin(task,'synthetic-planned'); await journal.commit();
  await journal.generated(run,{text,conversationId:'synthetic-report-chat'});
  await journal.resume(run.id);
  throw Error('Parent did not interrupt the dispatch.');
} else {
  await journal.restore();
  const run = journal.runs()[0]; let retryError = '';
  try { await journal.resume(run.id); } catch (error) { retryError = error.message; }
  process.send({phase:'recovered',run, retryError});
  process.disconnect();
}
