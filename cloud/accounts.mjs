import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

// Exomina account service (see ACCOUNTS-DESIGN.md). Identity and device keys only; no passwords,
// no provider credentials. Email sign-in code now, Google later on the same accounts.
const CODE_TTL_MS=10*60*1000,SESSION_TTL_MS=60*60*1000,SKEW_MS=2*60*1000,NONCE_WINDOW_MS=5*60*1000,WRAP_TTL_MS=15*60*1000;
const MAX_CODE_ATTEMPTS=5,MAX_DEVICES=20,MAX_PENDING=3,HOUR=60*60*1000,INVITE_TTL_MS=7*24*HOUR,TICKET_TTL_MS=10*60*1000;
export class AccountError extends Error{constructor(status,code,message){super(message||code);this.status=status;this.code=code;}}
const fail=(status,code,message)=>{throw new AccountError(status,code,message);};
const sha=(v)=>crypto.createHash('sha256').update(v).digest('hex');
const rid=(n=16)=>crypto.randomBytes(n).toString('base64url');
const EMAIL=/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const normalizeEmail=(v)=>{const e=String(v||'').trim().toLowerCase();if(e.length>254||!EMAIL.test(e))fail(400,'bad_email','Enter a valid email address.');return e;};
const publicKey=(b64,type)=>{try{const k=crypto.createPublicKey({key:Buffer.from(String(b64),'base64'),format:'der',type:'spki'});if(k.asymmetricKeyType!==type)throw 0;return k;}catch{fail(400,'bad_key','Invalid device public key.');}};

export class AccountService{
  // inviteOnly: no mailer yet (test circle); sign-in only via owner-issued invitations.
  constructor({file=':memory:',secret,mailer,inviteOnly=false,now=()=>Date.now(),codeLength=6}={}){
    if(!secret||String(secret).length<16)throw Error('Account service needs a secret of at least 16 characters.');
    if(!inviteOnly&&(!mailer||typeof mailer.sendCode!=='function'))throw Error('Account service needs a mailer.');
    this.secret=Buffer.from(String(secret));this.mailer=mailer;this.inviteOnly=inviteOnly;this.now=now;this.codeLength=codeLength;this.hits=new Map();
    this.db=new DatabaseSync(file);this.db.exec(`
      PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,plan TEXT NOT NULL DEFAULT 'free',created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS identities(iss TEXT NOT NULL,sub TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,PRIMARY KEY(iss,sub));
      CREATE TABLE IF NOT EXISTS signins(id TEXT PRIMARY KEY,email TEXT NOT NULL,code_hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,name TEXT NOT NULL,sign_key TEXT NOT NULL,box_key TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,last_seen INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS nonces(device_id TEXT NOT NULL,nonce TEXT NOT NULL,ts INTEGER NOT NULL,PRIMARY KEY(device_id,nonce));
      CREATE TABLE IF NOT EXISTS wraps(device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,from_device TEXT NOT NULL,blob TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(code_hash TEXT PRIMARY KEY,email TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tickets(ticket_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,issuer TEXT NOT NULL,expires INTEGER NOT NULL);
    `);
    // Columns added after the first schema; ALTER fails harmlessly when they already exist.
    for(const sql of ['ALTER TABLE accounts ADD COLUMN bootstrapped INTEGER NOT NULL DEFAULT 0','ALTER TABLE devices ADD COLUMN paired_by TEXT','ALTER TABLE devices ADD COLUMN proof TEXT'])try{this.db.exec(sql);}catch{}
    this.db.exec('UPDATE accounts SET bootstrapped=1 WHERE bootstrapped=0 AND id IN (SELECT account_id FROM devices)');
  }
  close(){this.db.close();}
  // sliding-window limiter kept in memory: enough for one service process, resets on restart
  limit(key,max,windowMs=HOUR){const t=this.now(),list=(this.hits.get(key)||[]).filter((x)=>t-x<windowMs);if(list.length>=max){this.hits.set(key,list);fail(429,'rate_limited','Too many attempts. Try again later.');}list.push(t);this.hits.set(key,list);}
  codeHash(id,code){return crypto.createHmac('sha256',this.secret).update(`${id}:${code}`).digest('hex');}

  // Uniform answer for every address, known or not (no account enumeration).
  async startEmail(emailInput,ip='unknown'){
    if(this.inviteOnly)fail(403,'invite_only','Sign in with your invitation code.');
    const email=normalizeEmail(emailInput);
    this.limit(`start-email:${email}`,5);this.limit(`start-ip:${ip}`,20);
    const id=rid(),code=String(crypto.randomInt(0,10**this.codeLength)).padStart(this.codeLength,'0');
    this.db.prepare('UPDATE signins SET used=1 WHERE email=? AND used=0').run(email);
    this.db.prepare('INSERT INTO signins(id,email,code_hash,expires) VALUES(?,?,?,?)').run(id,email,this.codeHash(id,code),this.now()+CODE_TTL_MS);
    try{await this.mailer.sendCode(email,code);}catch{/* never reveal delivery state */}
    return {signinId:id,expiresInSeconds:CODE_TTL_MS/1000};
  }
  verifyEmail(signinId,code,ip='unknown'){
    this.limit(`verify-ip:${ip}`,60);
    const row=this.db.prepare('SELECT * FROM signins WHERE id=?').get(String(signinId||''));
    if(!row||row.used||row.expires<this.now())fail(400,'bad_code','That code is wrong or expired.');
    // guess budget is per address per hour, so requesting a fresh code does not reset it
    this.limit(`verify-email:${row.email}`,MAX_CODE_ATTEMPTS*2);
    this.db.prepare('UPDATE signins SET attempts=attempts+1 WHERE id=?').run(row.id);
    const expected=Buffer.from(row.code_hash,'hex'),got=Buffer.from(this.codeHash(row.id,String(code||'').trim()),'hex');
    if(row.attempts+1>MAX_CODE_ATTEMPTS){this.db.prepare('UPDATE signins SET used=1 WHERE id=?').run(row.id);fail(400,'bad_code','That code is wrong or expired.');}
    if(!crypto.timingSafeEqual(expected,got))fail(400,'bad_code','That code is wrong or expired.');
    this.db.prepare('UPDATE signins SET used=1 WHERE id=?').run(row.id);
    return this.openSession(row.email);
  }
  openSession(email){
    let account=this.db.prepare('SELECT * FROM accounts WHERE email=?').get(email);
    if(!account){account={id:crypto.randomUUID(),email,plan:'free',created:this.now()};this.db.prepare('INSERT INTO accounts(id,email,plan,created) VALUES(?,?,?,?)').run(account.id,account.email,account.plan,account.created);}
    const token=rid(32);
    this.db.prepare('INSERT INTO sessions(token_hash,account_id,expires) VALUES(?,?,?)').run(sha(token),account.id,this.now()+SESSION_TTL_MS);
    return {session:token,accountId:account.id,email:account.email,expiresInSeconds:SESSION_TTL_MS/1000};
  }
  // Owner-issued invitation for the test circle: the owner vouches for the email, so the account
  // is keyed on it and email codes or Google attach to the same account later.
  createInvite(emailInput,{ttlMs=INVITE_TTL_MS}={}){
    const email=normalizeEmail(emailInput),code=rid(18);
    this.db.prepare('INSERT INTO invites(code_hash,email,expires) VALUES(?,?,?)').run(this.codeHash('invite',code),email,this.now()+ttlMs);
    return {code,email,expiresAt:this.now()+ttlMs};
  }
  redeemInvite(code,ip='unknown'){
    this.limit(`invite-ip:${ip}`,20);
    const hash=this.codeHash('invite',String(code||'').trim());
    const row=this.db.prepare('SELECT * FROM invites WHERE code_hash=?').get(hash);
    if(!row||row.used||row.expires<this.now())fail(400,'bad_invite','That invitation is wrong, used or expired.');
    if(!this.db.prepare('UPDATE invites SET used=1 WHERE code_hash=? AND used=0').run(hash).changes)fail(400,'bad_invite','That invitation is wrong, used or expired.');
    return this.openSession(row.email);
  }
  session(token){
    const row=this.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha(String(token||'')));
    if(!row||row.expires<this.now())fail(401,'bad_session','Sign in again.');
    return row.account_id;
  }
  // The first device activates immediately. Every later device waits for approval from an
  // existing device, so a hijacked mailbox alone never gets keys (design 13.1).
  // Only a brand-new account's first device activates on its own; after that (even once every
  // device is revoked) a device stays pending until an active one approves it. A session registers
  // one device and is then spent.
  registerDevice(sessionToken,{name,signKey,boxKey}){
    const accountId=this.session(sessionToken);
    publicKey(signKey,'ed25519');publicKey(boxKey,'x25519');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.deviceLimits(accountId);
      const fresh=this.db.prepare('UPDATE accounts SET bootstrapped=1 WHERE id=? AND bootstrapped=0').run(accountId).changes===1;
      const result=this.insertDevice(accountId,{name,signKey,boxKey,state:fresh?'active':'pending'});
      this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(String(sessionToken)));
      this.db.exec('COMMIT');return result;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  deviceLimits(accountId){
    const n=this.db.prepare("SELECT COUNT(*) n,SUM(state='pending') p FROM devices WHERE account_id=? AND revoked=0").get(accountId);
    if(n.n>=MAX_DEVICES)fail(409,'too_many_devices','Remove an old device first.');
    if((n.p||0)>=MAX_PENDING)fail(409,'too_many_pending','Approve or remove waiting devices first.');
  }
  insertDevice(accountId,{name,signKey,boxKey,state,pairedBy=null,proof=null}){
    const id=crypto.randomUUID(),t=this.now();
    this.db.prepare('INSERT INTO devices(id,account_id,name,sign_key,box_key,state,created,last_seen,paired_by,proof) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,accountId,String(name||'Device').slice(0,60),signKey,boxKey,state,t,t,pairedBy,proof);
    return {deviceId:id,accountId,state};
  }
  // Phone pairing (MOBILE-DESIGN.md). An active device gets a one-time ticket and shows it in a QR
  // together with a secret the server never sees; the phone's proof is HMAC(secret, its keys), which
  // only the issuing device can check before approving.
  createPairingTicket(auth){
    this.limit(`ticket:${auth.deviceId}`,20);
    const ticket=rid(24);
    this.db.prepare('INSERT INTO tickets(ticket_hash,account_id,issuer,expires) VALUES(?,?,?,?)').run(sha(ticket),auth.accountId,auth.deviceId,this.now()+TICKET_TTL_MS);
    return {ticket,expiresInSeconds:TICKET_TTL_MS/1000};
  }
  claimPairingTicket({ticket,name,signKey,boxKey,proof},ip='unknown'){
    this.limit(`pair-ip:${ip}`,20);
    publicKey(signKey,'ed25519');publicKey(boxKey,'x25519');
    if(typeof proof!=='string'||!/^[A-Za-z0-9+/=_-]{16,128}$/.test(proof))fail(400,'bad_proof','Invalid pairing proof.');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.db.prepare('SELECT * FROM tickets WHERE ticket_hash=?').get(sha(String(ticket||'')));
      if(!row||row.expires<this.now())fail(400,'bad_ticket','This pairing code is used or expired. Show a new one on your computer.');
      this.db.prepare('DELETE FROM tickets WHERE ticket_hash=?').run(row.ticket_hash);
      const issuer=this.db.prepare("SELECT 1 FROM devices WHERE id=? AND revoked=0 AND state='active'").get(row.issuer);
      if(!issuer)fail(400,'bad_ticket','This pairing code is used or expired. Show a new one on your computer.');
      this.deviceLimits(row.account_id);
      const result=this.insertDevice(row.account_id,{name,signKey,boxKey,state:'pending',pairedBy:row.issuer,proof});
      this.db.exec('COMMIT');return result;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // Canonical text a device signs for each request (design section 13.6).
  static canonical({method,path,body='',accountId,deviceId,ts,nonce}){return [String(method).toUpperCase(),path,sha(body),accountId,deviceId,ts,nonce].join('\n');}
  static sign(privateKey,parts){return crypto.sign(null,Buffer.from(AccountService.canonical(parts)),privateKey).toString('base64');}
  authenticate({method,path,body='',deviceId,ts,nonce,signature},{allowPending=false}={}){
    const dev=this.db.prepare('SELECT * FROM devices WHERE id=?').get(String(deviceId||''));
    if(!dev||dev.revoked)fail(401,'bad_signature','Request not accepted.');
    if(dev.state!=='active'&&!allowPending)fail(403,'device_pending','This device is waiting for approval.');
    const t=this.now(),stamp=Number(ts);
    if(!Number.isFinite(stamp)||Math.abs(t-stamp)>SKEW_MS)fail(401,'clock_skew','Correct your device clock, then reconnect.');
    if(!/^[\w-]{8,64}$/.test(String(nonce||'')))fail(401,'bad_signature','Request not accepted.');
    const text=AccountService.canonical({method,path,body,accountId:dev.account_id,deviceId:dev.id,ts:String(ts),nonce});
    let ok=false;try{ok=crypto.verify(null,Buffer.from(text),publicKey(dev.sign_key,'ed25519'),Buffer.from(String(signature||''),'base64'));}catch{}
    if(!ok)fail(401,'bad_signature','Request not accepted.');
    this.db.prepare('DELETE FROM nonces WHERE ts<?').run(t-NONCE_WINDOW_MS);
    try{this.db.prepare('INSERT INTO nonces(device_id,nonce,ts) VALUES(?,?,?)').run(dev.id,String(nonce),t);}catch{fail(401,'replay','Request not accepted.');}
    this.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(t,dev.id);
    return {accountId:dev.account_id,deviceId:dev.id,state:dev.state};
  }
  listDevices(auth){
    return this.db.prepare('SELECT id,name,state,created,last_seen,box_key,sign_key,paired_by,proof FROM devices WHERE account_id=? AND revoked=0 ORDER BY created').all(auth.accountId)
      .map((d)=>({id:d.id,name:d.name,state:d.state,created:d.created,lastSeen:d.last_seen,boxKey:d.box_key,signKey:d.sign_key,current:d.id===auth.deviceId,
        ...(d.state==='pending'&&d.paired_by?{pairedBy:d.paired_by,proof:d.proof}:{})}));
  }
  // An active device uploads the account key wrapped to the pending device. The server only relays the blob.
  approveDevice(auth,targetId,blob){
    const dev=this.db.prepare('SELECT * FROM devices WHERE id=? AND account_id=? AND revoked=0').get(String(targetId||''),auth.accountId);
    if(!dev||dev.state!=='pending')fail(404,'not_found','No pending device with that ID.');
    if(typeof blob!=='string'||!blob||blob.length>8192)fail(400,'bad_blob','Invalid key package.');
    this.db.prepare('INSERT OR REPLACE INTO wraps(device_id,from_device,blob,expires) VALUES(?,?,?,?)').run(dev.id,auth.deviceId,blob,this.now()+WRAP_TTL_MS);
    return {ok:true};
  }
  // Pending device (signed, allowPending) collects its package once and becomes active.
  claimApproval(auth){
    const row=this.db.prepare('SELECT * FROM wraps WHERE device_id=?').get(auth.deviceId);
    if(!row||row.expires<this.now())return {ready:false};
    this.db.prepare('DELETE FROM wraps WHERE device_id=?').run(auth.deviceId);
    this.db.prepare("UPDATE devices SET state='active' WHERE id=?").run(auth.deviceId);
    return {ready:true,blob:row.blob,fromDevice:row.from_device};
  }
  revokeDevice(auth,targetId){
    const r=this.db.prepare('UPDATE devices SET revoked=1 WHERE id=? AND account_id=? AND revoked=0').run(String(targetId||''),auth.accountId);
    if(!r.changes)fail(404,'not_found','No such device.');
    this.db.prepare('DELETE FROM wraps WHERE device_id=?').run(targetId);
    this.onRevoke?.(String(targetId));
    return {ok:true,rotationRequired:true};
  }
  deleteAccount(auth){
    this.db.prepare('DELETE FROM accounts WHERE id=?').run(auth.accountId);
    return {ok:true};
  }
  purgeExpired(){const t=this.now();this.db.prepare('DELETE FROM signins WHERE expires<?').run(t-HOUR);this.db.prepare('DELETE FROM sessions WHERE expires<?').run(t);this.db.prepare('DELETE FROM wraps WHERE expires<?').run(t);this.db.prepare('DELETE FROM nonces WHERE ts<?').run(t-NONCE_WINDOW_MS);this.db.prepare('DELETE FROM tickets WHERE expires<?').run(t);this.db.prepare('DELETE FROM invites WHERE expires<?').run(t);}
}

// Development mailer: keeps codes in memory. Production plugs in a real sender once the domain exists.
export class OutboxMailer{constructor(){this.sent=[];}async sendCode(email,code){this.sent.push({email,code});}}
