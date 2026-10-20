import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { CloudAuth } from '../cloud/auth.mjs';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keyPair.publicKey.export({ format: 'jwk' }), kid: 'synthetic-google-key', alg: 'RS256', use: 'sig' };
const defaults = { publicUrl: 'https://private.example.test', ownerEmail: 'owner@example.test', clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret' };
const now = () => Math.floor(Date.now() / 1000);
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(claims, header = {}, privateKey = keyPair.privateKey) {
  const message = `${encode({ alg: 'RS256', kid: jwk.kid, ...header })}.${encode(claims)}`;
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url')}`;
}
function response() {
  const headers = new Map();
  return { statusCode: 200, headers, setHeader: (name, value) => headers.set(name.toLowerCase(), value), getHeader: name => headers.get(name.toLowerCase()), end() { this.ended = true; } };
}
function request(url = '/', cookie = '', extras = {}) {
  return { method: 'GET', url, headers: { ...(cookie ? { cookie } : {}), ...extras } };
}
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'exomina-cloud-auth-'));
  const calls = [], state = { claims: {}, header: {}, tokenError: false };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'public, max-age=300' } });
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(init.method, 'POST');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('client_secret'), defaults.clientSecret);
    assert.equal(body.get('redirect_uri'), `${defaults.publicUrl}/auth/callback`);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), state.challenge);
    if (state.tokenError) return new Response('secret-provider-error synthetic-client-secret', { status: 400 });
    const claims = { iss: 'https://accounts.google.com', aud: defaults.clientId, sub: 'owner-subject', email: defaults.ownerEmail, email_verified: true, iat: now(), exp: now() + 3600, nonce: state.nonce, name: 'Private owner', ...state.claims };
    return new Response(JSON.stringify({ id_token: jwt(claims, state.header), access_token: 'MUST-NOT-PERSIST-ACCESS-TOKEN', refresh_token: 'MUST-NOT-PERSIST-REFRESH-TOKEN' }));
  };
  const auth = new CloudAuth({ ...defaults, dataDir, fetchImpl, ...options });
  await auth.init();
  t.after(async () => { auth.close(); await rm(dataDir, { recursive: true, force: true }); });
  function begin(cookie = '') {
    const res = response();
    auth.beginLogin(request('/auth/login', cookie), res);
    const url = new URL(res.getHeader('Location'));
    state.nonce = url.searchParams.get('nonce'); state.challenge = url.searchParams.get('code_challenge');
    return { res, url, cookie: res.getHeader('Set-Cookie')[0].split(';')[0], state: url.searchParams.get('state') };
  }
  async function login() {
    const started = begin(); const res = response();
    await auth.finishLogin(request(`/auth/callback?state=${started.state}&code=synthetic-code`, started.cookie), res);
    const cookie = res.getHeader('Set-Cookie').find(value => value.startsWith('__Host-exomina=')).split(';')[0];
    return { ...started, finished: res, sessionCookie: cookie };
  }
  return { auth, dataDir, calls, state, begin, login };
}

test('owner Google login enforces PKCE, durable hashed session and secure cookies end to end', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.auth.getStatus(request()), { configured: true, authenticated: false, loginUrl: '/auth/login' });
  const started = f.begin();
  assert.equal(started.res.statusCode, 302);
  assert.equal(started.url.origin, 'https://accounts.google.com');
  assert.equal(started.url.pathname, '/o/oauth2/v2/auth');
  assert.equal(started.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(started.url.searchParams.get('scope'), 'openid email profile');
  assert.ok(!started.url.href.includes(defaults.clientSecret));
  assert.match(started.res.getHeader('Set-Cookie')[0], /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  const finished = response();
  await f.auth.finishLogin(request(`/auth/callback?state=${started.state}&code=synthetic-code`, started.cookie), finished);
  assert.equal(finished.statusCode, 303); assert.equal(finished.getHeader('Location'), '/');
  assert.equal(finished.getHeader('Cache-Control'), 'no-store');
  const sessionCookie = finished.getHeader('Set-Cookie').find(value => value.startsWith('__Host-exomina='));
  assert.match(sessionCookie, /Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure/);
  assert.ok(!sessionCookie.includes('Domain='));
  const req = request('/', sessionCookie.split(';')[0]);
  const status = f.auth.getStatus(req);
  assert.equal(status.authenticated, true); assert.equal(status.displayName, 'Private owner'); assert.equal(status.csrf.length, 43);
  const row = f.auth.db.prepare('SELECT * FROM sessions').get();
  assert.equal(row.token_hash.length, 64);
  const dump = JSON.stringify({ session: row, pending: f.auth.db.prepare('SELECT * FROM login_states').all() });
  assert.ok(!dump.includes(sessionCookie.split(';')[0].split('=')[1]));
  assert.ok(!dump.includes('MUST-NOT-PERSIST')); assert.equal(f.auth.db.prepare('SELECT COUNT(*) AS count FROM login_states').get().count, 0);
  f.auth.close();
  const reopened = new CloudAuth({ ...defaults, dataDir: f.dataDir }); await reopened.init();
  assert.equal(reopened.requireOwner(req).subject, 'owner-subject'); reopened.close();
  assert.equal(f.calls.length, 2);
});

test('callback state must match browser cookie, be fresh, and can execute only once', async t => {
  const f = await fixture(t), s = f.begin();
  await assert.rejects(f.auth.finishLogin(request(`/auth/callback?state=${s.state}&code=code`), response()), error => error.status === 400);
  await assert.rejects(f.auth.finishLogin(request(`/auth/callback?state=wrong&code=code`, s.cookie), response()), error => error.status === 400);
  await assert.rejects(f.auth.finishLogin(request(`/auth/callback?state=${s.state}&state=${s.state}&code=code`, s.cookie), response()), error => error.status === 400);
  assert.equal(f.calls.length, 0);
  const res = response(); await f.auth.finishLogin(request(`/auth/callback?state=${s.state}&code=code`, s.cookie), res);
  await assert.rejects(f.auth.finishLogin(request(`/auth/callback?state=${s.state}&code=code`, s.cookie), response()), /already used/);
  assert.equal(f.calls.length, 2);
  const expired = f.begin(); f.auth.db.prepare('UPDATE login_states SET expires_at = ?').run(now() - 1);
  await assert.rejects(f.auth.finishLogin(request(`/auth/callback?state=${expired.state}&code=code`, expired.cookie), response()), /expired/);
  assert.equal(f.calls.length, 2);
});

test('owner allowlist, verified email, issuer, audience, expiry and nonce fail closed', async t => {
  const f = await fixture(t);
  const failures = [
    { email: 'other@example.test' }, { email_verified: false }, { email_verified: 'true' },
    { iss: 'https://attacker.example' }, { aud: 'other-client' },
    { aud: [defaults.clientId, 'other-client'] }, { azp: 'other-client' },
    { exp: now() - 1 }, { iat: now() + 3600 }, { nbf: now() + 3600 },
    { nonce: 'wrong' }, { sub: '' },
  ];
  for (const claims of failures) {
    f.state.claims = claims;
    await assert.rejects(f.login(), error => [401, 403].includes(error.status));
    assert.equal(f.auth.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  }
  assert.equal(f.calls.filter(call => call.url.includes('/certs')).length, 1, 'Google JWKS is cached');
  f.state.claims = { email: 'OWNER@EXAMPLE.TEST', aud: [defaults.clientId, 'another-audience'], azp: defaults.clientId };
  assert.equal(f.auth.getStatus(request('/', (await f.login()).sessionCookie)).authenticated, true);
});

test('valid signature is required and token-provided key locations are never fetched', async t => {
  const f = await fixture(t), s = f.begin();
  const claims = { iss: 'accounts.google.com', aud: defaults.clientId, sub: 'subject', email: defaults.ownerEmail, email_verified: true, iat: now(), exp: now() + 3600, nonce: f.state.nonce };
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(f.auth.verifyIdentity(jwt(claims, { jku: 'https://attacker.example/jwks' }, other.privateKey), f.state.nonce), error => error.status === 401);
  await assert.rejects(f.auth.verifyIdentity(jwt(claims, { alg: 'HS256' }), f.state.nonce), error => error.status === 401);
  await assert.rejects(f.auth.verifyIdentity(jwt(claims, { kid: 'unknown-key' }), f.state.nonce), error => error.status === 401);
  assert.deepEqual(f.calls.map(call => call.url), ['https://www.googleapis.com/oauth2/v3/certs']);
  assert.equal(f.auth.getStatus(request('/', s.cookie)).authenticated, false);
});

test('mutations require exact origin and CSRF; duplicate cookies fail; logout revokes session', async t => {
  const f = await fixture(t), signed = await f.login();
  const status = f.auth.getStatus(request('/', signed.sessionCookie));
  for (const headers of [{}, { origin: defaults.publicUrl }, { origin: 'https://evil.example', 'x-csrf-token': status.csrf }, { origin: defaults.publicUrl, 'x-csrf-token': 'wrong' }]) {
    assert.throws(() => f.auth.requireOwner(request('/', signed.sessionCookie, headers), { mutation: true }), error => error.status === 403);
  }
  assert.throws(() => f.auth.requireOwner(request('/', `${signed.sessionCookie}; ${signed.sessionCookie}`)), error => error.status === 401);
  const req = request('/auth/logout', signed.sessionCookie, { origin: defaults.publicUrl, 'x-csrf-token': status.csrf }); req.method = 'POST';
  assert.equal(f.auth.requireOwner(req, { mutation: true }).email, defaults.ownerEmail);
  const res = response(); f.auth.logout(req, res);
  assert.equal(res.statusCode, 204); assert.match(res.getHeader('Set-Cookie')[0], /Max-Age=0; Secure/);
  assert.equal(f.auth.getStatus(request('/', signed.sessionCookie)).authenticated, false);
});

test('sessions expire, config changes invalidate them and first owner Google subject stays pinned', async t => {
  const f = await fixture(t), signed = await f.login();
  f.auth.db.prepare('UPDATE sessions SET expires_at = ?').run(now() - 1);
  assert.throws(() => f.auth.requireOwner(request('/', signed.sessionCookie)), error => error.status === 401);
  f.state.claims = { sub: 'different-google-subject' };
  await assert.rejects(f.login(), error => error.status === 403);
  f.state.claims = {};
  const next = await f.login();
  f.auth.close();
  const changed = new CloudAuth({ ...defaults, dataDir: f.dataDir, clientId: 'changed-client' }); await changed.init();
  assert.equal(changed.getStatus(request('/', next.sessionCookie)).authenticated, false); changed.close();
});

test('missing configuration and insecure production URL fail closed with actionable safe status', async t => {
  for (const options of [{ clientSecret: '' }, { ownerEmail: '' }, { publicUrl: 'http://private.example.test' }, { publicUrl: 'http://localhost:4321' }, { publicUrl: 'https://name:secret@example.test' }, { publicUrl: 'https://private.example.test/path' }, { publicUrl: 'http://private.example.test', allowLocalHttp: true }]) {
    const f = await fixture(t, options);
    const status = f.auth.getStatus(request());
    assert.equal(status.configured, false); assert.equal(status.authenticated, false); assert.match(status.message, /Configure/);
    assert.ok(!JSON.stringify(status).includes(defaults.clientSecret));
    assert.throws(() => f.begin(), error => error.status === 503);
    assert.equal(f.calls.length, 0);
  }
  const local = await fixture(t, { publicUrl: 'http://127.0.0.1:4321', allowLocalHttp: true });
  const started = local.begin();
  assert.equal(local.auth.configured, true); assert.match(started.cookie, /^exomina-local-login=/);
  assert.ok(!started.res.getHeader('Set-Cookie')[0].includes('; Secure'));
});

test('provider rejection, oversized replies and network errors never disclose tokens or client secret', async t => {
  const f = await fixture(t); f.state.tokenError = true;
  await assert.rejects(f.login(), error => error.status === 502 && !error.message.includes('secret'));
  assert.equal(f.auth.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  for (const fetchImpl of [async () => { throw Error(defaults.clientSecret); }, async () => new Response('x'.repeat(300 * 1024))]) {
    const custom = await fixture(t, { fetchImpl });
    await assert.rejects(custom.auth.json('https://www.googleapis.com/oauth2/v3/certs'), error => error.status === 502 && !error.message.includes(defaults.clientSecret));
  }
});

test('closing the auth service aborts in-flight Google requests', async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    entered(); init.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }) });
  const pending = f.auth.json('https://www.googleapis.com/oauth2/v3/certs');
  await ready; f.auth.close();
  await assert.rejects(pending, error => error.status === 502);
  assert.equal(f.auth.requests.size, 0);
});
