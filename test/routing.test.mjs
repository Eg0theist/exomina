import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chooseLane, usedTools, sessionKey, LEAN_TOOLS } from '../desktop/routing.mjs';
import { planSharedContext, rememberSharedContext } from '../desktop/shared-context.mjs';
import { MemoryStore } from '../desktop/memory.mjs';

test('Auto keeps conversation light and equips work, in English and German', () => {
  const lane = (text, extra = {}) => chooseLane({ text, provider: 'claude', ...extra });
  assert.equal(lane('What do you think about Cioran and Taleb?'), 'chat');
  assert.equal(lane('Wie geht es dir heute?'), 'chat');
  assert.equal(lane('Fix the bug in src/App.jsx'), 'tools');
  assert.equal(lane('Look at https://example.com and summarise it'), 'tools');
  assert.equal(lane('Öffne bitte den Ordner mit den Bildern'), 'tools');
  assert.equal(lane('Here is a screenshot', { attachments: [{ kind: 'image' }] }), 'tools');
  assert.equal(lane('Thoughts?', { attachments: [{ kind: 'image' }] }), 'chat');
  assert.equal(lane('Thoughts?', { attachments: [{ kind: 'file' }] }), 'tools');
  // Work continues right after a reply that used tools; explicit choices always win.
  assert.equal(lane('And now?', { previousUsedTools: true }), 'tools');
  assert.equal(lane('Continue with the next step', { previousUsedTools: true }), 'tools');
  assert.equal(lane('Mach weiter', { previousUsedTools: true }), 'tools');
  assert.equal(lane("What's your assessment of what we did here so far and why/whether it matters", { previousUsedTools: true }), 'chat');
  assert.equal(lane('How are you today?', { previousUsedTools: true }), 'chat');
  assert.equal(lane('Fix the bug', { requested: 'chat' }), 'chat');
  assert.equal(lane('Hello', { requested: 'tools' }), 'tools');
  // Runtimes without a lean mode, and scheduled work, always get the full suite; phone chats stay light.
  assert.equal(chooseLane({ text: 'Hello', provider: 'openai-api' }), 'tools');
  assert.equal(chooseLane({ text: 'Hello', provider: 'codex', background: true }), 'tools');
  assert.equal(chooseLane({ text: 'Fix the file', provider: 'codex', channel: true }), 'chat');
});

test('only real tool work counts as tool use, and each lane has its own session key', () => {
  assert.equal(usedTools({ activity: [{ kind: 'tool', name: 'mcp__exomina__memory_note' }, { kind: 'thinking' }] }), false);
  assert.equal(usedTools({ activity: [{ kind: 'tool', name: 'Bash' }] }), true);
  assert.equal(usedTools(undefined), false);
  assert.equal(sessionKey('claude', 'chat'), 'claude:chat');
  assert.equal(sessionKey('claude', 'tools'), 'claude');
  for (const name of ['memory_note', 'archive_search', 'conversation_read', 'image_generate', 'model_consult']) assert.ok(LEAN_TOOLS.test(name), name);
  for (const name of ['workspace_write', 'browser_open', 'desktop_click', 'app_restart_to_update', 'request_permission']) assert.ok(!LEAN_TOOLS.test(name), name);
});

test('a session that already read memory receives only the notes added since', () => {
  const chat = {}, parts = { memory: 'MEMORY 1-3\n', archive: 'ARCHIVE\n' };
  let plan = planSharedContext(chat, 'claude', undefined, parts, { versions: { memory: { snapshot: 3, revision: 3 } } });
  rememberSharedContext(chat, 'claude', plan, { selection: { provider: 'claude' }, sessionId: 's1' });
  const delta = (name, earlier) => name === 'memory' && earlier.snapshot === 3 ? 'NEW NOTE 4\n' : null;
  plan = planSharedContext(chat, 'claude', 's1', { ...parts, memory: 'MEMORY 1-4\n' }, { versions: { memory: { snapshot: 4, revision: 4 } }, delta });
  assert.deepEqual(plan.partial, ['memory']);
  assert.deepEqual(plan.skipped, ['archive']);
  assert.match(plan.text, /NEW NOTE 4/);
  assert.doesNotMatch(plan.text, /MEMORY 1-4|ARCHIVE\n/);
  // Without a usable delta the whole part is sent again.
  plan = planSharedContext(chat, 'claude', 's1', { ...parts, memory: 'MEMORY changed\n' }, { delta: () => null });
  assert.match(plan.text, /MEMORY changed/);
});

test('the note store reports appended notes only when nothing else changed', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-routing-memory-'));
  const memory = new MemoryStore(dir);
  t.after(async () => { memory.close(); await rm(dir, { recursive: true, force: true }); });
  await memory.init();
  await memory.note('First synthetic note');
  const { snapshot, revision } = memory.meta();
  await memory.note('Second synthetic note');
  await memory.note('Third synthetic note');
  assert.deepEqual(memory.appendedSince({ snapshot, revision }).map(note => note.text), ['Second synthetic note', 'Third synthetic note']);
  const [first] = await memory.list('First synthetic');
  await memory.remove(first.id);
  assert.equal(memory.appendedSince({ snapshot, revision }), null);
  assert.equal(memory.appendedSince(undefined), null);
});
