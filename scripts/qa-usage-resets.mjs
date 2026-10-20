// Real hidden renderer with synthetic credit choices. No redemption, sign-ins or account reads.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = process.cwd(), output = path.resolve('../Workspace/qa-usage-resets');
await mkdir(output, { recursive: true });
const server = await createServer({ root, server: { port: 0, hmr: false }, logLevel: 'error' }); await server.listen();
const env = { ...process.env, EXOMINA_DESIGN_QA_URL: `http://localhost:${server.config.server.port}/preview.html`, EXOMINA_DESIGN_QA_DIR: output };
delete env.ELECTRON_RUN_AS_NODE;
const report = { scope: 'Hidden real renderer; fixture-only usage/reset responses and browser state. No live reset redemption, account reads or sign-ins.', checks: {}, errors: [] };
let app, page;
try {
  app = await electron.launch({ args: [path.join(root, 'scripts/qa-design-main.cjs')], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
  await page.evaluate(() => localStorage.setItem('exomina.browser.auto-reveal', 'false')); await page.reload();
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
  const openPopup = async () => { if (!await page.locator('.usage-details').count()) await page.locator('.usage-summary').click(); await page.locator('.usage-details').waitFor(); const credits = page.locator('.usage-details .usage-credits-compact:not([open]) > summary'); if (await credits.count()) await credits.click(); };
  const resetCalls = () => page.evaluate(() => window.__exominaPreviewCalls.filter(call => call.method === 'usage.resetCredit'));
  const setUsage = async (value, options = {}) => { await page.evaluate(({ value, options }) => window.__exominaPreviewSetUsage(value, options), { value, options }); };
  const base = await page.evaluate(() => window.__exominaPreviewUsage());
  await openPopup();
  await page.locator('.usage-details [data-credit-id="fixture-bonus"] input').waitFor();
  await page.waitForFunction(() => document.querySelector('.usage-details [data-credit-id="fixture-bonus"] input')?.checked);
  assert.equal(await page.locator('.usage-details [data-credit-id="fixture-bonus"] input').isChecked(), true);
  const readCalls = await page.evaluate(() => window.__exominaPreviewCalls.filter(call => call.method === 'usage.refresh'));
  assert.ok(readCalls.length > 0 && readCalls.every(call => call.payload.details === true));
  assert.equal((await resetCalls()).length, 0); report.checks.openReadsDetailedCreditsWithoutReset = true;
  for (const [index, [name, expected]] of [['Claude', 'claude.ai/settings/usage'], ['ChatGPT', 'chatgpt.com/codex/settings/usage']].entries()) {
    if (index) await openPopup();
    await page.locator('.usage-details section').filter({ has: page.locator('h3', { hasText: name }) }).locator('.usage-manage-icon').click();
    await page.getByRole('button', { name: 'Close embedded browser', exact: true }).waitFor();
    await page.waitForFunction(expected => document.querySelector('[aria-label="Browser address"]')?.value.includes(expected), expected);
    await page.getByRole('button', { name: 'Close embedded browser', exact: true }).click();
  }
  report.checks.providerButtonsOpenHiddenPane = true;
  await openPopup(); await page.getByRole('button', { name: 'All credit details', exact: true }).click();
  const section = page.locator('#settings-usage'); await section.waitFor();
  await section.locator('[data-credit-id="fixture-bonus"] input').waitFor();
  assert.match(await section.innerText(), /No expiry/);
  assert.match(await section.innerText(), /Expires .*remaining/);
  assert.match(await section.innerText(), /Claude subscriptions do not report reset credits/);
  await page.waitForTimeout(800);
  const position = await section.evaluate(el => { const own = el.getBoundingClientRect(), heading = el.querySelector('h2').getBoundingClientRect(), content = el.closest('.settings-panel-scroll'), pane = content.getBoundingClientRect(); return { top: own.top, headingTop: heading.top, paneTop: pane.top, paneBottom: pane.bottom, scrollTop: content.scrollTop }; }); assert.ok(position.headingTop >= position.paneTop - 1 && position.headingTop < position.paneBottom, `Usage heading scrolled into its content pane: ${JSON.stringify(position)}`);
  const covered = await page.evaluate(() => document.querySelector('#settings-usage h2').getBoundingClientRect().top < document.querySelector('.settings-panel-scroll').getBoundingClientRect().top);
  assert.equal(covered, false); report.checks.detailsNavigateToVisibleSettings = true;

  const dates = await page.evaluate(() => ({ early: new Date(Date.now() + 2 * 86400000).toISOString(), late: new Date(Date.now() + 4 * 86400000).toISOString(), expired: new Date(Date.now() - 3600000).toISOString() }));
  const normalized = (id, title, expiresAt, extras = {}) => ({ id, title, description: null, grantedAt: dates.expired, expiresAt, status: 'available', resetType: 'codexRateLimits', usable: true, expiryKnown: true, unavailableReason: null, ...extras });
  const credits = [
    normalized('late', 'Later expiry', dates.late), normalized('permanent', 'No-expiry choice', null), normalized('early', 'Earliest expiry', dates.early),
    normalized('redeemed', 'Previously used', dates.late, { status: 'redeemed', usable: false }),
    normalized('expired', 'Expired credit', dates.expired, { usable: false }),
    normalized('wrong-type', 'Other reset type', dates.late, { resetType: 'unknown', usable: false }),
    normalized('unknown-expiry', 'Expiry missing', null, { expiryKnown: false, usable: false }),
    normalized('redeeming', 'Redemption pending', dates.late, { status: 'redeeming', usable: false }),
    normalized('unknown', 'Unknown availability', dates.late, { status: 'unknown', usable: false }),
  ];
  const detailed = { ...base, codex: { ...base.codex, updatedAt: new Date().toISOString(), fetchStatus: 'ready', resetCredits: { availableCount: 3, detailsPartial: false, credits } } };
  await setUsage(detailed);
  await section.locator('[data-credit-id="early"]').waitFor();
  assert.deepEqual((await section.locator('.usage-credit-list li').evaluateAll(elements => elements.map(element => element.dataset.creditId))).slice(0, 3), ['early', 'late', 'permanent']);
  for (const id of ['redeemed', 'expired', 'wrong-type', 'unknown-expiry', 'redeeming', 'unknown']) assert.equal(await section.locator(`[data-credit-id="${id}"] input`).isDisabled(), true);
  assert.match(await section.locator('[data-credit-id="unknown-expiry"]').innerText(), /Expiry not reported/);
  assert.match(await section.locator('[data-credit-id="permanent"]').innerText(), /No expiry/);
  await section.getByText(/Earliest expiry:/).waitFor();
  await section.getByRole('radio', { name: 'Select Earliest expiry', exact: true }).check();
  await section.getByRole('button', { name: 'Use selected reset…', exact: true }).click();
  await section.getByText('Reset cancelled.', { exact: true }).waitFor();
  assert.deepEqual((await resetCalls()).at(-1).payload, { provider: 'codex', creditId: 'early' });
  assert.equal((await page.evaluate(() => window.__exominaPreviewUsage())).codex.resetCredits.credits.length, credits.length);
  await section.getByRole('radio', { name: 'Select No-expiry choice', exact: true }).check();
  await section.getByRole('button', { name: 'Use selected reset…', exact: true }).click();
  await page.waitForFunction(() => window.__exominaPreviewCalls.filter(call => call.method === 'usage.resetCredit').at(-1)?.payload.creditId === 'permanent');
  report.checks.sortAvailabilityExactExpiryAndChosenId = true;
  await section.evaluate(el => { const content = el.closest('.settings-panel-scroll'); content.scrollTop += el.getBoundingClientRect().top - content.getBoundingClientRect().top - 16; });
  await page.screenshot({ path: path.join(output, 'settings-credit-choices.png') });

  await openPopup(); await page.locator('.usage-details [data-credit-id="late"] input').check();
  await page.locator('.usage-details').getByRole('button', { name: 'Use selected reset…', exact: true }).click();
  await page.locator('.usage-details').getByText('Reset cancelled.', { exact: true }).waitFor();
  assert.deepEqual((await resetCalls()).at(-1).payload, { provider: 'codex', creditId: 'late' });
  for (const height of [650, 900]) {
    await page.setViewportSize({ width: 1360, height });
    const bounds = await page.locator('.usage-details').evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight }; });
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height);
  }
  report.checks.sidebarChosenIdAndScrollableLayout = true;
  await page.locator('.usage-details').evaluate(el => { el.scrollTop = 0; });
  await page.locator('.usage-details').screenshot({ path: path.join(output, 'popup-credit-choices.png') });
  await page.keyboard.press('Escape');

  const partial = { ...detailed, codex: { ...detailed.codex, resetCredits: { ...detailed.codex.resetCredits, availableCount: 6, detailsPartial: true, credits: credits.slice(0, 3) } } };
  await setUsage(partial);
  await section.getByText(/Credit details are partial/).waitFor();
  assert.match(await section.locator('.usage-credit-earliest').innerText(), /Earliest listed expiry/);
  assert.match(await section.locator('[data-credit-id="early"] .usage-credit-status').innerText(), /Earliest listed expiry/);
  report.checks.partialListsDoNotClaimGlobalEarliest = true;
  const missing = { ...detailed, codex: { ...detailed.codex, resetCredits: { availableCount: 3, credits: null } } };
  await setUsage(missing);
  await section.getByText('Credit details are unavailable. Refresh to choose a specific reset.', { exact: true }).waitFor();
  await section.getByRole('button', { name: 'Use provider-selected reset…', exact: true }).click();
  await page.waitForFunction(() => !('creditId' in window.__exominaPreviewCalls.filter(call => call.method === 'usage.resetCredit').at(-1).payload));
  assert.deepEqual((await resetCalls()).at(-1).payload, { provider: 'codex' });
  const empty = { ...missing, codex: { ...missing.codex, resetCredits: { availableCount: 3, credits: [], detailsPartial: true } } };
  await setUsage(empty); await section.getByText('The provider listed no credit details. Refresh to try again.', { exact: true }).waitFor();
  assert.equal(await section.getByRole('button', { name: 'Use provider-selected reset…', exact: true }).count(), 0);
  report.checks.countOnlyFallbackIsExplicitAndNeverForKnownInvalidRows = true;

  const stale = { ...detailed, codex: { ...detailed.codex, stale: true } };
  await setUsage(stale);
  await section.getByText('Refresh usage before using a reset credit.', { exact: true }).waitFor();
  assert.equal(await section.getByRole('button', { name: 'Use selected reset…', exact: true }).isDisabled(), true);
  assert.equal(await section.locator('[data-credit-id="early"] input').isDisabled(), true);
  report.checks.staleDataDisablesNewRedemption = true;

  await setUsage(detailed); await section.locator('[data-credit-id="early"] input').check();
  await page.evaluate(() => { window.__exominaPreviewResetError = "Error invoking remote method 'studio:invoke': Error: Synthetic uncertain reset"; window.__exominaPreviewResetBecomesPending = true; });
  await section.getByRole('button', { name: 'Use selected reset…', exact: true }).click();
  await section.getByText('Synthetic uncertain reset', { exact: true }).waitFor();
  await section.getByRole('button', { name: 'Check previous reset…', exact: true }).waitFor();
  assert.equal(await section.locator('input[type=radio]:not(:disabled)').count(), 0);
  assert.equal(await section.locator('input[type=radio]:checked').count(), 0);
  assert.equal(await section.getByRole('button', { name: 'Use selected reset…', exact: true }).count(), 0);
  const zeroStale = { ...stale, codex: { ...stale.codex, resetCredits: { availableCount: 0, credits: [] } } };
  await setUsage(zeroStale, { resetPending: true });
  await page.evaluate(() => { delete window.__exominaPreviewResetError; delete window.__exominaPreviewResetBecomesPending; window.__exominaPreviewResetResponse = { outcome: 'alreadyRedeemed', usageRefreshed: false }; });
  await section.getByRole('button', { name: 'Check previous reset…', exact: true }).click();
  await section.getByText('This reset was already applied. Usage refresh failed; refresh to see the latest figures.', { exact: true }).waitFor();
  assert.deepEqual((await resetCalls()).at(-1).payload, { provider: 'codex' });
  report.checks.uncertainAttemptLocksChoicesAndRetriesWithoutNewCreditEvenZeroStale = true;

  const soon = normalized('soon', 'Expiring now', new Date(Date.now() + 2400).toISOString());
  const expiring = { ...detailed, codex: { ...detailed.codex, resetCredits: { availableCount: 1, credits: [soon] } } };
  await setUsage(expiring, { resetPending: false });
  await section.locator('[data-credit-id="soon"] input').check();
  await section.locator('[data-credit-id="soon"] .usage-credit-status').getByText('Expired', { exact: true }).waitFor();
  assert.equal(await section.locator('[data-credit-id="soon"] input').isDisabled(), true);
  assert.equal(await section.getByRole('button', { name: 'Use selected reset…', exact: true }).count(), 0);
  report.checks.expiryRecheckedWithoutBackendRefresh = true;
  await setUsage(detailed);
  await section.locator('[data-credit-id="early"] input').check();
  const withoutSelected = { ...detailed, codex: { ...detailed.codex, resetCredits: { availableCount: 2, credits: credits.filter(item => item.id !== 'early') } } };
  await setUsage(withoutSelected);
  await section.getByText('Choose an available reset credit.', { exact: true }).waitFor();
  assert.equal(await section.getByRole('button', { name: 'Use selected reset…', exact: true }).isDisabled(), true);
  assert.equal(await section.locator('input[type=radio]:checked').count(), 0);
  report.checks.missingSelectedCreditDoesNotSilentlyChooseAnother = true;

  assert.deepEqual(report.errors, []);
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.isVisible()).length); assert.equal(visible, 0);
  report.checks.allWindowsHidden = true; report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) { report.ui = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
} finally { await app?.close(); await server.close(); await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
