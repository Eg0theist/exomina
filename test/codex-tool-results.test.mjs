import test from 'node:test';
import assert from 'node:assert/strict';
import { codexToolResult } from '../desktop/codex-tool-results.mjs';

test('Codex receives structured-only MCP observations including current action capabilities', () => {
  const structuredContent = { capture_id: 'capture-1', elements: [{ element_token: 'snapshot-1:3', role: 'button', label: 'Save', actions: ['invoke'] }], continuation: 'page-2' };
  const result = codexToolResult({ content: [], structuredContent });
  assert.equal(result.success, true);
  assert.equal(result.contentItems.length, 1);
  assert.deepEqual(JSON.parse(result.contentItems[0].text.split('\n').slice(1).join('\n')), structuredContent);
});

test('text, images and audio retain native protocol types and error results retain structured diagnostics', () => {
  const result = codexToolResult({ isError: true, content: [{ type: 'text', text: 'Fresh state is required.' }, { type: 'image', mimeType: 'image/png', data: 'dGVzdA==' }, { type: 'audio', mimeType: 'audio/wav', data: 'dGVzdA==' }], structuredContent: { code: 'stale_element', snapshot_id: 'new-snapshot' } });
  assert.equal(result.success, false);
  assert.deepEqual(result.contentItems.slice(0, 3), [{ type: 'inputText', text: 'Fresh state is required.' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,dGVzdA==' }, { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,dGVzdA==' }]);
  assert.match(result.contentItems[3].text, /stale_element/);
});

test('resource links and embedded text reach Codex without fetching or executing their URI', () => {
  const result = codexToolResult({ content: [{ type: 'resource_link', name: 'Report', uri: 'file:///synthetic/report.txt', description: 'Source reference.' }, { type: 'resource', resource: { uri: 'https://synthetic.invalid/source', mimeType: 'text/plain', text: 'Observed result.' } }] });
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.contentItems[0].text), { type: 'resource_link', name: 'Report', uri: 'file:///synthetic/report.txt', description: 'Source reference.' });
  assert.equal(JSON.parse(result.contentItems[1].text).resource.text, 'Observed result.');
});

test('duplicate structured JSON is sent once while missing content is reported honestly', () => {
  const structuredContent = { observed: true };
  assert.equal(codexToolResult({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent }).contentItems.length, 1);
  const result = codexToolResult({ content: [{ type: 'resource', resource: { uri: 'synthetic://blob', blob: 'dGVzdA==', mimeType: 'application/octet-stream' } }, { type: 'video', data: 'synthetic' }] });
  assert.equal(result.success, false);
  assert.match(result.contentItems[0].text, /not delivered/);
  assert.match(result.contentItems[1].text, /Unsupported MCP content type: video/);
  assert.match(result.contentItems[2].text, /effects may already be complete.*Inspect the target before repeating/);
});

test('malformed results and oversized data fail before generating an invalid native response', () => {
  for (const result of [null, {}, { content: [null] }, { content: [{ type: 'text', text: 1 }] }, { content: [], structuredContent: [] }, { content: [{ type: 'image', mimeType: 'image/png', data: 'invalid base64!' }] }]) assert.throws(() => codexToolResult(result), /invalid/i);
  assert.throws(() => codexToolResult({ content: [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024 + 1) }] }), /8 MiB text limit/);
  assert.throws(() => codexToolResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(32 * 1024 * 1024) }] }), /32 MiB native response limit/);
});
