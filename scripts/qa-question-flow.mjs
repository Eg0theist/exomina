// Main chat scroll, real question delivery and saved legacy activity recovery.
// The profile and provider are synthetic; no personal account stores are read.
import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { extractFile } from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT || root).replace(/app\.asar\.unpacked$/i, 'app.asar');
const version = JSON.parse(runtimeRoot.endsWith('.asar') ? extractFile(runtimeRoot, 'package.json') : await readFile(path.join(runtimeRoot, 'package.json'), 'utf8')).version;
const fixture = await createProtectedQaProfile('question-flow'), { profile, output } = fixture;
const workspace = path.join(output, 'workspace'); await mkdir(workspace);
const store = new Store(profile, { workspace }); await store.init();
Object.assign(store.state.settings, { workspace, autoTitle: false, autoUpdate: false, closeToTray: false, memoryEnabled: false, chatMemorySummaries: false, browserEnabled: false, desktopEnabled: false, permissionMode: 'full' });
const chat = store.create('codex'); chat.title = 'Question flow QA'; chat.titleSource = 'manual';
const group = { id: 'chronological-question', status: 'open', createdAt: '2026-10-11T10:00:01.000Z', questions: [{ id: 'colour', question: 'Which flow colour should I use? Consider the readability of the conversation, the hierarchy of actions and the way a long clarification appears while independent work continues. '.repeat(3).trim(), options: [{ label: 'Blue' }, { label: 'Green' }] }] };
chat.messages.push({ id: 'flow-reply', role: 'assistant', provider: 'codex', content: 'The work after this question is preserved.', questions: [group], activity: [
  { id: 'before', kind: 'note', status: 'done', startedAt: '2026-10-11T10:00:00.000Z', text: 'Work before the question.\n\n' + 'Earlier work paragraph with enough detail to make this a long conversation.\n\n'.repeat(35) },
  { id: 'after', kind: 'note', status: 'done', startedAt: '2026-10-11T10:00:02.000Z', text: 'Work after the question.\n\n' + 'Later work paragraph continues the task while the question remains available.\n\n'.repeat(35) },
] }); await store.save();
const launcher = path.join(output, 'launcher.cjs');
await writeFile(launcher, `const {app,BrowserWindow,session,dialog}=require('electron');BrowserWindow.prototype.show=function(){};dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};app.getVersion=()=>${JSON.stringify(version)};
(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${JSON.stringify(pathToFileURL(path.join(runtimeRoot,'desktop/providers.mjs')).href)});
ProviderManager.prototype.status=async()=>[{id:'codex',installed:true,connected:true,available:true}];ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;ProviderManager.prototype.getCodex=async()=>{throw Error('Personal runtime access prohibited in flow QA')};
ProviderManager.prototype.run=async()=>({text:'The saved flow answer was received.',sessionId:'synthetic-flow'});
await import(${JSON.stringify(pathToFileURL(path.join(runtimeRoot,'desktop/main.mjs')).href)});})().catch(error=>{console.error(error);app.exit(1)});`);
const env = { ...process.env, EXOMINA_DATA_DIR: profile, TEMP: output, TMP: output, TMPDIR: output }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/(?:token|secret|password|api_?key|credential|authorization)/i.test(key)) delete env[key];
const report = { runtimeRoot, version, output, scope: 'Hidden production host/renderer; real mouse wheel and question delivery in protected synthetic profile. No personal accounts or live inference.', checks: {}, errors: [] }; let app, page;
try {
  app = await electron.launch({ args: [launcher], cwd: root, env, timeout: 30000 }); page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('.chat-open').filter({ hasText: chat.title }).click();
  const popup = page.getByRole('dialog', { name: 'Your input', exact: true }); await popup.waitFor(); await popup.getByRole('button', { name: 'Later', exact: true }).click(); await popup.waitFor({ state: 'hidden' });
  const card = page.locator('.question-card[data-question-id="chronological-question"]'); await card.waitFor();
  // Place the visual evidence at the card after the real-wheel assertions.
  // Explicit intent lets the chat anchor capture this deliberate QA position.
  const showCard = async () => {
    await card.evaluate(el => { const scroller = el.closest('.chat-scroll'); scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })); scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 140; scroller.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(150);
    const shown = await card.boundingBox(), view = await page.locator('.chat-scroll').boundingBox();
    assert.ok(shown.y >= view.y && shown.y + shown.height <= view.y + view.height);
  };
  const order = await page.locator('.activity-updates > li').evaluateAll(rows => rows.map(row => row.querySelector('[data-question-id]') ? 'question' : row.textContent.includes('Work before the question.') ? 'before' : 'after'));
  assert.deepEqual(order, ['before', 'question', 'after']); assert.equal(await page.locator('.question-card').count(), 1); report.checks.prunedOrLegacyRowRestoredChronologicallyWithoutDuplicate = true;
  const scrolling = await page.locator('.chat-scroll').boundingBox(); await page.mouse.move(scrolling.x + scrolling.width / 2, scrolling.y + scrolling.height / 2);
  for (let attempt = 0; attempt < 8; attempt++) { const bounds = await card.boundingBox(), delta = bounds.y - (scrolling.y + 100); if (Math.abs(delta) < 5) break; await page.mouse.wheel(0, delta); await page.waitForTimeout(130); }
  const measure = () => card.evaluate(el => ({ top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height, main: el.closest('.chat-scroll').scrollTop, inner: el.closest('.activity-updates').scrollTop, max: getComputedStyle(el.closest('.activity-updates')).maxHeight, overflow: getComputedStyle(el.closest('.activity-updates')).overflowY }));
  await page.waitForTimeout(500); const before = await measure(); await page.mouse.wheel(0, -140); await page.waitForTimeout(500); const moved = await measure();
  assert.ok(moved.main < before.main - 100); assert.ok(moved.top > before.top + 100); assert.ok(Math.abs((moved.top-before.top)+(moved.main-before.main)) < 2); assert.equal(moved.inner, 0); assert.equal(moved.max, 'none'); assert.equal(moved.overflow, 'visible'); report.checks.realMouseWheelMovesQuestionWithMainConversation = { before, moved };
  await showCard();
  await page.screenshot({ path: path.join(output, 'pending-in-flow.png') });
  await card.getByLabel('Green', { exact: true }).check(); await card.getByRole('button', { name: 'Send answer', exact: true }).click();
  await page.getByText('The saved flow answer was received.', { exact: true }).waitFor(); await page.waitForFunction(() => document.querySelector('.question-card-head')?.getAttribute('aria-expanded') === 'false');
  assert.equal(await card.getAttribute('data-status'), 'answered'); assert.match(await card.locator('.question-preview').textContent(), /^Green · Which flow colour/); assert.equal(await card.locator('.question-card-body').count(), 0); assert.equal(await page.locator('.question-card').count(), 1); const compact = await measure(); assert.ok(compact.height < before.height / 2); report.checks.liveAnswerBecomesCompactRecordWithAnswerFirst = { pendingHeight: before.height, answeredHeight: compact.height };
  await card.locator('.question-card-head').click(); await card.locator('.question-answer').waitFor(); assert.match(await card.locator('.question-answer').textContent(), /Which flow colour.*Green/s); await card.locator('.question-card-head').click(); report.checks.answeredRecordExpandsOriginalQuestionAndResponse = true;
  await page.reload(); await page.locator('.chat-open').filter({ hasText: chat.title }).click(); await card.waitFor(); assert.equal(await page.locator('.question-card').count(), 1); assert.equal(await card.locator('.question-card-body').count(), 0); const refreshedOrder = await page.locator('.activity-updates').first().locator(':scope > li').evaluateAll(rows => rows.map(row => row.querySelector('[data-question-id]') ? 'question' : row.textContent.includes('Work before the question.') ? 'before' : 'after')); assert.deepEqual(refreshedOrder, order); report.checks.reopenPreservesChronologyAndCompactAnswer = true;
  await showCard(); await page.screenshot({ path: path.join(output, 'answered-in-flow.png') }); assert.deepEqual(report.errors, []); await app.close(); app = null; report.protection = await fixture.verify(); report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
finally { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); } await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
