import { randomUUID } from 'node:crypto';
import { snapshotSource, snapshotOptions } from './browser-extension/page-source.js';
import { browserLoadError } from './browser-network.mjs';

const stopped = () => new Error('The browser action was stopped.');

export function browserDeadline(operation, { milliseconds, message, signal, onTimeout, onCancel }) {
  if (signal?.aborted) return Promise.reject(stopped());
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { finish(stopped()); onCancel?.(); };
    const timer = setTimeout(() => { finish(new Error(message)); onTimeout?.(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal?.aborted) throw stopped(); return operation(); }).then(value => finish(null, value), error => finish(error));
  });
}

// These operations use the very same sandboxed WebContentsView shown in Exomina.
// mainFrame.executeJavaScript can read a parsed page while its resources still load;
// webContents.executeJavaScript instead waits for the entire load to finish.
export class BrowserRuntime {
  constructor({ wc, readState, readDocument = null, timeouts = {} }) {
    this.wc = wc;
    this.readState = readState;
    this.readDocument = readDocument;
    this.timeouts = { navigation: 12000, read: 4000, capture: 2500, action: 4000, ...timeouts };
    this.pageReady = false;
    this.revision = 0;
    this.navigation = 0;
    this.documentCommitted = true;
    this.captureTask = null;
    this.renderingUsers = 0;
    this.listeners = {
      'did-start-navigation': (_event, _url, inPlace, main) => { if (main && !inPlace) { this.revision++; this.documentCommitted = false; this.pageReady = false; this.captureTask = null; } },
      'did-navigate': () => { this.documentCommitted = true; },
      'dom-ready': () => { this.pageReady = this.documentCommitted; },
      'render-process-gone': () => { this.revision++; this.documentCommitted = false; this.pageReady = false; this.captureTask = null; }
    };
    for (const [name, listener] of Object.entries(this.listeners)) wc.on(name, listener);
  }

  async navigate(url, signal) {
    const navigation = ++this.navigation;
    let cleanup;
    const stopOwnNavigation = () => { if (this.navigation === navigation && !this.wc.isDestroyed()) this.wc.stop(); };
    try {
      await browserDeadline(() => new Promise((resolve, reject) => {
        let started = false, committed = false;
        const starting = (_event, _url, _inPlace, main) => { if (main) started = true; };
        const committedPage = () => { committed = true; };
        const ready = () => { if (started && committed) resolve(); };
        const destroyed = () => reject(new Error('The browser page was closed.'));
        const failed = (_event, code, description, _url, main) => { if (main && code !== -3) reject(new Error(browserLoadError(description))); };
        const listeners = { 'did-start-navigation': starting, 'did-navigate': committedPage, 'dom-ready': ready, 'destroyed': destroyed, 'did-fail-load': failed };
        cleanup = () => { for (const [name, listener] of Object.entries(listeners)) this.wc.removeListener(name, listener); };
        for (const [name, listener] of Object.entries(listeners)) this.wc.on(name, listener);
        // Keep the eventual load completion/rejection handled after DOM readiness.
        Promise.resolve().then(() => this.wc.loadURL(url)).then(resolve, error => reject(new Error(browserLoadError(error?.message))));
      }), {
        milliseconds: this.timeouts.navigation, signal, onTimeout: stopOwnNavigation, onCancel: stopOwnNavigation,
        message: 'The page did not become ready within 12 seconds. Loading was stopped; try again or use a different page.'
      });
      this.pageReady = true;
      const state = this.readState();
      return { ...state, pageReady: true, ...(state.loading ? { notice: 'The page is ready to read. Background resources are still loading; browser_snapshot can read it now.' } : {}) };
    } finally { cleanup?.(); }
  }

  execute(source, { signal, userGesture = false, timeout = this.timeouts.action } = {}) {
    return browserDeadline(() => this.wc.mainFrame.executeJavaScript(source, userGesture), {
      milliseconds: timeout, signal,
      message: 'The page did not respond in time. Check its current state before retrying an action.'
    });
  }

  // A hidden page needs time to become renderable after unthrottling. Keep the
  // lease through native frames queued by input, then allow idle tabs to sleep.
  async renderFrames(signal) {
    try {
      await this.execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))', { signal, timeout: 1200 });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Script-blocked documents and pages without a compositor remain readable.
    }
  }

  async withRendering(operation, { signal, warm = false } = {}) {
    if (signal?.aborted) throw stopped();
    if (this.closed) throw new Error('The browser page was closed.');
    if (!this.renderingUsers) {
      this.renderingThrottle = this.wc.getBackgroundThrottling();
      this.wc.setBackgroundThrottling(false);
    }
    this.renderingUsers++;
    try {
      if (warm) await this.renderFrames(signal);
      if (signal?.aborted) throw stopped();
      return await operation();
    } finally {
      // Frame draining is cleanup. Cancellation here must not erase a receipt
      // for native input that has already completed, or replace its own error.
      try { if (!signal?.aborted && !this.closed && !this.wc.isDestroyed()) await this.renderFrames(signal).catch(() => {}); }
      finally {
        if (!--this.renderingUsers && !this.closed && !this.wc.isDestroyed()) this.wc.setBackgroundThrottling(this.renderingThrottle);
      }
    }
  }

  capture(signal) {
    if (signal?.aborted) return Promise.reject(stopped());
    if (this.captureTask) return Promise.reject(new Error('A previous screenshot capture is still pending. Page text can still be read.'));
    const task = Promise.resolve().then(async () => {
      if (signal?.aborted) throw stopped();
      const screenshot = await this.wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (screenshot.isEmpty()) throw new Error('Screenshot capture returned an empty image.');
      return screenshot.toPNG().toString('base64');
    });
    this.captureTask = task;
    const settled = () => { if (this.captureTask === task) this.captureTask = null; };
    task.then(settled, settled);
    return browserDeadline(() => task, { milliseconds: this.timeouts.capture, signal, message: 'Screenshot capture timed out.' });
  }

  // Scripts cannot run in documents served with `CSP: sandbox` (raw GitHub files, for example).
  // Plain-text documents are then read from their response body; they have no actionable elements.
  async readPlain(options, signal) {
    if (!this.readDocument) return null;
    const controller = new AbortController();
    try {
      const doc = await browserDeadline(() => this.readDocument(controller.signal), { milliseconds: this.timeouts.read, signal, onTimeout: () => controller.abort(), onCancel: () => controller.abort(), message: 'Reading the document body timed out.' });
      if (!doc || typeof doc.content !== 'string') return null;
      const length = doc.content.length, offset = Math.min(options.offset, length), end = Math.min(offset + options.limit, length);
      return { url: doc.url, title: this.readState().title, readyState: 'complete', text: doc.content.slice(offset, end), textScope: 'document response body',
        mimeType: doc.mimeType, textOffset: offset, totalTextLength: length, nextOffset: end < length ? end : null, textTruncated: end < length, elements: [] };
    } catch { return null; }
    finally { controller.abort(); }
  }

  async snapshot(signal, input = {}) {
    const options = snapshotOptions(input);
    const revision = this.revision;
    const id = randomUUID();
    let [read, capture] = await Promise.allSettled([
      this.execute(snapshotSource(id, options), { signal, timeout: this.timeouts.read }),
      options.include_screenshot ? this.capture(signal) : Promise.resolve(null)
    ]);
    if (signal?.aborted) throw stopped();
    if (!(read.status === 'fulfilled' && read.value && typeof read.value === 'object')) {
      const plain = await this.readPlain(options, signal);
      if (signal?.aborted) throw stopped();
      if (plain) read = { status: 'fulfilled', value: plain };
    }
    const state = this.readState();
    const available = read.status === 'fulfilled' && read.value && typeof read.value === 'object';
    const page = available ? read.value : { url: state.url, title: state.title, text: '', elements: [] };
    const failedPage = !!state.error && (!!state.errorCode || !available || String(page.url).startsWith('chrome-error://'));
    const changed = revision !== this.revision || (available && !failedPage && page.url !== state.url);
    const image = capture.status === 'fulfilled' && !changed ? capture.value : null;
    const reason = result => String(result.reason?.message || 'The browser could not read this part of the page.').slice(0,240);
    page.untrusted = true;
    page.loading = state.loading;
    page.pageReady = this.pageReady && !failedPage;
    page.pageRead = available ? { available: true } : { available: false, reason: reason(read) };
    page.screenshot = image ? { available: true } : { available: false, reason: changed ? 'The page changed during the snapshot. Read it again.' : !options.include_screenshot ? 'Screenshot omitted by request.' : reason(capture) };
    if (failedPage && !changed) {
      page.url = state.url;
      page.title = state.title;
      page.text = '';
      page.elements = [];
      page.navigationError = { code: state.errorCode || null, message: state.error, url: state.url };
      page.notice = state.error;
    } else if (changed) {
      page.pageChanged = true;
      page.currentUrl = state.url;
      page.elements = [];
      page.notice = 'The browser navigated while this snapshot was being read. Read the current page again before using any selectors.';
    } else if (!available && !image) page.notice = 'The page did not provide readable text or a screenshot. The tool has stopped waiting; try another page or reload it.';
    else if (!available) page.notice = 'A current screenshot is available. Page text and selectors could not be read.';
    else if (!image) page.notice = 'Page text and actionable elements were read successfully. No screenshot is available for this snapshot.';
    else if (state.loading) page.notice = 'The page is readable while background resources continue loading.';
    const content = [{ type: 'text', text: JSON.stringify(page) }];
    if (image) content.push({ type: 'image', mimeType: 'image/png', data: image });
    return { content, ...(!available && !image || changed || failedPage ? { isError: true } : {}) };
  }

  close() {
    this.closed = true;
    this.captureTask = null;
    for (const [name, listener] of Object.entries(this.listeners)) this.wc.removeListener(name, listener);
  }
}
