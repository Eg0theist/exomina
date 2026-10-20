import { generateIdentity, parsePairingLink, pairingProof, pairingConfirmation, fingerprint, openChannel, randomId } from '../desktop/remote-crypto.mjs';
import { RelayClient } from '../desktop/relay-client.mjs';

export class PhoneStorage {
  async database() {
    if (!this.db) this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('exomina-phone-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('private');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('Private phone storage is unavailable. Use a regular browser tab.'));
    });
    return this.db;
  }
  async get(key) { const db = await this.database(); return new Promise((resolve, reject) => { const request = db.transaction('private').objectStore('private').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  async set(key, value) { const db = await this.database(); return new Promise((resolve, reject) => { const tx = db.transaction('private', 'readwrite'); tx.objectStore('private').put(value, key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('Phone storage could not be saved.')); }); }
}

export class PhoneRemote {
  constructor({ base = globalThis.location?.origin, storage = new PhoneStorage(), fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
    const url = new URL(base);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw Error('Phone access requires HTTPS.');
    this.base = url.origin; this.storage = storage; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
    this.listeners = new Set(); this.requests = new Map(); this.seen = {}; this.running = false;
  }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  clientFor(record) { return new RelayClient({ base: this.base, accountId: record.accountId, deviceId: record.deviceId, signPrivateKey: record.identity.sign.privateKey, fetchImpl: this.fetchImpl }); }
  async init() {
    this.record = await this.storage.get('connection'); this.seen = await this.storage.get('seen') || {};
    if (this.record && this.record.base !== this.base) throw Error('The saved phone connection belongs to another relay.');
    if (this.record) this.client = this.clientFor(this.record);
    return this.record;
  }
  async pair(link, name) {
    if (this.record) throw Error('Forget this phone’s existing connection before pairing again.');
    const qr = parsePairingLink(link);
    if (qr.base !== this.base) throw Error('Open the pairing link on its own relay website.');
    const identity = await generateIdentity();
    const fields = { ticket: qr.ticket, desktopId: qr.desktopId, name: String(name || 'My phone').slice(0, 60), signKey: identity.signKey, boxKey: identity.boxKey };
    const proof = await pairingProof(qr.secret, fields);
    const registered = await new RelayClient({ base: this.base, fetchImpl: this.fetchImpl }).claimPairing({ ...fields, proof });
    const confirmation = await pairingConfirmation(qr.ticket, qr.desktopFingerprint, identity.signKey, identity.boxKey);
    this.record = { base: this.base, accountId: registered.accountId, deviceId: registered.deviceId, desktopId: qr.desktopId, desktopFingerprint: qr.desktopFingerprint, identity, confirmation, name: fields.name, pending: true, expiresAt: Date.now() + 10 * 60_000 };
    await this.storage.set('connection', this.record); this.client = this.clientFor(this.record);
    return this.record;
  }
  async activate() {
    try { return await this.activateVerified(); }
    catch (error) { if (error.status === 401&&error.code!=='clock_skew') await this.forget(); throw error; }
  }
  async activateVerified() {
    if (!this.record) return false;
    if (this.record.pending) {
      if (Date.now() > this.record.expiresAt) { await this.forget(); throw Error('Pairing expired. Show a new code on your computer.'); }
      const approval = await this.client.claimApproval();
      if (!approval.ready) {
        // Recover if the server activated us but its one-time approval response was lost.
        try { const devices = await this.client.devices(); if (!devices.some(d => d.id === this.record.deviceId && d.state === 'active')) return false; }
        catch (error) { if (error.status === 403) return false; throw error; }
      } else if (approval.fromDevice !== this.record.desktopId) { await this.forget(); throw Error('The pairing computer did not match. Pair again.'); }
    }
    const devices = await this.client.devices();
    const own = devices.find(d => d.id === this.record.deviceId && d.state === 'active');
    const desktop = devices.find(d => d.id === this.record.desktopId && d.state === 'active');
    if (!own || !desktop || await fingerprint(desktop.signKey, desktop.boxKey) !== this.record.desktopFingerprint) { await this.forget(); throw Error('The computer’s identity changed or this phone was removed. Pair again.'); }
    if (this.record.peer && (desktop.signKey !== this.record.peer.signKey || desktop.boxKey !== this.record.peer.boxKey)) { await this.forget(); throw Error('The computer’s keys changed. Pair again.'); }
    this.record = { ...this.record, peer: { signKey: desktop.signKey, boxKey: desktop.boxKey, name: desktop.name }, pending: false };
    delete this.record.expiresAt; delete this.record.confirmation;
    await this.storage.set('connection', this.record);
    this.channel = await openChannel({ own: this.record.identity, ownId: this.record.deviceId, peerId: this.record.desktopId, peerBoxKey: desktop.boxKey });
    this.start(); return true;
  }
  async send(body) { if (!this.record || !this.channel) throw Error('Pair this phone first.'); await this.client.send(this.record.desktopId, await this.channel.seal(body)); }
  async invoke(method, payload = {}) {
    if (!this.running) throw Error('Your computer is not connected.');
    const rid = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(rid); reject(Error('No reply was confirmed. Check your computer and task history before retrying an action.')); }, this.timeoutMs);
      this.requests.set(rid, { resolve, reject, timer });
      this.send({ kind: 'invoke', rid, method, payload }).catch(error => { clearTimeout(timer); this.requests.delete(rid); reject(error); });
    });
  }
  start() {
    if (this.running) return; this.running = true; this.abort = new AbortController();
    const signal = this.abort.signal;
    this.heartbeat = setInterval(() => this.send({ kind: 'attach' }).catch(() => {}), 30000);
    (async () => {
      let connected = false;
      while (this.running && !signal.aborted) {
        try {
          if (!connected) await this.send({ kind: 'attach' });
          const messages = await this.client.inbox(20, signal);
          if (!this.running || signal.aborted) break;
          if (!connected) { connected = true; this.emit({ type: 'transport.connected' }); this.emit({ type: 'state.changed' }); }
          for (const message of messages) {
            if (message.from !== this.record.desktopId) continue;
            let opened; try { opened = await this.channel.open(message.blob); } catch { continue; }
            const key = `${message.from}:${opened.id}`;
            if (this.seen[key]) continue;
            for (const [id, time] of Object.entries(this.seen)) if (Date.now() - time > 10 * 60_000) delete this.seen[id];
            this.seen[key] = Date.now(); await this.storage.set('seen', this.seen);
            if (!this.running || signal.aborted) break;
            const body = opened.body;
            if (body?.kind === 'result') {
              const request = this.requests.get(body.rid);
              if (request) { clearTimeout(request.timer); this.requests.delete(body.rid); if (body.ok) request.resolve(body.value); else request.reject(Object.assign(Error(body.error || 'The computer refused this action.'), { code: 'remote_refused' })); }
            } else if (body?.kind === 'events' && Array.isArray(body.events)) for (const event of body.events) this.emit(event);
          }
          await this.client.ack(messages.map(m => m.seq));
        } catch (error) {
          if (!this.running || signal.aborted) break;
          connected = false; this.emit({ type: 'transport.offline' });
          if (error.status === 401&&error.code!=='clock_skew' || error.code === 'device_pending') { await this.forget(); this.emit({ type: 'remote.revoked' }); break; }
          if(error.code==='clock_skew')this.emit({type:'transport.error',error:error.message});
          await new Promise(resolve => { const timer = setTimeout(resolve, 2000); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
        }
      }
    })().catch(error => this.emit({ type: 'transport.error', error: error.message }));
  }
  stop() {
    this.running = false; this.abort?.abort(); clearInterval(this.heartbeat);
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(Error('Phone access disconnected. Check the computer before retrying an action.')); }
    this.requests.clear();
  }
  async forget() { this.stop(); this.record = null; this.channel = null; this.client = null; this.seen = {}; await this.storage.set('connection', null); await this.storage.set('seen', {}); }
}
