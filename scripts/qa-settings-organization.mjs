// Real renderer with a synthetic backend. No accounts, private app data or model calls.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extractFile } from '@electron/asar';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), output = path.resolve(process.argv[2] || '../Workspace/qa-settings-organization');
await mkdir(output, { recursive: true });
const packagedAsar = process.env.EXOMINA_QA_PACKAGED_ASAR;
const packagedResources = {}, packagedPrefix = '/__qa_packaged/';
const packagedPlugin = packagedAsar ? {
  name: 'qa-exact-packaged-renderer',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (!pathname.startsWith(packagedPrefix)) return next();
      const relative = pathname.slice(packagedPrefix.length);
      if (!relative || relative.split('/').some(part => !part || part === '..' || part === '.')) { res.statusCode = 400; return res.end(); }
      try {
        const asset = `dist/${relative}`, bytes = extractFile(packagedAsar, path.join('dist', ...relative.split('/')));
        packagedResources[asset] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json' })[path.extname(relative)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        if (relative === 'index.html') {
          // Add only the synthetic backend and URL prefix; compiled JS/CSS bytes stay exact.
          const html = bytes.toString('utf8').replaceAll('./assets/', `${packagedPrefix}assets/`).replace('<head>', '<head><script type="module" src="/preview/mock-studio.mjs"></script>');
          return res.end(html);
        }
        res.end(bytes);
      } catch (error) { res.statusCode = 404; res.end('QA packaged resource unavailable'); }
    });
  },
} : null;
const server = await createServer({ root, plugins: packagedPlugin ? [packagedPlugin] : [], server: { port: 0, hmr: false }, logLevel: 'error' });
await server.listen();
const env = { ...process.env, EXOMINA_DESIGN_QA_URL: `http://localhost:${server.config.server.port}${packagedAsar ? `${packagedPrefix}index.html` : '/preview.html'}`, EXOMINA_DESIGN_QA_DIR: output };
delete env.ELECTRON_RUN_AS_NODE;
const report = { scope: 'Hidden Electron production renderer, synthetic backend; no personal profile or account access.', checks: {}, errors: [] };
if (packagedAsar) {
  report.scope = 'Exact packaged compiled renderer assets with synthetic preview backend, served on loopback in a hidden Electron window; production host, account stores and live providers excluded.';
  report.packagedAsar = path.resolve(packagedAsar);
  report.packagedVersion = JSON.parse(extractFile(packagedAsar, 'package.json').toString('utf8')).version;
  report.packagedBuild = JSON.parse(await readFile(path.resolve(path.dirname(packagedAsar), '../exomina.build.json'), 'utf8'));
}
let app;
try {
  app = await electron.launch({ args: [path.join(root, 'scripts/qa-design-main.cjs')], env, timeout: 30000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Dots', exact: true }).count(), 0);
  assert.equal(await page.getByText('Encrypted on this device', { exact: true }).count(), 0);
  report.checks.sidebarPreviewAndRemovedLabel = true;
  await page.keyboard.press('Control+,');
  await page.getByLabel('Search settings', { exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button').count(), 6);
  const categories = [
    ['General', ['general', 'updates', 'about']], ['Models & usage', ['defaults', 'models', 'usage', 'local-ai']],
    ['Conversation', ['personalization', 'spelling']], ['Appearance & audio', ['appearance', 'sounds', 'voice']],
    ['Privacy & data', ['permissions', 'memory', 'data']], ['Connections & sync', ['connections', 'integrations', 'messaging']],
  ];
  for (const [category, ids] of categories) {
    await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: category, exact: true }).click();
    for (const id of ids) assert.equal(await page.locator(`#settings-${id}`).isVisible(), true, `${id} remains available`);
    const visible = await page.locator('.settings-panel:not([hidden])').count();
    assert.equal(visible, ids.length);
  }
  report.checks.all16SectionsAvailableInSixCategories = true;
  const search = page.getByLabel('Search settings', { exact: true });
  for (const [query, id] of [['fallback', 'models'], ['reset credits', 'usage'], ['encrypted', 'memory'], ['spelling', 'spelling'], ['voice', 'voice'], ['MCP', 'integrations']]) {
    await search.fill(query);
    const result = page.locator('.settings-search-result'); await result.first().waitFor();
    await search.press('Enter');
    assert.equal(await search.inputValue(), '');
    await page.locator(`#settings-${id}`).waitFor();
    await page.waitForFunction(id => { const el = document.getElementById(`settings-${id}`), own = el.getBoundingClientRect(), pane = el.closest('.settings-panel-scroll').getBoundingClientRect(); return own.top >= pane.top - 1 && own.top < pane.bottom; }, id);
    const bounds = await page.locator(`#settings-${id}`).evaluate(el => { const own = el.getBoundingClientRect(), pane = el.closest('.settings-panel-scroll').getBoundingClientRect(); return { top: own.top, paneTop: pane.top, paneBottom: pane.bottom }; });
    assert.ok(bounds.top >= bounds.paneTop - 1 && bounds.top < bounds.paneBottom, `${id} deep link visible`);
  }
  await search.fill('not-a-real-setting');
  await page.getByText('0 sections found', { exact: false }).waitFor();
  await search.press('Escape'); assert.equal(await search.inputValue(), '');
  report.checks.searchAndDeepLinks = true;
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Conversation', exact: true }).click();
  const instructions = page.locator('.persona-field').filter({ has: page.getByText('Instructions', { exact: true }) }).locator('textarea');
  await instructions.fill('Synthetic settings draft remains available.');
  // Changing categories saves on blur and retains the same mounted component.
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'General', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Conversation', exact: true }).click();
  assert.equal(await instructions.inputValue(), 'Synthetic settings draft remains available.');
  assert.equal((await page.evaluate(() => window.studio.invoke('bootstrap'))).settings.personalization.instructions, 'Synthetic settings draft remains available.');
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Models & usage', exact: true }).click();
  await page.getByLabel('Default provider', { exact: true }).selectOption('codex');
  assert.equal((await page.evaluate(() => window.studio.invoke('bootstrap'))).settings.provider, 'codex');
  report.checks.controlsSaveAndDraftsSurvive = true;
  await page.getByRole('button', { name: 'Exomina home', exact: true }).click();
  await page.keyboard.press('Control+,');
  await page.getByRole('navigation',{name:'Settings categories'}).getByRole('button',{name:'General',exact:true}).click();
  await page.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Updates',exact:true}).click();
  await page.locator('#settings-updates').waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'General', exact: true }).getAttribute('aria-current'), 'page');
  report.checks.externalUpdateDeepLink = true;
  await page.getByRole('button', { name: 'Exomina home', exact: true }).click();
  await page.locator('.usage-summary').click();
  await page.locator('.usage-details').getByRole('button', { name: 'Details', exact: true }).click();
  await page.waitForFunction(() => { const el = document.getElementById('settings-usage'), own = el?.getBoundingClientRect(), pane = el?.closest('.settings-panel-scroll').getBoundingClientRect(); return own && own.top >= pane.top - 1 && own.top < pane.bottom; });
  report.checks.externalUsageDeepLink = true;
  await search.fill('voice');
  await page.locator('.usage-summary').click();
  await page.locator('.usage-details').getByRole('button', { name: 'Details', exact: true }).click();
  assert.equal(await search.inputValue(), '');
  await page.locator('#settings-usage').waitFor();
  report.checks.externalDeepLinkClearsSearch = true;
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Privacy & data', exact: true }).click();
  for (const [width, height] of [[1360, 900], [1000, 760], [760, 680]]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(height => getComputedStyle(document.documentElement).getPropertyValue('--viewport-height').trim() === `${height}px`, height);
    const geometry = await page.locator('.settings-organized').evaluate(el => ({ overflow: el.scrollWidth > el.clientWidth + 1, pane: (() => { const r = el.querySelector('.settings-panel-scroll').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right }; })(), width: innerWidth, height: innerHeight }));
    assert.equal(geometry.overflow, false);
    assert.ok(geometry.pane.right <= geometry.width + 1 && geometry.pane.bottom <= geometry.height + 1, JSON.stringify(geometry));
    await page.screenshot({ path: path.join(output, `settings-${width}.png`) });
  }
  report.checks.responsiveLayout = true;
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally { await app?.close().catch(() => {}); await server.close(); if (packagedAsar) report.packagedResources = packagedResources; await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
