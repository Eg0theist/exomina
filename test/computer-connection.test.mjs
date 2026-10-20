import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { Store } from '../desktop/store.mjs';
import { ComputerConnection, driverLaunchSignature, approvedDriverLaunch, followBundledDriver } from '../desktop/computer-connection.mjs';
import { ExternalMcpTools } from '../desktop/external-mcp.mjs';

const fixtureCode = `
const input = require('node:readline').createInterface({input:process.stdin});
input.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
let result;
if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}}};
if(m.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object'}}]};
if(m.method==='tools/call')result={content:[{type:'text',text:m.params.arguments.text}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});
input.on('close',()=>process.exit(0));`;
const config = { id: 'cua', name: 'Synthetic computer driver', command: process.execPath, args: ['-e', fixtureCode], enabled: true };

function environment(settings, { accept = true } = {}) {
  const approvals = [], saved = [], timers = [];
  const external = new ExternalMcpTools({ getSettings: () => settings, approve: async request => { approvals.push(request); return accept; },
    launchApproved: server => approvedDriverLaunch(settings, server),
    rememberLaunch: async server => { if (server.id === 'cua') { settings.cuaDriverApproval = { signature: driverLaunchSignature(server), bundled: false }; saved.push(structuredClone(settings)); } },
  });
  const connection = new ComputerConnection({ external, getSettings: () => settings,
    setTimer: (callback, delay) => { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; }, clearTimer: timer => { if (timer) timer.cancelled = true; },
  });
  return { external, connection, approvals, saved, timers, async close() { connection.close(); await external.close(); } };
}

test('activation consent survives actual storage reload and reconnects with no new launch approval', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'exomina-computer-consent-'));
  let first, second;
  try {
    const store = new Store(directory); await store.init(); store.state.settings.externalMcpServers = [structuredClone(config)];
    first = environment(store.state.settings); await first.connection.start();
    assert.equal(first.external.definitions.length, 1); assert.equal(first.approvals.length, 1);
    assert.match(first.approvals[0].detail, /stay enabled.*reconnect after restarts/);
    await store.save(); await first.close();
    const reopened = new Store(directory); await reopened.init();
    second = environment(reopened.state.settings); await second.connection.start();
    assert.equal(second.external.status[0].connected, true); assert.equal(second.approvals.length, 0);
  } finally { await first?.close(); await second?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a dead driver reconnects automatically without replaying a previous action', async () => {
  const settings = { externalMcpServers: [structuredClone(config)] }, env = environment(settings);
  try {
    await env.connection.start(); const tool = env.external.definitions[0].name;
    assert.equal((await env.external.call(tool, { text: 'approved once' })).content[0].text, 'approved once');
    const first = env.external.clients.get('cua').client;
    const closed = new Promise(resolve => first.child.once('close', resolve)); first.child.kill(); await closed;
    assert.equal(first.dead, true); await env.connection.check();
    const second = env.external.clients.get('cua').client;
    assert.notEqual(second, first); assert.equal(second.dead, false);
    assert.equal(env.approvals.length, 2, 'Only the initial activation and requested action were approved.');
    assert.equal(second.nextId, 3, 'Reconnection sent only initialize and tools/list.');
    assert.equal(env.external.definitions[0].name, tool);
  } finally { await env.close(); }
});

test('Turn off stops the driver and a disabled profile stays off after restart', async () => {
  const settings = { externalMcpServers: [structuredClone(config)] }, env = environment(settings);
  let reopened;
  try {
    await env.connection.start(); settings.externalMcpServers[0].enabled = false; delete settings.cuaDriverApproval;
    await env.connection.check(); assert.equal(env.external.clients.size, 0); assert.equal(env.external.definitions.length, 0); assert.equal(env.external.status.length, 0);
    await env.close(); reopened = environment(structuredClone(settings)); await reopened.connection.start();
    assert.equal(reopened.external.clients.size, 0); assert.equal(reopened.approvals.length, 0);
  } finally { await env.close(); await reopened?.close(); }
});

test('declined activation never becomes consent and retries never repeat its popup', async () => {
  const settings = { externalMcpServers: [structuredClone(config)] }, env = environment(settings, { accept: false });
  try {
    await env.connection.start(); await env.connection.check(); await env.connection.check();
    assert.equal(env.approvals.length, 1); assert.equal(env.saved.length, 0); assert.equal(env.external.clients.size, 0);
    assert.equal(settings.cuaDriverApproval, undefined);
  } finally { await env.close(); }
});

test('launch consent is bound to command, args and environment, independent of display names or env key order', () => {
  const base = { ...config, env: { A: '1', B: '2' } }, settings = { cuaDriverApproval: { signature: driverLaunchSignature(base) } };
  assert.equal(approvedDriverLaunch(settings, { ...base, name: 'Renamed', env: { B: '2', A: '1' } }), true);
  for (const changed of [{ command: config.command + '.other' }, { args: ['different'] }, { env: { A: '2', B: '2' } }, { id: 'unrelated' }, { enabled: false }]) {
    assert.equal(approvedDriverLaunch(settings, { ...base, ...changed }), false);
  }
});

test('only an approved bundled connection follows the current installation, and custom paths stay selected', () => {
  const old = path.join(os.tmpdir(), 'old', 'resources', 'app.asar.unpacked', 'vendor', 'cua-driver', 'cua-driver.exe');
  const current = path.join(os.tmpdir(), 'new', 'resources', 'app.asar.unpacked', 'vendor', 'cua-driver', 'cua-driver.exe');
  const bundledConfig = { ...config, command: old }, settings = { cuaDriverPath: old, externalMcpServers: [bundledConfig], cuaDriverApproval: { signature: driverLaunchSignature(bundledConfig), bundled: true } };
  assert.equal(followBundledDriver(settings, current), true); assert.equal(settings.externalMcpServers[0].command, current);
  assert.equal(approvedDriverLaunch(settings, settings.externalMcpServers[0]), true);
  const legacy = { cuaDriverPath: old, externalMcpServers: [bundledConfig] };
  followBundledDriver(legacy, current); assert.equal(approvedDriverLaunch(legacy, legacy.externalMcpServers[0]), false);
  const custom = { cuaDriverPath: process.execPath, externalMcpServers: [config] };
  assert.equal(followBundledDriver(custom, current), false); assert.equal(custom.cuaDriverPath, process.execPath);
  const chosenBundle = { cuaDriverPath: old, cuaDriverBundled: false, externalMcpServers: [bundledConfig] };
  assert.equal(followBundledDriver(chosenBundle, current), false); assert.equal(chosenBundle.cuaDriverPath, old);
  const approvedCustom = { cuaDriverPath: old, externalMcpServers: [bundledConfig], cuaDriverApproval: { signature: driverLaunchSignature(bundledConfig), bundled: false } };
  assert.equal(followBundledDriver(approvedCustom, current), false); assert.equal(approvedCustom.cuaDriverPath, old);
});

test('automatic Cua startup leaves unrelated external servers closed, and Cua refresh preserves an already connected server', async () => {
  const other = { ...config, id: 'other', name: 'Unrelated external program' };
  const settings = { externalMcpServers: [structuredClone(config), other] }, env = environment(settings);
  try {
    await env.connection.start(); assert.equal(env.external.clients.size, 1); assert.equal(env.external.clients.has('other'), false); assert.equal(env.approvals.length, 1);
    await env.external.refresh(undefined, { serverIds: ['other'] }); const unrelated = env.external.clients.get('other').client;
    const otherTool = env.external.definitions.find(tool => tool.name.startsWith('external_other_')).name;
    await env.external.refresh(undefined, { serverIds: ['cua'] });
    assert.equal(env.external.clients.get('other').client, unrelated); assert.ok(env.external.definitions.some(tool => tool.name === otherTool));
    settings.externalMcpServers[0].enabled = false; await env.connection.check();
    assert.equal(env.external.clients.get('other').client, unrelated); assert.ok(env.external.definitions.some(tool => tool.name === otherTool));
  } finally { await env.close(); }
});

test('shutdown during connection preparation prevents a queued driver from launching', async () => {
  let prepared, release; const ready = new Promise(resolve => { prepared = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const settings = { externalMcpServers: [config] };
  const external = new ExternalMcpTools({ getSettings: () => settings, approve: async () => true, prepareLaunch: async () => { prepared(); await gate; } });
  const task = external.refresh(); await ready; await external.close(); release(); await task;
  assert.equal(external.clients.size, 0); assert.equal(external.definitions.length, 0); assert.equal(external.status.length, 0);
});

test('automatic retries back off and stopping the supervisor cancels its timer', async () => {
  const settings = { externalMcpServers: [{ ...config, command: path.join(os.tmpdir(), 'no-such-exomina-driver.exe') }] }, env = environment(settings);
  try {
    await env.connection.start(); assert.equal(env.timers.at(-1).delay, 10000);
    await env.connection.check(); assert.equal(env.timers.at(-1).delay, 20000);
    assert.equal(env.approvals.length, 1); env.connection.close(); assert.equal(env.timers.at(-1).cancelled, true);
    await env.connection.check(); assert.equal(env.approvals.length, 1);
  } finally { await env.close(); }
});
