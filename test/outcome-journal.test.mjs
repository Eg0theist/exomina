import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { OutcomeJournal } from '../desktop/outcome-journal.mjs';
import { OutcomeMarks } from '../desktop/outcome-marks.mjs';

const mark = id => ({ id, at: '2026-11-08T00:00:00Z', kind: 'file', claim: 'File exists', subject: `file ${id}.txt`, checkedBy: 'exomina', status: 'verified', observed: { exists: true, bytes: 10 } });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'exomina-receipts-'));
  const journal = await new OutcomeJournal({ dir, ...options }).init();
  t.after(async () => { journal.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, journal };
}
function service(journal, options = {}) {
  const chat = { id: 'a', messages: [] }, store = { state: { conversations: [chat] }, save: async () => {} };
  return { chat, store, outcomes: new OutcomeMarks({ store, archive: journal, evaluate: () => ({ decision: 'allow' }), updater: async () => ({ installed: { id: 'abcdefgh-1234', version: 'test' } }), ...options }) };
}
const check = outcomes => outcomes.call({ action: 'check', kind: 'update_installed', buildId: 'abcdefgh' }, 'a');

test('durable archive retains receipts beyond recent projection and exports bounded chain pages', async t => {
  const { journal } = await fixture(t), { outcomes, chat } = service(journal);
  const ids = [];
  for (let i = 0; i < 105; i++) ids.push((await check(outcomes)).mark.id);
  assert.equal(chat.outcomeMarks.length, 100); assert.equal(outcomes.resolve('a', ids[0]).id, ids[0]);
  const page = await outcomes.call({ action: 'view', offset: 100, limit: 3, export: true }, 'a');
  assert.equal(page.total, 105); assert.equal(page.marks.length, 3); assert.equal(page.nextOffset, 103); assert.equal(page.archive.integrity.status, 'consistent');
  assert.equal(page.archive.format, 'exomina-outcome-chain-v1'); assert.equal(page.archive.rows[0].mark.id, ids[4]);
  assert.throws(() => journal.append('a', null, { ...page.marks[0], claim: 'Changed' }), /cannot be changed/);
  assert.equal(journal.append('a', null, page.marks[0]).sequence, 5);
});

test('exact client buckets partition receipts including identical conversation and mark IDs', async t => {
  const { journal } = await fixture(t), one = { organizationId: 'org', clientId: 'one' }, two = { organizationId: 'org', clientId: 'two' };
  journal.append('a', one, mark('same')); journal.append('a', two, { ...mark('same'), subject: 'file other-client.txt' });
  assert.equal(journal.get('a', one, 'same').subject, 'file same.txt'); assert.equal(journal.get('a', two, 'same').subject, 'file other-client.txt');
  assert.equal(journal.get('a', null, 'same'), null); assert.equal(journal.view('b', one).marks.length, 0);
  assert.throws(() => journal.append('a', { clientId: 'one' }, mark('invalid')), /exact host organization/);
});

test('damaged payload, removed interior rows and missing suffix fail explicit consistency checks', async t => {
  const { journal } = await fixture(t);
  for (const chat of ['payload', 'interior', 'suffix']) for (let i = 1; i <= 3; i++) journal.append(chat, null, mark('row' + i));
  const payload = journal.head('payload', null).bucket; journal.db.prepare('UPDATE receipts SET payload=? WHERE bucket=? AND seq=2').run(JSON.stringify(mark('faked')), payload);
  const interior = journal.head('interior', null).bucket; journal.db.prepare('DELETE FROM receipts WHERE bucket=? AND seq=2').run(interior);
  const suffix = journal.head('suffix', null).bucket; journal.db.prepare('DELETE FROM receipts WHERE bucket=? AND seq=3').run(suffix);
  for (const chat of ['payload', 'interior', 'suffix']) { assert.equal(journal.verify(chat, null).status, 'damaged'); assert.throws(() => journal.view(chat, null), /damaged/); assert.throws(() => journal.prune(chat, null, 1), /consistent archive/); }
  assert.throws(() => journal.get('payload', null, 'row2'), /integrity/);
});

test('pruning is explicit, keeps an inspectable anchor and subsequent records continue the chain', async t => {
  const { journal } = await fixture(t);
  for (let i = 1; i <= 5; i++) journal.append('a', null, mark('m' + i));
  assert.deepEqual(journal.prune('a', null, 3).removed, 3); assert.equal(journal.get('a', null, 'm1'), null);
  assert.equal(journal.view('a', null).archive.retainedFrom, 4); assert.equal(journal.verify('a', null).status, 'consistent');
  assert.equal(journal.append('a', null, mark('m6')).sequence, 6);
  journal.prune('a', null, 6); assert.equal(journal.verify('a', null).status, 'consistent'); assert.equal(journal.append('a', null, mark('m7')).sequence, 7);
});

test('archive failure blocks returned success and concurrent saves preserve the projection', async t => {
  const { journal } = await fixture(t, { maxRecords: 2 }), { outcomes, chat } = service(journal);
  await check(outcomes); await check(outcomes); await assert.rejects(check(outcomes), /record limit/); assert.equal(chat.outcomeMarks.length, 2);
  journal.maxRecords = 50;
  const { outcomes: concurrent, chat: concurrentChat } = service(journal, { save: async () => new Promise(resolve => setTimeout(resolve, 2)) });
  const results = await Promise.all(Array.from({ length: 8 }, () => check(concurrent)));
  assert.equal(concurrentChat.outcomeMarks.length, 8); assert.equal(new Set(results.map(item => item.mark.id)).size, 8); assert.equal(journal.view('a', null).total, 10);
});

test('permission and scope changes during checks prevent stale observations from escaping', async t => {
  const { journal } = await fixture(t); let denied = false;
  const f = service(journal, { evaluate: () => ({ decision: denied ? 'deny' : 'allow' }), updater: async () => { denied = true; return { installed: { id: 'abcdefgh-1234' } }; } });
  const result = await check(f.outcomes); assert.equal(result.mark.status, 'refused'); assert.equal(result.mark.observed, undefined);
  await assert.rejects(f.outcomes.call({ action: 'view' }, 'a'), /blocked/);
  let scope = null;
  const g = service(journal, { getScope: () => scope, updater: async () => { scope = { organizationId: 'org', clientId: 'two' }; return { installed: { id: 'abcdefgh-1234' } }; } });
  await assert.rejects(check(g.outcomes), /scope changed/); assert.equal(journal.head('a', scope), undefined);
  f.outcomes.getScope = () => scope; assert.equal(f.outcomes.view('a').marks.length, 0); assert.equal(f.outcomes.resolve('a', result.mark.id), null);
});

test('owner archive pruning/deletion needs direct action, exact review and rejects changed heads', async t => {
  const { journal } = await fixture(t), f = service(journal, { approve: async () => true });
  for (let i = 0; i < 4; i++) await check(f.outcomes);
  await assert.rejects(f.outcomes.archiveControl({ action: 'delete' }, 'a'), /direct owner/);
  f.outcomes.approve = async () => { journal.append('a', null, mark('changed-during-review')); return true; };
  await assert.rejects(f.outcomes.archiveControl({ action: 'prune', throughSequence: 2 }, 'a', { userInitiated: true }), /changed during review/);
  f.outcomes.approve = async request => { assert.equal(request.requireConfirmation, true); return true; };
  assert.equal((await f.outcomes.archiveControl({ action: 'prune', throughSequence: 2 }, 'a', { userInitiated: true })).removed, 2); assert.equal(f.chat.outcomeMarks.length, 2);
  const deleted = await f.outcomes.archiveControl({ action: 'delete' }, 'a', { userInitiated: true }); assert.equal(deleted.removed, 3); assert.equal(f.chat.outcomeMarks.length, 0); assert.equal((await f.outcomes.call({ action: 'view' }, 'a')).marks.length, 0);
});

test('a committed WAL receipt survives abrupt writer death before normal close', async t => {
  const { dir, journal } = await fixture(t); journal.close();
  const script = path.join(dir, 'writer.mjs');
  await writeFile(script, `import{OutcomeJournal}from ${JSON.stringify(pathToFileURL(path.resolve('desktop/outcome-journal.mjs')).href)};const db=await new OutcomeJournal({dir:${JSON.stringify(dir)}}).init();db.append('crash',null,${JSON.stringify(mark('durable'))});process.stdout.write('committed\\n');setInterval(()=>{},1000);`, 'utf8');
  const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let text = ''; await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error('Writer did not report commit.')), 10000); child.stdout.on('data', chunk => { text += chunk; if (text.includes('committed')) { clearTimeout(timeout); resolve(); } }); child.once('error', reject); child.once('exit', code => { if (!text.includes('committed')) reject(Error('Writer exited ' + code)); }); });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const reopened = await new OutcomeJournal({ dir }).init(); try { assert.equal(reopened.get('crash', null, 'durable').status, 'verified'); assert.equal(reopened.verify('crash', null).status, 'consistent'); } finally { reopened.close(); }
});
