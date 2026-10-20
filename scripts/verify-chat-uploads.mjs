// Local renderer smoke test against preview.html's synthetic backend only.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8QsAAAAASUVORK5CYII=';
const browser = await chromium.launch({ headless: true, executablePath: process.env.EXOMINA_TEST_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5179/preview.html?usage-pending');
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  // Missing Claude numbers must keep its connected subscription visible.
  await page.locator('.usage-chip').filter({ hasText: 'Claude usage pending' }).waitFor();
  await page.locator('.usage-summary').click();
  await page.getByText('Claude has not reported current usage percentages.', { exact: false }).waitFor();
  await page.locator('.usage-summary').click();
  await page.locator('.new-chat-button').click();
  const input = page.locator('input[type=file][multiple]');
  await input.setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('Synthetic upload content') });
  await page.locator('.attachment-draft').getByText('notes.md', { exact: true }).waitFor();
  // Deliver the same clipboard event produced by pasting a screenshot.
  await page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), data = new DataTransfer();
    data.items.add(new File([bytes], 'Screenshot.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, png);
  await page.locator('.attachment-draft img').waitFor();
  await page.locator('.attachment-draft img').evaluate(image => image.decode());
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), true);
  await mkdir('.verification', { recursive: true });
  for (const width of [1380, 1000, 760, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(350); // Let responsive layout transitions finish.
    const layout = await page.locator('.composer-toolbar').evaluate(element => {
      const bounds = element.getBoundingClientRect(), items = [...element.children].filter(item => item.getBoundingClientRect().width > 0).map(item => { const r = item.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      return { left: bounds.left, right: bounds.right, items };
    });
    assert.ok(Math.max(...layout.items.map(item => item.y + item.height / 2)) - Math.min(...layout.items.map(item => item.y + item.height / 2)) < 3, `Controls share one row at ${width}px`);
    assert.ok(layout.items.every(item => item.x >= layout.left - 1 && item.x + item.width <= layout.right + 1), `Controls fit at ${width}px`);
    await page.screenshot({ path: `.verification/chat-uploads-${width}.png` });
  }
  await page.getByRole('button', { name: 'Remove notes.md', exact: true }).click();
  assert.equal(await page.locator('.attachment-draft .attachment-chip').count(), 1);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.locator('.message.user img').waitFor();
  assert.equal(await page.locator('.attachment-draft').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Renderer passed: file selection, screenshot paste, image preview, attachment-only send, removal and toolbar alignment at four widths.');
} finally { await browser.close(); }
