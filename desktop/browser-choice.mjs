import { browserWebUrl } from './browser-logins.mjs';
import { snapshotOptions } from './browser-extension/page-source.js';
import { isTabTool } from './browser-pages.mjs';
import {inspectOptions} from './browser-extension/inspect-source.js';

const connectedTabs = () => Error('Tabs are part of Exomina’s built-in browser. The connected browser keeps one tab per chat; switch to the built-in browser in Tools to use tabs.');

export class ConnectedBrowser {
  constructor({ bridge, approve, getSettings, isActive, emit }) { Object.assign(this, { bridge, approve, getSettings, isActive, emit }); this.selectedId = null; this.operations = new Map(); }
  state(id = this.selectedId) { return { conversationId: id, url: '', title: 'Your browser', loading: false, canGoBack: false, canGoForward: false, external: true, connected: this.bridge.status().connected, ...this.bridge.pages.get(id || 'new') }; }
  select(id) { this.selectedId = id || null; this.emit({ type: 'browser.state', ...this.state() }); return this.state(); }
  show(_visible, id = this.selectedId) { return this.select(id); }
  setBounds() {}
  async command(action, input = {}, id = this.selectedId, signal) { const result = await this.bridge.request(action, input, id, { signal }); return result?.state ? this.state(id) : result; }
  navigate(url, signal, id = this.selectedId) { return this.command('navigate', { url: browserWebUrl(url.includes('://') ? url : 'https://' + url) }, id, signal); }
  async call(name, input, conversationId) {
    if (!this.getSettings().browserEnabled) throw Error('Browser tools are off. Enable them in Tools.');
    if (!['browser_open', 'browser_snapshot', 'browser_inspect', 'browser_click', 'browser_type', 'browser_key'].includes(name)) throw Error('Unknown browser tool.');
    if (name === 'browser_open') input = { url: browserWebUrl(input.url) };
    if (name === 'browser_snapshot') input = snapshotOptions(input);
    if (name === 'browser_inspect') input = inspectOptions(input);
    if (['browser_click', 'browser_type'].includes(name) && (typeof input.selector !== 'string' || input.selector.length > 1000)) throw Error('A valid CSS selector is required.');
    if (name === 'browser_type' && (typeof input.text !== 'string' || input.text.length > 16000)) throw Error('Text is too long.');
    if (name === 'browser_key' && !['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Backspace'].includes(input.key)) throw Error('Unsupported key.');
    const detail = name === 'browser_snapshot' ? 'Read this chat’s page in your connected browser and share its visible content and screenshot with the selected AI provider.' : name==='browser_inspect'?'Share HTML or loaded source resources from this chat’s connected browser tab. HTML may include account-specific page data. No cookies, browser stores or network request bodies are read.\n'+JSON.stringify(input,null,2):JSON.stringify(input, null, 2);
    if (!await this.approve({ title: name === 'browser_snapshot' ? 'Read connected browser?' : 'Allow connected browser action?', detail, conversationId })) throw Error('Browser action declined.');
    if (!this.getSettings().browserEnabled || !this.isActive(conversationId)) throw Error('The browser action was stopped.');
    const controller = new AbortController(), operations = this.operations.get(conversationId) || new Set(); operations.add(controller); this.operations.set(conversationId, operations);
    try {
      const action = name.replace('browser_', '');
      const result = await this.bridge.request(action === 'open' ? 'navigate' : action, input, conversationId, { signal: controller.signal });
      return result?.content ? result : { content: [{ type: 'text', text: JSON.stringify(this.state(conversationId)) }] };
    } finally { operations.delete(controller); if (!operations.size) this.operations.delete(conversationId); }
  }
  cancel(id) { for (const controller of this.operations.get(id) || []) controller.abort(); this.bridge.cancel(id); }
  remove(id) { this.cancel(id); this.bridge.pages.delete(id || 'new'); this.bridge.request('remove', {}, id).catch(() => {}); }
  close() { for (const id of this.operations.keys()) this.cancel(id); }
}

export class BrowserChoice {
  constructor({ embedded, connected, getSource }) { Object.assign(this, { embedded, connected, getSource }); this.selectedId = null; }
  get current() { return this.getSource() === 'connected' ? this.connected : this.embedded; }
  get definitions() { return this.embedded.definitions.map(tool => ({ ...tool, description: tool.description.replaceAll('embedded browser', 'selected browser').replace('Each chat keeps its own page and history.', 'Each chat keeps its own page or connected browser tab.').replace('Requires browser tools enabled', 'Requires browser tools enabled') })); }
  select(id) { this.selectedId = id || null; return this.current.select(this.selectedId); }
  show(visible, id = this.selectedId) { this.selectedId = id || null; if (this.current === this.connected) this.embedded.show(false, this.selectedId); return this.current.show(visible, this.selectedId); }
  state(id = this.selectedId) { return this.current.state(id); }
  setBounds(bounds) { this.embedded.setBounds(bounds); }
  setWindow(window) { this.embedded.setWindow(window); }
  navigate(url, signal, id = this.selectedId) { return this.current.navigate(url, signal, id); }
  call(name, input, id) { if (isTabTool(name) && this.current === this.connected) throw connectedTabs(); return this.current.call(name, input, id); }
  tab(action, payload = {}, id = this.selectedId) {
    if (this.current === this.connected) throw connectedTabs();
    if (action === 'new') return this.embedded.newTab(id, payload.url ? browserWebUrl(payload.url.includes('://') ? payload.url : 'https://' + payload.url) : '');
    if (typeof payload.tabId !== 'string') throw Error('Choose a browser tab.');
    return action === 'close' ? this.embedded.closeTab(payload.tabId, id) : this.embedded.selectTab(payload.tabId, id);
  }
  cancel(id) { this.embedded.cancel(id); this.connected.cancel(id); }
  remove(id) { this.embedded.remove(id); this.connected.remove(id); }
  async command(action, id = this.selectedId) {
    if (this.current === this.connected) return this.connected.command(action, {}, id);
    const page = this.embedded.page(id);
    if (action === 'back' && page.wc.navigationHistory.canGoBack()) page.wc.navigationHistory.goBack();
    if (action === 'forward' && page.wc.navigationHistory.canGoForward()) page.wc.navigationHistory.goForward();
    if (action === 'reload') page.wc.reload(); if (action === 'stop') page.stop();
    return this.embedded.state(id);
  }
  close() { this.embedded.close(); this.connected.close(); }
}
