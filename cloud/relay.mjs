import {AccountError} from './accounts.mjs';

// Per-device mailbox for ciphertext between active devices of one account (MOBILE-DESIGN.md).
// The relay never sees keys or plaintext; it checks who may address whom and bounds storage.
const fail=(status,code,message)=>{throw new AccountError(status,code,message);};
export const RELAY_LIMITS={maxBlob:4*1024*1024,maxQueued:500,maxQueuedBytes:32*1024*1024,ttlMs:24*60*60*1000,maxWaitMs:25_000,batch:50};
const ID=/^[0-9a-f-]{36}$/;

export class RelayService{
  constructor({accounts,now=()=>Date.now(),limits={}}){
    this.accounts=accounts;this.db=accounts.db;this.now=now;this.limits={...RELAY_LIMITS,...limits};this.waiters=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS mailbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      to_device TEXT NOT NULL,from_device TEXT NOT NULL,blob TEXT NOT NULL,size INTEGER NOT NULL,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mailbox_to ON mailbox(to_device,seq);`);
    const previous=accounts.onRevoke;
    accounts.onRevoke=(id)=>{previous?.(id);this.purgeDevice(id);};
  }
  send(auth,{to,blob}){
    if(typeof to!=='string'||!ID.test(to)||to===auth.deviceId)fail(400,'bad_recipient','Unknown recipient.');
    if(typeof blob!=='string'||!blob||blob.length>this.limits.maxBlob)fail(413,'too_large','Message too large.');
    const peer=this.db.prepare("SELECT 1 FROM devices WHERE id=? AND account_id=? AND revoked=0 AND state='active'").get(to,auth.accountId);
    if(!peer)fail(400,'bad_recipient','Unknown recipient.');
    this.purgeExpired();
    const q=this.db.prepare('SELECT COUNT(*) n,COALESCE(SUM(size),0) b FROM mailbox WHERE to_device=?').get(to);
    if(q.n>=this.limits.maxQueued||q.b+blob.length>this.limits.maxQueuedBytes)fail(429,'mailbox_full','The other device has too many unread messages.');
    const r=this.db.prepare('INSERT INTO mailbox(account_id,to_device,from_device,blob,size,created) VALUES(?,?,?,?,?,?)').run(auth.accountId,to,auth.deviceId,blob,blob.length,this.now());
    this.wake(to);
    return {seq:Number(r.lastInsertRowid)};
  }
  list(deviceId){
    return this.db.prepare('SELECT seq,from_device,blob,created FROM mailbox WHERE to_device=? AND created>=? ORDER BY seq LIMIT ?').all(deviceId,this.now()-this.limits.ttlMs,this.limits.batch)
      .map((m)=>({seq:m.seq,from:m.from_device,blob:m.blob,created:m.created}));
  }
  // Long poll: answers at once when mail is waiting, else when mail arrives or the wait ends.
  // One poll per device; a newer poll ends the older one empty.
  async inbox(auth,{waitMs=0,signal}={}){
    const now=this.list(auth.deviceId);if(now.length||!waitMs)return {messages:now};
    this.waiters.get(auth.deviceId)?.();
    await new Promise((resolve)=>{
      const done=()=>{clearTimeout(timer);signal?.removeEventListener?.('abort',done);if(this.waiters.get(auth.deviceId)===done)this.waiters.delete(auth.deviceId);resolve();};
      const timer=setTimeout(done,Math.min(waitMs,this.limits.maxWaitMs));
      signal?.addEventListener?.('abort',done);this.waiters.set(auth.deviceId,done);
    });
    return {messages:this.list(auth.deviceId)};
  }
  ack(auth,seqs){
    if(!Array.isArray(seqs)||seqs.length>this.limits.batch*4||!seqs.every(Number.isSafeInteger))fail(400,'bad_ack','Invalid acknowledgement.');
    const del=this.db.prepare('DELETE FROM mailbox WHERE seq=? AND to_device=?');let removed=0;
    for(const seq of seqs)removed+=del.run(seq,auth.deviceId).changes;
    return {removed};
  }
  reset(auth){const removed=this.db.prepare('DELETE FROM mailbox WHERE to_device=?').run(auth.deviceId).changes;this.wake(auth.deviceId);return {removed};}
  wake(deviceId){this.waiters.get(deviceId)?.();}
  purgeDevice(deviceId){this.db.prepare('DELETE FROM mailbox WHERE to_device=? OR from_device=?').run(deviceId,deviceId);this.wake(deviceId);}
  purgeExpired(){this.db.prepare('DELETE FROM mailbox WHERE created<?').run(this.now()-this.limits.ttlMs);}
  close(){for(const done of [...this.waiters.values()])done();}
}
