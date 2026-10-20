// Isolated renderer + IPC fixture. All chats, notes, and responses are synthetic.
// No private profile, certificate, real provider, or network model call is used.
import { _electron as electron } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const output = await mkdtemp(path.resolve(root, '../Workspace/qa-memory-chats-'));
const preload = path.join(output, 'preload.cjs');
const entry = path.join(output, 'fixture.cjs');
const state = {
  settings: { provider: 'codex', model: 'auto', memoryEnabled: true, memoryCapture: 'automatic' },
  security: { recoveryAudit: { status: 'pending' } },
  connections: [{ id: 'codex', connected: false, checking: true, detail: 'Checking private account storage…' }], tools: [], approvals: [], version: 'synthetic',
  runtime: { capabilities: { nativeBrowser: false, localFiles: false, desktopControl: false } },
  memories: [{ id: 'baseline', text: 'Synthetic baseline note.', reviewed: true, createdAt: '2026-10-01' }],
  archive: { documents: 900, conversationCount: 800, artifactCount: 100 },
  conversations: [
    { id: 'alpha', title: 'Planning alpha', provider: 'codex', updatedAt: '2026-10-06', messages: Array.from({ length: 32 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: index === 3 ? 'Synthetic needle [x] first match. Another needle [x]. <img src=x onerror=alert(1)>' : index === 26 ? 'Synthetic final needle [x] match.' : `Synthetic message ${index}. ` + 'Long enough to create an independently scrollable transcript. '.repeat(6) })) },
    { id: 'beta', title: 'Pinned beta', pinned: true, provider: 'claude', updatedAt: '2026-10-02', messages: [{ role: 'user', content: 'Synthetic running chat.' }] },
    { id: 'gamma', title: 'Archived gamma', archived: true, provider: 'claude', updatedAt: '2026-10-03', messages: [{ role: 'user', content: 'Synthetic archive needle [x] context.' }] },
  ],
  activeRuns: [{ conversationId: 'beta' }],
};
await writeFile(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('studio',{invoke:(method,payload)=>ipcRenderer.invoke('qa:invoke',method,payload),onEvent:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('studio:event',listener);return()=>ipcRenderer.removeListener('studio:event',listener)}});`);
await writeFile(entry, `const{app,BrowserWindow,ipcMain}=require('electron');app.setPath('userData',process.env.QA_PROFILE);
globalThis.qa={state:${JSON.stringify(state)},calls:[],reviewedBatches:[],failReview:false};
const summary=()=>({unreviewedCount:globalThis.qa.state.memories.filter(item=>item.reviewed===false).length});
ipcMain.handle('qa:invoke',(_event,method,payload={})=>{
 const q=globalThis.qa,s=q.state;q.calls.push(method);
 if(method==='security.status')return{protected:true,supported:true,needsRecovery:false};
 if(method==='security.auditRecovery'){s.security.recoveryAudit={status:'checking'};_event.sender.send('studio:event',{type:'security.changed'});return new Promise((resolve,reject)=>{q.completeAudit=()=>{s.security.recoveryAudit=q.failAudit?{status:'error',message:'Synthetic full audit failure.'}:{status:'verified',checkedAt:'2026-10-06T12:00:00.000Z'};_event.sender.send('studio:event',{type:'security.changed'});if(q.failAudit)reject(Error('Synthetic full audit failure.'));else resolve(s.security.recoveryAudit)}})}
 if(method==='bootstrap')return{...s,memoryReview:summary()};
 if(method==='memory.search')return s.memories.filter(item=>(!payload.newOnly||!item.reviewed)&&item.text.toLowerCase().includes(String(payload.query||'').toLowerCase()));
 if(method==='memory.review'){if(q.failReview)throw Error('Synthetic review could not be saved');q.reviewedBatches.push(payload.ids);for(const note of s.memories)if(payload.ids.includes(note.id))note.reviewed=true;return summary()}
 if(method==='memory.add'){s.memories.push({id:'manual-'+s.memories.length,text:payload.text,reviewed:false,createdAt:new Date().toISOString()});return s.memories}
 if(method==='memory.delete'){s.memories=s.memories.filter(item=>item.id!==payload.id);return s.memories}
 if(method==='settings.save'){Object.assign(s.settings,payload);return s.settings}
 if(method==='connections.refresh')return s.connections;
 if(method==='provider.connect')return{message:'Synthetic official sign-in response.',url:'https://auth.kimi.com/device?synthetic=1',userCode:'QA-1234'};
 if(method==='conversations.get')return s.conversations.find(chat=>chat.id===payload.id);
 if(method==='conversations.delete'){s.conversations=s.conversations.filter(chat=>chat.id!==payload.id);return{}}
 if(['conversations.rename','conversations.pin','conversations.archive'].includes(method)){
   const chat=s.conversations.find(chat=>chat.id===payload.id);if(!chat)throw Error('Missing synthetic chat');
   if(method==='conversations.rename'){chat.title=payload.title.trim().replace(/\\s+/g,' ');chat.titleSource='manual'}
   if(method==='conversations.pin')chat.pinned=payload.pinned;
   if(method==='conversations.archive'){if(payload.archived&&s.activeRuns.some(run=>run.conversationId===chat.id))throw Error('Synthetic chat is active');chat.archived=payload.archived}
   return chat;
 }
 throw Error('Unexpected synthetic method: '+method);
});app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:1000,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadFile(${JSON.stringify(path.join(root, 'dist/index.html'))})});app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env, QA_PROFILE: path.join(output, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [entry], env, timeout: 30000 });
const report = { syntheticOnly: true, checks: {} };
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const memoryNav = page.getByRole('button', { name: 'Memory', exact: true });
  const dot = page.locator('.memory-update-dot');
  const emitChanged = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('studio:event', { type: 'state.changed' }));
  await page.getByRole('heading', { name: /^(Good (morning|afternoon|evening)|Up late).$/ }).waitFor();
  await page.getByText('Checking private account storage…', { exact: true }).waitFor();
  assert.equal(await page.locator('.connect-hint').getByRole('button', { name: 'Connect', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const checkingCard = page.locator('[data-provider="codex"]');
  assert.equal(await checkingCard.getByRole('button', { name: 'Checking…', exact: true }).isDisabled(), true);
  assert.equal(await checkingCard.getByRole('button', { name: /^Sign in/ }).count(), 0);
  await app.evaluate(({ BrowserWindow }) => { globalThis.qa.state.connections = [{ id: 'codex', installed: true, connected: false, checking: false, detail: 'Synthetic check complete.' }]; BrowserWindow.getAllWindows()[0].webContents.send('studio:event', { type: 'connections', connections: globalThis.qa.state.connections }); });
  await checkingCard.getByRole('button', { name: 'Sign in to ChatGPT', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  report.checks.accountChecking = { nonBlocking: true, signInDeferred: true, statusEventUnlocksAction: true };
  assert.equal(await dot.count(), 0, 'Baseline notes and imported archive totals must not notify');
  assert.equal(await memoryNav.locator('.nav-count').count(), 0);
  await app.evaluate(() => globalThis.qa.state.memories.push({ id: 'new-auto', text: 'Synthetic new automatic note.', reviewed: false }, { id: 'new-sync', text: 'Synthetic new synced note.', reviewed: false }));
  await emitChanged(); await dot.waitFor();
  await memoryNav.click();
  await page.locator('.memory-card.is-new').first().waitFor();
  assert.equal(await page.locator('.memory-card.is-new').count(), 2);
  assert.equal(await app.evaluate(() => globalThis.qa.reviewedBatches.length), 0, 'Opening Memory must not review notes');
  await page.getByRole('group', { name: 'Filter memories' }).getByRole('button', { name: /^New/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.memory-card').length === 2);
  await page.getByLabel('Search memories', { exact: true }).fill('automatic');
  await page.getByLabel('Search memories', { exact: true }).press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.memory-card').length === 1);
  await page.getByRole('button', { name: 'Mark shown as reviewed', exact: true }).click();
  await page.getByRole('heading', { name: 'No notes found', exact: true }).waitFor();
  assert.deepEqual(await app.evaluate(() => globalThis.qa.reviewedBatches), [['new-auto']]);
  await dot.waitFor();
  await page.getByLabel('Search memories', { exact: true }).fill('');
  await page.getByText('Synthetic new synced note.', { exact: true }).waitFor();
  await app.evaluate(() => { globalThis.qa.failReview = true; });
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic review could not be saved' }).waitFor();
  assert.equal(await page.locator('.memory-card.is-new').count(), 1);
  await app.evaluate(() => { globalThis.qa.failReview = false; });
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.getByRole('heading', { name: 'No new memories', exact: true }).waitFor();
  assert.equal(await dot.count(), 0);
  await page.reload(); await memoryNav.click();
  assert.equal(await dot.count(), 0, 'Renderer reload uses persisted review state');
  assert.equal(await page.locator('.memory-card.is-new').count(), 0);
  await page.getByRole('button', { name: 'Add a memory', exact: true }).click();
  await page.getByLabel('What should be saved?').fill('Synthetic manually saved note.');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await dot.waitFor(); await page.getByText('Synthetic manually saved note.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'memory-new.png') });
  report.checks.memoryReview = { noTotalBadge: true, archiveExcluded: true, newNotesHighlighted: true, explicitReviewOnly: true, visibleIdsOnly: true, failedReviewPreserved: true, reloadPreserved: true, manualNotesIncluded: true };

  if (process.argv.includes('--memory-only')) {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.locator('.memory-notes').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(output, 'phone-memory.png') });
    report.checks.phoneMemory = { viewport: 360, noHorizontalOverflow: true };
  } else {
  if (!process.argv.includes('--native-auth-only')) {
  const chatRow = id => page.locator(`.chat-list-entry[data-chat-id="${id}"]`);
  const more = id => chatRow(id).getByRole('button', { name: /^More options/ });
  await chatRow('alpha').locator('.chat-open').click();
  await more('alpha').click(); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Chat name', { exact: true }).fill('  My   renamed chat  ');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await chatRow('alpha').getByText('My renamed chat', { exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.qa.state.conversations.find(chat => chat.id === 'alpha').titleSource), 'manual');
  await more('alpha').click(); await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.chat-list-entry')?.dataset.chatId === 'alpha');
  await more('beta').click();
  assert.equal(await page.getByRole('menuitem', { name: 'Archive', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('menuitem', { name: 'Rename', exact: true }).isEnabled(), true);
  await page.keyboard.press('Escape');
  await more('alpha').click(); await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await page.getByText('This chat is archived.', { exact: true }).waitFor();
  assert.equal(await chatRow('alpha').count(), 0);
  assert.ok(await page.locator('.message').count() > 0, 'Archiving the open chat must preserve its view');
  await page.getByRole('button', { name: 'Restore chat', exact: true }).click();
  await chatRow('alpha').waitFor();
  const search = page.getByLabel('Search chats', { exact: true });
  await search.fill('needle [x]');
  await page.getByRole('region', { name: 'Your chats' }).getByRole('button', { name: 'All', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.chat-search-results .chat-list-entry').length === 2);
  assert.equal(await page.locator('.chat-search-snippet mark').count(), 2);
  await chatRow('gamma').locator('.chat-open').click();
  await page.locator('.message-content').getByText('Synthetic archive needle [x] context.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Restore chat', exact: true }).click();
  await page.getByRole('button', { name: 'Clear chat search', exact: true }).click();
  await more('gamma').click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await chatRow('gamma').count(), 1);
  await more('gamma').click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-chat-id="gamma"]'));
  await search.fill('this phrase has no match');
  await page.getByText('No matching chats. Try another phrase or choose All.', { exact: true }).waitFor();
  await search.press('Escape'); assert.equal(await search.inputValue(), '');
  assert.equal(await page.locator('.message-content img').count(), 0);
  report.checks.chatManagement = { renameManual: true, pinSorting: true, activeArchiveBlocked: true, archiveKeepsOpenView: true, restore: true, globalMessageSearch: true, archivedSearch: true, literalSnippetHighlight: true, emptyAndEscape: true, confirmedDelete: true };
  await chatRow('alpha').locator('.chat-open').click();
  await page.keyboard.press('Control+f');
  const find = page.getByRole('searchbox', { name: 'Find in this chat', exact: true });
  await find.fill('needle [x]');
  await page.getByText('1 of 3', { exact: true }).waitFor();
  assert.equal(await page.locator('.message-content mark.chat-match').count(), 3);
  assert.equal(await page.locator('[data-message-index="3"] mark.current').count(), 1);
  await page.getByRole('button', { name: 'Next match', exact: true }).click();
  await page.getByText('2 of 3', { exact: true }).waitFor();
  await find.press('Enter'); await page.getByText('3 of 3', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const hit = document.querySelector('[data-message-index="26"] mark.current');
    const region = document.querySelector('.chat-scroll');
    if (!hit || !region) return false;
    const a = hit.getBoundingClientRect(), b = region.getBoundingClientRect();
    return a.top >= b.top && a.bottom <= b.bottom;
  });
  await find.press('Enter'); await page.getByText('1 of 3', { exact: true }).waitFor();
  await find.press('Shift+Enter'); await page.getByText('3 of 3', { exact: true }).waitFor();
  await find.fill('unmatched synthetic phrase');
  await page.getByText('No matches', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Next match', exact: true }).isDisabled(), true);
  await find.press('Escape');
  assert.equal(await page.getByRole('search', { name: 'Find in current chat' }).count(), 0);
  assert.equal(await page.locator('.message-content mark').count(), 0);
  await search.fill('needle [x]'); await chatRow('alpha').locator('.chat-open').click();
  await page.getByText('1 of 3', { exact: true }).waitFor();
  assert.equal(await find.inputValue(), 'needle [x]', 'Global message hit opens the local finder');
  assert.equal(await page.locator('.message-content img').count(), 0, 'Search must never interpret message HTML');
  report.checks.chatFind = { globalHitOpensFinder: true, literalHighlights: true, nextPreviousWrap: true, keyboardNavigation: true, scrollToSelectedMatch: true, noMatchState: true, escapeCloses: true, textOnly: true };
  await page.screenshot({ path: path.join(output, 'chat-sidebar.png') });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForFunction(() => window.innerWidth === 360);
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole('button', { name: 'Close chat search', exact: true }).click();
  await page.getByRole('button', { name: 'Find in this chat', exact: true }).click();
  await find.fill('needle [x]');
  await page.getByText('1 of 3', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const a = document.querySelector('mark.current')?.getBoundingClientRect();
    const b = document.querySelector('.chat-scroll').getBoundingClientRect();
    return a && a.top >= b.top && a.bottom <= b.bottom;
  });
  await page.screenshot({ path: path.join(output, 'phone-find.png') });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().left >= -1);
  await page.getByLabel('Search chats', { exact: true }).fill('renamed');
  await page.screenshot({ path: path.join(output, 'phone-chat-search.png') });
  assert.equal(await page.getByLabel('Search chats', { exact: true }).evaluate(node => parseFloat(getComputedStyle(node).fontSize)), 16);
  await memoryNav.click();
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
  await page.locator('.memory-card.is-new').waitFor();
  await page.locator('.memory-review-toolbar').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'phone-memory.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  report.checks.phone = { viewport: 360, noHorizontalOverflow: true, chatSearchInput16px: true, touchFindButtonOpensSearch: true, selectedMatchVisible: true };
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.waitForFunction(() => window.innerWidth === 1440 && document.querySelector('.sidebar').getBoundingClientRect().left >= -1);
  await app.evaluate(({ BrowserWindow }) => {
    const s = globalThis.qa.state;
    s.providers = [{ id: 'codex', name: 'ChatGPT', mode: 'subscription', engine: 'Codex' }, { id: 'antigravity', name: 'Antigravity', mode: 'subscription', engine: 'Antigravity CLI' }, { id: 'copilot', name: 'GitHub Copilot', mode: 'subscription', engine: 'Copilot' }, { id: 'kimi-code', name: 'Kimi Code', mode: 'subscription', engine: 'Kimi Code' }];
    s.connections = s.providers.map(provider => ({ id: provider.id, installed: true, connected: false }));
    BrowserWindow.getAllWindows()[0].webContents.send('studio:event', { type: 'state.changed' });
  });
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.locator('[data-provider="kimi-code"]').getByRole('button', { name: 'Sign in to Kimi Code', exact: true }).click();
  await page.getByText('Continue Kimi Code sign-in', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Sign-in code', { exact: true }).textContent(), 'QA-1234');
  assert.equal(await page.getByRole('link', { name: 'Open provider sign-in' }).getAttribute('href'), 'https://auth.kimi.com/device?synthetic=1');
  await page.screenshot({ path: path.join(output, 'native-device-sign-in.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('studio:event', { type: 'auth.completed', provider: 'kimi-code' }));
  await page.waitForFunction(() => !document.querySelector('.provider-auth-banner'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('studio:event', { type: 'auth.url', provider: 'kimi-code', url: 'https://auth.kimi.com/device?synthetic-event=1' }));
  await page.getByText('Continue Kimi Code sign-in', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Sign-in code', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Dismiss provider sign-in', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('studio:event', { type: 'auth.url', provider: 'kimi-code', url: 'https://github.com/login/device' }));
  await page.getByRole('alert').filter({ hasText: 'unsupported sign-in address' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open provider sign-in' }).count(), 0);
  report.checks.nativeAuth = { desktopFallbackLink: true, deviceCodeVisible: true, officialKimiEvent: true, providerSpecificOriginRejected: true, completionClearsCode: true };
  await app.evaluate(({ BrowserWindow }) => { globalThis.qa.state.activeRuns = []; BrowserWindow.getAllWindows()[0].webContents.send('studio:event', { type: 'state.changed' }); });
  await page.getByRole('button', { name: /^Settings/ }).click();
  await page.getByText('Last full check: not checked in this version.', { exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.qa.calls.filter(method => method === 'security.auditRecovery').length), 0, 'Opening Settings must not trigger a full audit');
  await page.getByRole('button', { name: 'Check recovery', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Checking recovery…', exact: true }).isDisabled(), true);
  await page.getByText('Checking all private app files…', { exact: true }).waitFor();
  await app.evaluate(() => globalThis.qa.completeAudit());
  await page.waitForFunction(() => document.querySelector('.recovery-audit-status')?.textContent.includes('2026'));
  await app.evaluate(() => { globalThis.qa.failAudit = true; });
  await page.getByRole('button', { name: 'Check recovery', exact: true }).click();
  await page.getByRole('button', { name: 'Checking recovery…', exact: true }).waitFor();
  await app.evaluate(() => globalThis.qa.completeAudit());
  await page.locator('.recovery-audit-row').getByRole('alert').filter({ hasText: 'Synthetic full audit failure.' }).waitFor();
  await page.getByText('Last full check: failed.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Check recovery', exact: true }).isEnabled(), true);
  report.checks.manualRecoveryAudit = { noAutomaticAudit: true, pendingFeedback: true, lastCheckTimestamp: true, securityEventRefresh: true, failureActionable: true, retryAvailable: true };
  await page.screenshot({ path: path.join(output, 'recovery-audit-settings.png') });
  }
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).sort()), ['exomina.appearance', 'exomina.unread']);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  report.passed = true; report.rendererErrors = errors.length;
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }));
} finally { await app.close(); }
