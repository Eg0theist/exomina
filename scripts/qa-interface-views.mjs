// Hidden real renderer, synthetic backend; no account stores or live providers.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extractFile } from '@electron/asar';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), output = path.resolve(process.argv[2] || '../Workspace/interface-views-20261013');
await mkdir(output, { recursive: true });
const packagedAsar = process.env.EXOMINA_QA_PACKAGED_ASAR;
const resources = {};
const server = await createServer({ root, logLevel: 'error', server: { port: 0, hmr: false }, plugins: packagedAsar ? [{
  name: 'interface-view-packaged-renderer', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (!pathname.startsWith('/__qa_packaged/')) return next();
      const relative = pathname.slice('/__qa_packaged/'.length);
      if (relative.split('/').some(part => !part || part === '..' || part === '.')) { res.statusCode = 400; return res.end(); }
      try {
        const bytes = extractFile(packagedAsar, path.join('dist', ...relative.split('/')));
        resources[relative] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json' })[path.extname(relative)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.end(relative === 'index.html' ? bytes.toString('utf8').replaceAll('./assets/', '/__qa_packaged/assets/').replace('<head>', '<head><script type="module" src="/preview/mock-studio.mjs"></script>') : bytes);
      } catch { res.statusCode = 404; res.end('Packaged resource unavailable'); }
    });
  },
}] : [] });
await server.listen();
const env = { ...process.env, EXOMINA_DESIGN_QA_URL: `http://localhost:${server.config.server.port}${packagedAsar ? '/__qa_packaged/index.html' : '/preview.html'}`, EXOMINA_DESIGN_QA_DIR: path.join(output, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const report = { passed: false, scope: 'Hidden Electron renderer with synthetic backend. No live accounts or provider calls.', checks: [], errors: [], resources };
if (packagedAsar) report.packagedVersion = JSON.parse(extractFile(packagedAsar, 'package.json').toString('utf8')).version;
let app, page;
try {
  app = await electron.launch({ args: [path.join(root, 'scripts/qa-design-main.cjs')], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.errors.push(error.message));
  const view = () => page.getByRole('combobox', { name: 'Interface view', exact: true });
  const choose = async value => { await view().focus(); await view().selectOption(value); await page.locator(`.app-frame[data-interface-view="${value}"]`).waitFor(); };
  const snapshot = () => page.evaluate(async () => {
    const data = await window.studio.invoke('bootstrap');
    return { settings: structuredClone(data.settings), runs: structuredClone(data.activeRuns), chats: data.conversations.map(chat => ({ id: chat.id, projectId: chat.projectId, permissionMode: chat.permissionMode, taskGuide: chat.taskGuide })) };
  });
  await view().waitFor();
  // Existing installations keep the complete view unless a choice was saved.
  await page.evaluate(() => localStorage.removeItem('exomina.interfaceView')); await page.reload();
  assert.equal(await view().inputValue(), 'advanced');
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Keep this unsent draft while changing views.');
  const aimHigher = page.getByRole('group', { name: 'Aim higher', exact: true });
  const aimTrigger = aimHigher.getByRole('button', { name: 'Aim higher', exact: true });
  const liftLabels = ['Just do it', 'Think bigger', 'Go deeper', 'Bring in a team', 'Second opinion'];
  const shortcutCalls = await page.evaluate(() => window.__exominaPreviewCalls.length);
  assert.equal(await aimHigher.getByRole('button').count(), 1, 'unused options are collapsed into one control');
  await aimTrigger.click();
  for (const label of liftLabels) {
    if (await aimTrigger.getAttribute('aria-expanded') !== 'true') await aimTrigger.click();
    const button = aimHigher.getByRole('button', { name: label, exact: true });
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    const lifted = await message.inputValue();
    assert.ok(lifted.startsWith('Keep this unsent draft while changing views.\n\n'));
    await choose('standard');
    assert.equal(await aimTrigger.getAttribute('aria-expanded'), 'false', 'leaving the control closes its options');
    assert.equal(await aimHigher.getByRole('button', { name: `Remove ${label}`, exact: true }).isVisible(), true);
    await aimTrigger.click();
    assert.equal(await message.inputValue(), lifted);
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    await button.click();
    assert.equal(await message.inputValue(), 'Keep this unsent draft while changing views.');
    await choose('advanced');
  }
  await aimTrigger.click();
  for (const label of ['Go deeper', 'Second opinion']) await aimHigher.getByRole('button', { name: label, exact: true }).click();
  await page.screenshot({ path: path.join(output, 'aim-higher-expanded.png') });
  await page.keyboard.press('Escape');
  assert.equal(await aimTrigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await aimTrigger.evaluate(element => element === document.activeElement), true);
  assert.equal(await aimHigher.getByRole('button').count(), 3, 'only the control and two active options remain');
  await page.screenshot({ path: path.join(output, 'aim-higher-selected.png') });
  for (const label of ['Go deeper', 'Second opinion']) await aimHigher.getByRole('button', { name: `Remove ${label}`, exact: true }).click();
  assert.equal(await message.inputValue(), 'Keep this unsent draft while changing views.');
  await aimTrigger.focus(); await page.keyboard.press('Enter');
  assert.equal(await aimTrigger.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  await message.fill('');
  assert.equal(await aimHigher.count(), 0);
  await message.fill('Keep this unsent draft while changing views.');
  assert.equal(await aimHigher.getByRole('button').count(), 1);
  assert.equal(await aimTrigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(start => window.__exominaPreviewCalls.slice(start).filter(call => call.method === 'chat.send').length, shortcutCalls), 0);
  report.checks.push('Aim higher starts as one control; all five options work in both views, combine, toggle off exactly and never send. Active chips survive view changes, remove guidance and support keyboard open/Escape close.');
  await page.locator('.composer input[type=file]').setInputFiles({ name: 'quote.csv', mimeType: 'text/csv', buffer: Buffer.from('hours,rate,total\n5,100,600') });
  await page.getByRole('button', { name: 'Remove quote.csv', exact: true }).waitFor();
  const before = await snapshot(), calls = await page.evaluate(() => window.__exominaPreviewCalls.length);
  await choose('standard');
  assert.equal(await message.inputValue(), 'Keep this unsent draft while changing views.');
  assert.equal(await page.getByRole('button', { name: 'Remove quote.csv', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: /^Permissions:/ }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Shared memory', exact: true }).isVisible(), true);
  assert.equal(await page.locator('.privacy-caption').isVisible(), true);
  assert.equal(await page.locator('.usage-banner').isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Attach files', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Workspace', exact: true }).isVisible(), true);
  assert.equal(await page.locator('#welcome-who').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Dots', exact: true }).count(), 0);
  assert.deepEqual(await snapshot(), before);
  assert.equal(await page.evaluate(calls => window.__exominaPreviewCalls.slice(calls).filter(call => ['settings.save', 'chat.send', 'chat.cancel', 'approval.respond', 'browser.navigate'].includes(call.method)).length, calls), 0);
  await page.screenshot({ path: path.join(output, 'standard-home.png') });
  await choose('advanced'); assert.equal(await message.inputValue(), 'Keep this unsent draft while changing views.');
  assert.equal(await page.locator('#welcome-who').isVisible(), true);
  report.checks.push('Both views preserve drafts and attachments without changing host settings or submitting actions; Standard shows privacy, memory, permissions, usage and file access.');

  await page.getByRole('button', { name: 'Bring your own task', exact: true }).click();
  const material = page.getByRole('textbox', { name: 'Task material and context', exact: true });
  await material.fill('Quote: five hours at 100 euros per hour; total 600 euros.');
  await page.getByRole('textbox', { name: 'Desired task outcome', exact: true }).fill('Check the quote');
  await choose('standard'); assert.equal(await material.inputValue(), 'Quote: five hours at 100 euros per hour; total 600 euros.');
  await choose('advanced'); assert.equal(await page.getByRole('textbox', { name: 'Desired task outcome', exact: true }).inputValue(), 'Check the quote');
  await choose('standard'); await page.getByRole('button', { name: 'Review task request', exact: true }).click();
  assert.ok((await message.inputValue()).includes('Check the quote'));
  await choose('advanced'); assert.equal(await page.getByRole('button', { name: 'Edit setup', exact: true }).isVisible(), true);
  report.checks.push('Unsent task setup, outcome, attached material and reviewed request survive repeated switches.');

  await page.locator('.new-chat-button').click();
  await message.fill('Run the synthetic build task.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('alertdialog').waitFor();
  await message.fill('A follow-up draft during a pending approval.');
  const running = await snapshot(); assert.equal(running.runs.length, 1);
  const approval = await page.getByRole('alertdialog').innerText();
  await choose('standard');
  assert.equal(await page.getByRole('alertdialog').innerText(), approval);
  assert.equal(await message.inputValue(), 'A follow-up draft during a pending approval.');
  assert.deepEqual(await snapshot(), running);
  assert.equal(await page.getByRole('button', { name: 'Stop this reply', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page.getByRole('button', { name: 'Stop this reply', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await message.inputValue(), 'A follow-up draft during a pending approval.');
  report.plainActivity = await page.locator('.activity.is-plain .activity-title').allInnerTexts();
  await page.screenshot({ path: path.join(output, 'standard-chat.png') });
  await choose('advanced'); report.advancedActivity = await page.locator('.activity .activity-title').allInnerTexts();
  const further = page.getByRole('group', { name: 'Take it further', exact: true });
  assert.equal(await further.count(), 1);
  const furtherCalls = await page.evaluate(() => window.__exominaPreviewCalls.length);
  for (const label of ['Go deeper', 'What’s next?', 'Other angles', 'Second opinion']) {
    const button = further.getByRole('button', { name: label, exact: true });
    const prompt = await button.getAttribute('title');
    await button.click();
    assert.equal(await message.inputValue(), 'A follow-up draft during a pending approval.\n\n' + prompt);
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message');
    await message.fill('A follow-up draft during a pending approval.');
  }
  assert.equal(await page.evaluate(start => window.__exominaPreviewCalls.slice(start).filter(call => call.method === 'chat.send').length, furtherCalls), 0);
  await page.screenshot({ path: path.join(output, 'advanced-chat.png') });
  await page.setViewportSize({ width: 840, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await aimTrigger.click();
  for (const group of [aimHigher, further]) for (const button of await group.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 840);
  }
  await page.screenshot({ path: path.join(output, 'advanced-shortcuts-narrow.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1360, height: 900 });
  await choose('standard');
  assert.equal(await further.count(), 1);
  report.checks.push('All four Take it further shortcuts append to the existing draft and focus it without sending; both shortcut groups fit a narrow Advanced window.');
  report.checks.push('Active conversation, run, pending approval and follow-up draft persist; the reply completes in Standard.');

  await page.keyboard.press('Control+,');
  await page.getByRole('combobox', { name: 'Settings interface view', exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button').count(), 6); // Connections & sync joined in beta.49.
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Privacy & data', exact: true }).click();
  for (const id of ['permissions', 'memory', 'data']) assert.equal(await page.locator(`#settings-${id}`).isVisible(), true);
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Models & usage', exact: true }).click();
  assert.equal(await page.locator('#settings-usage').isVisible(), true);
  assert.equal(await page.locator('#settings-defaults').isVisible(), false);
  const search = page.getByRole('searchbox', { name: 'Search settings', exact: true });
  await search.fill('fallback');
  await page.getByText('Opens in Advanced', { exact: true }).waitFor();
  await search.press('Enter'); assert.equal(await view().inputValue(), 'advanced');
  await page.locator('#settings-models').waitFor();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Conversation', exact: true }).click();
  const instructions = page.locator('.persona-field').filter({ has: page.getByText('Instructions', { exact: true }) }).locator('textarea');
  await instructions.fill('Keep this preference draft.'); await choose('standard'); await choose('advanced');
  assert.equal(await instructions.inputValue(), 'Keep this preference draft.');
  report.checks.push('Standard settings keep permissions, privacy and usage visible; search discovers Advanced controls; settings drafts survive.');

  await choose('standard');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  assert.equal(await page.getByRole('switch', { name: 'Enable browser tools', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('switch', { name: 'Enable desktop tools', exact: true }).isVisible(), true);
  assert.equal(await page.locator('.tool-details.advanced-only').isVisible(), false);
  await page.getByRole('button', { name: 'Show Advanced view', exact: true }).click();
  assert.equal(await page.locator('.tool-details.advanced-only').isVisible(), true);
  report.checks.push('Standard Tools retain browser and desktop enablement; detailed tools remain available in Advanced.');

  await page.getByRole('button', { name: 'Projects & prompts', exact: true }).click();
  await page.getByRole('tab', { name: 'Scheduled tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New scheduled task', exact: true }).click();
  await choose('standard');
  assert.equal(await page.getByRole('tab', { name: 'Scheduled tasks', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.workbench-editor').isVisible(), true);
  await page.getByRole('tab', { name: 'Saved prompts', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Scheduled tasks', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Show Advanced view', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Scheduled tasks', exact: true }).isVisible(), true);
  report.checks.push('Saved prompts and projects remain accessible; changing views keeps an open scheduled task editor; scheduling setup is discoverable in Advanced.');

  await page.locator('.new-chat-button').click();
  await page.evaluate(async () => {
    const data = await window.studio.invoke('bootstrap');
    data.providerModels.claude = [{ id: 'opus', label: 'Opus', efforts: [{ id: 'high', label: 'High' }], speeds: [{ id: 'fast', label: 'Fast', paid: true, description: 'Synthetic extra-cost speed.' }] }];
    await window.studio.invoke('settings.save', { provider: 'claude', model: 'opus', effort: 'high', speed: 'fast' });
  });
  await page.getByRole('button', { name: 'Choose AI, model and effort', exact: true }).click();
  await page.getByRole('radio', { name: 'Fast paid', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Confirm paid speed', exact: true }).waitFor();
  await choose('standard');
  assert.equal(await page.getByRole('alertdialog', { name: 'Confirm paid speed', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Choose AI', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).inputValue(), 'opus');
  assert.match(await page.locator('.standard-model-summary').innerText(), /Fast.*costs extra/);
  assert.equal(await page.getByRole('listbox', { name: 'Model', exact: true }).count(), 0);
  const costSettings = (await snapshot()).settings;
  await page.getByRole('button', { name: 'More options in Advanced view', exact: true }).click();
  assert.equal(await page.getByRole('listbox', { name: 'Model', exact: true }).isVisible(), true);
  assert.deepEqual((await snapshot()).settings, costSettings);
  report.checks.push('Standard shows current model, effort and extra-cost speed; a pending paid-speed confirmation remains visible and guards are unchanged.');

  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const data = await window.studio.invoke('bootstrap');
    data.providerModels.claude[0].efforts = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'max', label: 'Max' }];
    await window.studio.invoke('settings.save', { provider: 'claude', model: 'opus', effort: 'high', speed: '' });
  });
  await choose('standard');
  await page.getByRole('button', { name: 'Choose AI', exact: true }).click();
  const tiers = page.getByRole('radiogroup', { name: 'How carefully should it work?', exact: true });
  assert.equal(await tiers.getByRole('radio').count(), 4, 'Let it decide plus Quick, Balanced and Thorough');
  assert.equal(await tiers.getByRole('radio', { name: /^Thorough/ }).getAttribute('aria-checked'), 'true');
  await tiers.getByRole('radio', { name: /^Quick/ }).click();
  await page.waitForFunction(async () => (await window.studio.invoke('bootstrap')).settings.effort === 'low');
  await page.keyboard.press('Escape');
  assert.match(await page.locator('.model-chip').innerText(), /Claude[\s\S]*Quick/);
  assert.equal(await page.locator('.advanced-status-strip').count(), 0);
  await choose('advanced');
  assert.equal(await page.locator('.advanced-status-strip').count(), 0);
  await page.evaluate(() => window.studio.invoke('settings.save', { memoryEnabled: true }));
  assert.match(await page.locator('.model-chip').innerText(), /Opus[\s\S]*Low/);
  report.checks.push('Standard offers Quick/Balanced/Thorough mapped to provider efforts; Advanced has no separate status strip above the composer.');

  await page.locator('.new-chat-button').click();
  await choose('standard');
  assert.equal(await page.getByRole('heading', { name: 'What do you want to get done?', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('group', { name: 'Starting points' }).getByRole('button').count(), 4);
  assert.equal(await page.locator('#welcome-start').isVisible(), false);
  await page.screenshot({ path: path.join(output, 'standard-home-redesign.png') });
  await page.getByRole('button', { name: 'A website', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Task website address', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Close task setup', exact: true }).click();
  await choose('advanced');
  assert.equal(await page.locator('.standard-home').count(), 0);
  assert.equal(await page.locator('#welcome-start').isVisible(), true);
  await page.screenshot({ path: path.join(output, 'advanced-home-redesign.png') });
  report.checks.push('Standard home is task-first with four starting points that open the matching task setup; Advanced keeps provider cards and suggestions.');

  await choose('standard'); await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 840, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  const bounds = await view().boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 840);
  await page.screenshot({ path: path.join(output, 'standard-narrow.png') });
  await page.reload(); await view().waitFor(); assert.equal(await view().inputValue(), 'standard');
  report.checks.push('The switch fits a narrow desktop window and the device preference survives reload.');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.failure = error.stack; await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(path.join(output, 'ui-result.json'), JSON.stringify(report, null, 2)); await app?.close(); await server.close(); }
console.log(JSON.stringify(report, null, 2));
