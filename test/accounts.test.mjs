import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {AccountService,AccountError,OutboxMailer} from '../cloud/accounts.mjs';
import {createAccountServer} from '../cloud/accounts-server.mjs';

const make=()=>{const clock={t:1_000_000};const mailer=new OutboxMailer();const svc=new AccountService({secret:'test-secret-0123456789',mailer,now:()=>clock.t});return {svc,mailer,clock};};
const device=()=>{const s=crypto.generateKeyPairSync('ed25519'),b=crypto.generateKeyPairSync('x25519');
  return {priv:s.privateKey,signKey:s.publicKey.export({type:'spki',format:'der'}).toString('base64'),boxKey:b.publicKey.export({type:'spki',format:'der'}).toString('base64')};};
const code=(m)=>m.sent.at(-1).code;
const login=async(env,email='a@example.com')=>{const {signinId}=await env.svc.startEmail(email);return env.svc.verifyEmail(signinId,code(env.mailer));};
const req=(svc,d,id,over={})=>{const acct=svc.db.prepare('SELECT account_id a FROM devices WHERE id=?').get(id)?.a;const p={method:'GET',path:'/v1/devices',body:'',accountId:acct,deviceId:id,ts:String(svc.now()),nonce:crypto.randomBytes(8).toString('hex'),...over};
  return {method:p.method,path:p.path,body:p.body,deviceId:id,ts:p.ts,nonce:p.nonce,signature:AccountService.sign(d.priv,p)};};
const throws=(fn,codeName)=>assert.throws(fn,(e)=>e instanceof AccountError&&e.code===codeName);

test('email code signs in once and creates the account; codes are single-use',async()=>{
  const env=make();const {signinId}=await env.svc.startEmail(' A@Example.com ');
  assert.match(code(env.mailer),/^\d{6}$/);assert.equal(env.mailer.sent[0].email,'a@example.com');
  const ok=env.svc.verifyEmail(signinId,code(env.mailer));assert.equal(ok.email,'a@example.com');assert.ok(ok.session.length>30);
  throws(()=>env.svc.verifyEmail(signinId,code(env.mailer)),'bad_code');
  const again=await login(env);assert.equal(again.accountId,ok.accountId);
});

test('wrong codes lock the sign-in, expired codes fail, resend does not reset the guess budget',async()=>{
  const env=make();let {signinId}=await env.svc.startEmail('b@example.com');const real=code(env.mailer);
  for(let i=0;i<5;i++)throws(()=>env.svc.verifyEmail(signinId,'000000'===real?'111111':'000000'),'bad_code');
  throws(()=>env.svc.verifyEmail(signinId,real),'bad_code');
  ({signinId}=await env.svc.startEmail('b@example.com'));
  for(let i=0;i<5;i++)try{env.svc.verifyEmail(signinId,'000000'===code(env.mailer)?'111111':'000000');}catch{}
  throws(()=>env.svc.verifyEmail(signinId,code(env.mailer)),'rate_limited');
  const e2=make();const s=await e2.svc.startEmail('c@example.com');e2.clock.t+=11*60*1000;throws(()=>e2.svc.verifyEmail(s.signinId,code(e2.mailer)),'bad_code');
});

test('start is rate limited per email and answers the same for unknown addresses and mail failures',async()=>{
  const env=make();for(let i=0;i<5;i++)await env.svc.startEmail('d@example.com');
  await assert.rejects(env.svc.startEmail('d@example.com'),(e)=>e.code==='rate_limited');
  const bad=new AccountService({secret:'test-secret-0123456789',mailer:{async sendCode(){throw Error('smtp down');}}});
  const r=await bad.startEmail('e@example.com');assert.ok(r.signinId);
  await assert.rejects(env.svc.startEmail('not-an-email'),(e)=>e.code==='bad_email');
});

test('codes are stored hashed, never in clear',async()=>{
  const env=make();await env.svc.startEmail('f@example.com');const row=env.svc.db.prepare('SELECT * FROM signins').get();
  assert.ok(!JSON.stringify(row).includes(code(env.mailer)));assert.equal(row.code_hash.length,64);
});

test('first device is active, later devices wait for approval from an existing device',async()=>{
  const env=make();const s=await login(env);const d1=device(),d2=device();
  const r1=env.svc.registerDevice(s.session,{name:'PC',signKey:d1.signKey,boxKey:d1.boxKey});assert.equal(r1.state,'active');
  const s2=await login(env);const r2=env.svc.registerDevice(s2.session,{name:'Laptop',signKey:d2.signKey,boxKey:d2.boxKey});assert.equal(r2.state,'pending');
  throws(()=>env.svc.authenticate(req(env.svc,d2,r2.deviceId)),'device_pending');
  const a1=env.svc.authenticate(req(env.svc,d1,r1.deviceId));
  assert.equal(env.svc.claimApproval(env.svc.authenticate(req(env.svc,d2,r2.deviceId,{method:'POST',path:'/v1/devices/claim'}),{allowPending:true})).ready,false);
  env.svc.approveDevice(a1,r2.deviceId,'wrapped-key-blob');
  const claim=env.svc.claimApproval(env.svc.authenticate(req(env.svc,d2,r2.deviceId,{method:'POST',path:'/v1/devices/claim'}),{allowPending:true}));
  assert.deepEqual([claim.ready,claim.blob],[true,'wrapped-key-blob']);
  assert.equal(env.svc.claimApproval({deviceId:r2.deviceId}).ready,false);
  assert.equal(env.svc.listDevices(env.svc.authenticate(req(env.svc,d2,r2.deviceId))).length,2);
});

test('signed requests reject replay, stale timestamps, tampered bodies and other accounts',async()=>{
  const env=make();const s=await login(env);const d=device();const r=env.svc.registerDevice(s.session,{name:'PC',signKey:d.signKey,boxKey:d.boxKey});
  const good=req(env.svc,d,r.deviceId,{accountId:s.accountId});
  env.svc.authenticate(good);throws(()=>env.svc.authenticate(good),'replay');
  const stale=req(env.svc,d,r.deviceId,{accountId:s.accountId,ts:String(env.clock.t-3*60*1000)});throws(()=>env.svc.authenticate(stale),'clock_skew');
  const t=req(env.svc,d,r.deviceId,{accountId:s.accountId,method:'POST',path:'/v1/devices/revoke',body:'{"deviceId":"x"}'});t.body='{"deviceId":"y"}';throws(()=>env.svc.authenticate(t),'bad_signature');
  const other=device();throws(()=>env.svc.authenticate(req(env.svc,other,r.deviceId,{accountId:s.accountId})),'bad_signature');
  throws(()=>env.svc.authenticate({...req(env.svc,d,r.deviceId,{accountId:s.accountId}),deviceId:'nope'}),'bad_signature');
});

test('revoked devices are refused immediately; invalid keys are rejected',async()=>{
  const env=make();const s=await login(env);const d=device(),d2=device();
  const r=env.svc.registerDevice(s.session,{name:'PC',signKey:d.signKey,boxKey:d.boxKey});
  throws(()=>env.svc.registerDevice(s.session,{name:'x',signKey:d2.signKey,boxKey:d2.boxKey}),'bad_session');
  const sk=await login(env);
  throws(()=>env.svc.registerDevice(sk.session,{name:'x',signKey:'AAAA',boxKey:d.boxKey}),'bad_key');
  throws(()=>env.svc.registerDevice(sk.session,{name:'x',signKey:d.boxKey,boxKey:d.boxKey}),'bad_key');
  const s2=await login(env);const r2=env.svc.registerDevice(s2.session,{name:'L',signKey:d2.signKey,boxKey:d2.boxKey});
  const a=env.svc.authenticate(req(env.svc,d,r.deviceId));assert.equal(env.svc.revokeDevice(a,r2.deviceId).rotationRequired,true);
  throws(()=>env.svc.authenticate(req(env.svc,d2,r2.deviceId),{allowPending:true}),'bad_signature');
  throws(()=>env.svc.registerDevice('bad-token',{name:'x',signKey:d.signKey,boxKey:d.boxKey}),'bad_session');
});

test('deleting an account erases devices and sessions',async()=>{
  const env=make();const s=await login(env);const d=device();const r=env.svc.registerDevice(s.session,{name:'PC',signKey:d.signKey,boxKey:d.boxKey});
  env.svc.deleteAccount(env.svc.authenticate(req(env.svc,d,r.deviceId)));
  for(const t of ['accounts','devices','sessions'])assert.equal(env.svc.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n,0);
});

test('HTTP layer: full sign-in and signed device list over a real socket',async()=>{
  const mailer=new OutboxMailer();const svc=new AccountService({secret:'test-secret-0123456789',mailer});const srv=createAccountServer(svc);
  await new Promise((r)=>srv.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${srv.address().port}`;
  try{
    const post=(p,b,h={})=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b)}).then(async(r)=>({status:r.status,json:await r.json()}));
    const start=await post('/v1/signin/email',{email:'g@example.com'});assert.equal(start.status,200);
    assert.equal((await post('/v1/signin/verify',{signinId:start.json.signinId,code:'abcdef'})).status,400);
    const ver=await post('/v1/signin/verify',{signinId:start.json.signinId,code:mailer.sent.at(-1).code});assert.equal(ver.status,200);
    const d=device();const reg=await post('/v1/devices',{name:'PC',signKey:d.signKey,boxKey:d.boxKey},{authorization:`Bearer ${ver.json.session}`});assert.equal(reg.json.state,'active');
    const p={method:'GET',path:'/v1/devices',body:'',accountId:ver.json.accountId,deviceId:reg.json.deviceId,ts:String(Date.now()),nonce:crypto.randomBytes(8).toString('hex')};
    const headers={'x-device':p.deviceId,'x-ts':p.ts,'x-nonce':p.nonce,'x-sig':AccountService.sign(d.priv,p)};
    const list=await fetch(base+'/v1/devices',{headers});assert.equal(list.status,200);assert.equal((await list.json()).devices.length,1);
    assert.equal((await fetch(base+'/v1/devices',{headers})).status,401);
    assert.equal((await fetch(base+'/v1/devices')).status,401);
  }finally{srv.close();svc.close();}
});

test('after the first device, revoking everything never re-opens automatic activation',async()=>{
  const env=make();const s=await login(env);const d=device(),d2=device();
  const r=env.svc.registerDevice(s.session,{name:'PC',signKey:d.signKey,boxKey:d.boxKey});
  env.svc.revokeDevice(env.svc.authenticate(req(env.svc,d,r.deviceId)),r.deviceId);
  const s2=await login(env);assert.equal(env.svc.registerDevice(s2.session,{name:'Thief',signKey:d2.signKey,boxKey:d2.boxKey}).state,'pending');
});

test('invitations: single use, expire, keyed on email, and invite-only mode refuses email codes',async()=>{
  const clock={t:1_000_000};const svc=new AccountService({secret:'test-secret-0123456789',inviteOnly:true,now:()=>clock.t});
  await assert.rejects(svc.startEmail('h@example.com'),(e)=>e.code==='invite_only');
  const inv=svc.createInvite('H@Example.com');assert.equal(inv.email,'h@example.com');assert.ok(inv.code.length>=24);
  assert.ok(!JSON.stringify(svc.db.prepare('SELECT * FROM invites').all()).includes(inv.code));
  const s=svc.redeemInvite(inv.code);assert.equal(s.email,'h@example.com');
  throws(()=>svc.redeemInvite(inv.code),'bad_invite');throws(()=>svc.redeemInvite('guess'),'bad_invite');
  const old=svc.createInvite('i@example.com');clock.t+=8*24*3600*1000;throws(()=>svc.redeemInvite(old.code),'bad_invite');
  const later=svc.createInvite('h@example.com');assert.equal(svc.redeemInvite(later.code).accountId,s.accountId);
});

test('pairing tickets: single use, bound to the issuing account, always pending, proof visible only to that account',async()=>{
  const env=make();const s=await login(env);const pc=device(),phone=device(),other=device();
  const r=env.svc.registerDevice(s.session,{name:'PC',signKey:pc.signKey,boxKey:pc.boxKey});
  const {ticket}=env.svc.createPairingTicket(env.svc.authenticate(req(env.svc,pc,r.deviceId,{method:'POST',path:'/v1/pair/ticket'})));
  const claim={ticket,name:'Pixel',signKey:phone.signKey,boxKey:phone.boxKey,proof:'A'.repeat(43)};
  const p=env.svc.claimPairingTicket(claim);assert.deepEqual([p.state,p.accountId],['pending',s.accountId]);
  throws(()=>env.svc.claimPairingTicket({...claim,signKey:other.signKey,boxKey:other.boxKey}),'bad_ticket');
  const list=env.svc.listDevices(env.svc.authenticate(req(env.svc,pc,r.deviceId)));
  const pend=list.find((x)=>x.id===p.deviceId);assert.equal(pend.pairedBy,r.deviceId);assert.equal(pend.proof,claim.proof);assert.equal(pend.signKey,phone.signKey);
  const t2=env.svc.createPairingTicket(env.svc.authenticate(req(env.svc,pc,r.deviceId,{method:'POST',path:'/v1/pair/ticket'}))).ticket;
  env.clock.t+=11*60*1000;throws(()=>env.svc.claimPairingTicket({...claim,ticket:t2}),'bad_ticket');
  throws(()=>env.svc.claimPairingTicket({...claim,ticket:'x',proof:'short'}),'bad_proof');
});
