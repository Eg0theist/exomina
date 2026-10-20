// Real renderer with a page-local synthetic question host. No account stores,
// provider calls, visible applications, or production data are reachable.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), output = await mkdtemp(path.resolve('../Workspace/qa-question-popup-'));
const packaged = process.argv.includes('--packaged');
const archive = path.resolve(process.env.EXOMINA_QA_ASAR || 'release/win-unpacked/resources/app.asar');
let html, entry, packagedRenderer = null;
if (packaged) {
  html = extractFile(archive, 'dist/index.html').toString();
  entry = /<script\b[^>]*src="\.\/([^" ]+\.js)"[^>]*><\/script>/.exec(html);
  assert.ok(entry, 'packaged renderer entry must be present');
  const bytes = extractFile(archive, path.join('dist', entry[1]));
  assert.ok(bytes.equals(await readFile(path.join(root, 'dist', entry[1]))), 'packaged renderer must match the current production build');
  packagedRenderer = { archive, entry: entry[1], sha256: createHash('sha256').update(bytes).digest('hex') };
} else html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Synthetic question popup QA</title></head><body><div id="root"></div><script type="module" src="./entry.mjs"></script></body></html>';

// Run before the real transport module captures window.studio. The wrapper
// replaces only question responses and delegates other calls to the preview.
const fixtureSource = `
const studio = window.studio;
const qa = window.__qaQuestionPopup = {
  calls: [], answerMode: 'success', pending: null,
  async group(chatId, groupId) {
    const chat = await studio.invoke('conversations.get', { id: chatId });
    const message = chat.messages.find(item => item.questions?.some(group => group.id === groupId));
    return { chat, message, group: message?.questions.find(item => item.id === groupId) };
  },
  async emit(chatId, group) {
    const chat = await studio.invoke('conversations.get', { id: chatId });
    const message = chat.messages.find(item => item.id === 'popup-message-' + chatId);
    message.questions ||= [];
    const index = message.questions.findIndex(item => item.id === group.id);
    if (index < 0) message.questions.push(structuredClone(group));
    else message.questions[index] = structuredClone(group);
    window.__exominaPreviewReplaceChat(chat);
    window.__exominaPreviewEmit({ type: 'chat.question', conversationId: chatId, messageId: message.id, question: structuredClone(group) });
  },
  async patch(chatId, groupId, patch) {
    const { group } = await this.group(chatId, groupId);
    await this.emit(chatId, { ...group, ...patch });
  },
  release(error = null) {
    if (!this.pending) throw Error('No synthetic question response is pending');
    const pending = this.pending; this.pending = null;
    if (error) pending.reject(Error(error)); else pending.resolve();
  }
};
window.studio = Object.freeze({ ...studio, invoke: async (method, payload = {}) => {
  if (!['chat.question.answer', 'chat.question.continue'].includes(method)) return studio.invoke(method, payload);
  qa.calls.push({ method, payload: structuredClone(payload), at: Date.now() });
  const { group } = await qa.group(payload.conversationId, payload.id);
  if (!group) throw Error('Synthetic question group missing');
  if (method === 'chat.question.continue') {
    await qa.patch(payload.conversationId, payload.id, { status: 'open', windowOutcome: 'continued' });
    return { id: group.id, status: 'open', answers: {}, pending: true };
  }
  if (qa.answerMode === 'fail') throw Error('Synthetic host rejected this answer');
  const answers = Object.fromEntries(Object.entries(payload.answers).map(([id, value]) => [id, { answers: [value] }]));
  if (qa.answerMode === 'hold-early-status') await qa.patch(payload.conversationId, payload.id, { status: 'answered', answers, deliveryState: 'sending' });
  if (['hold', 'hold-early-status'].includes(qa.answerMode)) await new Promise((resolve, reject) => { qa.pending = { resolve, reject }; });
  if (qa.answerMode === 'delivery-failed') {
    await qa.patch(payload.conversationId, payload.id, { status: 'answered', answers, deliveryState: 'failed', deliveryError: 'Synthetic delivery failed' });
    return { id: group.id, status: 'answered', answers, pending: false, deliveryState: 'failed', deliveryError: 'Synthetic delivery failed' };
  }
  await qa.patch(payload.conversationId, payload.id, { status: 'answered', answers, deliveryState: 'delivered' });
  return { id: group.id, status: 'answered', answers, pending: false, deliveryState: 'delivered' };
}});
`;
const plugin = { name: 'synthetic-question-popup', configureServer(server) {
  server.middlewares.use((request, response, next) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!pathname.startsWith('/qa-popup/')) return next();
    const file = decodeURIComponent(pathname.slice('/qa-popup/'.length));
    if (file.split('/').some(part => part === '..') || file.includes('\\')) { response.statusCode = 400; return response.end(); }
    try {
      let content, mime;
      if (file === 'index.html') { content = packaged ? html.replace(entry[0], entry[0].replace('./' + entry[1], './entry.mjs')) : html; mime = 'text/html'; }
      else if (file === 'entry.mjs') { content = `import '/preview/mock-studio.mjs';\n${fixtureSource}\nawait import(${JSON.stringify(packaged ? './' + entry[1] : '/src/main.jsx')});`; mime = 'text/javascript'; }
      else if (packaged) { content = extractFile(archive, path.join('dist', file)); mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream'; }
      else return next();
      response.setHeader('Content-Type', mime); response.end(content);
    } catch { response.statusCode = 404; response.end(); }
  });
} };
const server = await createServer({ root, plugins: [plugin], server: { port: 5194, strictPort: false }, logLevel: 'error' });
await server.listen();
const url = `http://localhost:${server.config.server.port}/qa-popup/index.html`;
const report = { scope: 'Fresh headless browser; real source or exact packaged renderer; page-local synthetic question responses, live event protocol, held/rejected acknowledgment; no production account stores or provider calls.', packagedRenderer, checks: {}, errors: [] };
let browser, page;
try {
  for (const channel of process.env.EXOMINA_QA_BROWSER_CHANNEL ? [process.env.EXOMINA_QA_BROWSER_CHANNEL] : ['chrome', 'msedge']) {
    try { browser = await chromium.launch({ channel, headless: true }); report.browserChannel = channel; break; }
    catch (error) { if (!/distribution.*not found|executable.*doesn't exist/i.test(error.message)) throw error; }
  }
  assert.ok(browser, 'Install Chrome or Edge, or set EXOMINA_QA_BROWSER_CHANNEL to an installed browser.');
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url);
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
  await page.evaluate(async () => {
    for (const id of ['c1', 'c2']) {
      const chat = await window.studio.invoke('conversations.get', { id });
      chat.title = id === 'c1' ? 'Synthetic popup source' : 'Synthetic popup background';
      chat.messages = [{ id: 'popup-message-' + id, role: 'assistant', provider: 'claude', content: 'Synthetic independent work continues.', questions: [] }];
      window.__exominaPreviewReplaceChat(chat);
    }
  });
  const dialog = () => page.getByRole('dialog', { name: 'Your input', exact: true });
  const open = async id => { await page.locator(`[data-chat-id="${id}"] .chat-open`).click(); await page.waitForTimeout(100); };
  const emit = (chatId, group) => page.evaluate(({ chatId, group }) => window.__qaQuestionPopup.emit(chatId, group), { chatId, group });
  const patch = (chatId, groupId, value) => page.evaluate(({ chatId, groupId, value }) => window.__qaQuestionPopup.patch(chatId, groupId, value), { chatId, groupId, value });
  const calls = () => page.evaluate(() => structuredClone(window.__qaQuestionPopup.calls));
  const answerCalls = async () => (await calls()).filter(call => call.method === 'chat.question.answer');
  const group = (id, questions, seconds = 60) => ({ id, questions, status: 'waiting', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + seconds * 1000).toISOString(), waitSeconds: seconds });
  const question = (id, text, labels = []) => ({ id, question: text, options: labels.map(label => ({ label, description: label + ' synthetic description.' })) });
  const reopen = async () => { await page.getByRole('button', { name: /Answer questions/ }).click(); await dialog().waitFor(); };
  await open('c1');

  await emit('c2', group('background', [question('background-choice', 'Which background route?', ['Route A', 'Route B'])]));
  await page.waitForTimeout(150);
  assert.equal(await dialog().count(), 0, 'background chat questions must not open over the current chat');
  assert.equal(await page.locator('.topbar-heading').filter({ hasText: 'Synthetic popup source' }).count(), 1);
  report.checks.backgroundChatDoesNotHijack = true;

  const first = group('current-one', [question('route', 'Which current route?', ['Short route', 'Long route']), question('details', 'What extra details?')], 10);
  await emit('c1', first); await dialog().waitFor();
  assert.match(await dialog().textContent(), /Which current route\?/);
  assert.equal(await dialog().getAttribute('aria-modal'), 'true');
  assert.equal(await dialog().evaluate(el => !!el.closest('.chat-scroll')), false, 'dialog is a separate popup outside the scrolling transcript');
  const popupBounds = await dialog().boundingBox();
  assert.ok(popupBounds && popupBounds.width > 250 && popupBounds.x >= 0 && popupBounds.y >= 0 && popupBounds.x + popupBounds.width <= 1361 && popupBounds.y + popupBounds.height <= 901, 'the popup stays fully inside the visible viewport');
  assert.equal(await page.locator('.chat-scroll .question-card[data-question-id="current-one"]').count(), 1, 'transcript retains its question card');
  assert.equal((await answerCalls()).length, 0, 'opening never supplies an answer');
  assert.equal(await dialog().locator('input:checked').count(), 0, 'no answer is preselected');
  assert.equal(await dialog().getByRole('button', { name: 'Send answer', exact: true }).isDisabled(), true, 'the user must choose each answer');
  assert.equal(await dialog().getByRole('button', { name: 'Send answer', exact: true }).evaluate(element => getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)'), true, 'sending has a visible button background rather than plain text');
  report.checks.currentEventOpensPopupAndRetainsTranscript = true;
  const longRow = dialog().locator('.question-option').filter({ hasText: 'Long route synthetic description.' });
  await longRow.getByText('Long route', { exact: true }).click();
  assert.equal(await dialog().getByLabel('Long route synthetic description.', { exact: false }).isChecked(), true, 'clicking option text selects its answer');
  await dialog().locator('.question-option').filter({ hasText: 'Short route synthetic description.' }).click({position:{x:12,y:12}});
  assert.equal(await dialog().getByLabel('Short route synthetic description.', { exact: false }).isChecked(), true, 'clicking the answer row selects its answer');
  report.checks.optionTextAndRowAcceptRealMouseClicks = true;
  await emit('c1', group('current-two', [question('second', 'Which queued route?', ['Queue A', 'Queue B'])]));
  assert.match(await dialog().textContent(), /Which current route\?/);
  assert.doesNotMatch(await dialog().textContent(), /Which queued route\?/);
  report.checks.newGroupQueuesWithoutReplacingCurrentDraft = true;

  const own = dialog().getByLabel('Write my own answer', { exact: true });
  await own.check();
  await dialog().getByLabel('Your answer: Which current route?', { exact: true }).fill('My custom synthetic route');
  await dialog().getByLabel('Your answer: What extra details?', { exact: true }).fill('Keep the existing planned details.');
  const beforeTimer = await dialog().locator('.question-timer').textContent();
  await dialog().getByRole('button', { name: 'Later', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  await page.waitForTimeout(1100); await reopen();
  assert.equal(await dialog().getByLabel('Your answer: Which current route?', { exact: true }).inputValue(), 'My custom synthetic route');
  assert.equal(await dialog().getByLabel('Your answer: What extra details?', { exact: true }).inputValue(), 'Keep the existing planned details.');
  const afterTimer = await dialog().locator('.question-timer').textContent();
  assert.notEqual(afterTimer, beforeTimer, 'response timer continues while popup is dismissed');
  const beforeSeconds = /Response window: (\d+)s/.exec(beforeTimer), afterSeconds = /Response window: (\d+)s/.exec(afterTimer);
  assert.ok(beforeSeconds && afterSeconds && Number(afterSeconds[1]) < Number(beforeSeconds[1]), 'Later dismisses the popup without ending its countdown');
  assert.equal((await calls()).filter(call => call.method === 'chat.question.continue').length, 0, 'Later must not silently end the response window');
  report.checks.dismissReopenPreservesMultipleCustomDrafts = true;
  report.checks.countdownContinuesWhenDismissed = { before: beforeTimer, after: afterTimer };

  await dialog().getByRole('button', { name: 'Later', exact: true }).focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i < 6 ? 'Tab' : 'Shift+Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"][aria-modal="true"]')), true, 'keyboard focus stays in the question dialog');
  }
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' }); await reopen();
  assert.equal(await dialog().getByLabel('Your answer: Which current route?', { exact: true }).inputValue(), 'My custom synthetic route');
  report.checks.keyboardTrapAndEscapePreserveDraft = true;
  const remaining = Math.max(0, Date.parse(first.expiresAt) - Date.now()) + 1200;
  await page.waitForTimeout(remaining);
  assert.equal((await answerCalls()).length, 0, 'timer expiry must not send any answer');
  assert.equal(await dialog().count(), 1, 'timer expiry leaves question popup available');
  assert.match(await dialog().locator('.question-timer').textContent(), /0s|window has ended|answer later/i);
  report.checks.realCountdownExpiresWithoutAutoSubmitting = true;

  await page.evaluate(() => { window.__qaQuestionPopup.answerMode = 'hold'; });
  await dialog().getByRole('button', { name: 'Send answer', exact: true }).click();
  await page.waitForFunction(() => !!window.__qaQuestionPopup.pending);
  assert.equal(await dialog().count(), 1, 'question stays visible while answer host response is pending');
  assert.equal(await dialog().getByRole('button', { name: /Sending/ }).isDisabled(), true);
  for (const shortcut of ['Control+n', 'Control+,', 'Control+f']) {
    await page.keyboard.press(shortcut);
    assert.equal(await dialog().getAttribute('data-question-id'), 'current-one', 'global navigation shortcuts cannot replace a busy question popup');
    assert.equal(await page.locator('.topbar-heading').textContent(), 'Synthetic popup source');
    assert.equal(await page.locator('.chat-find-bar').count(), 0);
  }
  await page.evaluate(() => window.__qaQuestionPopup.release('Synthetic host rejected this answer'));
  await dialog().getByRole('alert').filter({ hasText: 'Synthetic host rejected this answer' }).waitFor();
  assert.equal(await dialog().getByLabel('Your answer: Which current route?', { exact: true }).inputValue(), 'My custom synthetic route');
  const sent = (await answerCalls())[0].payload;
  assert.deepEqual(sent.answers, { route: 'My custom synthetic route', details: 'Keep the existing planned details.' });
  assert.equal(sent.conversationId, 'c1'); assert.equal(sent.id, 'current-one');
  report.checks.pendingAndRejectedHostResponseKeepPopupDraft = true;
  await page.evaluate(() => { window.__qaQuestionPopup.answerMode = 'success'; });
  await dialog().getByRole('button', { name: 'Send answer', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  // Later intentionally dismissed all groups that were already pending. The
  // header reopens the oldest pending group; a newly arriving group still queues.
  await reopen();
  await dialog().getByText('Which queued route?', { exact: true }).waitFor();
  await emit('c1', group('current-three', [question('third', 'Which newly queued route?', ['New queue A', 'New queue B'])]));
  assert.equal(await dialog().getByText('Which queued route?', { exact: true }).count(), 1);
  await dialog().getByRole('radio', { name: /^Queue B\b/ }).check();
  await page.evaluate(() => { window.__qaQuestionPopup.answerMode = 'hold-early-status'; });
  await dialog().getByRole('button', { name: 'Send answer', exact: true }).click();
  await page.waitForFunction(() => !!window.__qaQuestionPopup.pending);
  assert.equal(await dialog().getAttribute('data-question-id'), 'current-two', 'early answered/sending host event must not advance the queue before invocation acknowledgment');
  assert.match(await dialog().textContent(), /Sending/);
  await page.evaluate(() => window.__qaQuestionPopup.release('Synthetic acknowledgment was lost'));
  await dialog().getByRole('button', { name: 'Check answer again', exact: true }).waitFor();
  assert.equal(await dialog().getAttribute('data-question-id'), 'current-two');
  assert.match(await dialog().textContent(), /Synthetic acknowledgment was lost/);
  await page.evaluate(() => { window.__qaQuestionPopup.answerMode = 'success'; });
  await dialog().getByRole('button', { name: 'Check answer again', exact: true }).click();
  await dialog().getByText('Which newly queued route?', { exact: true }).waitFor();
  assert.equal(await dialog().getByRole('radio', { name: /^New queue A\b/ }).isChecked(), false, 'next distinct question does not inherit or preselect an answer');
  assert.equal(await dialog().getByRole('button', { name: 'Send answer', exact: true }).isDisabled(), true, 'next distinct question requires a deliberate selection');
  await dialog().getByRole('radio', { name: /^New queue A\b/ }).check();
  await dialog().getByRole('button', { name: 'Send answer', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  assert.equal((await answerCalls()).length, 5);
  assert.deepEqual((await answerCalls())[2].payload.answers, { second: 'Queue B' });
  report.checks.successfulAcknowledgmentAdvancesQueueAndCloses = true;
  report.checks.earlyAnsweredEventWaitsForHostAcknowledgment = true;
  assert.deepEqual((await answerCalls())[2].payload, (await answerCalls())[3].payload);
  report.checks.lostAcknowledgmentKeepsPopupAndChecksSavedAnswer = true;

  await emit('c1', group('delivery-retry', [question('retry-answer', 'Should delivery be retried?', ['Saved retry answer', 'Alternative'])]));
  await dialog().getByText('Should delivery be retried?', { exact: true }).waitFor();
  await dialog().getByRole('radio', { name: /^Saved retry answer\b/ }).check();
  await page.evaluate(() => { window.__qaQuestionPopup.answerMode = 'delivery-failed'; });
  await dialog().getByRole('button', { name: 'Send answer', exact: true }).click();
  await dialog().getByRole('button', { name: 'Retry sending answer', exact: true }).waitFor();
  assert.match(await dialog().textContent(), /Synthetic delivery failed/);
  await page.evaluate(() => { window.__qaQuestionPopup.answerMode = 'success'; });
  await dialog().getByRole('button', { name: 'Retry sending answer', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  const deliveryAttempts = (await answerCalls()).slice(-2);
  assert.deepEqual(deliveryAttempts[0].payload, deliveryAttempts[1].payload, 'delivery retry sends exactly the saved answer and group ID');
  report.checks.failedDeliveryKeepsPopupForExactExplicitRetry = true;

  await emit('c1', group('retired', [question('retired-answer', 'Should this question become irrelevant?', ['Retire', 'Keep'])]));
  await dialog().getByText('Should this question become irrelevant?', { exact: true }).waitFor();
  await patch('c1', 'retired', { status: 'irrelevant', reason: 'Synthetic task changed.' });
  await dialog().waitFor({ state: 'hidden' });
  assert.equal((await answerCalls()).length, 7);
  report.checks.retiringQuestionClosesWithoutAnswer = true;

  await emit('c1', group('navigation', [question('navigation-answer', 'Which navigation draft?', ['Stay', 'Switch'])]));
  await dialog().getByText('Which navigation draft?', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: 'Later', exact: true }).click();
  await open('c2');
  if (await dialog().count()) assert.doesNotMatch(await dialog().textContent(), /Which navigation draft\?/);
  if (!await dialog().count()) await reopen();
  await dialog().getByText('Which background route?', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: 'Later', exact: true }).click();
  await open('c1'); if (!await dialog().count()) await reopen();
  await dialog().getByText('Which navigation draft?', { exact: true }).waitFor();
  await page.evaluate(() => window.__exominaPreviewEmit({ type: 'chat.open', conversationId: 'c2' }));
  await page.waitForFunction(() => document.querySelector('.topbar-heading')?.textContent.includes('Synthetic popup background'));
  assert.equal(await dialog().getByText('Which navigation draft?', { exact: true }).count(), 0, 'external chat navigation must clear the stale modal');
  report.checks.chatChangesNeverKeepAnotherChatQuestion = true;

  await patch('c1', 'navigation', { status: 'irrelevant', reason: 'Synthetic navigation checks finished.' });
  await patch('c2', 'background', { status: 'irrelevant', reason: 'Synthetic background checks finished.' });
  await dialog().waitFor({ state: 'hidden' });
  await emit('c2', group('uncertain-reopen', [question('uncertain-answer', 'Should this saved answer be checked?', ['Keep saved check', 'Alternative'])]));
  await dialog().getByRole('radio', { name: /^Keep saved check\b/ }).check();
  await dialog().getByText('Should this saved answer be checked?', { exact: true }).waitFor();
  await page.evaluate(() => { window.__qaQuestionPopup.answerMode = 'hold-early-status'; });
  await dialog().getByRole('button', { name: 'Send answer', exact: true }).click();
  await page.waitForFunction(() => !!window.__qaQuestionPopup.pending);
  await page.evaluate(() => window.__qaQuestionPopup.release('Synthetic acknowledgment was lost before reopening'));
  await dialog().getByRole('button', { name: 'Check answer again', exact: true }).waitFor();
  await dialog().getByRole('button', { name: 'Later', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' }); await reopen();
  await dialog().getByRole('button', { name: 'Check answer again', exact: true }).waitFor();
  assert.match(await dialog().textContent(), /Sending has not been confirmed yet/);
  await page.evaluate(() => { window.__qaQuestionPopup.answerMode = 'success'; });
  await dialog().getByRole('button', { name: 'Check answer again', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  const checkAttempts = (await answerCalls()).slice(-2);
  assert.deepEqual(checkAttempts[0].payload, checkAttempts[1].payload);
  report.checks.dismissReopenPreservesUnconfirmedAnswerCheck = true;

  const copied = group('copied-group', [question('copied-question', 'Which shared branch draft?', ['Default shared', 'Other shared'])]);
  await emit('c1', copied); await emit('c2', copied);
  await dialog().getByText('Which shared branch draft?', { exact: true }).waitFor();
  await dialog().getByLabel('Write my own answer', { exact: true }).check();
  await dialog().getByLabel('Your answer: Which shared branch draft?', { exact: true }).fill('Background branch answer');
  await dialog().getByRole('button', { name: 'Later', exact: true }).click();
  await open('c1'); await dialog().getByText('Which shared branch draft?', { exact: true }).waitFor();
  assert.equal(await dialog().getByRole('radio', { name: /^Default shared\b/ }).isChecked(), false, 'a copied group ID in another chat does not inherit a choice');
  await dialog().getByLabel('Write my own answer', { exact: true }).check();
  await dialog().getByLabel('Your answer: Which shared branch draft?', { exact: true }).fill('Source branch answer');
  for (const shortcut of ['Control+n', 'Control+,', 'Control+f', 'Meta+n', 'Meta+,', 'Meta+f']) {
    await page.keyboard.press(shortcut);
    assert.equal(await dialog().getAttribute('data-question-id'), 'copied-group', 'global navigation shortcuts cannot change a question popup');
    assert.equal(await page.locator('.topbar-heading').textContent(), 'Synthetic popup source');
    assert.equal(await page.locator('.chat-find-bar').count(), 0);
  }
  await dialog().getByRole('button', { name: 'Later', exact: true }).click();
  await open('c2'); await reopen();
  assert.equal(await dialog().getByLabel('Your answer: Which shared branch draft?', { exact: true }).inputValue(), 'Background branch answer');
  await dialog().getByRole('button', { name: 'Later', exact: true }).click();
  await open('c1'); await reopen();
  assert.equal(await dialog().getByLabel('Your answer: Which shared branch draft?', { exact: true }).inputValue(), 'Source branch answer');
  report.checks.copiedGroupIdsKeepDraftsSeparateAcrossChats = true;
  report.checks.globalNavigationShortcutsCannotReplacePopup = true;

  await page.evaluate(() => { window.__qaQuestionPopup.answerMode = 'hold'; });
  await dialog().getByRole('button', { name: 'Send answer', exact: true }).click();
  await page.waitForFunction(() => !!window.__qaQuestionPopup.pending);
  await page.evaluate(() => window.__exominaPreviewEmit({ type: 'chat.open', conversationId: 'c2' }));
  await page.waitForFunction(() => document.querySelector('.topbar-heading')?.textContent.includes('Synthetic popup background'));
  if (!await dialog().count()) await reopen();
  assert.equal(await dialog().getByLabel('Your answer: Which shared branch draft?', { exact: true }).inputValue(), 'Background branch answer');
  assert.equal(await dialog().getByRole('button', { name: 'Send answer', exact: true }).isDisabled(), false, 'sending a copied ID in the source chat must not disable its background branch');
  await page.evaluate(() => window.__exominaPreviewEmit({ type: 'chat.open', conversationId: 'c1' }));
  await page.waitForFunction(() => document.querySelector('.topbar-heading')?.textContent.includes('Synthetic popup source'));
  assert.equal(await dialog().getByRole('button', { name: /Sending/ }).isDisabled(), true, 'the source chat still tracks its pending answer');
  await page.evaluate(() => { window.__qaQuestionPopup.answerMode = 'success'; window.__qaQuestionPopup.release(); });
  await dialog().waitFor({ state: 'hidden' });
  await open('c2'); await reopen();
  assert.equal(await dialog().getByLabel('Your answer: Which shared branch draft?', { exact: true }).inputValue(), 'Background branch answer');
  assert.equal((await answerCalls()).length, 10);
  assert.equal((await answerCalls()).at(-1).payload.conversationId, 'c1');
  assert.deepEqual((await answerCalls()).at(-1).payload.answers, { 'copied-question': 'Source branch answer' });
  report.checks.copiedGroupSendingAndReceiptStayInOriginChat = true;

  await dialog().getByRole('button', { name: 'Later', exact: true }).click();
  await patch('c2', 'copied-group', { status: 'irrelevant', reason: 'Synthetic branch checks finished.' });
  const multi = { ...question('features', 'Which features should I enable?', ['Memory', 'Browser', 'Desktop']), multiSelect: true };
  await emit('c2', group('multiple-answers', [multi]));
  await dialog().getByText('Which features should I enable?', { exact: true }).waitFor();
  assert.equal(await dialog().locator('input:checked').count(), 0);
  await dialog().getByRole('checkbox', { name: /^Memory\b/ }).click();
  await dialog().getByRole('checkbox', { name: /^Browser\b/ }).click();
  assert.equal(await dialog().locator('.question-option.is-selected').count(), 2, 'selected answer rows visibly reflect both choices');
  await dialog().getByRole('checkbox', { name: 'Write my own answer', exact: true }).click();
  assert.equal(await dialog().getByRole('button', { name: 'Send answer', exact: true }).isDisabled(), true, 'an empty checked custom answer cannot be silently dropped');
  await dialog().getByLabel('Your answer: Which features should I enable?', { exact: true }).fill('Project search');
  await dialog().getByRole('button', { name: 'Later', exact: true }).click(); await reopen();
  assert.equal(await dialog().getByRole('checkbox', { name: /^Memory\b/ }).isChecked(), true);
  assert.equal(await dialog().getByRole('checkbox', { name: /^Browser\b/ }).isChecked(), true);
  await dialog().getByRole('button', { name: 'Send answer', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  assert.deepEqual((await answerCalls()).at(-1).payload.answers, { features: 'Memory, Browser, Project search' });
  report.checks.multipleSelectionsAndCustomAnswerPersistAndSubmit = true;
  report.checks.noPreselectedAnswerAndVisibleSelectedRows = true;

  await page.setViewportSize({width:390,height:844});
  await emit('c2', group('narrow-radio', [question('narrow', 'Which narrow-layout answer?', ['First narrow option', 'Second narrow option'])]));
  await dialog().getByText('Which narrow-layout answer?', { exact: true }).waitFor();
  const narrowRadio=dialog().getByRole('radio',{name:/^Second narrow option\b/}),radioBounds=await narrowRadio.boundingBox();
  assert.ok(radioBounds&&radioBounds.width<=18&&radioBounds.height<=18, 'mobile text-field minimum height must not stretch answer radio controls');
  await dialog().locator('.question-option').filter({hasText:'Second narrow option synthetic description.'}).getByText('Second narrow option',{exact:true}).click();
  assert.equal(await narrowRadio.isChecked(),true);
  await dialog().getByRole('button',{name:'Send answer',exact:true}).click();await dialog().waitFor({state:'hidden'});
  assert.deepEqual((await answerCalls()).at(-1).payload.answers,{narrow:'Second narrow option'});
  report.checks.narrowViewportRadioRemainsCompactAndClickable=true;

  await page.screenshot({ path: path.join(output, 'question-popup.png') });
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'question-popup-failure.png') }).catch(() => {});
} finally {
  await browser?.close(); await server.close();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
