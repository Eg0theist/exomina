// Screenshots every main page in Standard view. Hidden real renderer, synthetic backend;
// no account stores or live providers. Used to review Standard for everyday users.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), output = path.resolve(process.argv[2] || '../Workspace/standard-audit');
await mkdir(output, { recursive: true });
const server = await createServer({ root, logLevel: 'error', server: { port: 0, hmr: false } });
await server.listen();
const env = { ...process.env, EXOMINA_DESIGN_QA_URL: `http://localhost:${server.config.server.port}/preview.html`, EXOMINA_DESIGN_QA_DIR: path.join(output, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const report = { passed: false, shots: [], texts: {}, errors: [] };
let app, page;
const shot = async (name, locator) => { const file = path.join(output, `${name}.png`); await (locator || page).screenshot({ path: file }); report.shots.push(name); };
const text = async (name, selector = 'main, .content-page, .app-frame') => { report.texts[name] = (await page.locator(selector).first().innerText()).slice(0, 6000); };
try {
  app = await electron.launch({ args: [path.join(root, 'scripts/qa-design-main.cjs')], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.setViewportSize?.({ width: 1360, height: 860 });
  const view = page.getByRole('combobox', { name: 'Interface view', exact: true });
  await view.waitFor();
  await view.selectOption('standard'); await page.locator('.app-frame[data-interface-view="standard"]').waitFor();
  await page.locator('.new-chat-button').click();
  await shot('01-home'); await text('home');

  // Aim higher: ideas only fill the message box; lifts are visible, reversible text; nothing is sent.
  const sendsBefore = await page.evaluate(() => window.__exominaPreviewCalls.filter(call => call.method === 'chat.send').length);
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await page.getByRole('button', { name: 'Your business', exact: true }).click();
  await page.locator('.ambition-card').first().click();
  assert.match(await message.inputValue(), /Google reviews/);
  await message.fill('Plan my sister’s 30th birthday.');
  const bar = page.getByRole('group', { name: 'Aim higher', exact: true });
  await bar.getByRole('button', { name: 'Think bigger', exact: true }).click();
  await bar.getByRole('button', { name: 'Second opinion', exact: true }).click();
  assert.equal(await bar.getByRole('button', { name: 'Think bigger', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.match(await message.inputValue(), /^Plan my sister’s 30th birthday\.\n\nBefore you start[\s\S]*different connected AI[\s\S]*language of my request/);
  await shot('01b-aim-higher');
  await bar.getByRole('button', { name: 'Think bigger', exact: true }).click();
  await bar.getByRole('button', { name: 'Second opinion', exact: true }).click();
  assert.equal(await message.inputValue(), 'Plan my sister’s 30th birthday.');
  await message.fill('');
  await page.getByText('Japan trip itinerary', { exact: true }).first().click();
  const further = page.getByRole('group', { name: 'Take it further', exact: true });
  await further.waitFor();
  assert.equal(await further.count(), 1, 'only under the latest reply');
  await further.getByRole('button', { name: 'Second opinion', exact: true }).click();
  assert.match(await message.inputValue(), /different connected AI/);
  await shot('01c-take-it-further');
  await message.fill('');
  assert.equal(await page.evaluate(() => window.__exominaPreviewCalls.filter(call => call.method === 'chat.send').length), sendsBefore);
  await page.locator('.new-chat-button').click();

  await page.getByRole('button', { name: 'Choose AI', exact: true }).click();
  const tiers = page.getByRole('radiogroup', { name: 'How carefully should it work?', exact: true });
  await tiers.waitFor();
  report.texts.picker = await page.getByRole('dialog', { name: 'Choose AI', exact: true }).innerText();
  assert.equal(await tiers.getByRole('radio').count(), 4, 'Let it decide + three levels on the default Claude model');
  await shot('02-model-picker');
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('auto');
  await page.waitForFunction(async () => (await window.studio.invoke('bootstrap')).settings.model === 'auto');
  await tiers.getByRole('radio', { name: /^Thorough/ }).click();
  await page.waitForFunction(async () => { const s = (await window.studio.invoke('bootstrap')).settings; return s.model === 'auto' && s.effort === 'high'; });
  assert.equal(await tiers.getByRole('radio', { name: /^Thorough/ }).getAttribute('aria-checked'), 'true');
  report.texts.chipAfterThorough = await page.locator('.model-chip').innerText();
  assert.match(report.texts.chipAfterThorough, /Claude[\s\S]*Thorough/);
  await page.keyboard.press('Escape');

  for (const [name, label] of [['04-projects', 'Projects & prompts'], ['05-tools', 'Tools']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(400);
    await shot(name); await text(name, '.content-page');
  }
  assert.equal(await page.getByRole('button', { name: 'Team', exact: true }).count(), 0);

  // Memory and Connections moved into Settings in beta.49.
  await page.keyboard.press('Control+,'); await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Connections & sync', exact: true }).click();
  const importHelp = page.getByRole('button', { name: 'Where do I get my chats?', exact: true });
  if (await importHelp.count()) {
    await importHelp.first().click();
    await page.getByRole('dialog', { name: 'Bring your chats from other AIs' }).waitFor();
    await shot('09-import-help'); report.texts.importHelp = await page.getByRole('dialog').innerText();
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();
  } else report.skipped = ['Import help button not found under Connections & sync'];

  await page.keyboard.press('Control+,');
  await page.getByRole('navigation', { name: 'Settings categories' }).waitFor();
  const categories = await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button').allInnerTexts();
  report.texts.settingsCategories = categories;
  for (const [index, label] of categories.entries()) {
    await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(300);
    await shot(`10-settings-${index + 1}`); await text(`settings-${label}`, '.content-page, .settings-page, main');
  }
  report.passed = report.errors.length === 0;
} catch (error) {
  report.error = error.stack || error.message;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await app?.close().catch(() => {}); await server.close();
}
console.log(JSON.stringify({ passed: report.passed, shots: report.shots.length, errors: report.errors, error: report.error?.split('\n').slice(0, 4) }, null, 1));
process.exit(report.passed ? 0 : 1);
