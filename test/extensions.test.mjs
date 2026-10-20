import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION_TOOLS, MAX_EXTENSIONS, extensionRecord, extensionSummary } from '../desktop/extensions.mjs';
import { hostAction } from '../desktop/permissions.mjs';

const proposal = { id: 'weather', name: 'Weather', command: 'node', args: ['C:\Workspace\weather\server.mjs'], purpose: 'Reads the forecast from a public API.' };

test('a proposed extension becomes an enabled server record with only the fields that were given', () => {
  assert.deepEqual(extensionRecord(proposal), { id: 'weather', name: 'Weather', command: 'node', args: ['C:\Workspace\weather\server.mjs'], enabled: true });
  assert.deepEqual(extensionRecord({ ...proposal, args: [], env: {} }), { id: 'weather', name: 'Weather', command: 'node', enabled: true });
});

test('bad ids, batch files, duplicates and a full list are refused before anything is asked of the user', () => {
  assert.throws(() => extensionRecord({ ...proposal, id: 'bad id!' }), /id/);
  assert.throws(() => extensionRecord({ ...proposal, command: 'run.cmd' }), /Batch scripts/);
  assert.throws(() => extensionRecord({ ...proposal, purpose: '' }), /Explain/);
  assert.throws(() => extensionRecord(proposal, [{ id: 'weather' }]), /already exists/);
  assert.throws(() => extensionRecord(proposal, Array.from({ length: MAX_EXTENSIONS }, (_, index) => ({ id: 'e' + index }))), /at most/);
  assert.throws(() => extensionRecord(null), /object/);
  assert.throws(() => extensionRecord({...proposal,id:'cua'}),/built-in/);
  assert.throws(() => extensionRecord({...proposal,args:['x'.repeat(23000)]}),/complete launch preview/);
});

test('the approval text shows the command, arguments and complete environment', () => {
  const record = extensionRecord({ ...proposal, env: { API_REGION: 'eu-secret-value' } });
  const text = extensionSummary(record, proposal.purpose);
  assert.match(text, /Runs: node/); assert.match(text, /server\.mjs/); assert.match(text, /API_REGION/); assert.equal(text.includes('eu-secret-value'), true);
});

test('the tool is described for models and counts as running a program for the permission rules', () => {
  assert.equal(EXTENSION_TOOLS[0].name, 'extension_add');
  assert.deepEqual(hostAction('extension_add', proposal), { kind: 'execute', tool: 'extension_add', target: 'node C:\Workspace\weather\server.mjs' });
});
