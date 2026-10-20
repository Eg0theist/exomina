// Real renderer, synthetic backend and reset confirmations. No real redemption or account data.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const root = process.cwd(), output = path.resolve(process.argv[2] || '../Workspace/qa-model-policies');
await mkdir(output, { recursive: true });
const server = await createServer({ root, server: { port: 5186, strictPort: false, hmr: false }, logLevel: 'error' });
await server.listen();
const env = { ...process.env, EXOMINA_DESIGN_QA_URL: `http://localhost:${server.config.server.port}/preview.html`, EXOMINA_DESIGN_QA_DIR: path.join(output, 'renderer-profile') }; delete env.ELECTRON_RUN_AS_NODE;
let app;
const report = { passed: false, checks: {}, errors: [] };
try {
  app = await electron.launch({ args: [path.join(root, 'scripts/qa-design-main.cjs')], env, timeout: 30000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Exomina home' }).waitFor();
  await page.locator('[data-chat-id="c1"] .chat-open').click();
  await page.getByLabel('Message', { exact: true }).waitFor();
  await page.locator('.usage-summary').click();
  await page.locator('.usage-refresh-row [title="Refreshes every minute"]').waitFor();
  await page.locator('.usage-details .usage-credits-compact:not([open]) > summary').click();
  await page.getByText('Provider reports 2 available reset credits.', { exact: true }).waitFor();
  for (const height of [650, 900]) {
    await page.setViewportSize({ width: 1360, height });
    const bounds = await page.locator('.usage-details').evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: window.innerHeight }; });
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height, 'usage popover must fit the screen and scroll its own contents');
  }
  report.checks.usageFitsViewport = true;
  await page.locator('.usage-details h3').first().click();
  assert.equal(await page.locator('.usage-details').count(), 1, 'clicks inside keep the panel open');
  await page.getByLabel('Message', { exact: true }).click();
  assert.equal(await page.locator('.usage-details').count(), 0, 'click-away closes usage');
  await page.locator('.usage-summary').click(); await page.locator('.usage-details').waitFor();
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.usage-details').count(), 0);
  report.checks.usageDismissal = true;
  await page.evaluate(async () => {
    await window.studio.invoke('conversations.permission', { id: 'c1', mode: 'full' });
    await window.studio.invoke('conversations.personalize', { id: 'c1', personalization: { tone: 'warm' } });
  });
  await page.locator('.chat-style .composer-chip.is-own').waitFor();
  await page.locator('.permission-picker:not(.chat-style) .composer-chip.is-own').waitFor();
  assert.equal(await page.locator('.chip-own-dot').count(), 0);
  report.checks.customSettingsNoDots = true;

  await page.keyboard.press('Control+,');
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Models & usage', exact: true }).click();
  const settings = page.locator('#settings-models'); await settings.scrollIntoViewIfNeeded();
  await settings.getByText('Claude', { exact: true }).click();
  await settings.getByLabel('Show Claude in pickers', { exact: true }).uncheck();
  await settings.getByText('ChatGPT', { exact: true }).click();
  await settings.getByLabel('Show ChatGPT GPT-6 mini', { exact: true }).uncheck();
  if (await settings.getByLabel('Automatic usage fallback', { exact: true }).getAttribute('aria-checked') !== 'true') await settings.getByLabel('Automatic usage fallback', { exact: true }).click();
  await settings.getByLabel('Fallback selection', { exact: true }).selectOption('ordered');
  await settings.getByLabel('Fallback AI', { exact: true }).selectOption('codex');
  await settings.getByLabel('Fallback model', { exact: true }).selectOption('gpt-6');
  await settings.getByRole('button', { name: 'Add fallback', exact: true }).click();
  await settings.locator('.fallback-targets').getByText('ChatGPT · GPT-6', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'model-settings.png') });
  const saved = await page.evaluate(async () => (await window.studio.invoke('bootstrap')).settings.modelPreferences);
  assert.equal(saved.fallback.enabled, true); assert.equal(saved.fallback.targets[0].model, 'gpt-6');
  assert.ok(saved.hiddenProviders.includes('claude')); assert.ok(!saved.models.codex.includes('gpt-6-mini'));
  report.checks.visibilityAndFallbackSaved = true;

  await page.getByRole('button', { name: 'Exomina home', exact: true }).click();
  await page.locator('.provider-cards').waitFor();
  const cards = await page.locator('.provider-card strong').allTextContents();
  assert.ok(cards.includes('ChatGPT')); assert.ok(!cards.includes('Claude')); assert.ok(!cards.includes('Gemini'));
  await page.screenshot({ path: path.join(output, 'filtered-home.png') });
  await page.getByRole('button', { name: 'Choose AI, model and effort' }).click();
  const offered = await page.getByLabel('AI connection', { exact: true }).locator('option').allTextContents();
  assert.ok(!offered.some(value => value.startsWith('Claude')) && !offered.some(value => value.startsWith('Gemini')));
  assert.equal(await page.getByRole('button', { name: /^GPT-6 mini/ }).count(), 0);
  assert.equal(await page.getByRole('option', { name: /^GPT-6 mini/ }).count(), 0);
  await page.getByRole('option', { name: /^GPT-6 4 effort/ }).waitFor();
  await page.screenshot({ path: path.join(output, 'filtered-menu.png') }); await page.keyboard.press('Escape');
  report.checks.newChatAndPickerFiltered = true;

  await page.locator('[data-chat-id="c1"] .chat-open').click();
  await page.getByRole('button', { name: 'Choose AI, model and effort' }).click();
  assert.equal(await page.getByLabel('AI connection', { exact: true }).inputValue(), 'claude', 'an existing chat may keep its hidden current provider');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    window.__exominaPreviewEmit({ type: 'chat.started', conversationId: 'c1', provider: 'claude', startedAt: new Date().toISOString() });
    window.__exominaPreviewEmit({ type: 'chat.activity', conversationId: 'c1', step: { id: 'completed-write', kind: 'tool', name: 'workspace_write', status: 'done', target: 'report.txt', title: 'Wrote report.txt', doneTitle: 'Wrote report.txt', output: 'Completed' } });
    window.__exominaPreviewEmit({ type: 'chat.handoff', conversationId: 'c1', provider: 'codex', model: 'gpt-6', effort: 'high' });
    window.__exominaPreviewEmit({ type: 'chat.activity', conversationId: 'c1', step: { id: 'handoff', kind: 'status', status: 'done', text: 'Usage exhausted. Continuing with ChatGPT.' } });
  });
  await page.locator('.model-chip').filter({ hasText: 'GPT-6' }).waitFor();
  await page.getByRole('button', { name: 'Stop this reply', exact: true }).waitFor();
  await page.getByText('Usage exhausted. Continuing with ChatGPT.', { exact: true }).waitFor();
  await page.locator('.activity.is-running .activity-head').last().click();
  await page.getByText('Wrote report.txt', { exact: true }).waitFor();
  const resetCalls = () => page.evaluate(() => window.__exominaPreviewCalls.filter(call => call.method === 'usage.resetCredit').length);
  assert.equal(await resetCalls(), 0, 'usage reads and fallback cannot invoke the reset UI route');
  report.checks.activeHandoffAndProgress = true;
  await page.screenshot({ path: path.join(output, 'task-handoff.png') });

  await page.locator('.usage-summary').click(); await page.locator('.usage-details').waitFor();
  await page.locator('.usage-details .usage-credits-compact:not([open]) > summary').click();
  await page.getByRole('button', { name: 'Use selected reset…', exact: true }).click();
  await page.getByText('Reset cancelled.', { exact: true }).waitFor();
  assert.equal(await resetCalls(), 1, 'only the explicit manual click invokes confirmation');
  await page.getByText('Provider reports 2 available reset credits.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'manual-reset.png') });
  report.checks.manualResetCancellation = true;
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) { report.failure = error.message; throw error; }
finally { await writeFile(path.join(output, 'renderer-report.json'), JSON.stringify(report, null, 2)); if (app) await app.close().catch(() => {}); await server.close(); }
console.log(JSON.stringify(report));
