import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual, createPublicKey, verify } from 'node:crypto';

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const LOGIN_SECONDS = 10 * 60;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const timestamp = () => Math.floor(Date.now() / 1000);
const failure = (status, message) => Object.assign(new Error(message), { status, statusCode: status });
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const boundedString = (value, maximum = 4096) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const email = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

function cookieValue(req, name) {
  const raw = req.headers?.cookie;
  if (typeof raw !== 'string' || raw.length > 16384) return null;
  const matches = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function setCookie(res, value) {
  const previous = res.getHeader?.('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), value]);
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

export class CloudAuth {
  constructor({ dataDir, publicUrl, ownerEmail, clientId, clientSecret, fetchImpl = globalThis.fetch, allowLocalHttp = false }) {
    this.dataDir = dataDir;
    this.ownerEmail = email(ownerEmail);
    this.clientId = typeof clientId === 'string' ? clientId.trim() : '';
    this.clientSecret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
    this.fetchImpl = fetchImpl;
    this.publicUrl = null;
    try {
      const url = new URL(publicUrl);
      const localHttp = allowLocalHttp === true && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol === 'https:' || localHttp) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') this.publicUrl = url.origin;
    } catch {}
    this.secure = this.publicUrl?.startsWith('https:') === true;
    this.cookieName = this.secure ? '__Host-exomina' : 'exomina-local';
    this.loginCookieName = this.secure ? '__Host-exomina-login' : 'exomina-local-login';
    this.configured = Boolean(this.publicUrl && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.ownerEmail) && boundedString(this.clientId) && boundedString(this.clientSecret));
    this.scope = hash(JSON.stringify([this.publicUrl, this.ownerEmail, this.clientId]));
    this.jwks = new Map();
    this.jwksExpires = 0;
    this.jwksFetched = 0;
    this.requests = new Set();
    this.closed = false;
  }

  async init() {
    if (this.db) return;
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dataDir, 'cloud-auth.sqlite');
    this.db = new DatabaseSync(file);
    try {
      await chmod(file, 0o600);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS login_states (
          state_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, nonce TEXT NOT NULL,
          verifier TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, subject TEXT NOT NULL,
          email TEXT NOT NULL, display_name TEXT NOT NULL, csrf TEXT NOT NULL,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS owner_bindings (email TEXT PRIMARY KEY, subject TEXT NOT NULL);
      `);
      this.cleanup();
    } catch (error) { this.db.close(); this.db = null; throw error; }
  }

  ensureOpen() {
    if (!this.db || this.closed) throw failure(503, 'Private sign-in is unavailable. Restart the service.');
  }

  ensureConfigured() {
    this.ensureOpen();
    if (!this.configured) throw failure(503, 'Private sign-in needs the server HTTPS URL, owner email and Google OAuth client configured.');
  }

  cleanup() {
    this.db.prepare('DELETE FROM login_states WHERE expires_at <= ? OR scope != ?').run(timestamp(), this.scope);
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR scope != ?').run(timestamp(), this.scope);
  }

  cookie(name, value, seconds) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.secure ? '; Secure' : ''}`;
  }

  readSession(req) {
    if (!this.configured || !this.db || this.closed) return null;
    const value = cookieValue(req, this.cookieName);
    if (!value) return null;
    const id = hash(value);
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND scope = ? AND expires_at > ?').get(id, this.scope, timestamp());
    if (!row || row.email !== this.ownerEmail) return null;
    const binding = this.db.prepare('SELECT subject FROM owner_bindings WHERE email = ?').get(this.ownerEmail);
    if (!binding || binding.subject !== row.subject) return null;
    return { id, subject: row.subject, email: row.email, displayName: row.display_name, csrf: row.csrf, expiresAt: row.expires_at };
  }

  getStatus(req) {
    const session = this.readSession(req);
    return {
      configured: this.configured && !this.closed,
      authenticated: Boolean(session),
      loginUrl: '/auth/login',
      ...(session ? { displayName: session.displayName, csrf: session.csrf } : {}),
      ...(!this.configured ? { message: 'Configure the private server URL, owner email and Google OAuth client before signing in.' } : {}),
    };
  }

  requireOwner(req, { mutation = false } = {}) {
    this.ensureConfigured();
    const session = this.readSession(req);
    if (!session) throw failure(401, 'Sign in with the approved owner account.');
    if (mutation && (req.headers?.origin !== this.publicUrl || !same(req.headers?.['x-csrf-token'], session.csrf))) throw failure(403, 'This request could not be verified. Refresh the app and try again.');
    return session;
  }

  beginLogin(req, res) {
    this.ensureConfigured();
    if (req.method !== 'GET') throw failure(405, 'Use the sign-in link to continue.');
    this.cleanup();
    if (this.db.prepare('SELECT COUNT(*) AS count FROM login_states').get().count >= 200) throw failure(429, 'Too many sign-in attempts. Try again shortly.');
    const previous = cookieValue(req, this.loginCookieName);
    if (previous) this.db.prepare('DELETE FROM login_states WHERE state_hash = ?').run(hash(previous));
    const state = token(), nonce = token(), verifier = token(48);
    this.db.prepare('INSERT INTO login_states VALUES (?, ?, ?, ?, ?)').run(hash(state), this.scope, nonce, verifier, timestamp() + LOGIN_SECONDS);
    const url = new URL(GOOGLE_AUTHORIZE);
    url.search = new URLSearchParams({
      client_id: this.clientId, redirect_uri: `${this.publicUrl}/auth/callback`,
      response_type: 'code', scope: 'openid email profile', state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', prompt: 'select_account',
    }).toString();
    noStore(res);
    setCookie(res, this.cookie(this.loginCookieName, state, LOGIN_SECONDS));
    res.statusCode = 302;
    res.setHeader('Location', url.href);
    res.end();
  }

  async json(url, options = {}, maximum = 256 * 1024) {
    if (this.closed) throw failure(503, 'Private sign-in is unavailable. Restart the service.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    this.requests.add(controller);
    try {
      const response = await this.fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error();
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maximum) throw new Error();
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return { value, headers: response.headers };
    } catch { throw failure(502, 'Google sign-in could not be verified. Start sign-in again.'); }
    finally { clearTimeout(timeout); this.requests.delete(controller); }
  }

  async signingKey(kid) {
    const now = timestamp();
    if (this.jwksExpires > now && this.jwks.has(kid)) return this.jwks.get(kid);
    // Limit unknown-key refreshes while still allowing normal Google key rotation.
    if (this.jwksExpires > now && now - this.jwksFetched < 60 && !this.jwks.has(kid)) throw failure(401, 'Google sign-in could not be verified. Start sign-in again.');
    if (!this.jwksRequest) this.jwksRequest = (async () => {
      const { value, headers } = await this.json(GOOGLE_JWKS);
      if (!Array.isArray(value.keys) || value.keys.length > 20) throw failure(502, 'Google signing keys are unavailable. Try again shortly.');
      const keys = new Map();
      try {
        for (const jwk of value.keys) {
          if (jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig') || (jwk.key_ops && !jwk.key_ops.includes('verify')) || jwk.d || !boundedString(jwk.kid, 200) || keys.has(jwk.kid)) continue;
          const key = createPublicKey({ key: jwk, format: 'jwk' });
          if (key.asymmetricKeyDetails?.modulusLength < 2048) continue;
          keys.set(jwk.kid, key);
        }
      } catch { throw failure(502, 'Google signing keys are unavailable. Try again shortly.'); }
      if (!keys.size) throw failure(502, 'Google signing keys are unavailable. Try again shortly.');
      const age = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(headers.get('cache-control') || '')?.[1] || 300);
      this.jwks = keys;
      this.jwksFetched = timestamp();
      this.jwksExpires = this.jwksFetched + Math.max(60, Math.min(3600, age));
    })().finally(() => { this.jwksRequest = null; });
    await this.jwksRequest;
    const key = this.jwks.get(kid);
    if (!key) throw failure(401, 'Google sign-in could not be verified. Start sign-in again.');
    return key;
  }

  async verifyIdentity(raw, nonce) {
    const denied = () => failure(401, 'Google sign-in could not be verified. Start sign-in again.');
    if (!boundedString(raw, 16000)) throw denied();
    const parts = raw.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw denied();
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); }
    catch { throw denied(); }
    if (!header || header.alg !== 'RS256' || !boundedString(header.kid, 200) || header.crit !== undefined || !claims || typeof claims !== 'object' || Array.isArray(claims)) throw denied();
    const key = await this.signingKey(header.kid);
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw denied();
    const now = timestamp();
    const audience = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || !Array.isArray(audience) || !audience.includes(this.clientId) || (audience.length > 1 && claims.azp !== this.clientId) || (claims.azp !== undefined && claims.azp !== this.clientId)) throw denied();
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= now || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 || claims.iat >= claims.exp || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 60)) || !same(claims.nonce, nonce) || !boundedString(claims.sub, 255)) throw denied();
    if (claims.email_verified !== true || email(claims.email) !== this.ownerEmail) throw failure(403, 'This app is private. Sign in with its approved owner account.');
    return { subject: claims.sub, email: this.ownerEmail, displayName: boundedString(claims.name, 120) ? claims.name : this.ownerEmail };
  }

  async finishLogin(req, res) {
    this.ensureConfigured();
    if (req.method !== 'GET' || typeof req.url !== 'string' || req.url.length > 20000) throw failure(400, 'Invalid sign-in response. Start sign-in again.');
    const url = new URL(req.url, this.publicUrl);
    const state = url.searchParams.get('state');
    const bound = cookieValue(req, this.loginCookieName);
    if (url.origin !== this.publicUrl || url.pathname !== '/auth/callback' || url.searchParams.getAll('state').length !== 1 || !bound || !same(state, bound)) throw failure(400, 'Sign-in state did not match. Start sign-in again.');
    const stateHash = hash(state);
    const pending = this.db.prepare('SELECT * FROM login_states WHERE state_hash = ? AND scope = ?').get(stateHash, this.scope);
    if (!pending || pending.expires_at <= timestamp()) throw failure(400, 'Sign-in expired or was already used. Start sign-in again.');
    // Consume before the first network await: callbacks cannot be replayed in parallel.
    this.db.prepare('DELETE FROM login_states WHERE state_hash = ?').run(stateHash);
    noStore(res);
    setCookie(res, this.cookie(this.loginCookieName, '', 0));
    if (url.searchParams.has('error')) throw failure(401, 'Google sign-in was not completed. Start sign-in again.');
    const code = url.searchParams.get('code');
    if (url.searchParams.getAll('code').length !== 1 || !boundedString(code, 8192)) throw failure(400, 'Invalid sign-in response. Start sign-in again.');
    const { value } = await this.json(GOOGLE_TOKEN, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: `${this.publicUrl}/auth/callback`, grant_type: 'authorization_code', code_verifier: pending.verifier }).toString(),
    }, 64 * 1024);
    const identity = await this.verifyIdentity(value.id_token, pending.nonce);
    this.ensureOpen();
    const raw = token(), csrf = token(), now = timestamp();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const binding = this.db.prepare('SELECT subject FROM owner_bindings WHERE email = ?').get(this.ownerEmail);
      if (binding && binding.subject !== identity.subject) throw failure(403, 'The Google account does not match this app’s established owner.');
      if (!binding) this.db.prepare('INSERT INTO owner_bindings VALUES (?, ?)').run(this.ownerEmail, identity.subject);
      const old = cookieValue(req, this.cookieName);
      if (old) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(old));
      this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(hash(raw), this.scope, identity.subject, identity.email, identity.displayName, csrf, now, now + SESSION_SECONDS);
      this.db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 32)').run();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    setCookie(res, this.cookie(this.cookieName, raw, SESSION_SECONDS));
    res.statusCode = 303;
    res.setHeader('Location', '/');
    res.end();
  }

  logout(req, res) {
    if (req.method !== 'POST') throw failure(405, 'Use the sign-out button to continue.');
    const session = this.requireOwner(req, { mutation: true });
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.id);
    noStore(res);
    setCookie(res, this.cookie(this.cookieName, '', 0));
    res.statusCode = 204;
    res.end();
  }

  close() {
    this.closed = true;
    for (const controller of this.requests) controller.abort();
    if (this.db) { this.db.close(); this.db = null; }
    this.jwks.clear();
  }
}
