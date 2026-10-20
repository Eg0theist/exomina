// Synthetic localhost HTTP host. No Google account, API key, or provider request.
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { PROVIDER_CATALOG } from '../desktop/provider-catalog.mjs';

const root = process.cwd();
const output = path.resolve(root, '../web-ui-qa');
await mkdir(output, { recursive: true });
const methods = [], eventClients = new Set(), requestIds = new Set();
let devices = [{ id: 'synthetic-desktop', name: 'Synthetic desktop', lastSeenAt: Date.now() }];
let activeRuns = [], bootstrapCount = 0, lastSent = null;
const state = {
  settings: { provider: 'gemini', model: 'auto', memoryEnabled: true, memoryCapture: 'automatic', workspace: '' },
  providers: PROVIDER_CATALOG, conversations: [], memories: [{ id: 'synthetic-memory', text: 'Synthetic saved context.', date: new Date().toISOString() }],
  connections: PROVIDER_CATALOG.map(item => ({ id: item.id, name: item.name, available: item.mode === 'api', configured: item.id === 'gemini', connected: item.id === 'gemini', model: item.id === 'gemini' ? 'synthetic-model' : '', hasKey: item.id === 'gemini', unavailableReason: item.mode !== 'api' ? 'Requires an online supported host.' : undefined, executionLocation: 'Private server' })),
  runtime: { mode: 'web', capabilities: { nativeBrowser: false, localFiles: false, desktopControl: false, archiveUpload: false }, executor: { label: 'Private server', online: true } },
  sync: { enabled: true, state: 'synced', lastSyncedAt: new Date().toISOString(), pendingCount: 0 },
  tools: [{ name: 'memory_search', description: 'Search your saved context.', enabled: true, available: true, executionLocation: 'Private server' }, { name: 'desktop_click', description: 'Click a desktop control.', enabled: false, available: false, unavailableReason: 'Desktop connection is offline.' }],
  archive: { documents: 0 }, approvals: [], version: 'synthetic-test',
};
function emit(event) { for (const response of eventClients) response.write(`data: ${JSON.stringify(event)}\n\n`); }
function json(response, body, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); }
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const authenticated = request.headers.cookie?.includes('synthetic-session=owner');
    if (url.pathname === '/api/auth/status') return json(response, { authenticated: !!authenticated, displayName: 'Synthetic owner', csrf: authenticated ? 'synthetic-csrf' : '', loginUrl: '/auth/login' });
    if (url.pathname === '/auth/login') { response.writeHead(302, { Location: '/', 'Set-Cookie': 'synthetic-session=owner; HttpOnly; SameSite=Strict; Path=/' }); return response.end(); }
    if (url.pathname === '/auth/logout') { assert.equal(request.headers['x-csrf-token'], 'synthetic-csrf'); response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'synthetic-session=; Max-Age=0; HttpOnly; Path=/' }); return response.end('{}'); }
    if (url.pathname === '/api/events') { if (!authenticated) return json(response, { error: 'Sign in required' }, 401); response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); response.write('retry: 100\n\n'); eventClients.add(response); request.on('close', () => eventClients.delete(response)); return; }
    if (url.pathname === '/api/invoke') {
      if (!authenticated) return json(response, { error: 'Sign in required' }, 401);
      assert.equal(request.headers['x-csrf-token'], 'synthetic-csrf');
      let text = ''; for await (const part of request) text += part;
      const { method, payload, requestId } = JSON.parse(text);
      assert.ok(requestId && !requestIds.has(requestId)); requestIds.add(requestId); methods.push(method);
      if (method === 'bootstrap') { bootstrapCount++; return json(response, { ...state, activeRuns }); }
      if (method === 'settings.save') { Object.assign(state.settings, payload); emit({ type: 'state.changed' }); return json(response, state.settings); }
      if (method === 'connections.refresh') return json(response, state.connections);
      if (method === 'conversations.get') return json(response, state.conversations.find(chat => chat.id === payload.id));
      if (method === 'memory.add') { state.memories.push({ id: randomUUID(), text: payload.text, date: new Date().toISOString() }); return json(response, state.memories); }
      if (method === 'memory.delete') { state.memories = state.memories.filter(item => item.id !== payload.id); return json(response, state.memories); }
      if (method === 'memory.search') return json(response, state.memories.filter(item => item.text.includes(payload.query)));
      if (method === 'device.list') return json(response, { devices });
      if (method === 'device.pairingCode') return json(response, { code: 'SYNTHETIC-PRIVATE-CODE', expiresAt: Date.now() + 300000 });
      if (method === 'device.revoke') { devices = devices.map(item => item.id === payload.id ? { ...item, revokedAt: Date.now() } : item); return json(response, {}); }
      if (method === 'data.export') return json(response, { filename: 'synthetic-export.md', mimeType: 'text/markdown', content: '# Synthetic exported context\n' });
      if (method === 'chat.send') {
        lastSent = payload;
        const chat = { id: randomUUID(), title: payload.text, provider: payload.provider, updatedAt: new Date().toISOString(), messages: [{ role: 'user', content: payload.text }, { role: 'assistant', content: '' }] }; state.conversations.push(chat); activeRuns = [{ conversationId: chat.id }];
        json(response, { conversationId: chat.id });
        setTimeout(() => { chat.messages[1].content = 'Synthetic server response.'; emit({ type: 'chat.delta', conversationId: chat.id, text: chat.messages[1].content }); activeRuns = []; emit({ type: 'chat.complete', conversationId: chat.id }); }, 60); return;
      }
      return json(response, { error: `Unexpected frontend request: ${method}` }, 400);
    }
    const relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const filename = path.resolve(root, 'dist', relative);
    if (!filename.startsWith(path.resolve(root, 'dist') + path.sep)) return json(response, { error: 'Not found' }, 404);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' }); response.end(await readFile(filename));
  } catch (error) { if (!response.headersSent) return json(response, { error: error.message }, 500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const entry = path.join(output, 'synthetic-web-host.cjs');
await writeFile(entry, `const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.QA_WEB_PROFILE);app.whenReady().then(()=>{const w=new BrowserWindow({width:390,height:844,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.webContents.session.on('will-download',(_event,item)=>{globalThis.qaDownloadName=item.getFilename();item.cancel()});w.loadURL(process.env.QA_WEB_URL)});app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env, QA_WEB_URL: base, QA_WEB_PROFILE: path.join(output, 'profile-' + randomUUID()) }; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: [entry], env, timeout: 30000 });
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Your private workspace' }).waitFor();
  assert.equal(methods.length, 0, 'No private bootstrap before authentication');
  await page.screenshot({ path: path.join(output, 'phone-sign-in.png') });
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  await page.getByRole('heading', { name: /^(Good (morning|afternoon|evening)|Up late).$/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Browser', exact: true }).count(), 0);
  assert.equal(await page.locator('.workspace-button').count(), 0);
  emit({ type: 'auth.url', provider: 'claude', url: 'https://claude.ai/oauth/authorize?synthetic=1' });
  const loginLink = page.getByRole('link', { name: 'Open provider sign-in', exact: true });
  await loginLink.waitFor();
  assert.equal(await loginLink.getAttribute('href'), 'https://claude.ai/oauth/authorize?synthetic=1');
  assert.equal(await loginLink.getAttribute('target'), '_blank');
  assert.match(await loginLink.getAttribute('rel'), /noopener/);
  await page.getByRole('button', { name: 'Dismiss provider sign-in', exact: true }).click();
  emit({ type: 'auth.url', provider: 'claude', url: 'https://claude.ai.evil.invalid/oauth/authorize' });
  await page.getByText('The provider returned an unsupported sign-in address.', { exact: true }).waitFor();
  assert.equal(await loginLink.count(), 0);
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  assert.equal(await page.getByLabel('Message', { exact: true }).evaluate(node => getComputedStyle(node).fontSize), '16px');
  await page.screenshot({ path: path.join(output, 'phone-home.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
  await page.getByLabel('Message', { exact: true }).fill('Synthetic phone task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Synthetic server response.', { exact: true }).waitFor();
  const before = bootstrapCount; for (const client of eventClients) client.end();
  await page.waitForFunction(() => !document.querySelector('.connection-banner'));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(bootstrapCount > before, 'Reconnect refreshes bootstrap');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('heading', { name: 'Tools & capabilities', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Choose file', exact: true }).count(), 0);
  await page.getByText('Desktop connection is offline.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'phone-tools.png') });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  assert.equal(await page.locator('[data-provider="claude"]').getByRole('button', { name: 'Unavailable on this host' }).isDisabled(), true);
  await page.setViewportSize({ width: 360, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '360px layout fits');
  await page.getByLabel('Filter providers').fill('Gemini');
  await page.locator('[data-provider="gemini"]').getByRole('button', { name: 'Manage connection', exact: true }).click();
  await page.getByRole('heading', { name: 'Set up Gemini', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'phone-provider.png') });
  assert.ok(await page.getByRole('dialog').evaluate(node => node.getBoundingClientRect().right <= innerWidth));
  await page.getByRole('button', { name: 'Close provider setup' }).click();
  // An explicitly supported hosted subscription exposes only its reported
  // models and efforts; the normal unavailable case was checked above.
  Object.assign(state.connections.find(item => item.id === 'claude'), { available: true, connected: true, configured: true });
  state.providerModels = { claude: [{ id: 'synthetic-subscription-model', label: 'Synthetic subscription model', efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultEffort: 'low' }] };
  emit({ type: 'connections', connections: state.connections, providerModels: state.providerModels });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'New chat', exact: false }).click();
  await page.locator('.provider-trigger').click();
  await page.getByLabel('Search providers', { exact: true }).fill('Claude');
  await page.locator('.provider-menu-item').filter({ hasText: 'Claude' }).click();
  await page.getByRole('button', { name: 'Model: auto', exact: true }).click();
  await page.getByLabel('Model', { exact: true }).selectOption('synthetic-subscription-model');
  await page.getByLabel('Reasoning effort', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Reasoning effort', { exact: true }).locator('option').count(), 3);
  await page.getByLabel('Reasoning effort', { exact: true }).selectOption('high');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Synthetic effort task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Synthetic server response.', { exact: true }).waitFor();
  assert.equal(lastSent.model, 'synthetic-subscription-model'); assert.equal(lastSent.effort, 'high');
  await page.locator('.provider-trigger').click();
  await page.getByLabel('Search providers', { exact: true }).fill('Gemini');
  await page.locator('.provider-menu-item').filter({ hasText: 'Gemini' }).click();
  await page.getByRole('button', { name: 'Model: auto', exact: true }).waitFor();
  assert.equal(state.settings.effort, '', 'Switching provider clears unsupported effort');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Memory/ }).click();
  const capture = page.getByLabel('Save new memories', { exact: true });
  assert.equal(await capture.inputValue(), 'automatic');
  assert.equal(await capture.evaluate(node => getComputedStyle(node).fontSize), '16px');
  await capture.selectOption('ask');
  await page.getByRole('heading', { name: 'Review new memories before they are saved', exact: true }).waitFor();
  assert.equal(state.settings.memoryCapture, 'ask');
  await capture.selectOption('automatic');
  await page.getByRole('heading', { name: 'Useful details, saved as you chat', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add a memory', exact: true }).click();
  await page.getByLabel('What should be saved?', { exact: true }).fill('Synthetic phone note to delete.');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  const phoneNote = page.locator('.memory-card').filter({ hasText: 'Synthetic phone note to delete.' });
  await phoneNote.waitFor();
  assert.ok(await phoneNote.getByRole('button', { name: 'Delete memory', exact: true }).evaluate(node => node.getBoundingClientRect().height >= 44));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Memory controls fit a 360px screen');
  await page.screenshot({ path: path.join(output, 'phone-memory.png') });
  await phoneNote.getByRole('button', { name: 'Delete memory', exact: true }).click();
  await page.getByRole('alertdialog').getByText('Synthetic phone note to delete.', { exact: true }).waitFor();
  assert.ok(await page.getByRole('alertdialog').evaluate(node => node.getBoundingClientRect().right <= innerWidth));
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete memory', exact: true }).click();
  await phoneNote.waitFor({ state: 'hidden' });
  assert.equal(state.memories.length, 1); assert.equal(state.memories[0].id, 'synthetic-memory');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Settings', exact: false }).click();
  assert.equal(await page.getByLabel('Save new memories', { exact: true }).inputValue(), 'automatic');
  assert.equal(await page.getByRole('button', { name: 'Choose folder', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Open folder', exact: true }).count(), 0);
  await page.getByText('Synthetic desktop', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create pairing code', exact: true }).click();
  await page.getByText('SYNTHETIC-PRIVATE-CODE', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Hide pairing code', exact: true }).click();
  assert.equal(await page.getByText('SYNTHETIC-PRIVATE-CODE', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke access', exact: true }).click();
  await page.getByText('Access revoked', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Revoke', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Export data', exact: true }).click();
  await page.getByLabel('Include', { exact: true }).selectOption('memory');
  await page.getByLabel('Format', { exact: true }).selectOption('markdown');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByText('Downloaded synthetic-export.md', { exact: true }).waitFor();
  for (let attempt=0;attempt<20 && !(await app.evaluate(()=>globalThis.qaDownloadName));attempt++) await page.waitForTimeout(50);
  assert.equal(await app.evaluate(()=>globalThis.qaDownloadName), 'synthetic-export.md');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('heading', { name: 'Your private workspace' }).waitFor();
  assert.equal(await page.getByText('Synthetic server response.', { exact: true }).count(), 0);
  assert.ok(!methods.some(method => /^(browser\.|mcp\.|workspace\.|app\.openData)/.test(method)), 'No native calls from phone');
  assert.equal(errors.length, 0, errors.join('\n'));
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname)))).flat());
  assert.ok(cached.every(item => !item.startsWith('/api/') && !item.startsWith('/auth/')), 'No authenticated data cached');
  console.log(JSON.stringify({ passed: true, widths: [390, 360], memoryControls: { automaticDefault: true, askFirstPreference: true, noteDeletion: true, unrelatedNotePreserved: true, touchTargets: true }, csrfChecked: requestIds.size, bootstrapCount, cachedPublicAssets: cached.length, screenshots: output }));
} finally { if (app) await app.close(); for (const client of eventClients) client.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

