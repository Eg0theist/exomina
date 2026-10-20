import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ClaudeStreamInput } from '../desktop/claude-stream-input.mjs';

const ID = '17003897-99c2-47eb-ae98-4a7c7e9f1660';
const IMAGE = { mimeType: 'image/png', dataBase64: 'aW1hZ2U=' };
const replay = (uuid = ID, overrides = {}) => ({ type: 'user', isReplay: true, uuid, session_id: 'session', parent_tool_use_id: null, ...overrides });
function fixture(t, options = {}) {
  const stream = new PassThrough(), frames = [], timers = new Map(); let active = true, sequence = 0;
  stream.on('data', data => frames.push(JSON.parse(data.toString())));
  const lane = new ClaudeStreamInput({ stream, isActive: () => active, sessionId: () => 'session',
    setTimer: callback => { timers.set(++sequence, callback); return sequence; }, clearTimer: id => timers.delete(id), ...options });
  t.after(() => { lane.close(); stream.destroy(); });
  return { lane, stream, frames, timers, deactivate: () => { active = false; } };
}

test('initial Claude text and image input leaves stdin open with a fresh sender UUID and resume scope', async t => {
  const f = fixture(t);
  assert.equal(await f.lane.send({ prompt: 'Continue the saved task.', images: [IMAGE], initial: true }), true);
  const frame = f.frames[0];
  assert.match(frame.uuid, /^[0-9a-f-]{36}$/); assert.equal(frame.session_id, 'session');
  assert.equal(frame.parent_tool_use_id, null); assert.equal(f.stream.writableEnded, false);
  assert.deepEqual(frame.message.content, [{ type: 'text', text: 'Continue the saved task.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE.dataBase64 } }]);
});

test('Claude steering confirms only a matching top-level echo from its bound native conversation', async t => {
  const f = fixture(t); let delivered = false;
  const pending = f.lane.send({ prompt: 'Preserve the existing setting.', messageId: ID });
  pending.then(() => { delivered = true; });
  for (const event of [replay('unknown'), replay(ID, { isReplay: false }), replay(ID, { parent_tool_use_id: 'child-tool' }), replay(ID, { session_id: 'different-session' })]) f.lane.observe(event);
  await Promise.resolve(); assert.equal(delivered, false); assert.equal(f.frames.length, 1);
  f.lane.observe(replay()); assert.equal(await pending, true); assert.equal(f.timers.size, 0);
});

test('top-level consumed-message metadata confirms input when a runtime omits replay echoes', async t => {
  for (const type of ['assistant', 'stream_event', 'result']) {
    const f = fixture(t), pending = f.lane.send({ prompt: 'Apply the correction.', messageId: ID });
    f.lane.observe({ type, session_id: 'session', parent_tool_use_id: null, user_message_uuid: 'other', user_message_uuids: ['other', ID] });
    assert.equal(await pending, true); assert.equal(f.timers.size, 0);
  }
});

test('reusing a tracked ID cannot duplicate native input or change the original follow-up', async t => {
  const f = fixture(t), request = { prompt: 'Apply this once.', images: [IMAGE], messageId: ID };
  const first = f.lane.send(request), duplicate = f.lane.send(request);
  assert.equal(first, duplicate); assert.equal(f.frames.length, 1);
  assert.throws(() => f.lane.send({ ...request, prompt: 'A different action.' }), /already used/);
  f.lane.observe(replay()); assert.equal(await first, true);
  assert.equal(await f.lane.send(request), true); assert.equal(f.frames.length, 1);
});

test('an unacknowledged write times out honestly and never retransmits after a late echo', async t => {
  const f = fixture(t), request = { prompt: 'Make this change.', messageId: ID };
  const pending = f.lane.send(request), rejection = assert.rejects(pending, /has not acknowledged/);
  [...f.timers.values()][0](); await rejection;
  f.lane.observe(replay()); await assert.rejects(f.lane.send(request), /has not acknowledged/);
  assert.equal(f.frames.length, 1);
});

test('EOF rejects new directions while already queued acknowledgments still arrive', async t => {
  const f = fixture(t), pending = f.lane.send({ prompt: 'Already accepted work.', messageId: ID });
  f.lane.end(); assert.equal(f.stream.writableEnded, true);
  assert.equal(await f.lane.send({ prompt: 'After completion.' }), false);
  f.lane.observe(replay()); assert.equal(await pending, true);
});

test('Stop and native process closure settle pending delivery and ignore late replay', async t => {
  const f = fixture(t), pending = f.lane.send({ prompt: 'Stopped direction.', messageId: ID });
  f.lane.close(); f.lane.observe(replay());
  assert.equal(await pending, false); assert.equal(f.timers.size, 0);
  assert.equal(await f.lane.send({ prompt: 'Late input.' }), false);
});

test('a replaced active task cannot consume old acknowledgments or dispatch another write', async t => {
  const f = fixture(t), pending = f.lane.send({ prompt: 'Old direction.', messageId: ID });
  f.deactivate(); f.lane.observe(replay());
  assert.equal(await f.lane.send({ prompt: 'Another direction.' }), false);
  f.lane.close(); assert.equal(await pending, false); assert.equal(f.frames.length, 1);
});

test('invalid native input is rejected before writing while long initial context remains supported', async t => {
  const f = fixture(t);
  for (const images of [[{ ...IMAGE, mimeType: 'text/plain' }], [{ ...IMAGE, dataBase64: 'not base64' }], Array(11).fill(IMAGE)])
    assert.throws(() => f.lane.send({ prompt: 'Inspect.', images }), /image/);
  assert.throws(() => f.lane.send({ prompt: 'x'.repeat(200001) }), /valid follow-up/);
  assert.throws(() => f.lane.send({ prompt: 'Inspect.', messageId: 1 }), /message ID/);
  assert.equal(f.frames.length, 0);
  assert.equal(await f.lane.send({ prompt: 'x'.repeat(200001), initial: true }), true);
});
