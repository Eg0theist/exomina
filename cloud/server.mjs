import http from 'node:http';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';

const fail = (status, message) => Object.assign(new Error(message), { status, statusCode: status });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const within = (root, value) => { const relative = path.relative(root, value); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
function security(res, secure) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
function json(res, value, status = 200) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); }
function queryInt(url, name, fallback, min, max) {
  if (!url.searchParams.has(name)) return fallback;
  const text = url.searchParams.get(name);
  if (url.searchParams.getAll(name).length !== 1 || !/^\d+$/.test(text)) throw fail(400, `Invalid ${name}.`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw fail(400, `Invalid ${name}.`);
  return number;
}
function one(url, name, fallback = '') { if (url.searchParams.getAll(name).length > 1) throw fail(400, `Invalid ${name}.`); return url.searchParams.get(name) ?? fallback; }
function body(req, maximum = 2 * 1024 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) throw fail(415, 'Send an uncompressed JSON request.');
  if (Number(req.headers['content-length'] || 0) > maximum) { req.resume(); throw fail(413, 'The request exceeds its size limit.'); }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > maximum) { rejected = true; chunks.length = 0; reject(fail(413, 'The request exceeds its size limit.')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); resolve(value); }
      catch { reject(fail(400, 'The request must be a valid JSON object.')); }
    });
    req.on('error', () => reject(fail(400, 'The request could not be read.')));
    req.on('aborted', () => reject(fail(400, 'The request was interrupted.')));
  });
}

/** Call listen(port, '127.0.0.1') behind an HTTPS reverse proxy. Dependencies are initialized by the caller. */
export function createCloudServer({ service, auth, devices, distDir }) {
  const streams = new Set(), rates = new Map();
  function rate(req, bucket, maximum, windowMs) {
    const now = Date.now(), key = `${bucket}:${req.socket.remoteAddress || 'unknown'}`;
    let entry = rates.get(key);
    if (!entry || entry.reset <= now) {
      if (rates.size > 1000) for (const [storedKey, value] of rates) if (value.reset <= now) rates.delete(storedKey);
      if (rates.size > 1000) throw fail(429, 'Too many requests. Try again shortly.');
      entry = { count: 0, reset: now + windowMs }; rates.set(key, entry);
    }
    if (++entry.count > maximum) throw fail(429, 'Too many requests. Try again shortly.');
  }
  function checkOrigin(req) {
    if (req.headers.origin && req.headers.origin !== auth.publicUrl) throw fail(403, 'Cross-origin requests are not allowed.');
  }
  function principal(req, mutation = false, ownerOnly = false) {
    auth.ensureConfigured(); checkOrigin(req);
    if (req.headers.authorization !== undefined) {
      if (ownerOnly) throw fail(403, 'Manage paired devices from the signed-in owner account.');
      const match = /^Bearer (exd_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization);
      const device = match && devices.authenticate(match[1]);
      if (!device) throw fail(401, 'This device is not paired or has been revoked.');
      return { type: 'device', id: device.id };
    }
    const session = auth.requireOwner(req, { mutation });
    return { type: 'session', id: session.id };
  }
  function closeMatching(type, id) { for (const stream of [...streams]) if (stream.principal.type === type && stream.principal.id === id) stream.close(); }
  async function staticFile(req, res, pathname) {
    if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'Method not allowed.');
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!(relative === 'index.html' || ['manifest.webmanifest', 'shell-assets.json', 'sw.js', 'icon.png', 'icon.svg', 'favicon.ico', 'icons/icon.png', 'icons/icon.svg'].includes(relative) || /^assets\/[A-Za-z0-9_./-]+$/.test(relative))) throw fail(404, 'Not found.');
    if (!MIME[path.extname(relative)]) throw fail(404, 'Not found.');
    const root = await realpath(distDir), requested = path.resolve(root, relative);
    if (!within(root, requested)) throw fail(404, 'Not found.');
    let file;
    try { file = await realpath(requested); } catch { throw fail(404, 'Not found.'); }
    if (!within(root, file)) throw fail(404, 'Not found.');
    const info = await stat(file);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw fail(404, 'Not found.');
    res.setHeader('Content-Type', MIME[path.extname(relative)]); res.setHeader('Content-Length', info.size);
    if (req.method === 'HEAD') res.end(); else res.end(await readFile(file));
  }
  function subscribe(req, res, identity) {
    if (streams.size >= 16) throw fail(429, 'Too many event connections. Close another tab and try again.');
    let ended = false, timer, unsubscribe = () => {};
    const stream = { principal: identity, close: () => { if (ended) return; ended = true; clearInterval(timer); try { unsubscribe(); } finally { streams.delete(stream); res.end(); } } };
    const send = event => {
      if (ended) return;
      try {
        principal(req);
        let encoded = JSON.stringify(event);
        if (encoded.length > 1024 * 1024) encoded = JSON.stringify({ type: 'state.changed' });
        if (res.writableLength > 512 * 1024) { stream.close(); return; }
        const id = Number.isSafeInteger(event?.seq) && event.seq > 0 ? `id: ${event.seq}\n` : '';
        res.write(`${id}data: ${encoded}\n\n`);
      } catch { stream.close(); }
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    timer = setInterval(() => { try { principal(req); if (res.writableLength > 512 * 1024) stream.close(); else res.write(': heartbeat\n\n'); } catch { stream.close(); } }, 15000);
    timer.unref();
    streams.add(stream);
    try { const cleanup = service.subscribe(send); if (typeof cleanup === 'function') unsubscribe = cleanup; }
    catch { stream.close(); return; }
    req.once('close', stream.close); res.once('error', stream.close);
    // Clients fetch persisted state/cursors on reconnect; transient deltas are not falsely advertised as durable replay.
    send({ type: 'state.changed', reconnected: true });
  }
  const server = http.createServer(async (req, res) => {
    security(res, auth.secure);
    try {
      if (typeof req.url !== 'string' || req.url.length > 16000 || !req.url.startsWith('/') || req.url.startsWith('//')) throw fail(400, 'Invalid request path.');
      if (auth.publicUrl) {
        let host; try {
          if (typeof req.headers.host !== 'string' || /[\s\\/@?#]/.test(req.headers.host)) throw new Error();
          host = new URL(`${new URL(auth.publicUrl).protocol}//${req.headers.host}`).host;
        } catch { throw fail(400, 'Invalid request host.'); }
        if (host !== new URL(auth.publicUrl).host) throw fail(403, 'Unexpected request host.');
      }
      let pathname; try { pathname = decodeURIComponent(req.url.split('?')[0]); } catch { throw fail(400, 'Invalid request path.'); }
      if (/[\\\x00-\x1f\x7f]/.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) throw fail(400, 'Invalid request path.');
      const url = new URL(req.url, auth.publicUrl || 'http://localhost');
      if (pathname === '/api/auth/status' && req.method === 'GET') { rate(req, 'status', 120, 60000); checkOrigin(req); return json(res, auth.getStatus(req)); }
      if (pathname === '/auth/login') { rate(req, 'login', 20, 600000); return auth.beginLogin(req, res); }
      if (pathname === '/auth/callback') { rate(req, 'callback', 30, 600000); return await auth.finishLogin(req, res); }
      if (['/api/auth/logout', '/auth/logout'].includes(pathname)) {
        const identity = principal(req, true, true); auth.logout(req, res); closeMatching('session', identity.id); return;
      }
      if (pathname === '/api/pair') {
        auth.ensureConfigured(); checkOrigin(req); rate(req, 'pair', 10, 60000);
        if (req.method !== 'POST') throw fail(405, 'Use POST to exchange a pairing code.');
        return json(res, devices.pair(await body(req, 4096)));
      }
      if (pathname.startsWith('/api/')) {
        const identity = principal(req, !['GET', 'HEAD'].includes(req.method));
        rate(req, pathname.startsWith('/api/sync/') ? 'sync' : 'api', pathname.startsWith('/api/sync/') ? 5000 : 600, 60000);
        if (pathname === '/api/events' && req.method === 'GET') return subscribe(req, res, identity);
        if (pathname === '/api/invoke' && req.method === 'POST') {
          const input = await body(req);
          if (typeof input.method !== 'string' || !/^[a-z][a-zA-Z0-9_.]{0,79}$/.test(input.method)) throw fail(400, 'Invalid operation.');
          const payload = input.payload ?? {};
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail(400, 'Operation payload must be an object.');
          if (input.method.startsWith('device.')) {
            principal(req, true, true);
            if (input.method === 'device.pairingCode') return json(res, devices.createPairingCode());
            if (input.method === 'device.list') return json(res, { devices: devices.list() });
            if (input.method === 'device.revoke') { const result = devices.revoke(payload.id); closeMatching('device', payload.id); return json(res, result); }
            throw fail(404, 'Unknown device operation.');
          }
          if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.requestId))) throw fail(400, 'Invalid request ID.');
          return json(res, await service.invoke(input.method, payload, { requestId: input.requestId }));
        }
        if (pathname === '/api/sync/changes' && req.method === 'GET') return json(res, service.syncStore.changes(queryInt(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER), queryInt(url, 'limit', 100, 1, 200)));
        if (pathname === '/api/sync/list' && req.method === 'GET') return json(res, service.syncStore.list(one(url, 'kind'), queryInt(url, 'limit', 100, 1, 200), one(url, 'afterId')));
        if (pathname === '/api/sync/get' && req.method === 'GET') {
          const entity = service.syncStore.get(one(url, 'kind'), one(url, 'id')); if (!entity) throw fail(404, 'This entity was not found.'); return json(res, entity);
        }
        if (pathname === '/api/sync/snapshot' && req.method === 'GET') return json(res, service.syncStore.snapshot(queryInt(url, 'limit', 100, 1, 200), one(url, 'cursor', null)));
        if (pathname === '/api/sync/apply' && req.method === 'POST') {
          const input = await body(req, 34 * 1024 * 1024);
          if (identity.type === 'device') { if (input.deviceId !== undefined && input.deviceId !== identity.id) throw fail(403, 'Use this paired device’s identity for synchronization.'); input.deviceId = identity.id; }
          await service.beforeSync?.(input);
          const result = service.syncStore.apply(input);
          await service.syncChanged?.(result.entity);
          return json(res, result);
        }
        throw fail(404, 'Unknown private API operation.');
      }
      return await staticFile(req, res, pathname);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = [error.status, error.statusCode, error.code].find(value => Number.isInteger(value) && value >= 400 && value <= 599) || 500;
      if (status === 429) res.setHeader('Retry-After', '60');
      json(res, { error: status >= 500 ? 'The private service could not complete this request.' : String(error.message).slice(0, 1000), code: status, ...(status === 409 && error.current ? { current: error.current } : {}) }, status);
    }
  });
  server.headersTimeout = 15000; server.requestTimeout = 60000; server.keepAliveTimeout = 5000;
  const originalClose = server.close.bind(server);
  server.close = callback => { for (const stream of [...streams]) stream.close(); return originalClose(callback); };
  return server;
}
