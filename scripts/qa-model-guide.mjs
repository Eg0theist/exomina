// Real renderer with a synthetic backend. No account access or provider requests.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), output = path.resolve('../Workspace/notes-batch-20261020/model-guide');
await mkdir(output, { recursive: true });
const server = await createServer({ root, logLevel: 'error', server: { port: 0, hmr: false } });
await server.listen();
const env = { ...process.env, EXOMINA_DESIGN_QA_URL: `http://localhost:${server.config.server.port}/preview.html`, EXOMINA_DESIGN_QA_DIR: path.join(output, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const report = { passed: false, checks: {}, errors: [], scope: 'Real hidden renderer, synthetic catalogue and backend; no inference or account access.' };
let app, page;
try {
  app = await electron.launch({ args: [path.join(root, 'scripts/qa-design-main.cjs')], env });
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.errors.push(error.message));
  const view = page.getByRole('combobox', { name: 'Interface view', exact: true }); await view.waitFor();
  await view.selectOption('advanced');
  await page.evaluate(async () => {
    const data = await window.studio.invoke('bootstrap');
    data.providerModels.codex = [{ id: 'auto', isDefault: true, efforts: [{ id: 'medium' }] }, { id: 'gpt-6-luna', label: 'Luna', efforts: [{ id: 'low' }] }, { id: 'gpt-6.1-sol', label: 'Sol', efforts: [{ id: 'medium' }] }, { id: 'gpt-6-astra', label: 'Astra', efforts: [{ id: 'high' }] }];
    await window.studio.invoke('settings.save', { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', speed: '', modelPreferences: { models: { codex: ['auto', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'] } } });
  });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('KEEP_UNSENT_MODEL_GUIDE_DRAFT');
  await page.getByRole('button', { name: 'Choose AI, model and effort', exact: true }).click();
  const openGuide = async () => { const details = page.locator('.model-choice-guide'); if (!await details.getAttribute('open').then(value => value !== null)) await details.locator('summary').click(); };
  await openGuide();
  const pick = async (title, model, effort) => {
    const start = await page.evaluate(() => window.__exominaPreviewCalls.length);
    await page.getByRole('button', { name: 'Use suggestion: ' + title, exact: true }).click();
    await page.waitForFunction(async ({ model, effort }) => { const data = await window.studio.invoke('bootstrap'); return data.settings.model === model && data.settings.effort === effort; }, { model, effort });
    const calls = await page.evaluate(start => window.__exominaPreviewCalls.slice(start).filter(call => call.method === 'settings.save'), start);
    assert.equal(calls.length, 1, 'model and effort must be saved atomically');
    const data = await page.evaluate(() => window.studio.invoke('bootstrap'));
    assert.equal(data.settings.provider, 'codex'); assert.equal(data.settings.speed, '');
  };
  await pick('Difficult problem', 'gpt-6-astra', 'high'); report.checks.advancedAppliesReportedModelAndEffortOnce = true;
  await view.selectOption('standard'); await openGuide();
  await pick('Everyday work', 'gpt-6.1-sol', 'medium');
  await pick('Small, clear task', 'gpt-6-luna', 'low'); report.checks.standardChoicesUseSupportedSettings = true;
  await page.evaluate(async () => window.studio.invoke('settings.save', { modelPreferences: { models: { codex: ['auto', 'gpt-6.1-sol'] } } }));
  await page.getByRole('button', { name: 'Use suggestion: Small, clear task', exact: true }).getByText('Provider default · medium effort', { exact: true }).waitFor();
  report.checks.hiddenModelIsNotSuggested = true;
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'KEEP_UNSENT_MODEL_GUIDE_DRAFT');
  assert.equal(await page.evaluate(() => window.__exominaPreviewCalls.filter(call => call.method === 'chat.send').length), 0);
  report.checks.draftUnchangedAndNothingSent = true;
  await page.screenshot({ path: path.join(output, 'standard-guide.png') });
  await page.keyboard.press('Escape'); await page.setViewportSize({ width: 560, height: 820 });
  await page.getByRole('button', { name: 'Choose AI', exact: true }).click(); await openGuide();
  assert.equal(await page.locator('.model-choice-guide').evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
  report.checks.narrowGuideHasNoHorizontalOverflow = true;
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
finally { await app?.close(); await server.close(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify({ output, ...report }, null, 2)); }
