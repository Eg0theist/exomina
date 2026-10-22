import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { AccountService } from '../cloud/accounts.mjs';
import { RelayService } from '../cloud/relay.mjs';
import { createAccountServer } from '../cloud/accounts-server.mjs';
import { RemoteAccess,relayFailure } from '../desktop/remote-access.mjs';
import { PhoneRemote } from '../src/remote-transport.js';
import { phoneApproval, checkPhoneApproval, trimBootstrap, SeenStore } from '../desktop/remote-bridge.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('relay diagnostics distinguish service, identity, TLS, DNS and protocol failures without echoing secrets',()=>{
 for(const [error,expected]of [[{status:401},'authorization'],[{status:404},'endpoint'],[{status:503},'server'],[{cause:{code:'CERT_HAS_EXPIRED'}},'tls'],[{cause:{code:'ENOTFOUND'}},'dns'],[{code:'protocol'},'protocol'],[{name:'TimeoutError'},'timeout']])assert.equal(relayFailure(error).code,expected);
 assert.ok(!relayFailure({message:'sensitive transport bytes'}).message.includes('sensitive'));
});
test('relay reconnect preserves paired identity and recovers after a bounded connection failure',async t=>{
 const e=await setup(t);await pair(e);
 // This case drives refresh explicitly. Drain the periodic poll before fault
 // injection so an already successful request cannot absorb the forced call.
 clearInterval(e.desktop.timer);e.desktop.timer=null;if(e.desktop.refreshing)await e.desktop.refreshing;
 const original=e.desktop.client.devices.bind(e.desktop.client),peers=structuredClone(e.desktop.config.peers);let attempts=0;e.desktop.client.devices=async()=>{attempts++;throw Object.assign(Error('offline'),{cause:{code:'ENOTFOUND'}});};
 await e.desktop.refresh({force:true});assert.equal(e.desktop.status().errorCode,'dns');await e.desktop.refresh({force:false});assert.equal(attempts,1);assert.ok(e.desktop.status().retryAt);e.desktop.client.devices=original;await e.desktop.reconnect();assert.equal(e.desktop.status().connected,true);assert.deepEqual(e.desktop.config.peers,peers);assert.equal(e.desktop.status().errorCode,'');assert.deepEqual(await e.phone.invoke('chat.send',{text:'after reconnect'}),{conversationId:'c1',ok:true});
});
test('overlapping relay saves serialize complete snapshots without sharing temporary filenames',async t=>{
 const e=await setup(t);await e.desktop.configure({base:e.base,invitation:e.accounts.createInvite('owner@example.com').code});
 const writes=[];for(let i=1;i<=6;i++){e.desktop.config.marker=i;writes.push(e.desktop.save());}await Promise.all(writes);
 const envelope=JSON.parse(await readFile(path.join(e.directory,'remote-connection.json'),'utf8')),saved=JSON.parse(e.secure.decryptString(Buffer.from(envelope.encrypted,'base64')));assert.equal(saved.marker,6);assert.ok(!(await readdir(e.directory)).some(name=>name.endsWith('.tmp')));
});
test('reconnect waits for an in-flight bridge startup before creating its replacement',async t=>{
 const e=await setup(t);await pair(e);e.desktop.bridge.stop();e.desktop.bridge=null;const reset=e.desktop.client.resetInbox.bind(e.desktop.client);let entered=false,release,calls=0;e.desktop.client.resetInbox=async()=>{if(++calls===1){entered=true;await new Promise(r=>release=r);}return reset();};
 const refresh=e.desktop.refresh();await until(()=>entered);const reconnect=e.desktop.reconnect();release();await Promise.all([refresh,reconnect]);assert.ok(e.desktop.bridge.running);assert.equal(e.desktop.status().connected,true);assert.equal(calls,2);assert.deepEqual(await e.phone.invoke('chat.send',{text:'after overlapped reconnect'}),{conversationId:'c1',ok:true});
});
async function until(read, accept = Boolean) { const end = Date.now() + 5000; do { const value = await read(); if (accept(value)) return value; await wait(20); } while (Date.now() < end); throw Error('Expected remote state did not arrive.'); }
const storage = () => { const values = new Map(); return { get: async key => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)); } }; };
function encryption() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); } };
}
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'exomina-phone-test-'));
  const accounts = new AccountService({ secret: 'synthetic-test-secret-0123456789', inviteOnly: true });
  const relay = new RelayService({ accounts });
  const server = createAccountServer(accounts, { relay, webRoot: path.resolve('dist') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port, calls = [];
  const secure = encryption();
  const invoke = async (method, payload) => {
    calls.push({ method, payload });
    return method === 'bootstrap' ? { settings: { provider: 'codex', externalMcpServers: [{ env: { SECRET: 'never-send' } }] }, conversations: [{ id: 'c1', title: 'Test', messages: [{ role: 'user', content: 'Hi' }] }], approvals: [], activeRuns: [] } : { conversationId: 'c1', ok: true };
  };
  const desktop = await new RemoteAccess({ dataDir: directory, encryption: secure, invoke, allowLocalHttp: true, pollMs: 200 }).init();
  const phoneStorage = storage(), phone = new PhoneRemote({ base, storage: phoneStorage, timeoutMs: 500 });
  t.after(async () => { phone.stop(); desktop.close(); relay.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); accounts.close(); await rm(directory, { recursive: true, force: true }); });
  return { desktop, phone, phoneStorage, directory, accounts, relay, base, secure, calls, invoke };
}
async function pair(e) {
  await e.desktop.configure({ base: e.base, invitation: e.accounts.createInvite('owner@example.com').code });
  assert.equal(e.desktop.status().enabled, false);
  await e.desktop.setEnabled(true);
  const qr = (await e.desktop.newPairing()).pairing;
  assert.match(qr.image, /^data:image\/png;base64,/);
  await e.phone.init(); await e.phone.pair(qr.link, 'Test phone');
  await e.desktop.refresh();
  const pending = e.desktop.status().pending[0];
  assert.equal(pending.fingerprint, e.phone.record.confirmation);
  await assert.rejects(e.desktop.approve(pending.id, 'wrong'), /Compare the confirmation/);
  await e.desktop.approve(pending.id, pending.fingerprint);
  assert.equal(await e.phone.activate(), true);
  return pending;
}

test('owner UI flow: confirmation, non-extractable phone keys, encrypted persistence and immediate RPC', async t => {
  const e = await setup(t); await pair(e);
  assert.equal(e.phone.record.identity.sign.privateKey.extractable, false);
  assert.equal(e.phone.record.identity.box.privateKey.extractable, false);
  assert.equal(e.phone.record.confirmation, undefined);
  assert.equal(e.phone.record.secret, undefined);
  const saved = await readFile(path.join(e.directory, 'remote-connection.json'), 'utf8');
  assert.ok(!saved.includes(e.desktop.config.identity.signPriv));
  const state = await e.phone.invoke('bootstrap');
  assert.deepEqual(state.settings, { provider: 'codex' });
  assert.deepEqual(state.conversations[0].messages, []);
  assert.deepEqual(await e.phone.invoke('chat.send', { text: 'Hi', permissionMode: 'full', background: true, speed: 'fast' }), { conversationId: 'c1', ok: true });
  assert.deepEqual(e.calls.at(-1).payload, { text: 'Hi' });
  for (const method of ['remote.enabled', 'remote.approve', 'remote.configure', 'settings.save', 'provider.connect', 'permissions.resetChats']) await assert.rejects(e.phone.invoke(method), /only available on the computer/);
  const html = await fetch(e.base + '/remote');
  assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await html.text(), /assets\/remote-/);
  for (const file of ['/sw.js', '/desktop/main.mjs', '/accounts.sqlite', '/index.html']) assert.equal((await fetch(e.base + file)).status, 404);
});

test('off drops queued requests across re-enable; removal is immediate and persists', async t => {
  const e = await setup(t); const pin = await pair(e);
  await e.phone.invoke('bootstrap');
  await e.desktop.setEnabled(false);
  await assert.rejects(e.phone.invoke('notes.create'), /No reply was confirmed/);
  assert.equal(e.calls.some(c => c.method === 'notes.create'), false);
  await e.desktop.setEnabled(true); await e.desktop.refresh(); await wait(250);
  assert.equal(e.calls.some(c => c.method === 'notes.create'), false, 'off-switch request must not execute after re-enable');
  await e.phone.invoke('bootstrap');
  const revokedClient=e.phone.client;await e.desktop.remove(pin.id);
  assert.equal(e.desktop.status().phones.length, 0);
  await assert.rejects(revokedClient.send(e.desktop.config.deviceId, 'x'), error => error.status === 401);
  const loaded = await new RemoteAccess({ dataDir: e.directory, encryption: e.secure, invoke: e.invoke, allowLocalHttp: true }).init();
  assert.equal(loaded.status().phones.length, 0); loaded.close();
});

test('phone reload retains keys and replay state, desktop pins do not trust server replacements', async t => {
  const e = await setup(t); await pair(e); await e.phone.invoke('bootstrap');
  const seen = await e.phoneStorage.get('seen'); assert.ok(Object.keys(seen).length > 0);
  e.phone.stop();
  const reloaded = new PhoneRemote({ base: e.base, storage: e.phoneStorage, timeoutMs: 1000 });
  t.after(() => reloaded.stop());
  await reloaded.init(); assert.deepEqual(reloaded.seen, seen); assert.equal(await reloaded.activate(), true);
  await reloaded.invoke('bootstrap');
  e.accounts.db.prepare('UPDATE devices SET box_key=? WHERE id=?').run(e.desktop.identity.boxKey, e.phone.record.deviceId);
  await e.desktop.refresh();
  assert.equal(e.desktop.livePeers.length, 0);
});

test('phone approval is bound to exact immutable details; account/security changes remain desktop-only', () => {
  const request = { id: 'a1', title: 'Write file', tool: 'workspace_write', target: 'draft.txt', detail: 'Exact content', kind: 'write', finish: () => {} };
  const shown = phoneApproval(request);
  assert.doesNotThrow(() => checkPhoneApproval(request, { digest: shown.digest, decision: 'once' }));
  assert.throws(() => checkPhoneApproval({ ...request, detail: 'Changed content' }, { digest: shown.digest, decision: 'once' }), /changed/);
  const sensitive = { ...request, tool: 'app_restart_to_update' }, view = phoneApproval(sensitive);
  assert.equal(view.desktopOnly, true);
  assert.throws(() => checkPhoneApproval(sensitive, { digest: view.digest, decision: 'once' }), /computer/);
  assert.doesNotThrow(() => checkPhoneApproval(sensitive, { digest: view.digest, decision: 'deny' }));
  assert.throws(() => checkPhoneApproval(null, { digest: shown.digest }), /no longer pending/);
  assert.equal(trimBootstrap({ settings: { remote: { secret: 'private' } } }).settings.remote, undefined);
});

test('replay persistence recovers after an isolated write failure without claiming the failed ID',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'exomina-phone-seen-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const blocked=path.join(directory,'blocked');await writeFile(blocked,'file','utf8');
  const seen=new SeenStore(path.join(blocked,'seen.json'));
  await assert.rejects(seen.claim('retry-this'));
  seen.file=path.join(directory,'working','seen.json');
  assert.equal(await seen.claim('retry-this'),true);assert.equal(await seen.claim('retry-this'),false);
});

test('temporary chats and account-approval secrets stay off the phone boundary',()=>{
  const state=trimBootstrap({conversations:[{id:'public',messages:[]},{id:'private',private:true,messages:[{content:'secret'}]}],activeRuns:[{conversationId:'private'},{conversationId:'public',nativeSession:'private-token'}],approvals:[{id:'private-approval',conversationId:'private',detail:'secret'},{id:'account-approval',tool:'provider_connect',detail:'login-code',target:'private-token',explain:{reason:'secret'}}]});
  assert.deepEqual(state.activeRuns,[{conversationId:'public'}]);assert.equal(state.approvals.length,1);assert.ok(!JSON.stringify(state).includes('login-code'));assert.ok(!JSON.stringify(state).includes('private-token'));
  const events=[],manager=new RemoteAccess({isPrivate:id=>id==='temporary'});manager.bridge={event:value=>events.push(value)};
  manager.event({type:'chat.delta',conversationId:'temporary',text:'secret'});manager.event({type:'chat.delta',conversationId:'public',text:'safe'});
  assert.equal(events.length,1);assert.equal(events[0].text,'safe');
});

test('failed server revocation retains a retryable tombstone and never restores local access',async t=>{
  const e=await setup(t);const pin=await pair(e);await e.phone.invoke('bootstrap');
  await e.desktop.setEnabled(false);
  const realRevoke=e.desktop.client.revoke.bind(e.desktop.client);let offline=true;
  e.desktop.client.revoke=async id=>{if(offline)throw Error('Synthetic relay outage');return realRevoke(id);};
  await assert.rejects(e.desktop.remove(pin.id),/blocked locally/);
  assert.equal(e.desktop.config.peers.length,0);
  assert.equal(e.desktop.status().phones[0].revoking,true);
  const loaded=await new RemoteAccess({dataDir:e.directory,encryption:e.secure,invoke:e.invoke,allowLocalHttp:true}).init();
  assert.equal(loaded.config.peers.length,0);assert.equal(loaded.status().phones[0].revoking,true);loaded.close();
  offline=false;await e.desktop.refresh();assert.equal(e.desktop.status().phones.length,0);
});
