import { fileURLToPath } from 'node:url';

const panels = new Set(['browser', 'notes', 'terminal', 'workbench']);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const usable = window => window && !window.isDestroyed();
const satellitePreload = fileURLToPath(new URL('./workspace-preload.cjs', import.meta.url)).replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');

/** Keep detached panels as views of the one renderer, with no independent IPC authority. */
export class WorkspaceWindows {
  constructor({ window, indexUrl, emit = () => {}, setBrowserOwner = () => {}, openExternal = () => {}, getDisplays = () => [], displaySource, backgroundColor = () => '#121615', onCreate = () => {}, now = Date.now }) {
    Object.assign(this, { window, indexUrl, emit, setBrowserOwner, openExternal, getDisplays, backgroundColor, onCreate, now });
    this.entries = new Map(); this.browserOwnerId = null;
    this.created = (child, details) => this.didCreate(child, details);
    window.webContents.setWindowOpenHandler(request => this.open(request));
    window.webContents.on('did-create-window', this.created);
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.closeAll({ preserveLayout: true }); });
    window.webContents.on('render-process-gone', () => this.closeAll({ preserveLayout: true }));
    const recoverDisplays = () => this.recoverBounds();
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) displaySource?.on(event, recoverDisplays);
    window.once('closed', () => { for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) displaySource?.removeListener(event, recoverDisplays); });
  }
  prepare(input = {}) {
    const { id, panel } = input;
    if (!validId(id) || !panels.has(panel)) throw Error('Choose a valid workspace panel.');
    for (const [key, value] of this.entries) if (!value.window && value.expires < this.now()) this.entries.delete(key);
    if (this.entries.has(id)) throw Error('That panel window is already open or opening.');
    if (this.entries.size >= 8) throw Error('Close a detached panel before opening another.');
    if ([...this.entries.values()].some(entry => entry.panel === panel)) throw Error('That workspace panel is already detached.');
    const url = this.indexUrl + '#workspace-panel=' + id;
    this.entries.set(id, { id, panel, url, title: String(input.title || panel).replace(/[\r\n\0]/g, ' ').slice(0, 80), bounds: this.bounds(input.bounds), expires: this.now() + 60000, opening: false, window: null });
    return { id, url };
  }
  bounds(input = {}) {
    const numeric = (key, fallback) => Number.isFinite(input?.[key]) ? Math.round(input[key]) : fallback;
    const proposed = { x: numeric('x', NaN), y: numeric('y', NaN), width: Math.max(420, Math.min(3840, numeric('width', 800))), height: Math.max(360, Math.min(2160, numeric('height', 720))) };
    const displays = this.getDisplays().map(display => display.workArea || display.bounds).filter(area => area && area.width > 0 && area.height > 0);
    if (displays.length) {
      const area = displays.find(area => proposed.x < area.x + area.width && proposed.x + proposed.width > area.x && proposed.y < area.y + area.height && proposed.y + proposed.height > area.y) || displays[0];
      proposed.width = Math.min(proposed.width, area.width); proposed.height = Math.min(proposed.height, area.height);
      proposed.x = Math.max(area.x, Math.min(area.x + area.width - proposed.width, Number.isFinite(proposed.x) ? proposed.x : area.x + 40));
      proposed.y = Math.max(area.y, Math.min(area.y + area.height - proposed.height, Number.isFinite(proposed.y) ? proposed.y : area.y + 40));
    }
    if (!Number.isFinite(proposed.x)) delete proposed.x;
    if (!Number.isFinite(proposed.y)) delete proposed.y;
    return proposed;
  }
  open({ url, disposition }) {
    const entry = [...this.entries.values()].find(value => value.url === url && !value.window && !value.opening && value.expires >= this.now());
    if (!entry || !usable(this.window) || disposition === 'background-tab') {
      if (/^https?:/.test(url || '')) Promise.resolve(this.openExternal(url)).catch(() => {});
      return { action: 'deny' };
    }
    entry.opening = true;
    return { action: 'allow', overrideBrowserWindowOptions: {
      ...entry.bounds, minWidth: 420, minHeight: 360, title: entry.title, autoHideMenuBar: true, backgroundColor: this.backgroundColor(),
      webPreferences: { preload: satellitePreload, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false },
    } };
  }
  didCreate(child, details = {}) {
    const entry = [...this.entries.values()].find(value => value.url === details.url && value.opening && !value.window);
    if (!entry || !usable(this.window)) { child.destroy(); return; }
    entry.window = child; entry.opening = false; child.setMenu(null);
    this.keepRendererActive();
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, url) => { if (url !== entry.url) event.preventDefault(); };
    child.webContents.on('will-navigate', guard); child.webContents.on('will-redirect', guard);
    child.webContents.on('will-attach-webview', event => event.preventDefault());
    let documentReady = false;
    child.webContents.once('dom-ready', () => { documentReady = true; });
    child.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (documentReady && mainFrame && !inPlace && usable(child)) child.close(); });
    child.webContents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame && url !== entry.url && usable(child)) child.close(); });
    child.webContents.once('render-process-gone', () => { this.restoreBrowser(entry.id); if (usable(child)) child.destroy(); });
    child.webContents.once('destroyed', () => this.restoreBrowser(entry.id));
    const changed = () => { if (usable(child)) { entry.bounds = child.getBounds(); if (!entry.preserveLayout) this.notify({ type: 'workspace.window.bounds', id: entry.id, bounds: entry.bounds }); } };
    child.on('move', changed); child.on('resize', changed);
    child.on('close', () => { changed(); this.restoreBrowser(entry.id); });
    child.once('closed', () => {
      this.restoreBrowser(entry.id); this.entries.delete(entry.id); this.keepRendererActive();
      if (!entry.preserveLayout) this.notify({ type: 'workspace.window.closed', id: entry.id, panel: entry.panel, bounds: entry.bounds });
    });
    this.onCreate(child);
    this.notify({ type: 'workspace.window.opened', id: entry.id, panel: entry.panel, bounds: child.getBounds() });
  }
  owner(id) {
    if (id === undefined) throw Error('Choose the browser panel window.');
    const entry = id === null ? null : this.entries.get(id);
    if (id !== null && (!entry || entry.panel !== 'browser' || !usable(entry.window))) throw Error('That browser panel window is no longer open.');
    this.setBrowserOwner(entry?.window || this.window); this.browserOwnerId = id;
    return { id };
  }
  restoreBrowser(id) {
    if (this.browserOwnerId !== id) return;
    if (this.mainContents()) this.setBrowserOwner(this.window);
    this.browserOwnerId = null;
  }
  close(id, { preserveLayout = false } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return { closed: true };
    if (preserveLayout) entry.preserveLayout = true;
    if (usable(entry.window)) entry.window.close(); else this.entries.delete(id);
    return { closed: !this.entries.has(id) };
  }
  list() {
    return { windows: [...this.entries.values()].filter(entry => usable(entry.window)).map(entry => ({ id: entry.id, panel: entry.panel, bounds: entry.window.getBounds() })), browserOwnerId: this.browserOwnerId };
  }
  attended() { return [...this.entries.values()].some(entry => usable(entry.window) && entry.window.isVisible() && !entry.window.isMinimized() && entry.window.isFocused()); }
  mainContents() {
    if (!usable(this.window)) return null;
    try { const contents = this.window.webContents; return contents && !contents.isDestroyed?.() ? contents : null; } catch { return null; }
  }
  notify(value) { if (this.mainContents()) this.emit(value); }
  keepRendererActive() {
    const contents = this.mainContents();
    if (!contents) return;
    if ([...this.entries.values()].some(entry => usable(entry.window))) {
      if (this.originalBackgroundThrottling === undefined) this.originalBackgroundThrottling = contents.getBackgroundThrottling?.() ?? true;
      contents.setBackgroundThrottling?.(false);
    } else if (this.originalBackgroundThrottling !== undefined) {
      contents.setBackgroundThrottling?.(this.originalBackgroundThrottling); this.originalBackgroundThrottling = undefined;
    }
  }
  recoverBounds() {
    for (const entry of this.entries.values()) if (usable(entry.window)) {
      const previous = entry.window.getBounds(), next = this.bounds(previous);
      if (['x', 'y', 'width', 'height'].some(key => next[key] !== previous[key])) entry.window.setBounds(next);
    }
  }
  closeAll(options) { for (const id of [...this.entries.keys()]) this.close(id, options); }
}
