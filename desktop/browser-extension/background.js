import { snapshotSource, snapshotOptions, actionSource } from './page-source.js';
import {inspectPage} from './inspect-source.js';
let connection = null, polling = false, generation = 0;
const tasks = new Map();

async function host(route, { method = 'GET', body, auth = true, signal } = {}) {
  if (!connection) throw Error('Connect Exomina first.');
  const response = await fetch(`http://127.0.0.1:${connection.port}${route}`, { method, signal: signal || AbortSignal.timeout(10000),
    headers: { 'X-Exomina-Extension': chrome.runtime.id, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: `Bearer ${connection.token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw Error(response.status === 403 ? 'The connection was removed. Pair this browser again in Exomina.' : 'Exomina did not accept the browser response.');
  return response.status === 204 ? null : response.json();
}
async function tabs() { return (await chrome.storage.session.get('chatTabs')).chatTabs || {}; }
async function tabFor(chat, create = false) {
  const owned = await tabs();
  if (owned[chat]) { try { return await chrome.tabs.get(owned[chat]); } catch { delete owned[chat]; } }
  if (!create) throw Error('Open a web page for this chat first.');
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true }); owned[chat] = tab.id;
  await chrome.storage.session.set({ chatTabs: owned }); return tab;
}
const send = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
async function evaluate(tabId, expression) {
  const result = await send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'The browser could not perform this action.');
  return result.result.value;
}
function checkedUrl(value) {
  const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Only HTTP and HTTPS pages are allowed.'); return url.href;
}
async function state(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const history = await send(tabId, 'Page.getNavigationHistory').catch(() => ({ currentIndex: 0, entries: [] }));
  return { url: tab.url || '', title: tab.title || 'Browser', loading: tab.status === 'loading', canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 };
}
async function execute(command) {
  if (!command || !['navigate','snapshot','inspect','click','type','key','back','forward','reload','stop','remove'].includes(command.action) || Date.now() > command.expiresAt) throw Error('This browser action expired or is unsupported.');
  const { action, input = {}, chat } = command;
  if (action === 'navigate') checkedUrl(input.url);
  if (action === 'type' && (typeof input.text !== 'string' || input.text.length > 16000)) throw Error('Invalid text.');
  const tab = await tabFor(chat, action === 'navigate');
  if (action === 'remove') { await chrome.tabs.remove(tab.id); return {}; }
  if (action !== 'navigate') checkedUrl(tab.url);
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  let detached = false;
  const detach = async () => { if (!detached) { detached = true; await chrome.debugger.detach({ tabId: tab.id }).catch(() => {}); } };
  const timer = setTimeout(detach, Math.max(1, command.expiresAt - Date.now()));
  try {
    await send(tab.id, 'Page.enable');
    if (Date.now() > command.expiresAt) throw Error('This browser action expired.');
    if (action === 'navigate') {
      const result = await send(tab.id, 'Page.navigate', { url: input.url }); if (result.errorText) throw Error(result.errorText);
      const limit = Math.min(command.expiresAt, Date.now() + 20000);
      while (Date.now() < limit) {
        const frame = await send(tab.id, 'Page.getFrameTree').catch(() => null);
        if ((!result.loaderId || frame?.frameTree?.frame?.loaderId === result.loaderId) && await evaluate(tab.id, 'document.readyState === "interactive" || document.readyState === "complete"').catch(() => false)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else if (action === 'inspect') {
      return {...await inspectPage({send:(method,params)=>send(tab.id,method,params),evaluate:source=>evaluate(tab.id,source)},input),state:await state(tab.id)};
    } else if (action === 'snapshot') {
      const options = snapshotOptions(input);
      const data = await evaluate(tab.id, snapshotSource(command.id, options));
      const contents = [{ type: 'text', text: JSON.stringify({ ...data, untrusted: true, external: true }) }];
      try { if (options.include_screenshot) { const screenshot = await send(tab.id, 'Page.captureScreenshot', { format: 'png' }); if (screenshot.data.length < 10 * 1024 * 1024) contents.push({ type: 'image', data: screenshot.data, mimeType: 'image/png' }); } }
      catch { data.notice = 'Page text was read successfully. A screenshot could not be captured.'; contents[0].text = JSON.stringify({ ...data, untrusted: true, external: true }); }
      return { content: contents, state: await state(tab.id) };
    } else if (action === 'click' || action === 'type') {
      const point = await evaluate(tab.id, actionSource(command));
      if (action === 'click') { await send(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await send(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }); }
    } else if (action === 'key') {
      const keys = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8 };
      if (!keys[input.key]) throw Error('Unsupported key.');
      await send(tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: input.key, code: input.key, windowsVirtualKeyCode: keys[input.key], ...(input.key === 'Enter' ? { text: '\r' } : {}) });
      await send(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: input.key, code: input.key, windowsVirtualKeyCode: keys[input.key] });
    } else if (action === 'back' || action === 'forward') {
      const history = await send(tab.id, 'Page.getNavigationHistory'); const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)];
      if (entry) await send(tab.id, 'Page.navigateToHistoryEntry', { entryId: entry.id });
    } else if (action === 'reload') await send(tab.id, 'Page.reload');
    else if (action === 'stop') await send(tab.id, 'Page.stopLoading');
    return { state: await state(tab.id) };
  } finally { clearTimeout(timer); await detach(); }
}
async function run(command) {
  const previous = tasks.get(command.chat) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    try { await host('/result', { method: 'POST', body: { id: command.id, result: await execute(command) } }); }
    catch (error) { await host('/result', { method: 'POST', body: { id: command.id, error: error.message } }).catch(() => {}); }
  });
  tasks.set(command.chat, task); task.finally(() => { if (tasks.get(command.chat) === task) tasks.delete(command.chat); });
}
async function poll() {
  if (polling || !connection) return;
  polling = true; const epoch = generation;
  try {
    while (connection && epoch === generation) {
      const command = await host('/commands', { signal: AbortSignal.timeout(25000) });
      if (command && epoch === generation) run(command);
    }
  } catch { /* Alarm or opening the extension reconnects after Exomina returns. */ }
  finally { polling = false; if (connection && epoch !== generation) poll(); }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('connect.html')) return false;
  (async () => {
    if (message.action === 'pair') {
      const match = /^(\d{1,5}):([A-Za-z0-9_-]{43})$/.exec(message.code || '');
      if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw Error('Copy a fresh connection code from Exomina → Tools.');
      const saved = connection; connection = { port: Number(match[1]) };
      try {
        const result = await host('/pair', { method: 'POST', auth: false, body: { code: match[2], browser: /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome' } });
        connection.token = result.token; await chrome.storage.local.set({ connection });
        await chrome.storage.session.remove('chatTabs'); generation++;
      } catch (error) { connection = saved; throw error; }
    } else if (message.action === 'disconnect') { connection = null; generation++; await chrome.storage.local.remove('connection'); }
    if (!polling) poll();
    return {};
  })().then(respond, error => respond({ error: error.message })); return true;
});
chrome.alarms.onAlarm.addListener(() => { if (!polling) poll(); });
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (!connection || (!change.url && !change.status && !change.title)) return;
  const owned = await tabs(); const entry = Object.entries(owned).find(([, id]) => id === tabId);
  if (entry) host('/state', { method: 'POST', body: { chat: entry[0], state: { url: tab.url, title: tab.title, loading: tab.status === 'loading' } } }).catch(() => {});
});
chrome.storage.local.get('connection').then(saved => { connection = saved.connection || null; poll(); });
chrome.alarms.create('exomina-connection', { periodInMinutes: 0.5 });
