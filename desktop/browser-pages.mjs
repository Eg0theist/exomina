import { randomUUID } from 'node:crypto';

const keyOf = id => id || null;
export const MAX_TABS = 8;
const emptyState = id => ({ conversationId: id, url: '', title: 'Browser', loading: false, pageReady: false, canGoBack: false, canGoForward: false, error: null, tabs: [], activeTabId: null });
const args = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const TAB_TOOLS = [
  { name: 'browser_tabs', description: 'List the open tabs of the current chat’s embedded browser with their ids, titles and addresses, after user approval to share them. browser_snapshot, browser_click, browser_type and browser_key act on the active tab.', inputSchema: args({}) },
  { name: 'browser_tab_new', description: `Open a new tab in the current chat’s embedded browser and make it active. With url, the page opens after the same approval as browser_open. At most ${MAX_TABS} tabs per chat.`, inputSchema: args({ url: { type: 'string' } }, []) },
  { name: 'browser_tab_select', description: 'Make one tab from browser_tabs the active tab, so later browser tools act on it.', inputSchema: args({ tab_id: { type: 'string' } }) },
  { name: 'browser_tab_close', description: 'Close one tab from browser_tabs after user approval. Closing the last tab leaves one empty tab.', inputSchema: args({ tab_id: { type: 'string' } }) },
];
const TAB_NAMES = new Set(TAB_TOOLS.map(tool => tool.name));
export const isTabTool = name => TAB_NAMES.has(name);
const savedTabs = saved => Array.isArray(saved?.tabs) && saved.tabs.length ? saved.tabs.slice(0, MAX_TABS) : saved?.url ? [{ url: saved.url, title: saved.title }] : [];
const savedActive = (saved, count) => Math.min(Math.max(0, Math.trunc(Number(saved?.activeTab)) || 0), Math.max(0, count - 1));

/** Each chat owns a set of live tabs with their own navigation history; only the selected chat's active tab is attached. */
export class ChatBrowser {
  constructor({ createPage, emit = () => {}, getSaved = () => null, saveState = async () => {}, isEnabled = () => true, approve = async () => true }) {
    Object.assign(this, { createPage, emit, getSaved, saveState, isEnabled, approve });
    this.pages = new Map(); this.selectedId = null; this.visible = false; this.bounds = null;
  }
  /** The chat's tab set, created and restored from its saved tabs on first use. */
  chat(id) {
    id = keyOf(id);
    if (!this.pages.has(id)) {
      const entry = { tabs: [], active: null }, saved = this.getSaved(id), restore = savedTabs(saved);
      this.pages.set(id, entry);
      for (const item of restore) this.addTab(id, item?.url, { activate: false });
      if (!entry.tabs.length) this.addTab(id, '', { activate: false });
      entry.active = entry.tabs[savedActive(saved, entry.tabs.length)].id;
    }
    return this.pages.get(id);
  }
  addTab(id, url, { activate = true } = {}) {
    id = keyOf(id);
    const entry = this.pages.get(id);
    if (entry.tabs.length >= MAX_TABS) throw Error(`This chat already has ${MAX_TABS} browser tabs. Close one first.`);
    const tab = { id: randomUUID().slice(0, 8) };
    tab.page = this.createPage(id, event => {
      if (event.type !== 'browser.state') { this.emit({ ...event, conversationId: id }); return; }
      if (!this.pages.get(id)?.tabs.includes(tab)) return;
      this.emit({ type: 'browser.state', ...this.state(id), ...(event.error && tab.id === entry.active ? { error: event.error } : {}) });
      this.persist(id);
    });
    if (this.ownerWindow) tab.page.setWindow?.(this.ownerWindow);
    entry.tabs.push(tab);
    if (this.bounds) tab.page.setBounds(this.bounds);
    if (url) tab.page.restore = tab.page.navigate(url).catch(error => { this.emit({ type: 'browser.state', ...this.state(id), error: error.message }); });
    if (activate) this.activate(id, tab.id);
    return tab;
  }
  activate(id, tabId) {
    id = keyOf(id);
    const entry = this.chat(id), next = entry.tabs.find(tab => tab.id === tabId);
    if (!next) throw Error('That browser tab is no longer open.');
    if (entry.active !== tabId) {
      const shown = this.visible && this.selectedId === id;
      if (shown) this.activeTab(id)?.page.show(false);
      entry.active = tabId;
      if (shown) next.page.show(true);
      this.persist(id);
    }
    return next;
  }
  activeTab(id = this.selectedId) { const entry = this.pages.get(keyOf(id)); return entry?.tabs.find(tab => tab.id === entry.active); }
  page(id = this.selectedId) { this.chat(id); return this.activeTab(id).page; }
  /** Saves web tabs only; a chat that never opened a page keeps no browser record. */
  persist(id) {
    const entry = this.pages.get(keyOf(id));
    if (!entry) return;
    const tabs = entry.tabs.map(tab => { const state = tab.page.state(); return { url: /^https?:/.test(state.url || '') ? state.url : '', title: state.title || '' }; });
    if (!tabs.some(tab => tab.url)) return;
    const activeTab = Math.max(0, entry.tabs.findIndex(tab => tab.id === entry.active));
    Promise.resolve(this.saveState(keyOf(id), { url: tabs[activeTab].url, title: tabs[activeTab].title, tabs, activeTab })).catch(() => {});
  }
  select(id) {
    id = keyOf(id);
    if (id !== this.selectedId) {
      this.activeTab(this.selectedId)?.page.show(false);
      this.selectedId = id;
      if (this.visible) this.page().show(true);
    }
    const state = this.state(); this.emit({ type: 'browser.state', ...state }); return state;
  }
  state(id = this.selectedId) {
    id = keyOf(id);
    const entry = this.pages.get(id);
    if (!entry) {
      const saved = this.getSaved(id) || {}, restore = savedTabs(saved);
      const tabs = restore.map((tab, index) => ({ id: `saved-${index}`, url: tab?.url || '', title: tab?.title || '', loading: false }));
      return { ...emptyState(id), ...saved, tabs, activeTabId: tabs.length ? `saved-${savedActive(saved, tabs.length)}` : null, conversationId: id };
    }
    const tabs = entry.tabs.map(tab => { const state = tab.page.state(); return { id: tab.id, url: state.url || '', title: state.title || '', loading: !!state.loading }; });
    return { ...emptyState(id), ...this.activeTab(id).page.state(), tabs, activeTabId: entry.active, conversationId: id };
  }
  show(visible, id = this.selectedId) {
    if (!visible) this.activeTab(this.selectedId)?.page.show(false);
    this.visible = Boolean(visible); this.select(id);
    if (this.visible) this.page().show(true); else this.activeTab(this.selectedId)?.page.show(false);
    return this.state();
  }
  setBounds(bounds) { this.bounds = bounds; for (const entry of this.pages.values()) for (const tab of entry.tabs) tab.page.setBounds(bounds); }
  setWindow(window) { this.ownerWindow = window; for (const entry of this.pages.values()) for (const tab of entry.tabs) tab.page.setWindow?.(window); }
  get wc() { return this.page().wc; }
  get runtime() { return this.page().runtime; }
  async navigate(url, signal, id = this.selectedId) { const page = this.page(id); await page.restore; return { ...await page.navigate(url, signal), conversationId: keyOf(id) }; }
  stop(id = this.selectedId) { this.activeTab(id)?.page.stop(); return this.state(id); }
  /** Tab controls from the browser panel. A saved chat that was never opened restores first. */
  newTab(id = this.selectedId, url = '') {
    const fresh = !this.pages.has(keyOf(id)), entry = this.chat(id), blank = fresh && entry.tabs.length === 1 && !entry.tabs[0].page.state().url && entry.tabs[0];
    if (blank) { if (url) blank.page.restore = blank.page.navigate(url).catch(error => { this.emit({ type: 'browser.state', ...this.state(id), error: error.message }); }); if (this.visible && this.selectedId === keyOf(id)) blank.page.show(true); }
    else this.addTab(id, url);
    return this.announce(id);
  }
  selectTab(tabId, id = this.selectedId) { this.activate(id, tabId); return this.announce(id); }
  closeTab(tabId, id = this.selectedId) {
    id = keyOf(id);
    const entry = this.chat(id), index = entry.tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) throw Error('That browser tab is no longer open.');
    const shown = this.visible && this.selectedId === id, [tab] = entry.tabs.splice(index, 1);
    if (!entry.tabs.length) this.addTab(id, '', { activate: false });
    tab.page.show(false); tab.page.close();
    if (entry.active === tabId) { entry.active = entry.tabs[Math.min(index, entry.tabs.length - 1)].id; if (shown) this.activeTab(id).page.show(true); }
    this.persist(id);
    return this.announce(id);
  }
  announce(id) { const state = this.state(id); this.emit({ type: 'browser.state', ...state }); return state; }
  get definitions() { return this.toolDefinitions ??= [...this.page(null).definitions, ...TAB_TOOLS]; }
  async call(name, input, id) {
    if (!this.isEnabled()) throw Error('Embedded browser tools are off. Enable them in Tools.');
    if (isTabTool(name)) return this.callTab(name, input || {}, id);
    const page = this.page(id); await page.restore; return page.call(name, input, id);
  }
  async callTab(name, input, id) {
    const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    const list = () => { const state = this.state(id); return { activeTabId: state.activeTabId, tabs: state.tabs }; };
    if (name === 'browser_tabs') {
      if (!await this.approve({ title: 'Share browser tabs?', detail: 'Share the titles and addresses of this chat’s open browser tabs with the selected AI provider.', conversationId: id })) throw Error('Browser action declined.');
      return text(list());
    }
    if (name === 'browser_tab_new') {
      if (input.url !== undefined && typeof input.url !== 'string') throw Error('A valid address is required.');
      this.chat(id); const tab = this.addTab(id, ''); this.announce(id);
      if (input.url) await tab.page.call('browser_open', { url: input.url }, id);
      return text({ tabId: tab.id, ...list() });
    }
    const tab = typeof input.tab_id === 'string' && this.chat(id).tabs.find(item => item.id === input.tab_id);
    if (!tab) throw Error('That browser tab is no longer open. Use browser_tabs to list the current tabs.');
    if (name === 'browser_tab_select') { this.selectTab(tab.id, id); return text(list()); }
    const state = tab.page.state();
    if (!await this.approve({ title: 'Close browser tab?', detail: `${state.title || 'Untitled tab'}\n${state.url || ''}`.trim(), conversationId: id })) throw Error('Browser action declined.');
    if (this.chat(id).tabs.includes(tab)) this.closeTab(tab.id, id);
    return text(list());
  }
  cancel(id) { for (const tab of this.pages.get(keyOf(id))?.tabs || []) tab.page.cancel(id); }
  remove(id) {
    id = keyOf(id);
    const entry = this.pages.get(id);
    if (entry) { for (const tab of entry.tabs) { tab.page.show(false); tab.page.close(); } this.pages.delete(id); }
    if (this.selectedId === id) { this.selectedId = null; this.visible = false; }
  }
  close() { for (const id of [...this.pages.keys()]) this.remove(id); }
}
