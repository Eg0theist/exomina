import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { cloudEndpoint } from './cloud-client.mjs';
import { RelayClient } from './relay-client.mjs';
import { generateIdentity, exportIdentity, importIdentity, fingerprint, pairingConfirmation, randomSecret, pairingLink, verifyPairingProof } from './remote-crypto.mjs';
import { RemoteBridge, SeenStore } from './remote-bridge.mjs';

export function relayFailure(error){
  const code=String(error?.cause?.code||error?.code||error?.name||'');
  if(error?.status===401||error?.status===403)return {code:'authorization',message:'The relay rejected this computer’s device identity. Check the relay’s device list or recover this connection on the computer.'};
  if(error?.status===404)return {code:'endpoint',message:'The address responds, but the Exomina relay endpoint is missing. Check the relay address and deployed version.'};
  if(error?.status===429)return {code:'rate-limit',message:'The relay is limiting requests. Exomina will reconnect automatically.'};
  if(error?.status>=500)return {code:'server',message:'The phone relay is responding with a server error. Check the relay service and its logs.'};
  if(/CERT|TLS|SSL|SELF_SIGNED/.test(code))return {code:'tls',message:'The relay’s HTTPS certificate could not be verified. Repair its certificate before reconnecting.'};
  if(/ENOTFOUND|EAI_AGAIN/.test(code))return {code:'dns',message:'The phone relay’s hostname could not be resolved. Check its address and DNS.'};
  if(/Timeout|ETIMEDOUT|Abort/.test(code))return {code:'timeout',message:'The phone relay did not respond in time. Check that the service is online and reachable.'};
  if(code==='protocol')return {code:'protocol',message:'This address did not return an Exomina relay response. Check the relay address and version.'};
  return {code:'unreachable',message:'Could not connect to the phone relay. Check that its service is running and reachable from this computer.'};
}

/** Owner-only desktop settings. Provider credentials never enter this connection. */
export class RemoteAccess {
  constructor({ dataDir, encryption, invoke, emit = () => {}, isPrivate = () => false, name = 'My computer', allowLocalHttp = false, fetchImpl = globalThis.fetch, pollMs = 5000 }) {
    Object.assign(this, { dataDir, encryption, invoke, emit, isPrivate, name, allowLocalHttp, fetchImpl, pollMs });
    this.config = null; this.livePeers = []; this.pending = []; this.verifiedAt = 0; this.error = ''; this.queue = Promise.resolve();this.saveQueue=Promise.resolve();this.failures=0;this.retryAt=0;this.lastConnectedAt=null;this.errorCode='';
  }
  async init() {
    this.file = path.join(this.dataDir, 'remote-connection.json');
    try {
      const envelope = JSON.parse(await readFile(this.file, 'utf8'));
      if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw Error('Encrypted device storage is unavailable.');
      const saved = JSON.parse(this.encryption.decryptString(Buffer.from(envelope.encrypted, 'base64')));
      if (saved === null) return this;
      if (saved.version !== 1 || !Array.isArray(saved.peers) || !saved.deviceId || !saved.accountId) throw Error('Invalid phone connection.');
      saved.base = cloudEndpoint(saved.base, this.allowLocalHttp);
      this.identity = await importIdentity(saved.identity); this.config = saved; this.makeClient();
      if (saved.enabled) this.start();
    } catch (error) { if (error.code !== 'ENOENT') this.error = 'Phone access could not be unlocked. Connect again on this computer.'; }
    return this;
  }
  mutate(action) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  makeClient() { this.client = new RelayClient({ base: this.config.base, accountId: this.config.accountId, deviceId: this.config.deviceId, signPrivateKey: this.identity.sign.privateKey, fetchImpl: this.fetchImpl }); }
  save() {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw Error('Encrypted device storage is unavailable.');
    const encrypted = this.encryption.encryptString(JSON.stringify(this.config)).toString('base64');
    const task=this.saveQueue.catch(()=>{}).then(async()=>{await mkdir(this.dataDir,{recursive:true});const temporary=this.file+'.'+randomSecret().replace(/[^a-z0-9]/gi,'').slice(0,24)+'.tmp';await writeFile(temporary,JSON.stringify({version:1,encrypted}),{encoding:'utf8',mode:0o600,flag:'wx'});await rename(temporary,this.file);});this.saveQueue=task;return task;
  }
  changed() { this.emit({ type: 'remote.changed' }); }
  enabled() { return this.config?.enabled === true && Date.now() - this.verifiedAt < 30_000; }
  status() {
    const pair = this.pair?.expiresAt > Date.now() ? this.pair : null;
    return { configured: !!this.config, enabled: this.config?.enabled === true, connected: this.enabled(), base: this.config?.base || '', error: this.error,
      errorCode:this.errorCode,retryAt:this.retryAt?new Date(this.retryAt).toISOString():null,lastConnectedAt:this.lastConnectedAt,checking:!!this.refreshing,
      phones: [...(this.config?.peers || []), ...(this.config?.revoking || []).map(p=>({...p,revoking:true}))].map(p => ({ id: p.id, name: p.name, revoking:p.revoking===true,lastSeen: this.devices?.find(d => d.id === p.id)?.lastSeen || null })),
      pending: this.pending.map(p => ({ id: p.id, name: p.name, fingerprint: p.fingerprint })),
      pairing: pair ? { link: pair.link, image: pair.image, expiresAt: pair.expiresAt } : null };
  }
  configure({ base, invitation, name } = {}) { return this.mutate(async () => {
    if (this.config) throw Error('Disconnect the existing phone relay first.');
    const url = cloudEndpoint(base, this.allowLocalHttp);
    if (!String(invitation || '').trim()) throw Error('Enter your invitation code.');
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw Error('Encrypted device storage is unavailable.');
    const identity = await generateIdentity({ extractable: true });
    const client = new RelayClient({ base: url, fetchImpl: this.fetchImpl });
    const session = await client.redeemInvite(String(invitation).trim());
    const registered = await client.register(session.session, { name: String(name || this.name).slice(0, 60), signKey: identity.signKey, boxKey: identity.boxKey });
    if (registered.state !== 'active') throw Error('This account already has a computer. Approve or recover it from that computer before connecting here.');
    this.config = { version: 1, base: url, accountId: registered.accountId, deviceId: registered.deviceId, identity: await exportIdentity(identity), enabled: false, peers: [] };
    this.identity = identity; this.makeClient(); await this.save(); this.error = ''; this.changed(); return this.status();
  }); }
  setEnabled(enabled) { return this.mutate(async () => {
    if (!this.config) throw Error('Connect your relay first.');
    this.config.enabled = enabled === true;
    if (!this.config.enabled) this.stop();
    try { await this.save(); } catch (error) { this.config.enabled = false; this.stop(); throw error; }
    if (this.config.enabled) { this.start(); await this.refresh(); }
    this.changed(); return this.status();
  }); }
  start() {
    if (this.timer || this.closed) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh({force:false}).catch(() => {}), this.pollMs); this.timer.unref?.();
  }
  stop() {
    clearInterval(this.timer); this.timer = null; this.verifiedAt = 0; this.livePeers = []; this.pending = []; this.pair = null;
    this.bridge?.stop(); this.bridge = null;
  }
  async refresh({force=true}={}) {
    if (!this.config || this.closed) return this.status();
    if (this.refreshing) return this.refreshing;
    if(!force&&Date.now()<this.retryAt)return this.status();
    const config = this.config;
    this.refreshing = (async () => {
      try {
        for (const removed of [...(config.revoking||[])]) {
          try { await this.client.revoke(removed.id); } catch(error) { if(error.status!==404)throw error; }
          config.revoking=config.revoking.filter(p=>p.id!==removed.id);await this.save();
        }
        const devices = await this.client.devices();
        if (this.closed || this.config !== config) return this.status();
        if(!Array.isArray(devices))throw Object.assign(Error('Invalid relay response'),{code:'protocol'});
        this.devices = devices;
        // A locally confirmed phone may still be collecting server approval. The relay itself
        // refuses pending-device traffic; keeping this pin ready avoids dropping its first call.
        this.livePeers = config.peers.filter(pin => devices.some(d => d.id === pin.id && ['active','pending'].includes(d.state) && d.signKey === pin.signKey && d.boxKey === pin.boxKey));
        this.pending = [];
        if (config.enabled && this.pair?.expiresAt > Date.now()) for (const device of devices.filter(d => d.state === 'pending' && d.pairedBy === config.deviceId)) {
          const fields = { ticket: this.pair.ticket, desktopId: config.deviceId, name: device.name, signKey: device.signKey, boxKey: device.boxKey };
          if (await verifyPairingProof(this.pair.secret, fields, device.proof)) this.pending.push({ ...device, fingerprint: await pairingConfirmation(this.pair.ticket, await fingerprint(this.identity.signKey, this.identity.boxKey), device.signKey, device.boxKey) });
        }
        this.verifiedAt = Date.now(); this.lastConnectedAt=new Date().toISOString();this.error = '';this.errorCode='';this.failures=0;this.retryAt=0;
        if (config.enabled && !this.bridge) {
          const seen = this.seen ||= await new SeenStore(path.join(this.dataDir, 'remote-seen.json')).load();
          if (!config.enabled || this.closed || this.config !== config) return this.status();
          this.bridge = new RemoteBridge({ client: this.client, identity: this.identity, ownId: config.deviceId, getPeers: () => this.livePeers, isEnabled: () => this.enabled(), drainOnStart:true,invoke: this.invoke, seen });
          this.bridge.start(); await this.bridge.ready;
        }
      } catch(error) { if(this.closed||this.config!==config)return this.status();this.verifiedAt = 0; this.livePeers = []; this.pending = [];if(this.bridge&&!this.bridge.running)this.bridge=null;const failure=relayFailure(error);this.error=failure.message;this.errorCode=failure.code;this.failures++;this.retryAt=Date.now()+Math.min(60000,Math.max(this.pollMs,1000)*2**Math.min(4,this.failures-1)); }
      this.changed(); return this.status();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  reconnect(){return this.mutate(async()=>{if(!this.config)throw Error('Connect your phone relay first.');if(this.refreshing)await this.refreshing;this.bridge?.stop();this.bridge=null;this.verifiedAt=0;this.retryAt=0;return this.refresh({force:true});});}
  newPairing() { return this.mutate(async () => {
    if (!this.config?.enabled) throw Error('Turn on Allow phone control first.');
    const { ticket, expiresInSeconds } = await this.client.pairingTicket();
    const secret = randomSecret();
    const link = pairingLink(this.config.base, { ticket, secret, desktopId: this.config.deviceId, desktopFingerprint: await fingerprint(this.identity.signKey, this.identity.boxKey) });
    this.pair = { ticket, secret, link, image: await QRCode.toDataURL(link, { margin: 2, width: 320 }), expiresAt: Date.now() + expiresInSeconds * 1000 };
    await this.refresh(); this.changed(); return this.status();
  }); }
  approve(id, confirmation) { return this.mutate(async () => {
    await this.refresh();
    const device = this.pending.find(p => p.id === id);
    if (!this.config?.enabled || !device || !(this.pair?.expiresAt > Date.now())) throw Error('This pairing request is invalid or expired. Show a new code.');
    if (confirmation !== device.fingerprint) throw Error('Compare the confirmation code on both screens before approving.');
    const pin = { id: device.id, name: device.name, signKey: device.signKey, boxKey: device.boxKey };
    const prior=this.config.peers;
    this.config.peers = [...prior.filter(p => p.id !== id), pin];
    try { await this.save(); } catch(error) { this.config.peers=prior;throw error; }
    try { await this.client.approve(id); } catch (error) { this.config.peers = this.config.peers.filter(p => p.id !== id); await this.save(); throw error; }
    this.pair = null; this.pending = []; await this.refresh(); return this.status();
  }); }
  remove(id) { return this.mutate(async () => {
    const phone=this.config?.peers.find(p=>p.id===id)||this.pending.find(p=>p.id===id)||this.config?.revoking?.find(p=>p.id===id);
    if (!phone) throw Error('Unknown phone.');
    this.config.revoking=[...(this.config.revoking||[]).filter(p=>p.id!==id),{id,name:phone.name}];
    this.config.peers = this.config.peers.filter(p => p.id !== id); this.livePeers = this.livePeers.filter(p => p.id !== id); this.pending = this.pending.filter(p => p.id !== id);
    this.bridge?.forget(id); await this.save(); this.changed();
    await this.refresh();if(this.config.revoking.some(p=>p.id===id))throw Error('Phone blocked locally. Server revocation is pending; use Refresh phones to retry.');return this.status();
  }); }
  disconnect() { return this.mutate(async () => {
    if (this.config?.peers.length||this.config?.revoking?.length) throw Error('Remove your paired phones before disconnecting the relay.');
    if(this.config){this.config.enabled=false;await this.save();}this.stop(); const client = this.client, id = this.config?.deviceId;
    if (client && id) await client.revoke(id);
    this.config = null; this.identity = null; this.client = null; await this.save(); this.error = ''; this.changed(); return this.status();
  }); }
  event(value) { if(value?.conversationId&&this.isPrivate(value.conversationId))return;this.bridge?.event(value); }
  close() { this.closed = true; this.stop(); }
}
