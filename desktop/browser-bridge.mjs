import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const extensionOrigin = value => /^chrome-extension:\/\/[a-p]{32}$/.test(value || '');
const matches = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const secret = () => randomBytes(32).toString('base64url');

/** A paired extension acts in its own browser profile. No cookies or passwords are transferred. */
export class BrowserBridge {
  constructor({ dir, encrypt, decrypt, emit = () => {}, port = 17493, timeout = 45000 }) {
    Object.assign(this, { encrypt, decrypt, emit, port, timeout });
    this.file = dir ? path.join(dir, 'browser-link.json') : null;
    this.pending = new Map(); this.queue = []; this.lastPoll = 0; this.poll = null; this.pages = new Map(); this.error = '';
  }
  async init() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(this.decrypt(Buffer.from(await readFile(this.file, 'utf8'), 'base64')));
      if (!extensionOrigin(saved.origin) || typeof saved.token !== 'string' || saved.token.length !== 43) throw Error('Invalid browser connection.');
      this.identity = saved; await this.start();
    } catch (error) { if (error.code !== 'ENOENT') this.error = 'The saved browser connection could not be opened. Connect your browser again.'; }
  }
  status() {
    return { paired: !!this.identity, connected: !!this.identity && Date.now() - this.lastPoll < 60000, browser: this.identity?.browser || 'Your browser', error: this.error };
  }
  async start() {
    if (this.server) return;
    const server = http.createServer((request, response) => this.handle(request, response).catch(() => { if (!response.writableEnded) { response.writeHead(400); response.end(); } }));
    server.headersTimeout = 10000; server.requestTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.port, '127.0.0.1', resolve); });
    server.on('error', () => { this.error = 'The browser connection stopped. Reconnect it in Tools.'; });
    this.server = server; this.port = server.address().port;
  }
  async prepare() {
    await this.start(); this.pairing = { code: secret(), expiresAt: Date.now() + 600000 };
    return { code: `${this.port}:${this.pairing.code}`, ...this.status() };
  }
  async body(request) {
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > 12 * 1024 * 1024) throw Error('Browser response is too large.'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  respond(response, value, status = 200) {
    if (response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(value === null ? '' : JSON.stringify(value));
  }
  async handle(request, response) {
    // Chromium may omit Origin on privileged extension GETs. Require the paired
    // extension ID header and bearer token in that case; websites still have an
    // ordinary Origin and cannot use this fallback to impersonate an extension.
    const origin = request.headers.origin || (typeof request.headers['x-exomina-extension'] === 'string' ? `chrome-extension://${request.headers['x-exomina-extension']}` : undefined);
    if (!extensionOrigin(origin) || request.headers.host !== `127.0.0.1:${this.port}`) { this.respond(response, null, 403); return; }
    const route = new URL(request.url, `http://127.0.0.1:${this.port}`).pathname;
    const pairing = route === '/pair' && this.pairing?.expiresAt > Date.now();
    if (!pairing && origin !== this.identity?.origin) { this.respond(response, null, 403); return; }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') { response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Exomina-Extension'); response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS'); this.respond(response, null, 204); return; }
    if (pairing && request.method === 'POST') {
      const input = await this.body(request);
      if (!matches(input.code, this.pairing.code)) { this.respond(response, null, 403); return; }
      const identity = { origin, token: secret(), browser: input.browser === 'Edge' ? 'Edge' : 'Chrome or Chromium' };
      // Persist only through the host's OS encryption; never return this token in app state or tool output.
      if (this.file) await writeFile(this.file, this.encrypt(JSON.stringify(identity)).toString('base64'), { mode: 0o600 });
      this.rejectPending('The browser connection was replaced.'); this.identity = identity; this.pairing = null; this.lastPoll = Date.now(); this.error = '';
      this.respond(response, { token: identity.token }); this.emit({ type: 'browser.connection', ...this.status() }); return;
    }
    if (!matches(request.headers.authorization, `Bearer ${this.identity?.token}`)) { this.respond(response, null, 403); return; }
    this.lastPoll = Date.now();
    if (route === '/commands' && request.method === 'GET') {
      if (this.poll) { clearTimeout(this.poll.timer); this.respond(this.poll.response, null, 204); }
      const next = this.queue.shift(); if (next) { this.respond(response, next); return; }
      const poll = { response, timer: setTimeout(() => { if (this.poll === poll) this.poll = null; this.respond(response, null, 204); }, 20000) };
      this.poll = poll; response.once('close', () => { clearTimeout(poll.timer); if (this.poll === poll) this.poll = null; }); return;
    }
    if (route === '/result' && request.method === 'POST') {
      const input = await this.body(request), job = this.pending.get(input.id);
      if (job) { this.pending.delete(input.id); clearTimeout(job.timer); job.cleanup?.();
        if (typeof input.error === 'string') job.reject(Error(input.error.slice(0, 500)));
        else { if (input.result?.state) this.savePage(job.chat, input.result.state); job.resolve(input.result); }
      }
      this.respond(response, {}); return;
    }
    if (route === '/state' && request.method === 'POST') {
      const input = await this.body(request);
      if (typeof input.chat === 'string' && input.chat.length < 200 && input.state) this.savePage(input.chat, input.state);
      this.respond(response, {}); return;
    }
    this.respond(response, null, 404);
  }
  savePage(chat, state) {
    let url = ''; try { const value = new URL(state.url); if (['https:', 'http:'].includes(value.protocol) && !value.username && !value.password) url = value.href; } catch {}
    const next = { url, title: typeof state.title === 'string' ? state.title.slice(0, 200) : 'Browser', loading: !!state.loading, canGoBack: !!state.canGoBack, canGoForward: !!state.canGoForward, pageReady: !state.loading, external: true };
    this.pages.set(chat, next); this.emit({ type: 'browser.state', conversationId: chat === 'new' ? null : chat, ...next });
  }
  request(action, input, chat, { signal, timeout = this.timeout } = {}) {
    if (!this.status().connected) return Promise.reject(Error('Your browser is disconnected. Open the Exomina extension in your browser to reconnect.'));
    if (signal?.aborted) return Promise.reject(Error('The browser action was stopped.'));
    const id = randomUUID(), key = chat || 'new';
    return new Promise((resolve, reject) => {
      const fail = message => { this.pending.delete(id); this.queue = this.queue.filter(item => item.id !== id); clearTimeout(job.timer); job.cleanup?.(); reject(Error(message)); };
      const abort = () => fail('The browser action was stopped.');
      const job = { resolve, reject, chat: key, timer: setTimeout(() => fail('Your browser did not finish the action in time. Check its Exomina extension.'), timeout), cleanup: () => signal?.removeEventListener('abort', abort) };
      this.pending.set(id, job); signal?.addEventListener('abort', abort, { once: true });
      const command = { id, action, input, chat: key, expiresAt: Date.now() + timeout };
      if (this.poll) { const poll = this.poll; this.poll = null; clearTimeout(poll.timer); this.respond(poll.response, command); } else this.queue.push(command);
    });
  }
  cancel(chat) {
    const key = chat || 'new';
    for (const [id, job] of this.pending) if (job.chat === key) { clearTimeout(job.timer); job.cleanup?.(); job.reject(Error('The browser action was stopped.')); this.pending.delete(id); }
    this.queue = this.queue.filter(item => item.chat !== key);
  }
  rejectPending(message) { for (const job of this.pending.values()) { clearTimeout(job.timer); job.cleanup?.(); job.reject(Error(message)); } this.pending.clear(); this.queue = []; this.pages.clear(); }
  async disconnect() {
    this.identity = null; this.pairing = null; this.lastPoll = 0; this.rejectPending('The browser was disconnected.');
    if (this.file) await unlink(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await this.close(); this.emit({ type: 'browser.connection', ...this.status() });
  }
  async close() {
    this.rejectPending('Exomina closed its browser connection.');
    if (this.poll) { clearTimeout(this.poll.timer); this.respond(this.poll.response, null, 204); this.poll = null; }
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
