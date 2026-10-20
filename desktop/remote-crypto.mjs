// Phone ⇄ desktop protection for the mobile remote (MOBILE-DESIGN.md). WebCrypto only, so this
// exact file runs in the phone's browser and in Node 24 on the desktop. No dependencies.
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
export const REMOTE_VERSION = 1;
const LABEL = 'exomina-remote-v1';

export const toB64 = bytes => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
export const fromB64 = text => Uint8Array.from(atob(String(text || '')), c => c.charCodeAt(0));
const toB64url = bytes => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = text => fromB64(String(text || '').replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(text || '').length + 3) % 4));
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export const randomId = () => globalThis.crypto.randomUUID();
export const randomSecret = () => toB64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));

/** Device keys. Browsers keep private keys non-extractable (IndexedDB stores the CryptoKey);
 * the desktop needs extractable keys so it can persist them in its encrypted store. */
export async function generateIdentity({ extractable = false } = {}) {
  const sign = await subtle.generateKey({ name: 'Ed25519' }, extractable, ['sign', 'verify']);
  const box = await subtle.generateKey({ name: 'X25519' }, extractable, ['deriveBits']);
  return { sign, box, signKey: toB64(await subtle.exportKey('spki', sign.publicKey)), boxKey: toB64(await subtle.exportKey('spki', box.publicKey)) };
}
export async function exportIdentity(id) {
  return { signKey: id.signKey, boxKey: id.boxKey, signPriv: toB64(await subtle.exportKey('pkcs8', id.sign.privateKey)), boxPriv: toB64(await subtle.exportKey('pkcs8', id.box.privateKey)) };
}
export async function importIdentity(saved) {
  return {
    signKey: saved.signKey, boxKey: saved.boxKey,
    sign: { privateKey: await subtle.importKey('pkcs8', fromB64(saved.signPriv), { name: 'Ed25519' }, false, ['sign']) },
    box: { privateKey: await subtle.importKey('pkcs8', fromB64(saved.boxPriv), { name: 'X25519' }, false, ['deriveBits']) },
  };
}

/** Pins both public keys of a device; shown short to people, carried in full inside the QR. */
export async function fingerprint(signKey, boxKey) {
  return toB64url(await subtle.digest('SHA-256', enc.encode(JSON.stringify([LABEL, 'fp', signKey, boxKey]))));
}
export const shortFingerprint = fp => hex(fromB64url(fp).slice(0, 8)).toUpperCase().match(/.{4}/g).join(' ');
export async function pairingConfirmation(ticket, desktopFingerprint, signKey, boxKey) {
  const digest = await subtle.digest('SHA-256', enc.encode(JSON.stringify([LABEL, 'confirm', ticket, desktopFingerprint, signKey, boxKey])));
  return hex(new Uint8Array(digest).slice(0, 4)).toUpperCase().match(/.{4}/g).join(' ');
}

const proofKey = secret => subtle.importKey('raw', fromB64url(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const proofText = ({ ticket, desktopId, name, signKey, boxKey }) => enc.encode(JSON.stringify([LABEL, 'pair', ticket, desktopId, String(name || ''), signKey, boxKey]));
/** Phone side: proves to the desktop that these keys came from whoever scanned the QR. */
export async function pairingProof(secret, fields) { return toB64url(await subtle.sign('HMAC', await proofKey(secret), proofText(fields))); }
/** Desktop side, constant time via WebCrypto verify. */
export async function verifyPairingProof(secret, fields, proof) {
  try { return await subtle.verify('HMAC', await proofKey(secret), fromB64url(proof), proofText(fields)); } catch { return false; }
}

/** Pairing link shown as QR. Everything after # stays on the phone; servers never receive it. */
export function pairingLink(base, { ticket, secret, desktopId, desktopFingerprint }) {
  return `${String(base).replace(/\/$/, '')}/remote#${new URLSearchParams({ v: String(REMOTE_VERSION), t: ticket, s: secret, d: desktopId, f: desktopFingerprint })}`;
}
export function parsePairingLink(link) {
  const url = new URL(link), p = new URLSearchParams(url.hash.slice(1));
  const out = { base: url.origin, ticket: p.get('t'), secret: p.get('s'), desktopId: p.get('d'), desktopFingerprint: p.get('f') };
  if (p.get('v') !== String(REMOTE_VERSION) || Object.values(out).some(v => !v)) throw new Error('This pairing code is not valid.');
  return out;
}

/** Encrypted channel between two paired devices. Directional AES-256-GCM keys from static X25519
 * via HKDF; AAD binds sender, recipient, message ID and time. Callers drop seen IDs (persisted). */
export async function openChannel({ own, ownId, peerId, peerBoxKey, windowMs = 5 * 60_000, now = () => Date.now() }) {
  const peer = await subtle.importKey('spki', fromB64(peerBoxKey), { name: 'X25519' }, false, []);
  const shared = await subtle.deriveBits({ name: 'X25519', public: peer }, own.box.privateKey, 256);
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const salt = enc.encode([ownId, peerId].sort().join('|'));
  const key = (from, to, usage) => subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(`${LABEL}|${from}>${to}`) }, ikm, { name: 'AES-GCM', length: 256 }, false, [usage]);
  const sendKey = await key(ownId, peerId, 'encrypt'), recvKey = await key(peerId, ownId, 'decrypt');
  const aad = (from, to, id, ts) => enc.encode(JSON.stringify([LABEL, from, to, id, ts]));
  return {
    async seal(body) {
      const id = randomId(), ts = now(), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(ownId, peerId, id, ts) }, sendKey, enc.encode(JSON.stringify(body)));
      return JSON.stringify({ v: REMOTE_VERSION, id, ts, iv: toB64(iv), ct: toB64(ct) });
    },
    async open(text) {
      let env; try { env = JSON.parse(text); } catch { throw new Error('Unreadable message.'); }
      if (env?.v !== REMOTE_VERSION || typeof env.id !== 'string' || !/^[0-9a-f-]{36}$/.test(env.id) || !Number.isSafeInteger(env.ts)) throw new Error('Unreadable message.');
      if (Math.abs(now() - env.ts) > windowMs) throw new Error('Message outside the time window.');
      let plain;
      try { plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: aad(peerId, ownId, env.id, env.ts) }, recvKey, fromB64(env.ct)); }
      catch { throw new Error('Message failed authentication.'); }
      return { id: env.id, ts: env.ts, body: JSON.parse(dec.decode(plain)) };
    },
  };
}

/** Same canonical request text as AccountService.canonical on the server. */
export async function signRequest(signPrivateKey, { method, path, body = '', accountId, deviceId, ts, nonce }) {
  const bodyHash = hex(await subtle.digest('SHA-256', enc.encode(body)));
  const text = [String(method).toUpperCase(), path, bodyHash, accountId, deviceId, ts, nonce].join('\n');
  return toB64(await subtle.sign({ name: 'Ed25519' }, signPrivateKey, enc.encode(text)));
}
