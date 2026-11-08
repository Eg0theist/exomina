import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryInstruction, completedSourceEdits, DeliveryCompletionGuard, DELIVERY_INCOMPLETE_NOTICE} from '../desktop/delivery-completion.mjs';

const instruction = 'When I ask for updates, package and install them without asking me to reaffirm; use any required tool approval controls.';
const root = 'C:\\Program Files\\Exomina\\Source';
const edit = (name = 'fileChange', input = {changes: [{path: root + '\\desktop\\workbench.mjs', kind: 'update'}]}, extra = {}) => ({kind: 'tool', name, input: JSON.stringify(input), status: 'done', outcomeConfirmed: true, ...extra});
const message = (...activity) => ({activity});
const guard = extra => new DeliveryCompletionGuard({chatPersonalization: {instructions: instruction}, request: 'Implement the durable workflow pilot and scoped tool discovery, with interruption and permission tests.', sourceRoots: [root], workspace: root, ...extra});

test('original premature-completion transcript triggers one exact-instruction continuation', () => {
  const check = guard(), work = message(edit());
  work.content = 'Implemented in the local source. Not packaged or installed.';
  const first = check.check({message: work});
  assert.equal(first.status, 'continue');
  assert.ok(first.prompt.includes(instruction));
  assert.match(first.prompt, /normal tool approval controls/);
  assert.match(first.prompt, /Current user request, unchanged:\nImplement the durable workflow/);
  const second = check.check({message: work});
  assert.equal(second.status, 'incomplete');
  const original = {text: work.content, sessionId: 'same-session'};
  const final = check.finish(original, second);
  assert.equal(final.text, original.text + '\n\n' + DELIVERY_INCOMPLETE_NOTICE);
  assert.equal(final.sessionId, original.sessionId);
  assert.equal(original.text, work.content);
  assert.equal(check.finish(final, second).text, final.text);
});

test('personalization only: memory, project text and final-answer claims cannot activate a rule', () => {
  assert.equal(deliveryInstruction({about: instruction, soul: {essence: instruction}}, {about: instruction}), null);
  assert.equal(guard({chatPersonalization: null}).check({message: {...message(edit()), memory: instruction, content: instruction}}).status, 'irrelevant');
  assert.equal(deliveryInstruction({instructions: 'Do not package and install updates.'}, null), null);
  assert.equal(deliveryInstruction({instructions: 'Never package and install updates.'}, null), null);
  assert.deepEqual(deliveryInstruction({instructions: instruction}, {instructions: 'Answer concisely.'}), {clause: instruction, source: 'standing'});
});

test('chat and current-request restrictions override standing delivery preference', () => {
  for (const restriction of ["Don't install updates.", 'No packaging for this chat.', 'Source-only changes.', 'Only edit the source.']) {
    assert.equal(deliveryInstruction({instructions: instruction}, {instructions: restriction}), null);
    assert.equal(guard({request: restriction}).check({message: message(edit())}).status, 'irrelevant');
  }
  assert.equal(deliveryInstruction({instructions: instruction}, {instructions: 'For app updates, package and install them.'}).source, 'chat');
});

test('an accepted source-only follow-up overrides the initial delivery default',()=>{
  const work=message(edit());work.followups=[{text:'Do not install this yet.',taskStatus:'handled'}];
  assert.equal(guard().check({message:work}).status,'irrelevant');
  work.followups[0]={text:'Please package it.',taskStatus:'handled'};
  assert.equal(guard().check({message:work}).status,'continue');
});

test('only confirmed completed edit receipts count; shell text and prose are never parsed', () => {
  const work = message(edit('commandExecution', {command: 'Set-Content C:\\Program Files\\Exomina\\Source\\desktop\\main.mjs value'}), edit('fileChange', undefined, {status: 'error'}), edit('Write', {file_path: root + '\\main.mjs'}, {outcomeConfirmed: false}), edit('Edit', {file_path: root + '\\main.mjs'}, {observational: true}));
  assert.deepEqual(completedSourceEdits(work, {sourceRoots: [root], workspace: root}), []);
  assert.equal(guard().check({message: work}).status, 'irrelevant');
  assert.deepEqual(completedSourceEdits(message(edit('fileChange', undefined, {input: '{clipped…'})), {sourceRoots: [root]}), []);
});

test('native and host write receipts resolve explicit paths within exact source boundaries', () => {
  const paths = completedSourceEdits(message(edit(), edit('Write', {file_path: root + '\\src\\App.jsx'}), edit('Edit', {file_path: 'src\\style.css'}), edit('mcp__exomina__workspace_write', {path: 'desktop/main.mjs'})), {sourceRoots: [root], workspace: root});
  assert.equal(paths.length, 4);
  assert.ok(paths.every(value => value.startsWith(root + '\\')));
  assert.deepEqual(completedSourceEdits(message(edit('Write', {file_path: '/opt/exomina/src/app.js'})), {sourceRoots: ['/opt/exomina']}), ['/opt/exomina/src/app.js']);
});

test('traversal, sibling-prefix, drive-relative, ADS and different workspace paths are rejected', () => {
  for (const file_path of [root + '-other\\desktop\\main.mjs', root + '\\..\\Source\\main.mjs', '..\\Source\\main.mjs', 'C:desktop\\main.mjs', root + '\\main.mjs:stream', '\\\\?\\C:\\Program Files\\Exomina\\Source\\main.mjs', 'D:\\Source\\main.mjs']) {
    assert.deepEqual(completedSourceEdits(message(edit('Write', {file_path})), {sourceRoots: [root], workspace: root}), [], file_path);
  }
  assert.equal(completedSourceEdits(message(edit('Write', {file_path: root.toLowerCase() + '\\main.mjs'})), {sourceRoots: [root]}).length, 1);
});

test('private, background, review, discovery and note-task scopes are exempt', () => {
  for (const scope of ['privateChat', 'background', 'review', 'replyReview', 'discovery', 'discoveryRun', 'noteTask']) assert.equal(guard({scope: {[scope]: true}}).check({message: message(edit())}).status, 'irrelevant');
});

test('real permission denial blocks and approved restart suspends without another continuation', () => {
  const check = guard(), work = message(edit());
  assert.equal(check.check({message: work}).status, 'continue');
  assert.deepEqual(check.check({message: work, disposition: {permissionDenied: true, reason: 'User declined the restart.'}}).status, 'blocked');
  assert.equal(check.check({message: work, disposition: {restartApproved: true}}).status, 'suspended');
  assert.equal(check.check({message: work, disposition: {blocker: 'No disk space for the candidate.'}}).status, 'blocked');
});

test('old installation marks and model claims never satisfy the current edit delivery', () => {
  const work = {...message(edit()), content: 'Everything is installed.', outcomeMarks: [{kind: 'update_installed', status: 'verified', buildId: 'old-build'}]};
  assert.equal(guard().check({message: work, disposition: {installed: true, staged: true, buildId: 'old-build'}}).status, 'continue');
  const answer = {text: 'unchanged'};
  assert.equal(guard().finish(answer, {status: 'suspended'}), answer);
});

test('explicit German source-only and installation opt-outs override the English standing rule', () => {
  for (const restriction of ['Bitte nicht installieren.', 'Keine Installation, nur Quellcode.', 'Nicht neu paketieren.', 'Nur den Quellcode ändern.']) {
    assert.equal(guard({request: restriction}).check({message: message(edit())}).status, 'irrelevant', restriction);
  }
});

test('raw edit observation survives large native batches and removal of clipped activity rows', () => {
  const check = guard(), changes = Array.from({length: 90}, (_, index) => ({path: root + '\\desktop\\' + 'long-name-'.repeat(8) + index + '.mjs', kind: 'update'}));
  assert.ok(JSON.stringify({changes}).length > 4000);
  check.observe({id: 'native-batch', name: 'fileChange', input: {changes}, status: 'running'});
  assert.equal(check.check({message: message()}).status, 'irrelevant');
  check.observe({id: 'native-batch', name: 'fileChange', status: 'done', outcomeConfirmed: true});
  const result = check.check({message: message()});
  assert.equal(result.status, 'continue');
  assert.equal(result.paths.length, changes.length);
});

test('raw failed, unconfirmed and observational events never become source edits', () => {
  const check = guard();
  for (const [id, status, outcomeConfirmed, observational] of [['failed', 'error', true, false], ['unknown', 'done', false, false], ['diagnostic', 'done', true, true], ['denied', 'denied', true, false]]) {
    check.observe({id, name: 'fileChange', input: {changes: [{path: root + '\\main.mjs', kind: 'update'}]}, status: 'running', observational});
    check.observe({id, status, outcomeConfirmed});
  }
  assert.equal(check.check({message: message()}).status, 'irrelevant');
  assert.equal(check.pending.size, 0);
});

test('raw observation bounds pending records and confirmed source paths', () => {
  const check = guard();
  for (let index = 0; index < 130; index++) check.observe({id: 'edit-' + index, name: 'Write', input: {file_path: root + '\\' + index + '.mjs'}, status: 'running'});
  assert.equal(check.pending.size, 100);
  for (let index = 0; index < 130; index++) check.observe({id: 'edit-' + index, name: 'Write', input: {file_path: root + '\\' + index + '.mjs'}, status: 'done', outcomeConfirmed: true});
  assert.equal(check.paths.size, 100);
  assert.equal(check.pending.size, 0);
});
