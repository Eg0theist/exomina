import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalMcpTools, StdioMcpClient, toolAlias, validateServerConfig } from '../desktop/external-mcp.mjs';

const fixtureCode = `
  const readline = require('node:readline');
  const input = readline.createInterface({ input: process.stdin });
  const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result})+'\\n');
  input.on('line', line => {
    const message = JSON.parse(line);
    if (!message.method || message.id === undefined) return;
    if (message.method === 'initialize') send(message.id, {protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'synthetic-fixture',version:'1'}});
    if (message.method === 'tools/list') send(message.id, {tools:[{name:'echo',description:'Synthetic fixture only.',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]});
    if (message.method === 'tools/call') send(message.id, {content:[{type:'text',text:message.params.arguments.text},{type:'image',mimeType:'image/png',data:'c3ludGhldGlj'}],structuredContent:{synthetic:true}});
  });
  input.on('close', () => process.exit(0));
`;
const config = { id: 'synthetic', name: 'Synthetic MCP fixture', command: process.execPath, args: ['-e', fixtureCode], enabled: true };

test('MCP configuration rejects shell scripts and malformed inputs', () => {
  for (const server of [{}, { ...config, id: '../escape' }, { ...config, command: 'npx.cmd' }, { ...config, command: 'node\nmalicious' }, { ...config, args: 'mcp' }, { ...config, env: { BAD: 1 } }]) assert.throws(() => validateServerConfig(server));
  assert.equal(validateServerConfig(config), config);
  assert.equal(toolAlias('driver', 'a'.repeat(200)).length, 64);
  assert.notEqual(toolAlias('driver', 'a/b'), toolAlias('driver', 'a b'));
});

test('real stdio JSON-RPC handshake and tool responses preserve MCP image and structured data', async () => {
  const client = new StdioMcpClient(config);
  try {
    const connected = await client.connect();
    assert.equal(connected.serverInfo.name, 'synthetic-fixture');
    assert.equal((await client.listTools())[0].name, 'echo');
    const result = await client.request('tools/call', { name: 'echo', arguments: { text: 'ä 中文 literal {ENTER}' } });
    assert.equal(result.content[0].text, 'ä 中文 literal {ENTER}');
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.structuredContent.synthetic, true);
  } finally { await client.close(); }
  assert.equal(client.dead, true);
});

for (const pipe of ['stdout', 'stderr']) test(`MCP ${pipe} errors reject pending requests and remain contained after close`, async () => {
  const client = new StdioMcpClient(config);
  try {
    await client.connect();
    const pending = client.request('synthetic/unanswered', {});
    const rejected = assert.rejects(pending, /MCP output pipe failed: EPIPE.*inspect the target before retrying/);
    assert.doesNotThrow(() => client.child[pipe].emit('error', Object.assign(new Error('private diagnostic body'), { code: 'EPIPE' })));
    await rejected;
    assert.equal(client.pending.size, 0);
    assert.equal(client.dead, true);
    const stream = client.child[pipe];
    await client.close();
    assert.doesNotThrow(() => stream.emit('error', new Error('late private diagnostic body')));
  } finally { await client.close(); }
});

test('external MCP requires executable approval, invocation approval, and current enabled config', async () => {
  let settings = { externalMcpServers: [config] };
  const approvals = [];
  let accept = false;
  const external = new ExternalMcpTools({ getSettings: () => settings, approve: async (request) => { approvals.push(request); return accept; } });
  try {
    const declined = await external.refresh('test-conversation');
    assert.equal(declined.status[0].connected, false);
    assert.equal(external.clients.size, 0);
    accept = true;
    const connected = await external.refresh('test-conversation');
    assert.equal(connected.toolCount, 1);
    const name = external.definitions[0].name;
    assert.match(external.definitions[0].description, /untrusted/);
    accept = false;
    assert.equal((await external.call(name, { text: 'blocked' }, 'test-conversation')).isError, true);
    accept = true;
    const result = await external.call(name, { text: 'approved' }, 'test-conversation');
    assert.equal(result.content[0].text, 'approved');
    assert.match(approvals.at(-1).detail, /sent to the selected assistant/);
    settings = { externalMcpServers: [{ ...config, enabled: false }] };
    assert.equal((await external.call(name, { text: 'disabled' })).isError, true);
    assert.equal((await external.refresh()).toolCount, 0);
    assert.equal(external.clients.size, 0);
  } finally { await external.close(); }
});

test('duplicate server ids fail before launching anything', async () => {
  const external = new ExternalMcpTools({ getSettings: () => ({ externalMcpServers: [config, config] }), approve: () => { throw new Error('Must not request approval'); } });
  await assert.rejects(external.refresh(), /Duplicate MCP server id/);
});

test('a server disabled while its launch approval is open never starts', async () => {
  let settings = { externalMcpServers: [config] };
  const external = new ExternalMcpTools({ getSettings: () => settings, approve: async () => { settings = { externalMcpServers: [] }; return true; } });
  const result = await external.refresh();
  assert.equal(result.status[0].connected, false);
  assert.match(result.status[0].error, /configuration changed/);
  assert.equal(external.clients.size, 0);
});
