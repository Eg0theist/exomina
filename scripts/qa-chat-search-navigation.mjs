// Real renderer in a hidden Electron window; all chats and assets are synthetic.
// Holds only search navigation frames so delayed callbacks can be exercised deterministically.
import { _electron as electron, chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), output = await mkdtemp(path.resolve('../Workspace/qa-chat-search-navigation-'));
const headless = process.argv.includes('--headless'), packaged = process.argv.includes('--packaged');
const archive = path.resolve(process.env.EXOMINA_QA_ASAR || 'release/win-unpacked/resources/app.asar');
const sourceSnapshot = process.env.EXOMINA_QA_SOURCE_SNAPSHOT ? path.resolve(process.env.EXOMINA_QA_SOURCE_SNAPSHOT) : null;
let packagedRenderer = null;
const plugins = [];
if (sourceSnapshot) {
  assert.equal(packaged, false, 'source snapshot overlays cannot change the packaged renderer');
  const source = new Map();
  for (const file of ['App.jsx', 'useChatScroll.js']) source.set(path.normalize(path.join(root, 'src', file)), await readFile(path.join(sourceSnapshot, file), 'utf8'));
  plugins.push({ name: 'read-only-source-snapshot', enforce: 'pre', load(id) { return source.get(path.normalize(id.split('?')[0])); } });
}
if (packaged) {
  const html = extractFile(archive, 'dist/index.html').toString();
  const entry = /<script\b[^>]*src="\.\/([^" ]+\.js)"[^>]*><\/script>/.exec(html);
  assert.ok(entry, 'packaged renderer entry must be present');
  const bytes = extractFile(archive, path.join('dist', entry[1]));
  assert.ok(bytes.equals(await readFile(path.join(root, 'dist', entry[1]))), 'packaged renderer must match the current production build');
  packagedRenderer = { archive, entry: entry[1], sha256: createHash('sha256').update(bytes).digest('hex') };
  plugins.push({ name: 'synthetic-packaged-renderer', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (!pathname.startsWith('/qa-packaged/')) return next();
      const file = decodeURIComponent(pathname.slice('/qa-packaged/'.length));
      if (file.split('/').some(part => part === '..') || file.includes('\\')) { response.statusCode = 400; return response.end(); }
      try {
        let content, mime;
        if (file === 'index.html') { content = html.replace(entry[0], entry[0].replace(`./${entry[1]}`, './entry.mjs')); mime = 'text/html'; }
        else if (file === 'entry.mjs') { content = `import '/preview/mock-studio.mjs'; import './${entry[1]}';`; mime = 'text/javascript'; }
        else { content = extractFile(archive, path.join('dist', file)); mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream'; }
        response.setHeader('Content-Type', mime); response.end(content);
      } catch { response.statusCode = 404; response.end(); }
    });
  } });
}
const server = await createServer({ root, plugins, server: { port: 5193, strictPort: false }, logLevel: 'error' });
await server.listen();
const url = `http://localhost:${server.config.server.port}/${packaged ? 'qa-packaged/index.html' : 'preview.html'}`;
const env = { ...process.env, EXOMINA_DESIGN_QA_URL: url, EXOMINA_DESIGN_QA_DIR: path.join(output, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const report = { scope: `${headless ? 'Fresh headless Edge with naturally delivered focus and scroll events' : 'Hidden Electron; native focus moves the pane, then suspended scroll events and search frames are explicitly delivered'}; ${packaged ? 'exact renderer bytes served from app.asar with a synthetic backend' : 'production source renderer with a synthetic backend'}; deliberately delayed search frames; no personal stores or provider calls.`, headless, sourceSnapshot, packagedRenderer, checks: {}, errors: [] };
let app, page, browser;
try {
  if (headless) { browser = await chromium.launch({ channel: 'msedge', headless: true }); const context = await browser.newContext({ viewport: { width: 1360, height: 900 } }); page = await context.newPage(); await page.goto(url); }
  else { app = await electron.launch({ args: [path.join(root, 'scripts/qa-design-main.cjs')], env, timeout: 30000 }); page = await app.firstWindow(); }
  page.setDefaultTimeout(10000); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
  await page.evaluate(async headless => {
    for (const id of ['c1', 'c2']) {
      const chat = await window.studio.invoke('conversations.get', { id });
      chat.title = id === 'c1' ? 'Synthetic navigation source' : 'Synthetic navigation destination';
      chat.messages = Array.from({ length: 86 }, (_, i) => ({ id: `${id}-synthetic-${i}`, role: i % 2 ? 'assistant' : 'user', provider: 'claude', content: `Chat ${id}, message ${i}. ${id === 'c1' && [17, 61].includes(i) ? 'HISTORICAL NEEDLE. ' : ''}` + 'Synthetic wrapped paragraph for a long scrolling conversation. '.repeat(i % 2 ? 36 : 5) }));
      chat.messages.push({ id: `${id}-final-marker`, role: 'assistant', provider: 'claude', content: `FINAL ${id} MARKER` });
      window.__exominaPreviewReplaceChat(chat);
    }
    const nativeFrame = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window);
    const held = new Map();
    // Hidden windows may defer native frames indefinitely; explicit release models
    // the frame being delivered after the suspended window becomes active again.
    window.__searchFrameGate = { active: false, held: () => held.size, release() { this.active = false; const callbacks = [...held.values()]; held.clear(); for (const callback of callbacks) headless ? nativeFrame(callback) : callback(performance.now()); return callbacks.length; } };
    window.requestAnimationFrame = callback => {
      const source = String(callback), search = source.includes('data-message-index') && source.includes('data-search-start') || new Error().stack.includes('showChatHit');
      if (!window.__searchFrameGate.active || !search) return nativeFrame(callback);
      const id = nativeFrame(() => {}); held.set(id, callback); return id;
    };
    window.cancelAnimationFrame = id => { held.delete(id); nativeCancel(id); };
  }, headless);
  const gap = () => page.locator('.chat-scroll').evaluate(el => ({ gap: el.scrollHeight - el.scrollTop - el.clientHeight, top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
  const open = async id => { await page.locator(`[data-chat-id="${id}"] .chat-open`).click(); await page.waitForTimeout(150); };
  const clearSidebar = async () => { const clear = page.getByRole('button', { name: 'Clear chat search', exact: true }); if (await clear.count()) await clear.click(); };
  const queueSearch = async () => {
    await page.evaluate(() => { window.__searchFrameGate.active = true; });
    await page.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('HISTORICAL NEEDLE');
    await open('c1');
    await page.waitForFunction(() => window.__searchFrameGate.held() > 0);
    return page.evaluate(() => window.__searchFrameGate.held());
  };

  for (const [name, target] of [['delayedSearchFromAnotherChat', 'c2'], ['delayedSearchOnReselectedChat', 'c1']]) {
    await clearSidebar(); await open('c1');
    const queued = await queueSearch();
    await clearSidebar(); await open(target);
    const before = await gap();
    const released = await page.evaluate(() => window.__searchFrameGate.release());
    await page.waitForTimeout(200);
    report.checks[name] = { queued, released, before, after: await gap() };
  }

  await open('c2');
  await page.locator('[data-message-index="25"] .message-actions button').first().evaluate((el, headless) => { el.focus(); if (!headless) el.closest('.chat-scroll').dispatchEvent(new Event('scroll')); }, headless);
  await page.waitForTimeout(200);
  report.checks.unexpectedFocusScroll = await gap();
  await open('c2');
  await page.locator('.chat-scroll').evaluate((el, headless) => { el.scrollTop = el.querySelector('[data-message-index="24"]').offsetTop; if (!headless) el.dispatchEvent(new Event('scroll')); }, headless);
  await page.waitForTimeout(200);
  report.checks.unexpectedProgrammaticScroll = await gap();

  // Search still deliberately reveals an old message, and Next match advances.
  await page.evaluate(() => { window.__searchFrameGate.active = true; });
  await page.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('HISTORICAL NEEDLE');
  await open('c1'); await page.waitForFunction(() => window.__searchFrameGate.held() > 0);
  await page.evaluate(() => window.__searchFrameGate.release()); await page.waitForTimeout(100);
  const visible = index => page.locator(`[data-message-index="${index}"]`).evaluate(el => { const outer = el.closest('.chat-scroll').getBoundingClientRect(), rect = el.getBoundingClientRect(); return rect.top < outer.bottom && rect.bottom > outer.top; });
  report.checks.legitimateSearch = { query: await page.getByRole('searchbox', { name: 'Find in this chat', exact: true }).inputValue(), firstVisible: await visible(17), firstGap: await gap() };
  await page.evaluate(() => { window.__searchFrameGate.active = true; });
  await page.getByRole('button', { name: 'Next match', exact: true }).click(); await page.waitForFunction(() => window.__searchFrameGate.held() > 0);
  await page.evaluate(() => window.__searchFrameGate.release()); await page.waitForTimeout(100);
  report.checks.legitimateSearch.nextVisible = await visible(61);
  report.checks.legitimateSearch.nextCount = await page.locator('.chat-find-count').textContent();
  const beforeClose = await gap();
  await page.evaluate(() => { window.__searchFrameGate.active = true; });
  await page.getByRole('button', { name: 'Previous match', exact: true }).click(); await page.waitForFunction(() => window.__searchFrameGate.held() > 0);
  await page.getByRole('button', { name: 'Close chat search', exact: true }).click();
  const releasedAfterClose = await page.evaluate(() => window.__searchFrameGate.release()); await page.waitForTimeout(100);
  report.checks.closedSearchDoesNotApplyPendingHit = { released: releasedAfterClose, before: beforeClose, after: await gap(), searchBars: await page.locator('.chat-find-bar').count() };
  await clearSidebar(); await open('c1');
  report.checks.normalReselectAfterSearch = await gap();

  // Explicit Top and a deliberate wheel scroll continue to hold the reading position.
  await page.getByRole('button', { name: 'Scroll to top of chat', exact: true }).click();
  await page.waitForTimeout(100); report.checks.explicitTop = await gap();
  await open('c1');
  await page.locator('.chat-scroll').evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true })); el.scrollTop -= 600; });
  await page.waitForTimeout(100); const manualBefore = await gap();
  await page.locator('.message:last-child').evaluate(el => { el.append(Object.assign(document.createElement('p'), { textContent: 'Later synthetic layout growth. '.repeat(80) })); });
  await page.waitForTimeout(150); report.checks.manualReading = { before: manualBefore, after: await gap() };
  if (headless) {
    await open('c1');
    await page.locator('.message:last-child .message-actions button').first().evaluate(el => el.focus({ preventScroll: true }));
    let tabs = 0;
    while (tabs < 8 && (await gap()).gap < 100) { await page.keyboard.press('Shift+Tab'); tabs++; await page.waitForTimeout(50); }
    const tabBefore = await gap();
    await page.locator('.message:last-child').evaluate(el => { el.append(Object.assign(document.createElement('p'), { textContent: 'Later keyboard reading layout growth. '.repeat(40) })); });
    await page.waitForTimeout(100);
    report.checks.keyboardReading = { tabs, before: tabBefore, after: await gap(), focusedMessage: await page.evaluate(() => document.activeElement.closest('[data-message-index]')?.dataset.messageIndex) };
    await page.getByRole('button', { name: 'Scroll to bottom of chat', exact: true }).click(); await page.waitForTimeout(100);
    report.checks.explicitBottom = await gap();
  }

  for (const name of ['delayedSearchFromAnotherChat', 'delayedSearchOnReselectedChat']) {
    assert.ok(report.checks[name].before.gap < 3, `${name}: regular navigation must initially pin to latest`);
    assert.ok(report.checks[name].after.gap < 3, `${name}: delayed old search callback must not move the reopened chat`);
    assert.equal(report.checks[name].released, 0, `${name}: navigation must cancel the queued search frame`);
  }
  assert.ok(report.checks.unexpectedFocusScroll.gap < 3, 'native focus scroll while pinned must return to latest');
  assert.ok(report.checks.unexpectedProgrammaticScroll.gap < 3, 'unexpected scroll while pinned must return to latest');
  assert.equal(report.checks.legitimateSearch.query, 'HISTORICAL NEEDLE');
  assert.equal(report.checks.legitimateSearch.firstVisible, true); assert.equal(report.checks.legitimateSearch.nextVisible, true);
  assert.equal(report.checks.legitimateSearch.nextCount, '2 of 2');
  assert.equal(report.checks.closedSearchDoesNotApplyPendingHit.released, 0); assert.equal(report.checks.closedSearchDoesNotApplyPendingHit.searchBars, 0);
  assert.ok(Math.abs(report.checks.closedSearchDoesNotApplyPendingHit.before.top - report.checks.closedSearchDoesNotApplyPendingHit.after.top) < 3);
  assert.ok(report.checks.normalReselectAfterSearch.gap < 3); assert.equal(report.checks.explicitTop.top, 0);
  assert.ok(report.checks.manualReading.before.gap > 100); assert.ok(Math.abs(report.checks.manualReading.after.top - report.checks.manualReading.before.top) < 3);
  if (headless) { assert.ok(report.checks.keyboardReading.before.gap > 100); assert.ok(Math.abs(report.checks.keyboardReading.after.top - report.checks.keyboardReading.before.top) < 3); assert.ok(report.checks.explicitBottom.gap < 3); }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally { await browser?.close(); await app?.close(); await server.close(); await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, ...report }, null, 2)); }
