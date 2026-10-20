import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiConnections, connectionEndpoint } from '../desktop/api-connections.mjs';
import { ApiAgent } from '../desktop/api-agent.mjs';
import { RequestGuard, RequestLimitError } from '../desktop/request-guard.mjs';
import { PROVIDER_CATALOG, getProvider } from '../desktop/provider-catalog.mjs';

const encryption = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from('enc:' + text), decryptString: buffer => buffer.toString().replace(/^enc:/, '') };
const sse = (...events) => new Response(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const answer = text => () => sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }, '[DONE]');

test('the catalog offers four fixed APIs and an optional own-server connection beside the subscriptions', () => {
  assert.deepEqual(PROVIDER_CATALOG.filter(item => item.mode === 'api').map(item => item.id), ['openai-api', 'anthropic-api', 'gemini', 'xai', 'custom-api']);
  assert.equal(getProvider('custom-api').optional, true);
  assert.deepEqual(PROVIDER_CATALOG.filter(item => item.mode === 'subscription').map(item => item.id).sort(), ['antigravity', 'claude', 'codex', 'grok', 'muse-code'].filter(id => getProvider(id)).sort());
  assert.equal(PROVIDER_CATALOG.some(item => item.mode === 'local'), false);
});

test('an API key is stored encrypted, needs a billing confirmation, and is bound to its documented endpoint', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'api-connections-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const connections = new ApiConnections({ dataDir: dir, encryption }); await connections.init();
  await assert.rejects(connections.configure({ provider: 'openai-api', model: 'm', apiKey: 'sk-test-secret' }), /billing/);
  const status = await connections.configure({ provider: 'openai-api', model: 'm', apiKey: 'sk-test-secret', allowPaidApi: true });
  assert.equal(status.configured, true); assert.equal(status.hasKey, true);
  assert.equal(JSON.stringify(status).includes('sk-test-secret'), false);
  assert.equal((await readFile(path.join(dir, 'api-connections.json'), 'utf8')).includes('sk-test-secret'), false);
  assert.equal((await connections.getConnection('openai-api')).apiKey, 'sk-test-secret');
  assert.throws(() => connectionEndpoint(getProvider('openai-api'), 'https://evil.example/v1'), /documented endpoints/);
  await assert.rejects(connections.configure({ provider: 'openai-api', model: 'm', baseUrl: 'https://evil.example/v1', allowPaidApi: true }), /documented endpoints/);
  await assert.rejects(connections.configure({ provider: 'codex', model: 'm', allowPaidApi: true }), /API/);
  await connections.disconnect('openai-api');
  assert.equal(connections.status().find(item => item.id === 'openai-api').configured, false);
});

test('API rounds reserve input and bounded output before dispatch; titles and helpers count as background', async () => {
  const seen = []; let fetches = 0;
  const guard = new RequestGuard({ getLimits: () => ({ tokens: { hour: 9000, day: 9000 } }), nameOf: () => 'OpenAI API' });
  const agent = new ApiAgent({ getConnection: async () => ({ provider: 'openai-api', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'sk-x' }), callTool: async () => ({}), getTools: () => [],
    fetchImpl: async () => { fetches++; return answer('ok')(); }, beforeRequest: request => { seen.push([request.kind, request.provider]); guard.check(request); }, meter: guard });
  const first = await agent.run({ provider: 'openai-api', conversationId: 'a', prompt: 'x'.repeat(400) });
  assert.equal(first.text, 'ok');
  await assert.rejects(agent.run({ provider: 'openai-api', conversationId: 'b', prompt: 'hello', ephemeral: true }), error => /safety limit/.test(error.message) && /OpenAI API/.test(error.message));
  assert.deepEqual(seen, [['reply', 'openai-api'], ['background', 'openai-api']]);
  assert.equal(fetches, 1, 'the refused request never reached the provider');
  assert.ok(guard.view().tokens['openai-api'].hour >= 8192);
});

test('a guard refusal before any request starts nothing and keeps its explanation', async () => {
  let fetches = 0;
  const agent = new ApiAgent({ getConnection: async () => ({ provider: 'xai', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', model: 'm', apiKey: 'xai-secret-key' }), callTool: async () => ({}), getTools: () => [],
    fetchImpl: async () => { fetches++; return answer('no')(); }, beforeRequest: () => { throw new RequestLimitError('Exomina paused Grok API', {}); } });
  await assert.rejects(agent.run({ provider: 'xai', conversationId: 'c', prompt: 'hi' }), /Exomina paused Grok API/);
  assert.equal(fetches, 0);
});
