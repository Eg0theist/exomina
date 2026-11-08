import test from 'node:test';
import assert from 'node:assert/strict';
import { ScopedToolDiscovery, TOOL_DISCOVERY_TOOLS, TOOL_DISCOVERY_LIMITS } from '../desktop/scoped-tool-discovery.mjs';
import { PermissionPolicy, hostAction } from '../desktop/permissions.mjs';

const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
function fixture() {
  let now = 1000;
  const scopes = new Map([['a', 'run-a-policy-1'], ['b', 'run-b-policy-1']]);
  const tools = [
    { name: 'workspace_read', description: 'Read a UTF-8 report file from the workspace', inputSchema: schema, env: { TOKEN: 'private' }, credentials: 'private', providerState: 'private' },
    { name: 'external_mail_send', description: 'Send a report message to a recipient', inputSchema: schema },
    { name: 'browser_snapshot', description: 'Read the current page', inputSchema: schema },
    ...TOOL_DISCOVERY_TOOLS,
  ];
  const disabled = new Set(), denied = new Set();
  const discovery = new ScopedToolDiscovery({ getCatalog: () => tools, getScope: id => scopes.get(id), getEligible: tool => !disabled.has(tool.name), evaluate: tool => ({ decision: denied.has(tool.name) ? 'deny' : tool.name === 'workspace_read' ? 'allow' : 'ask' }), now: () => now });
  return { discovery, tools, scopes, disabled, denied, advance: ms => { now += ms; } };
}

test('discovery ranks authorized summaries, loads schemas lazily and exposes only public fields', async () => {
  const f = fixture(), found = await f.discovery.discover({ query: 'report', limit: 2 }, 'a');
  assert.equal(found.results.length, 2);
  assert.ok(found.results.every(item => !('inputSchema' in item)));
  assert.doesNotMatch(JSON.stringify(found), /TOKEN|private|providerState/);
  const summary = found.results.find(item => item.name === 'workspace_read');
  const detail = await f.discovery.details({ ref: summary.ref }, 'a');
  assert.deepEqual(detail.inputSchema, schema);
  assert.deepEqual(detail.execution, { tool: 'workspace_read', requiresOrdinaryAuthorization: true });
  assert.doesNotMatch(JSON.stringify(detail), /TOKEN|private|providerState/);
  assert.match(detail.notice, /exact arguments/);
  assert.equal(typeof f.discovery.execute, 'undefined');
});

test('revoked features and denied tools disappear before matching, counts and schemas', async () => {
  const f = fixture();
  f.disabled.add('browser_snapshot'); f.denied.add('external_mail_send');
  const found = await f.discovery.discover({ query: 'report page send' }, 'a');
  assert.deepEqual(found.results.map(item => item.name), ['workspace_read']);
  assert.equal(found.matched, 1);
  assert.equal((await f.discovery.discover({ query: 'tool_discover' }, 'a')).matched, 0);
});

test('references cannot cross chats, runs, scope settings or expiry boundaries', async () => {
  const f = fixture(), ref = (await f.discovery.discover({ query: 'report' }, 'a')).results[0].ref;
  await assert.rejects(f.discovery.details({ ref }, 'b'), /unavailable/);
  f.scopes.set('a', 'new-run');
  await assert.rejects(f.discovery.details({ ref }, 'a'), /unavailable/);
  f.scopes.set('a', 'run-a-policy-1');
  f.advance(TOOL_DISCOVERY_LIMITS.ttl);
  await assert.rejects(f.discovery.details({ ref }, 'a'), /unavailable/);
  f.scopes.delete('a');
  await assert.rejects(f.discovery.discover({ query: 'report' }, 'a'), /unavailable/);
});

test('schema changes, tool replacement, denial and revocation invalidate old references', async () => {
  for (const change of [
    f => { f.tools[0] = { ...f.tools[0], inputSchema: { ...schema, required: [] } }; },
    f => { f.tools[0] = { ...f.tools[0], description: 'New implementation' }; },
    f => f.denied.add('workspace_read'),
    f => f.disabled.add('workspace_read'),
  ]) {
    const f = fixture(), ref = (await f.discovery.discover({ query: 'workspace_read' }, 'a')).results[0].ref;
    change(f);
    await assert.rejects(f.discovery.details({ ref }, 'a'), /unavailable/);
  }
});

test('permission revocation while catalog or eligibility awaits fails closed', async () => {
  let resolve, scope = 'old';
  const discovery = new ScopedToolDiscovery({ getScope: () => scope, getCatalog: () => new Promise(done => { resolve = done; }), getEligible: () => true, evaluate: () => ({ decision: 'allow' }) });
  const pending = discovery.discover({ query: 'report' }, 'a');
  scope = 'revoked'; resolve([{ name: 'read', description: 'report', inputSchema: schema }]);
  await assert.rejects(pending, /unavailable/);
  const next = new ScopedToolDiscovery({ getScope: () => scope, getCatalog: () => [{ name: 'read', description: 'report', inputSchema: schema }], getEligible: async () => { scope = 'changed-again'; return true; }, evaluate: () => ({ decision: 'allow' }) });
  await assert.rejects(next.discover({ query: 'report' }, 'a'), /unavailable/);
});

test('discovery is bounded, literal and cannot accept execution arguments', async () => {
  const f = fixture();
  for (const input of [{ query: '' }, { query: 'x'.repeat(501) }, { query: 'report', limit: 13 }, { query: 'report', args: {} }, { query: 'report', command: 'anything' }]) await assert.rejects(f.discovery.discover(input, 'a'));
  assert.equal((await f.discovery.discover({ query: 'r.*' }, 'a')).matched, 0);
  f.tools.push({ ...f.tools[0] });
  await assert.rejects(f.discovery.discover({ query: 'report' }, 'a'), /ambiguous/);
});

test('canonical schema ordering keeps references stable, and details cannot mutate catalog', async () => {
  const f = fixture(), ref = (await f.discovery.discover({ query: 'workspace_read' }, 'a')).results[0].ref;
  f.tools[0] = { ...f.tools[0], inputSchema: { additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } }, type: 'object' } };
  const detail = await f.discovery.details({ ref }, 'a');
  detail.inputSchema.required.push('invented');
  assert.deepEqual((await f.discovery.details({ ref }, 'a')).inputSchema.required, ['path']);
});

test('references have bounded retention and no decision defaults to allow', async () => {
  const f = fixture(), first = (await f.discovery.discover({ query: 'report' }, 'a')).results[0].ref;
  for (let i = 0; i < 140; i++) await f.discovery.discover({ query: 'report' }, 'a');
  assert.ok(f.discovery.refs.size <= TOOL_DISCOVERY_LIMITS.refs);
  await assert.rejects(f.discovery.details({ ref: first }, 'a'), /unavailable/);
  const closed = new ScopedToolDiscovery({ getScope: () => 'run', getCatalog: () => f.tools });
  assert.equal((await closed.discover({ query: 'report' }, 'a')).matched, 0);
});

test('actual host policy denies override full mode and discovery never approves a target-specific operation', async () => {
  const settings = { permissionMode: 'full', permissionRules: [], browserEnabled: true };
  const policy = new PermissionPolicy({ getSettings: () => settings });
  const catalog = [
    { name: 'workspace_write', description: 'Write a report file', inputSchema: schema },
    { name: 'browser_snapshot', description: 'Read a report page', inputSchema: schema },
  ];
  const discovery = new ScopedToolDiscovery({ getScope: () => JSON.stringify(settings), getCatalog: () => catalog, getEligible: tool => !tool.name.startsWith('browser_') || settings.browserEnabled, evaluate: (tool, id) => policy.evaluate(hostAction(tool.name, {}), id) });
  const ref = (await discovery.discover({ query: 'report' }, 'a')).results.find(item => item.name === 'workspace_write').ref;
  settings.permissionRules.push({ effect: 'deny', tool: 'workspace_write', match: 'private/' });
  await assert.rejects(discovery.details({ ref }, 'a'), /stale/);
  const fresh = await discovery.discover({ query: 'report' }, 'a');
  assert.ok(fresh.results.some(item => item.name === 'workspace_write'));
  assert.equal(policy.evaluate(hostAction('workspace_write', { path: 'private/report.txt' }), 'a').decision, 'deny');
  settings.permissionRules.push({ effect: 'deny', tool: 'workspace_write', match: '' });
  settings.browserEnabled = false;
  assert.equal((await discovery.discover({ query: 'report' }, 'a')).matched, 0);
});
