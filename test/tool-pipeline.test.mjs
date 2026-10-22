import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolPipeline, PIPELINE_LIMITS, PIPELINE_READ_TOOLS } from '../desktop/tool-pipeline.mjs';

function fixture(t, execute = async () => ({ rows: [{ name: 'One', status: 'ready' }, { name: 'Two', status: 'waiting' }] })) {
  const runs = new Map([['chat', {}], ['other', {}]]), calls = [];
  let time = Date.parse('2026-10-22T12:00:00Z');
  const pipeline = new ToolPipeline({ execute: async (...args) => { calls.push(args); return execute(...args); }, getRun: id => runs.get(id), authorizeEvidence: async () => true, now: () => time });
  t.after(() => pipeline.close());
  return { pipeline, calls, runs, advance: milliseconds => { time += milliseconds; } };
}

test('pipeline dispatches the original read tool through the injected ordinary host path and retains exact evidence', async t => {
  const f = fixture(t), result = await f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read', arguments: { path: 'known.json' }, path: ['rows'], contains: 'ready', fields: ['name'] }] }, 'chat');
  assert.deepEqual(f.calls, [['workspace_read', { path: 'known.json' }, 'chat']]);
  assert.equal(result.status, 'completed'); assert.equal(result.steps[0].text, '[{"name":"One"}]');
  const raw = await f.pipeline.call({ action: 'read', id: result.id, step: 0, limit: 15 }, 'chat');
  assert.equal(raw.text, '{"rows":[{"name'); assert.equal(raw.nextOffset, 15);
  const rest = await f.pipeline.call({ action: 'read', id: result.id, step: 0, offset: raw.nextOffset, limit: 64000 }, 'chat');
  assert.equal(JSON.parse(raw.text + rest.text).rows[1].name, 'Two'); assert.equal(rest.nextOffset, null);
});

test('every planned tool and projection is validated before any read or permission request happens', async t => {
  const f = fixture(t);
  for (const tool of ['workspace_shell', 'workspace_write', 'terminal_input', 'browser_click', 'external_cua_click', 'model_consult', 'tool_pipeline']) {
    await assert.rejects(f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read' }, { tool }] }, 'chat'), /listed read tools/);
  }
  for (const path of [['__proto__'], ['constructor'], ['prototype'], [-1], ['rows', 'constructor']]) await assert.rejects(f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read', path }] }, 'chat'), /JSON path/);
  await assert.rejects(f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read', fields: ['__proto__'] }] }, 'chat'), /safe fields/);
  await assert.rejects(f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read', script: 'execute anything' }] }, 'chat'), /unsupported/);
  assert.equal(f.calls.length, 0);
  assert.ok(!PIPELINE_READ_TOOLS.some(tool => /shell|write|execute/.test(tool)));
});

test('filters are literal, case handling is explicit and paths cannot reach inherited properties', async t => {
  const f = fixture(t, async () => ({ text: 'before\nA.* literal\na.* lower\naXX wildcard\nafter' }));
  const result = await f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read', path: ['text'], contains: 'a.*', caseSensitive: false }] }, 'chat');
  assert.equal(result.steps[0].text, 'A.* literal\na.* lower');
  const missing = await f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read', path: ['toString'] }, { tool: 'workspace_list' }] }, 'chat');
  assert.equal(missing.status, 'failed'); assert.match(missing.steps[0].text, /path is absent/); assert.equal(f.calls.length, 2);
});

test('permission denials, tool errors and thrown errors stop before later reads while preserving the failure evidence', async t => {
  const denied = fixture(t, async () => { throw Error('Read sharing denied.'); });
  const first = await denied.pipeline.call({ action: 'run', steps: [{ tool: 'notes_read', arguments: { id: 'shared' } }, { tool: 'workspace_list' }] }, 'chat');
  assert.equal(first.status, 'failed'); assert.equal(first.isError, true); assert.equal(denied.calls.length, 1);
  const evidence = await denied.pipeline.call({ action: 'read', id: first.id, step: 0 }, 'chat'); assert.match(evidence.text, /Read sharing denied/);
  const error = fixture(t, async () => ({ isError: true, content: [{ type: 'text', text: 'Tool refused the read.' }] }));
  const second = await error.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read' }, { tool: 'workspace_list' }] }, 'chat');
  assert.equal(second.status, 'failed'); assert.equal(error.calls.length, 1);
});

test('evidence cannot cross chats, active runs or expiry boundaries', async t => {
  const f = fixture(t), result = await f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_list' }] }, 'chat');
  await assert.rejects(f.pipeline.call({ action: 'read', id: result.id, step: 0 }, 'other'), /unavailable/);
  f.runs.set('chat', {});
  await assert.rejects(f.pipeline.call({ action: 'read', id: result.id, step: 0 }, 'chat'), /unavailable/);
  const next = await f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_list' }] }, 'chat');
  f.advance(PIPELINE_LIMITS.ttl);
  await assert.rejects(f.pipeline.call({ action: 'read', id: next.id, step: 0 }, 'chat'), /unavailable/);
});

test('cancellation is checked before and after each ordinary read and does not dispatch remaining steps', async t => {
  const controller = new AbortController(), f = fixture(t, async () => { controller.abort(); return { privateResult: 'must not publish after cancellation' }; });
  const result = await f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read' }, { tool: 'workspace_list' }] }, 'chat', { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(f.calls.length, 1); assert.equal(result.steps.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /privateResult|must not publish/);
  await assert.rejects(f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read' }] }, 'chat', { signal: controller.signal }), /stopped/);
});

test('output and raw evidence truncation are explicit and independently bounded', async t => {
  const text = '雪'.repeat(200000), f = fixture(t, async () => ({ text }));
  const result = await f.pipeline.call({ action: 'run', limit: 20, steps: [{ tool: 'workspace_read', path: ['text'], limit: 12 }, { tool: 'workspace_read', path: ['text'], limit: 12 }] }, 'chat');
  assert.equal(result.returnedCharacters, 20); assert.equal(result.steps[0].text.length, 12); assert.equal(result.steps[1].text.length, 8); assert.equal(result.truncated, true); assert.equal(result.evidenceTruncated, true);
  const evidence = await f.pipeline.call({ action: 'read', id: result.id, step: 0 }, 'chat');
  assert.equal(evidence.retainedCharacters, PIPELINE_LIMITS.stepEvidence); assert.equal(evidence.originalCharacters, JSON.stringify({ text }).length); assert.equal(evidence.truncated, true);
});

test('retained evidence has a global cap and expired record identifiers fail closed', async t => {
  const f = fixture(t, async () => ({ text: 'x'.repeat(200000) })), ids = [];
  for (let i = 0; i < 12; i++) ids.push((await f.pipeline.call({ action: 'run', steps: Array.from({ length: 4 }, () => ({ tool: 'workspace_read', limit: 1 })) }, 'chat')).id);
  assert.ok(f.pipeline.records.size <= PIPELINE_LIMITS.records);
  assert.ok([...f.pipeline.records.values()].reduce((sum, record) => sum + record.steps.reduce((n, step) => n + step.text.length, 0), 0) <= PIPELINE_LIMITS.retained);
  await assert.rejects(f.pipeline.call({ action: 'read', id: ids[0], step: 0 }, 'chat'), /unavailable/);
});

test('browser reads keep their normal dispatcher and force text snapshots; unsafe media and JSON keys reject first', async t => {
  const f = fixture(t);
  await f.pipeline.call({ action: 'run', steps: [{ tool: 'browser_snapshot' }] }, 'chat');
  assert.deepEqual(f.calls[0], ['browser_snapshot', { include_screenshot: false }, 'chat']);
  await assert.rejects(f.pipeline.call({ action: 'run', steps: [{ tool: 'browser_snapshot', arguments: { include_screenshot: true } }] }, 'chat'), /text only/);
  await assert.rejects(f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read', arguments: JSON.parse('{"__proto__":{"polluted":true}}') }] }, 'chat'), /Unsafe JSON/);
  assert.equal(f.calls.length, 1);
});

test('cached evidence rechecks original source authorization and fails closed after revocation', async t => {
  const f = fixture(t), result = await f.pipeline.call({ action: 'run', steps: [{ tool: 'notes_read', arguments: { id: 'shared-note' } }] }, 'chat');
  const checked = [];
  f.pipeline.authorizeEvidence = async (...args) => { checked.push(args); return false; };
  await assert.rejects(f.pipeline.call({ action: 'read', id: result.id, step: 0 }, 'chat'), /no longer authorized/);
  assert.deepEqual(checked, [['notes_read', { id: 'shared-note' }, 'chat']]);
  assert.equal(f.calls.length, 1, 'authorization must not repeat the original source read');
});

test('changing the workspace scope invalidates cached relative-path evidence within the same run', async t => {
  const f = fixture(t); let workspace = 'C:/first'; f.pipeline.getEvidenceScope = () => workspace;
  const result = await f.pipeline.call({ action: 'run', steps: [{ tool: 'workspace_read', arguments: { path: 'same-name.txt' } }] }, 'chat');
  workspace = 'C:/second';
  await assert.rejects(f.pipeline.call({ action: 'read', id: result.id, step: 0 }, 'chat'), /unavailable/);
  assert.equal(f.calls.length, 1);
});
