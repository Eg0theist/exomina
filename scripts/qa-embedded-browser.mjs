import { _electron as electron } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'output/playwright/embedded-browser');
await fs.mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: 'Production Electron host, IPC, tool dispatch and approval UI; synthetic provider and localhost-only page; isolated workspace app profile.' };
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Embedded browser QA fixture</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>body{background:#15211f;color:#eefbf3;font:18px system-ui;padding:30px}input,button{display:block;margin:16px 0;padding:12px;font:inherit;border-radius:8px;max-width:90%}button{background:#b8f4ce;color:#12251a;border:0}input{width:340px}p{line-height:1.5}</style></head>
<body><h1>Embedded browser QA fixture</h1><p>This page contains synthetic test data only.</p><input id="fixture-input" aria-label="Synthetic browser field" value=""><button id="fixture-submit">Confirm synthetic value</button><p id="fixture-result" role="status">No value submitted</p><script>document.getElementById('fixture-submit').addEventListener('click',()=>{document.getElementById('fixture-result').textContent='Confirmed: '+document.getElementById('fixture-input').value;});</script></body></html>`;
const requests = [];
const server = http.createServer((req, res) => { requests.push(req.url); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/synthetic-fixture`;
const env = { ...process.env, EXOMINA_DATA_DIR: path.resolve(root, `../qa-embedded-userdata-${Date.now()}`) };
delete env.ELECTRON_RUN_AS_NODE;
await fs.mkdir(path.join(env.EXOMINA_DATA_DIR, 'browser-data'), { recursive: true });
let app, page;
async function until(read, accepted, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value;
  do { value = await read(); if (accepted(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for QA state: ${JSON.stringify(value)}`);
}
try {
  app = await electron.launch({ args: [path.join(root, 'scripts/qa-embedded-launcher.cjs')], cwd: root, env, timeout: 30000 });
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Exomina home' }).waitFor();
  await until(() => page.evaluate(() => window.studio.invoke('bootstrap')), state => state.connections.length === 2 && state.connections.every(c => c.connected));
  await page.evaluate(() => window.studio.invoke('settings.save', { memoryEnabled: false, browserEnabled: false }));
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await page.getByLabel('Browser address').fill(fixtureUrl);
  await page.getByRole('button', { name: 'Search or navigate' }).click();
  report.manualNavigation = await until(() => page.evaluate(() => window.studio.invoke('browser.state')), state => state.url === fixtureUrl && state.title === 'Embedded browser QA fixture' && !state.loading);
  assert.equal(report.manualNavigation.title, 'Embedded browser QA fixture');

  const contentsId = await app.evaluate(({ webContents }, url) => {
    const matches = webContents.getAllWebContents().filter(wc => wc.getURL() === url);
    if (matches.length !== 1) throw new Error('Expected one exact synthetic embedded page.');
    return matches[0].id;
  }, fixtureUrl);
  const readFixture = () => app.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id);
    return wc.executeJavaScript('({value:document.getElementById("fixture-input").value,status:document.getElementById("fixture-result").textContent,hasNode:typeof require!=="undefined",hasAppBridge:typeof window.studio!=="undefined"})');
  }, contentsId);
  report.rendererIsolation = await readFixture();
  assert.equal(report.rendererIsolation.hasNode, false);
  assert.equal(report.rendererIsolation.hasAppBridge, false);

  const sent = await page.evaluate(() => window.studio.invoke('chat.send', { text: 'Synthetic browser QA only', provider: 'codex' }));
  await app.evaluate(async () => { const end = Date.now() + 5000; while (!globalThis.__embeddedQa) { if (Date.now() > end) throw new Error('Synthetic run did not start'); await new Promise(resolve => setTimeout(resolve, 20)); } });
  const directTool = (name, args = {}) => app.evaluate(async (_electron, request) => globalThis.__embeddedQa.call(request.name, request.args), { name, args });
  const disabled = await directTool('browser_snapshot');
  assert.equal(disabled.isError, true);
  assert.match(disabled.content[0].text, /off/);
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  report.disabledGate = true;
  await page.evaluate(() => window.studio.invoke('settings.save', { browserEnabled: true }));

  const request = async (name, args, approve, beforeDecision) => {
    let finished = false;
    const pending = directTool(name, args).then(result => { finished = true; return result; });
    pending.catch(() => {}); // Preserve the primary assertion if cleanup closes a pending request.
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    assert.equal(finished, false, 'Tool must wait for approval.');
    const childContents = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(view => view.webContents?.id ?? null));
    assert.equal(childContents.includes(contentsId), false, 'The exact embedded native browser must be removed while the approval dialog is shown.');
    report.approvalNativeViewHidden = true;
    if (beforeDecision) await beforeDecision();
    await dialog.getByRole('button', { name: approve ? 'Allow once' : 'Deny', exact: true }).click();
    const result = await pending;
    await dialog.waitFor({ state: 'hidden' });
    return result;
  };

  const denied = await request('browser_type', { selector: '#fixture-input', text: 'Denied text must never appear' }, false, async () => assert.equal((await readFixture()).value, ''));
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /declined/);
  assert.equal((await readFixture()).value, '');
  report.deniedActionDidNotExecute = true;

  const snapshot = await request('browser_snapshot', {}, true);
  assert.notEqual(snapshot.isError, true);
  const state = JSON.parse(snapshot.content.find(item => item.type === 'text').text);
  assert.equal(state.url, fixtureUrl);
  assert.match(state.text, /synthetic test data/);
  const field = state.elements.find(item => item.tag === 'INPUT' && item.text === 'Synthetic browser field');
  const button = state.elements.find(item => item.tag === 'BUTTON' && item.text === 'Confirm synthetic value');
  assert.ok(field?.selector && button?.selector);
  const screenshot = snapshot.content.find(item => item.type === 'image');
  assert.ok(screenshot?.data);
  const png = Buffer.from(screenshot.data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  await fs.writeFile(path.join(output, 'embedded-view.png'), png);
  report.snapshot = { elementCount: state.elements.length, screenshotBytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };

  const expectedText = 'Shared browser works — ä 中文 {literal}';
  const filled = await request('browser_type', { selector: field.selector, text: expectedText }, true, async () => assert.equal((await readFixture()).value, ''));
  assert.notEqual(filled.isError, true);
  assert.equal((await readFixture()).value, expectedText);
  const clicked = await request('browser_click', { selector: button.selector }, true);
  assert.notEqual(clicked.isError, true);
  const readback = await readFixture();
  assert.equal(readback.status, `Confirmed: ${expectedText}`);
  report.toolReadback = readback;
  const after = await request('browser_snapshot', {}, true);
  assert.match(JSON.parse(after.content.find(item => item.type === 'text').text).text, /Confirmed: Shared browser works/);
  report.approvedFillClickAndSnapshot = true;

  const directCapture = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), contentsId);
  await fs.writeFile(path.join(output, 'embedded-view-after.png'), Buffer.from(directCapture, 'base64'));
  await page.screenshot({ path: path.join(output, 'app-with-browser.png') });
  await app.evaluate(() => globalThis.__embeddedQa.complete());
  await until(() => page.evaluate(id => window.studio.invoke('conversations.get', { id }), sent.conversationId), conversation => conversation.messages.at(-1).content.includes('Synthetic browser QA completed'));
  report.fixtureRequests = requests;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = { message: error.message, stack: error.stack };
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
