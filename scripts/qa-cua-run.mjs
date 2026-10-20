import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runScopedCuaQa } from './qa-cua.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputPath = path.resolve(projectRoot, '../cua-qa-result.json');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const report = { startedAt: new Date().toISOString(), scope: 'Dedicated synthetic fixture only; exact PID and HWND from Electron main; no app/window enumeration or full-desktop capture.' };
try {
  app = await electron.launch({ executablePath: path.join(projectRoot, 'node_modules/electron/dist/electron.exe'), args: [path.join(projectRoot, 'scripts/qa-cua-fixture.cjs')], cwd: projectRoot, env, timeout: 30000 });
  const page = await app.firstWindow();
  await page.locator('#cua-field').waitFor();
  const target = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const handle = window.getNativeWindowHandle();
    return { pid: process.pid, windowId: Number(handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE()), expectedTitle: window.getTitle() };
  });
  report.target = target;
  const expectedText = 'Exomina CUA verified – ä 中文';
  report.cua = await runScopedCuaQa({ ...target, expectedText, allowForeground: true });
  const observed = await page.evaluate(() => ({ value: document.getElementById('cua-field').value, status: document.getElementById('cua-status').textContent }));
  assert.equal(observed.value, expectedText);
  assert.equal(observed.status, `Confirmed: ${expectedText}`);
  report.independentDomReadback = observed;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = { message: error.message, stack: error.stack };
  if (error.cuaSteps) report.nativeSteps = error.cuaSteps;
  if (app) {
    try { report.domOnFailure = await (await app.firstWindow()).evaluate(() => ({ value: document.getElementById('cua-field').value, status: document.getElementById('cua-status').textContent, events: window.fixtureEvents })); }
    catch (readbackError) { report.domReadbackError = readbackError.message; }
  }
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
