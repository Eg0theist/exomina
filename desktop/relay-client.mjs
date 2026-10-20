import { signRequest, randomId } from './remote-crypto.mjs';

// Talks to the account server and relay (cloud/accounts-server.mjs). Shared by the desktop bridge
// and the phone transport; every call after registration is Ed25519-signed.
async function reply(response) {
  let body = {}; try { body = await response.json(); } catch {if(response.ok)throw Object.assign(Error('Invalid relay response'),{code:'protocol'});}
  if (!response.ok) throw Object.assign(new Error(body.message || `Request failed (${response.status}).`), { status: response.status, code: body.error });
  return body;
}

export class RelayClient {
  constructor({ base, accountId = '', deviceId = '', signPrivateKey = null, fetchImpl = globalThis.fetch.bind(globalThis) }) {
    Object.assign(this, { base: String(base).replace(/\/$/, ''), accountId, deviceId, signPrivateKey });
    this.fetch = (url, options = {}) => fetchImpl(url, { ...options, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000) });
  }
  async plain(path, body) {
    return reply(await this.fetch(this.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  }
  async signed(method, path, value, { signal } = {}) {
    const body = value === undefined ? '' : JSON.stringify(value), ts = String(Date.now()), nonce = randomId();
    const sig = await signRequest(this.signPrivateKey, { method, path, body, accountId: this.accountId, deviceId: this.deviceId, ts, nonce });
    const headers = { 'x-device': this.deviceId, 'x-ts': ts, 'x-nonce': nonce, 'x-sig': sig };
    if (body) headers['content-type'] = 'application/json';
    return reply(await this.fetch(this.base + path, { method, headers, body: body || undefined, signal }));
  }
  redeemInvite(code) { return this.plain('/v1/signin/invite', { code }); }
  async register(session, { name, signKey, boxKey }) {
    return reply(await this.fetch(this.base + '/v1/devices', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: JSON.stringify({ name, signKey, boxKey }) }));
  }
  claimPairing(fields) { return this.plain('/v1/pair/claim', fields); }
  devices() { return this.signed('GET', '/v1/devices').then(r => r.devices); }
  pairingTicket() { return this.signed('POST', '/v1/pair/ticket', {}); }
  approve(deviceId, blob = 'paired') { return this.signed('POST', '/v1/devices/approve', { deviceId, blob }); }
  claimApproval() { return this.signed('POST', '/v1/devices/claim', {}); }
  revoke(deviceId) { return this.signed('POST', '/v1/devices/revoke', { deviceId }); }
  send(to, blob) { return this.signed('POST', '/v1/relay/send', { to, blob }); }
  inbox(waitSeconds = 0, signal) { return this.signed('GET', `/v1/relay/inbox?wait=${waitSeconds}`, undefined, { signal }).then(r => r.messages); }
  ack(seqs) { return seqs.length ? this.signed('POST', '/v1/relay/ack', { seqs }) : Promise.resolve({ removed: 0 }); }
  resetInbox() { return this.signed('POST', '/v1/relay/reset', {}); }
}
