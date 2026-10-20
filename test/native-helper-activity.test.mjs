import test from 'node:test';
import assert from 'node:assert/strict';
import {ClaudeHelperActivity, createCodexHelper} from '../desktop/native-helper-activity.mjs';

function fixture(options = {}) {
  const events = []; let time = 100;
  const tracker = new ClaudeHelperActivity({turnId: 'host-run', sourceModel: () => 'reported-main-model', emit: helper => events.push(helper), now: () => ++time, ...options});
  return {tracker, events};
}
const tool = (id = 'spawn', input = {}) => ({type: 'assistant', message: {content: [{type: 'tool_use', id, name: 'Agent', input}]}});
const task = (fields = {}) => ({type: 'system', subtype: 'task_started', task_id: 'task', tool_use_id: 'spawn', task_type: 'local_agent', description: 'Review', ...fields});

test('Codex configured child identity stays separate from requested and executed models', () => {
  const helper = createCodexHelper({sessionId: 'native-child', parentState: {provider: 'codex', sessionId: 'parent', runtimeSelection: {model: 'reported-parent'}}},
    {agentNickname: 'Ada', agentRole: 'reviewer', model: 'configured-child', reasoningEffort: 'high', preview: 'Inspect the patch.'}, 1);
  assert.equal(helper.name, 'Ada'); assert.equal(helper.role, 'reviewer'); assert.equal(helper.sourceModel, 'reported-parent');
  assert.equal(helper.configuredModel, 'configured-child'); assert.equal(helper.effectiveModel, undefined); assert.equal(helper.requestedModel, undefined);
  assert.equal(helper.status, 'waiting'); assert.equal(helper.kind, 'native');
  const nested = createCodexHelper({sessionId: 'nested', parentState: {provider: 'codex', sessionId: 'native-child', nativeHelper: helper}}, {}, 2);
  assert.equal(nested.sourceModel, 'configured-child'); assert.equal(nested.sourceModelSource, 'configured');
});
test('Claude native tool calls identify requested task/model and child streams prove actual model', () => {
  const {tracker, events} = fixture();
  tracker.observe(tool('spawn', {description: 'Tests', prompt: 'Review the tests.', model: 'sonnet', subagent_type: 'reviewer'}));
  tracker.observe(task());
  assert.equal(events[0].requestedModel, 'sonnet'); assert.equal(events[0].effectiveModel, undefined); assert.equal(events[0].task, 'Review the tests.');
  assert.equal(events[0].nativeToolUseId,'spawn');
  assert.equal(tracker.observe({type: 'stream_event', parent_tool_use_id: 'spawn', event: {type: 'message_start', message: {model: 'claude-executed-model'}}}), true);
  assert.equal(events.at(-1).effectiveModel, 'claude-executed-model'); assert.equal(events.at(-1).modelSource, 'execution');
  assert.equal(events.at(-1).sourceModel, 'reported-main-model'); assert.equal(tracker.helpers.size, 1);
});
test('Claude native task bookends preserve background lifecycle after placeholder tool results', () => {
  const {tracker, events} = fixture(); tracker.observe(tool()); tracker.observe(task({is_backgrounded: true}));
  tracker.observe({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'spawn', content: 'Running in background.'}]}});
  assert.equal(events.at(-1).status, 'running');
  tracker.observe({type: 'system', subtype: 'task_progress', task_id: 'task', summary: 'Checking the imports.'});
  assert.equal(events.at(-1).summary, 'Checking the imports.');
  tracker.observe({type: 'system', subtype: 'task_notification', task_id: 'task', status: 'completed', summary: 'Reviewed.'});
  assert.equal(events.at(-1).status, 'complete'); assert.ok(events.at(-1).finishedAt);
  const count = events.length; tracker.observe({type: 'system', subtype: 'task_updated', task_id: 'task', patch: {status: 'running'}}); tracker.close();
  assert.equal(events.length, count); assert.equal(events.at(-1).status, 'complete');
});
test('Claude foreground results finish their helper and native failure/cancellation patches remain distinct', () => {
  const {tracker, events} = fixture(); tracker.observe(tool()); tracker.observe(task({is_backgrounded: false}));
  tracker.observe({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'spawn', content: 'Reviewed.'}]}});
  assert.equal(events.at(-1).status, 'complete');
  tracker.observe(task({task_id: 'failed-task', tool_use_id: 'failed-tool'}));
  tracker.observe({type: 'system', subtype: 'task_updated', task_id: 'failed-task', patch: {status: 'failed', error: 'Parser failed.'}});
  assert.equal(events.at(-1).status, 'failed'); assert.equal(events.at(-1).error, 'Parser failed.');
  tracker.observe(task({task_id: 'paused-task', tool_use_id: 'paused-tool'}));
  tracker.observe({type: 'system', subtype: 'task_updated', task_id: 'paused-task', patch: {status: 'paused'}});
  assert.equal(events.at(-1).status, 'waiting'); tracker.close(); assert.equal(events.at(-1).status, 'cancelled');
});
test('ordinary bash/MCP/workflow tasks and unrecognized progress never create helper cards', () => {
  const {tracker, events} = fixture();
  for (const type of ['local_bash', 'mcp_task', 'local_workflow', 'housekeeping']) tracker.observe(task({task_type: type, subagent_type: 'claimed-type'}));
  tracker.observe({type: 'system', subtype: 'task_started', task_id: 'unknown', description: 'Unknown task'});
  tracker.observe({type: 'system', subtype: 'task_progress', task_id: 'unknown', summary: 'Unknown progress'});
  assert.equal(events.length, 0);
  assert.equal(tracker.observe({type: 'assistant', parent_tool_use_id: 'unobserved-child', message: {model: 'actual-child', content: []}}), true);
  assert.equal(events.length, 0);
});
test('nested Claude native helpers preserve the actual immediate source and share no model guesses', () => {
  const {tracker, events} = fixture(); tracker.observe(tool());
  tracker.observe({type: 'assistant', parent_tool_use_id: 'spawn', message: {model: 'actual-parent-helper', content: [{type: 'tool_use', id: 'nested', name: 'Task', input: {prompt: 'Inspect nested task.'}}]}});
  const nested = events.at(-1); assert.equal(nested.sourceModel, 'actual-parent-helper'); assert.equal(nested.effectiveModel, undefined);
  assert.equal(nested.parentHelperId, events[0].id); assert.equal(tracker.helpers.size, 2);
});
test('helper text is bounded and redacted, duplicate snapshots are quiet, and shutdown rejects later metadata', () => {
  const {tracker, events} = fixture({maxHelpers: 1});
  tracker.observe(tool('spawn', {description: 'Bearer secret-credential', prompt: 'sk-secret-credential ' + 'x'.repeat(4000)}));
  assert.doesNotMatch(JSON.stringify(events), /secret-credential/); assert.ok(events[0].task.length <= 2000); assert.equal(events[0].taskTruncated, true);
  const count = events.length; tracker.observe(tool('spawn', {description: 'Bearer secret-credential', prompt: 'sk-secret-credential ' + 'x'.repeat(4000)}));
  assert.equal(events.length, count); tracker.observe(tool('extra', {prompt: 'Extra'})); assert.equal(tracker.helpers.size, 1);
  tracker.close('failed'); const end = events.length; tracker.observe(task()); tracker.observe(tool('late')); assert.equal(events.length, end);
});
test('native helper identifiers and alias bookkeeping are bounded independently from display text', () => {
  const {tracker} = fixture({maxHelpers: 1}); tracker.observe(tool('x'.repeat(301))); assert.equal(tracker.helpers.size, 0);
  tracker.observe(tool('known')); tracker.observe(task({tool_use_id: 'known'}));
  for (let index = 0; index < 20; index++) tracker.observe(task({tool_use_id: 'known', task_id: `alias-${index}`}));
  assert.ok(tracker.taskIds.size <= 2); assert.ok(tracker.toolIds.size <= 2); assert.equal(tracker.helpers.size, 1);
});
