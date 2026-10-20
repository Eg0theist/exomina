import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { antigravityToolLease } from '../desktop/antigravity-tools.mjs';

const script = fileURLToPath(new URL('../desktop/mcp-stdio.mjs', import.meta.url));
const image = { mimeType: 'image/png', dataBase64: 'cGl4ZWxz' };

async function fixture(t, overrides = {}) {
  const state = { conversationId: 'antigravity-test', toolDefinitions: [
    { name: 'memory_note', inputSchema: { type: 'object' } },
    { name: 'browser_snapshot', inputSchema: { type: 'object' } },
    { name: 'request_user_input_async', inputSchema: { type: 'object' } },
    { name: 'request_permission', inputSchema: { type: 'object' } },
  ] };
  const calls = [], manager = { gateway: { script }, callTool: async (name, args, id) => { calls.push({ name, args, id }); return { content: [{ type: 'text', text: name }], structuredContent: { accepted: true } }; } };
  const lease = await antigravityToolLease(manager, state, { images: [image], ...overrides });
  t.after(() => lease?.close());
  const child = lease && spawn(lease.config.mcpServers.exomina.command, lease.config.mcpServers.exomina.args, { env: { ...process.env, ...lease.config.mcpServers.exomina.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child?.kill());
  let nextId = 0, buffered = '';
  const pending = new Map();
  child?.stdout.on('data', chunk => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const result = JSON.parse(buffered.slice(0, index)); buffered = buffered.slice(index + 1);
      pending.get(result.id)?.(result);
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => reject(new Error('MCP test timed out.')), 5000);
    pending.set(id, result => { clearTimeout(timer); pending.delete(id); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { state, manager, calls, lease, request };
}

test('Antigravity MCP exposes the run allowlist and dispatches browser, memory and question calls through the host', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('initialize')).result.serverInfo.name, 'exomina');
  const tools = (await f.request('tools/list')).result.tools.map(tool => tool.name);
  assert.deepEqual(tools, ['memory_note', 'browser_snapshot', 'request_user_input_async', 'antigravity_attachment_read']);
  for (const name of tools.slice(0, 3)) {
    const response = await f.request('tools/call', { name, arguments: { test: true } });
    assert.equal(response.result.content[0].text, name);
    assert.deepEqual(response.result.structuredContent, { accepted: true });
  }
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.id === f.state.conversationId));
  assert.ok((await f.request('tools/call', { name: 'workspace_shell', arguments: {} })).error);
  assert.equal(f.calls.length, 3);
});

test('Antigravity attachment tool returns the original supplied pixels without local file access', async t => {
  const f = await fixture(t);
  const result = (await f.request('tools/call', { name: 'antigravity_attachment_read', arguments: { index: 0 } })).result;
  assert.deepEqual(result.content[1], { type: 'image', data: image.dataBase64, mimeType: image.mimeType });
  assert.match(f.lease.imageContext, /imageIndex.*0/);
  for (const args of [{ index: 1 }, { index: -1 }, { index: 0, path: 'C:\\private' }, { index: '0' }]) {
    assert.ok((await f.request('tools/call', { name: 'antigravity_attachment_read', arguments: args })).error);
  }
  assert.equal(f.calls.length, 0);
});

test('cancelled or completed Antigravity turns cannot call their old bridge', async t => {
  for (const ended of ['cancelled', 'turnEnded']) {
    const f = await fixture(t); f.state[ended] = true;
    assert.ok((await f.request('tools/list')).error);
    assert.ok((await f.request('tools/call', { name: 'memory_note', arguments: {} })).error);
    assert.equal(f.calls.length, 0);
    f.lease.close();
  }
});

test('the host permission refusal and image screenshots are preserved in MCP results', async t => {
  const f = await fixture(t);
  f.manager.callTool = async () => ({ isError: true, content: [{ type: 'text', text: 'Browser sharing was declined.' }, { type: 'image', data: 'c2NyZWVuc2hvdA==', mimeType: 'image/png' }] });
  assert.deepEqual((await f.request('tools/call', { name: 'browser_snapshot', arguments: {} })).result, await f.manager.callTool());
});

test('tool-free runs expose no MCP lease and reject unsupported direct image input explicitly', async t => {
  const f = await fixture(t, { noTools: true, images: [] });
  assert.equal(f.lease, null);
  await assert.rejects(antigravityToolLease(f.manager, f.state, { noTools: true, images: [image] }), /tool-free helper/);
  await assert.rejects(antigravityToolLease(f.manager, f.state, { images: [{ ...image, mimeType: 'image/svg+xml' }] }), /PNG, JPEG or WebP/);
  await assert.rejects(antigravityToolLease(f.manager, f.state, { images: [{ ...image, dataBase64: 'pixels' }] }), /total at most/);
});
