// Real renderer, generated theme assets, synthetic backend and an isolated profile.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { THEMES } from '../desktop/themes.mjs';

const root = process.cwd();
const output = path.resolve('../Workspace/qa-theme-art');
await mkdir(output, { recursive: true });
const server = await createServer({ root, server: { port: 5191, strictPort: false }, logLevel: 'error' });
await server.listen();
const env = { ...process.env, EXOMINA_DESIGN_QA_URL: `http://localhost:${server.config.server.port}/preview.html`, EXOMINA_DESIGN_QA_DIR: path.join(output, 'renderer-profile') };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const report = { errors: [], checks: {}, themes: {}, scope: 'Synthetic renderer preview; no real account or model access.' };
try {
  app = await electron.launch({ args: [path.join(root, 'scripts/qa-design-main.cjs')], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
  const appearance = async () => {
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: 'Appearance', exact: true }).first().click();
    await page.waitForTimeout(450);
  };
  const shot = async name => { await page.waitForTimeout(180); await page.screenshot({ path: path.join(output, name + '.png') }); };
  for (const theme of THEMES.filter(theme => theme.artwork)) {
    await appearance();
    await page.getByRole('radio', { name: new RegExp('^' + theme.name) }).click();
    await page.waitForFunction(id => document.documentElement.dataset.theme === id, theme.id);
    const asset = await page.evaluate(async artwork => {
      const img = new Image();
      img.src = new URL(artwork, document.baseURI).href;
      await img.decode();
      return { url: img.src, width: img.naturalWidth, height: img.naturalHeight, root: document.documentElement.style.getPropertyValue('--theme-art') };
    }, theme.artwork);
    assert.ok(asset.width >= 1500 && asset.width * asset.height >= 1500000, 'Artwork has at least 1.5 megapixels, including panoramic assets');
    assert.ok(asset.root.includes(theme.artwork));
    await page.getByRole('button', { name: 'Exomina home', exact: true }).click();
    await shot(theme.id + '-home');
    await page.locator('[data-chat-id="c1"] .chat-open').click();
    await shot(theme.id + '-chat');
    report.themes[theme.id] = { ...asset, styles: await page.evaluate(() => ({
      backdrop: getComputedStyle(document.querySelector('.main-shell'), '::before').backgroundImage,
      reading: getComputedStyle(document.querySelector('.message.assistant')).backgroundColor,
      composer: getComputedStyle(document.querySelector('.composer')).backgroundColor,
      warning: (() => {
        const banner = document.querySelector('.usage-banner');
        if (!banner) return null;
        const background = getComputedStyle(banner).backgroundColor;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.fillStyle = background;
        context.fillRect(0, 0, 1, 1);
        return { background, alpha: context.getImageData(0, 0, 1, 1).data[3] };
      })(),
      overlayPointerEvents: getComputedStyle(document.querySelector('.main-shell'), '::before').pointerEvents
    })) };
    assert.ok(report.themes[theme.id].styles.backdrop.includes(theme.artwork));
    assert.equal(report.themes[theme.id].styles.overlayPointerEvents, 'none');
    assert.ok(report.themes[theme.id].styles.warning?.alpha >= 244, 'Usage warnings need a readable panel over the artwork.');
    await page.getByLabel('Message', { exact: true }).fill('Theme controls remain usable.');
    await page.locator('.model-chip').click();
    await page.locator('.model-popover').waitFor();
    await page.keyboard.press('Escape');
  }
  await appearance();
  await page.locator('#settings-appearance').evaluate(e => {
    const scroller=e.closest('.content-page');
    scroller.scrollTo({top:scroller.scrollTop+e.getBoundingClientRect().top-scroller.getBoundingClientRect().top-120,behavior:'instant'});
  });
  assert.equal(await page.locator('.theme-group.extravagant .tp-artwork').count(), THEMES.filter(theme => theme.artwork).length);
  await shot('theme-gallery');
  report.checks.artworkGallery = true;
  await page.getByRole('radio', { name: 'Always reduce', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'reduced');
  assert.equal(await page.locator('.main-shell').evaluate(e => getComputedStyle(e, '::after').animationName), 'none');
  report.checks.reducedMotion = true;
  await page.getByRole('radio', { name: /^Neon Leather/ }).click();
  await page.getByRole('button', { name: 'Exomina home', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 720));
  await shot('neon-leather-narrow');
  const layout = await page.locator('.composer').evaluate(e => {
    const r = e.getBoundingClientRect();
    return { left: r.left, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.bottom <= layout.height && !layout.overflow, JSON.stringify(layout));
  report.checks.narrowComposer = layout;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 900));
  await appearance();
  await page.getByRole('radio', { name: /^Paper/ }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'paper');
  assert.equal(await page.locator('html').getAttribute('data-artwork'), null);
  assert.equal(await page.locator('html').evaluate(e => e.style.getPropertyValue('--theme-art')), '');
  await page.getByRole('button', { name: 'Exomina home', exact: true }).click();
  await shot('paper-after-artwork');
  report.checks.plainThemeRestored = true;
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
  if (app) { const page = await app.firstWindow(); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await app?.close();
  await server.close();
}
