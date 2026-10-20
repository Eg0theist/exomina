import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AccountService} from '../cloud/accounts.mjs';
import {RelayService} from '../cloud/relay.mjs';
import {createAccountServer} from '../cloud/accounts-server.mjs';
import {RelayClient} from '../desktop/relay-client.mjs';
import {generateIdentity,exportIdentity,importIdentity,fingerprint,shortFingerprint,pairingProof,verifyPairingProof,pairingLink,parsePairingLink,openChannel,randomSecret} from '../desktop/remote-crypto.mjs';
import {RemoteBridge,SeenStore,REMOTE_METHODS,trimBootstrap} from '../desktop/remote-bridge.mjs';

const wait=(ms)=>new Promise((r)=>setTimeout(r,ms));
async function until(fn,ms=3000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await wait(20);}throw Error('timed out');}

async function setup(){
  const dir=await mkdtemp(path.join(tmpdir(),'exomina-remote-'));
  const accounts=new AccountService({secret:'test-secret-0123456789',inviteOnly:true});const relay=new RelayService({accounts});
  const server=createAccountServer(accounts,{relay});await new Promise((r)=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  // Desktop: invitation sign-in, first device of a new account is active.
  const desk=await generateIdentity({extractable:true});
  const s=await new RelayClient({base}).redeemInvite(accounts.createInvite('owner@example.com').code);
  const reg=await new RelayClient({base}).register(s.session,{name:'PC',signKey:desk.signKey,boxKey:desk.boxKey});assert.equal(reg.state,'active');
  const deskClient=new RelayClient({base,accountId:reg.accountId,deviceId:reg.deviceId,signPrivateKey:desk.sign.privateKey});
  // QR on the desktop.
  const {ticket}=await deskClient.pairingTicket(),secret=randomSecret();
  const link=pairingLink(base,{ticket,secret,desktopId:reg.deviceId,desktopFingerprint:await fingerprint(desk.signKey,desk.boxKey)});
  // Phone scans it.
  const qr=parsePairingLink(link);assert.equal(qr.base,base);
  const phone=await generateIdentity();
  const fields={ticket:qr.ticket,desktopId:qr.desktopId,name:'Pixel',signKey:phone.signKey,boxKey:phone.boxKey};
  const claimed=await new RelayClient({base}).claimPairing({...fields,proof:await pairingProof(qr.secret,fields)});assert.equal(claimed.state,'pending');
  const phoneClient=new RelayClient({base,accountId:claimed.accountId,deviceId:claimed.deviceId,signPrivateKey:phone.sign.privateKey});
  // Desktop checks the proof with its secret, then approves.
  const pending=(await deskClient.devices()).find((d)=>d.state==='pending');
  assert.ok(await verifyPairingProof(secret,{ticket,desktopId:reg.deviceId,name:pending.name,signKey:pending.signKey,boxKey:pending.boxKey},pending.proof));
  await deskClient.approve(pending.id);
  assert.equal((await phoneClient.claimApproval()).ready,true);
  // Phone pins the desktop keys it was shown in the QR.
  const deskSeen=(await phoneClient.devices()).find((d)=>d.id===qr.desktopId);
  assert.equal(await fingerprint(deskSeen.signKey,deskSeen.boxKey),qr.desktopFingerprint);
  const calls=[];let enabled=true;const peers=[{id:claimed.deviceId,boxKey:pending.boxKey,name:'Pixel'}];
  const invoke=async(method,payload)=>{calls.push({method,payload});if(method==='bootstrap')return {conversations:[{id:'c1',title:'T',messages:[{role:'user'}]}],memories:[{a:1}],tools:[{name:'x',category:'x',enabled:true,inputSchema:{}}],settings:{}};return {ok:method};};
  const bridge=new RemoteBridge({client:deskClient,identity:await importIdentity(await exportIdentity(desk)),ownId:reg.deviceId,getPeers:()=>peers,isEnabled:()=>enabled,invoke,seen:await new SeenStore(path.join(dir,'seen.json')).load()});
  bridge.start();
  const ch=await openChannel({own:phone,ownId:claimed.deviceId,peerId:reg.deviceId,peerBoxKey:deskSeen.boxKey});
  const inbox=[];
  const recv=async()=>{const msgs=await phoneClient.inbox(1);await phoneClient.ack(msgs.map((m)=>m.seq));for(const m of msgs)inbox.push((await ch.open(m.blob)).body);return inbox;};
  const ask=async(method,payload)=>{const rid=crypto.randomUUID();await phoneClient.send(reg.deviceId,await ch.seal({kind:'invoke',rid,method,payload}));
    return until(async()=>{await recv();const i=inbox.findIndex((x)=>x.rid===rid);return i<0?null:inbox.splice(i,1)[0];});};
  const close=async()=>{bridge.stop();await wait(50);relay.close();server.closeAllConnections?.();server.close();accounts.close();await rm(dir,{recursive:true,force:true});};
  return {accounts,relay,base,desk,reg,deskClient,phone,phoneClient,claimed,bridge,ch,calls,ask,recv,inbox,peers,setEnabled:(v)=>{enabled=v;},close,dir,secret,ticket};
}

test('pairing, then an allowed call round-trips encrypted and forbidden fields never reach the desktop',async()=>{
  const e=await setup();
  try{
    const r=await e.ask('chat.send',{conversationId:'c1',text:'hi',permissionMode:'full',notePermission:'all',background:true});
    assert.deepEqual(r,{kind:'result',rid:r.rid,ok:true,value:{ok:'chat.send'}});
    assert.deepEqual(e.calls.at(-1),{method:'chat.send',payload:{conversationId:'c1',text:'hi'}});
    const denied=await e.ask('security.protect',{});assert.equal(denied.ok,false);assert.match(denied.error,/only available on the computer/);
    assert.equal(e.calls.some((c)=>c.method==='security.protect'),false);
    for(const m of ['permissions.resetChats','conversations.permission','settings.save','provider.connect','update.install','team.invite','constructor','__proto__'])assert.equal((await e.ask(m,{})).ok,false,m);
    await e.ask('approval.respond',{id:'a1',decision:'always',rule:{tool:'shell',match:'*'}});
    assert.deepEqual(e.calls.at(-1).payload,{id:'a1',decision:'deny'});
    await e.ask('approval.respond',{id:'a2',decision:'once'});assert.deepEqual(e.calls.at(-1).payload,{id:'a2',decision:'once'});
    const boot=await e.ask('bootstrap',{});assert.equal(boot.value.conversations[0].messages.length,0);assert.equal(boot.value.conversations[0].messageCount,1);
    assert.deepEqual(boot.value.memories,[]);assert.equal(boot.value.tools[0].inputSchema,undefined);
  }finally{await e.close();}
});

test('live events reach an attached phone only',async()=>{
  const e=await setup();
  try{
    e.bridge.event({type:'chat.delta',text:'ignored, not attached'});await wait(400);
    await e.phoneClient.send(e.reg.deviceId,await e.ch.seal({kind:'attach'}));
    await until(()=>e.bridge.attached.size===1);
    e.bridge.event({type:'chat.delta',text:'RAW_CHAT_TEXT'});e.bridge.event({type:'chat.activity',output:'RAW_TOOL_OUTPUT'});
    const got=await until(async()=>{await e.recv();return e.inbox.find((x)=>x.kind==='events');});
    assert.deepEqual(got.events,[{type:'state.changed'}]);
    assert.equal(e.inbox.some((x)=>x.events?.some((v)=>v.text==='ignored, not attached')),false);
  }finally{await e.close();}
});

test('replays, the off switch, forged messages and revoked phones are refused',async()=>{
  const e=await setup();
  try{
    const blob=await e.ch.seal({kind:'invoke',rid:'r1',method:'notes.view',payload:{}});
    await e.phoneClient.send(e.reg.deviceId,blob);await until(()=>e.calls.length===1);
    await e.phoneClient.send(e.reg.deviceId,blob);await wait(400);assert.equal(e.calls.length,1,'replayed message must not run twice');
    // A restarted desktop keeps the seen IDs.
    const reloaded=await new SeenStore(path.join(e.dir,'seen.json')).load();assert.equal(await reloaded.claim(`${e.claimed.deviceId}:${JSON.parse(blob).id}`),false);
    // Ciphertext made with someone else's key (e.g. a hostile relay) is dropped.
    const mallory=await generateIdentity();
    const fake=await openChannel({own:mallory,ownId:e.claimed.deviceId,peerId:e.reg.deviceId,peerBoxKey:e.desk.boxKey});
    await e.phoneClient.send(e.reg.deviceId,await fake.seal({kind:'invoke',rid:'r2',method:'notes.view',payload:{}}));await wait(400);assert.equal(e.calls.length,1);
    e.setEnabled(false);
    await e.phoneClient.send(e.reg.deviceId,await e.ch.seal({kind:'invoke',rid:'r3',method:'notes.view',payload:{}}));await wait(400);assert.equal(e.calls.length,1);
    e.setEnabled(true);
    await e.deskClient.revoke(e.claimed.deviceId);
    await assert.rejects(e.phoneClient.send(e.reg.deviceId,'x'),(err)=>err.status===401);
  }finally{await e.close();}
});

test('pairing proof binds the ticket, desktop, name and both phone keys; QR fragment parsing',async()=>{
  const a=await generateIdentity(),b=await generateIdentity(),secret=randomSecret();
  const f={ticket:'t',desktopId:'d',name:'Pixel',signKey:a.signKey,boxKey:a.boxKey},proof=await pairingProof(secret,f);
  assert.ok(await verifyPairingProof(secret,f,proof));
  for(const change of [{ticket:'u'},{desktopId:'e'},{name:'Other'},{signKey:b.signKey},{boxKey:b.boxKey}])assert.equal(await verifyPairingProof(secret,{...f,...change},proof),false);
  assert.equal(await verifyPairingProof(randomSecret(),f,proof),false);
  assert.throws(()=>parsePairingLink('https://x.example/remote#t=1&s=2'));
  assert.match(shortFingerprint(await fingerprint(a.signKey,a.boxKey)),/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
});

test('channel rejects tampering, stale timestamps and the wrong direction',async()=>{
  const a=await generateIdentity(),b=await generateIdentity();let t=1_000_000;
  const ab=await openChannel({own:a,ownId:'A',peerId:'B',peerBoxKey:b.boxKey,now:()=>t}),ba=await openChannel({own:b,ownId:'B',peerId:'A',peerBoxKey:a.boxKey,now:()=>t});
  const sealed=await ab.seal({x:1});assert.deepEqual((await ba.open(sealed)).body,{x:1});
  await assert.rejects(ab.open(sealed),/authentication/);
  const env=JSON.parse(sealed);await assert.rejects(ba.open(JSON.stringify({...env,id:crypto.randomUUID()})),/authentication/);
  t+=6*60_000;await assert.rejects(ba.open(sealed),/time window/);
});

test('allowlist is explicit and bootstrap only exposes phone-safe settings',()=>{
  assert.equal(Object.hasOwn(REMOTE_METHODS,'toString'),false);
  for(const m of Object.keys(REMOTE_METHODS))assert.doesNotMatch(m,/^(security|permissions|settings|provider|update|team|messaging|cloud|browser|window|ghidra)\./);
  assert.deepEqual(trimBootstrap({settings:{provider:'codex',externalMcpServers:[{env:{SECRET:'not-for-phone'}}],workspace:'private'}}).settings,{provider:'codex'});
});

test('relay: mailbox quotas, cross-account isolation and long-poll wake-up',async()=>{
  const accounts=new AccountService({secret:'test-secret-0123456789',inviteOnly:true});const relay=new RelayService({accounts,limits:{maxQueued:2}});
  try{
    const mk=async(email)=>{const id=await generateIdentity();const s=accounts.redeemInvite(accounts.createInvite(email).code);return accounts.registerDevice(s.session,{name:'d',signKey:id.signKey,boxKey:id.boxKey});};
    const a=await mk('a@example.com'),b=await mk('b@example.com');
    const s2=accounts.redeemInvite(accounts.createInvite('a@example.com').code);const id2=await generateIdentity();
    const a2=accounts.registerDevice(s2.session,{name:'d2',signKey:id2.signKey,boxKey:id2.boxKey});
    const auth=(d)=>({accountId:d.accountId,deviceId:d.deviceId});
    assert.throws(()=>relay.send(auth(a),{to:a2.deviceId,blob:'x'}),(e)=>e.code==='bad_recipient','pending device cannot receive');
    accounts.approveDevice(auth(a),a2.deviceId,'k');accounts.claimApproval(auth(a2));
    assert.throws(()=>relay.send(auth(a),{to:b.deviceId,blob:'x'}),(e)=>e.code==='bad_recipient','other account');
    const polled=relay.inbox(auth(a2),{waitMs:2000});await wait(20);relay.send(auth(a),{to:a2.deviceId,blob:'m1'});
    assert.equal((await polled).messages[0].blob,'m1');
    relay.send(auth(a),{to:a2.deviceId,blob:'m2'});
    assert.throws(()=>relay.send(auth(a),{to:a2.deviceId,blob:'m3'}),(e)=>e.code==='mailbox_full');
    assert.equal(relay.ack(auth(b),relay.list(a2.deviceId).map((m)=>m.seq)).removed,0,'cannot ack someone else\'s mail');
    assert.equal(relay.ack(auth(a2),relay.list(a2.deviceId).map((m)=>m.seq)).removed,2);
  }finally{relay.close();accounts.close();}
});

test('trimChat keeps a huge chat under the relay limit and drops images', async () => {
  const { trimChat } = await import('../desktop/remote-bridge.mjs');
  const messages = Array.from({ length: 400 }, (_, i) => ({ id: 'm' + i, role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(30000), images: ['data:' + 'A'.repeat(200000)], activity: [{ title: 't', output: 'y'.repeat(50000) }] }));
  const out = trimChat({ id: 'c', title: 'Big', messages });
  assert.ok(JSON.stringify(out).length < 1_600_000);
  assert.equal(out.messages.at(-1).id, 'm399');
  assert.equal(out.messages.at(-1).images, undefined);
  assert.ok(out.earlierOmitted > 0);
  assert.throws(() => trimChat({ id: 'p', private: true, messages: [] }), /private/);
});
