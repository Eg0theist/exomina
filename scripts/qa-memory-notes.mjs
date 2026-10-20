// Real compiled renderer, fresh synthetic IPC/profile; no personal data or provider calls.
import { _electron as electron } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), output = await mkdtemp(path.resolve(root, '../Workspace/qa-memory-notes-'));
const notes = Array.from({ length: 73 }, (_, index) => ({
  id: `note-${index + 1}`, reviewed: false, date: `2026-10-${String(7 - index % 7).padStart(2, '0')}`,
  text: `Synthetic note ${String(index + 1).padStart(2, '0')}: ${index === 69 ? 'faraway-search-token. ' : ''}Keep a useful project decision with enough context to find and understand it later.`,
}));
notes[6].text = 'Synthetic Unicode note: ' + 'ö🙂 '.repeat(30);
notes[10].text = 'L'.repeat(280);
const state = {
  settings: { provider: 'codex', model: 'auto', memoryEnabled: true, memoryCapture: 'automatic', appearance: { theme: 'erebus-flame', motion: 'reduced' } },
  runtime: { capabilities: { localFiles: true, nativeBrowser: false } },
  security: {}, connections: [], conversations: [], tools: [], approvals: [], memories: notes,
  archive: { documents: 0 }, version: 'synthetic',
};
const preload = path.join(output, 'preload.cjs'), entry = path.join(output, 'fixture.cjs');
await writeFile(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('studio',{invoke:(method,payload)=>ipcRenderer.invoke('qa:invoke',method,payload),onEvent:cb=>{const f=(_e,d)=>cb(d);ipcRenderer.on('studio:event',f);return()=>ipcRenderer.removeListener('studio:event',f)}});`);
await writeFile(entry, `const{app,BrowserWindow,ipcMain}=require('electron');app.setPath('userData',process.env.QA_PROFILE);
globalThis.qa={state:${JSON.stringify(state)},calls:[],reviews:[],failReview:false};
const summary=()=>({unreviewedCount:qa.state.memories.filter(x=>x.reviewed===false).length});
ipcMain.handle('qa:invoke',(_e,method,p={})=>{qa.calls.push({method,p});const s=qa.state;
 if(method==='security.status')return{protected:true,supported:true,needsRecovery:false};
 if(method==='bootstrap')return{...s,memoryReview:summary()};
 if(method==='memory.search')return s.memories.filter(x=>(!p.newOnly||x.reviewed===false)&&x.text.toLowerCase().includes(String(p.query||'').toLowerCase()));
 if(method==='memory.review'){if(qa.failReview)throw Error('Synthetic review failure.');qa.reviews.push(p.ids);for(const x of s.memories)if(p.ids.includes(x.id))x.reviewed=true;return summary();}
 if(method==='memory.reviewAll'){if(qa.failReview)throw Error('Synthetic review failure.');for(const x of s.memories)x.reviewed=true;return summary();}
 if(method==='decision.status')return{settings:{enabled:true,makeWay:true},status:null,models:[],download:null,agent:{triggers:[],inbox:[],runsToday:0}};
 if(method==='memory.add'){s.memories.unshift({id:'added-note',text:p.text,reviewed:false,date:new Date().toISOString()});return s.memories;}
 if(method==='memory.delete'){s.memories=s.memories.filter(x=>x.id!==p.id);return s.memories;}
 if(method==='memory.wake'){
   if(qa.failWake)throw Error('Synthetic context read failure.');
   const first=p.part===undefined;
   if(!first&&(p.part!==2||p.snapshot!==73||p.cursor!==65))throw Error('Unexpected context continuation.');
   return{text:JSON.stringify({notes:first?[{seq:73,id:'context-recent',text:'Synthetic context remains unchanged.'},{range:'65-72',summary:'Recent saved notes, compacted.'}]:[{range:'1-64',summary:'Earlier saved notes: café 🌙, sources preserved.'}],snapshot:73,nextPart:first?2:null,nextCursor:first?65:null,total:73,pendingSummary:null})};
 }
 if(method==='memory.export')return{path:'synthetic-export-only.txt'};
 if(method==='settings.save'){Object.assign(s.settings,p);return s.settings;}
 throw Error('Unexpected synthetic method '+method);
});app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(path.join(process.env.EXOMINA_QA_RENDERER_ROOT||root,'dist/index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env, QA_PROFILE: path.join(output, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [entry], env, timeout: 30000 });
const report = { syntheticOnly: true, sourceNotes: notes.length, checks: {} };
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const emit = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('studio:event', { type: 'state.changed' }));
  assert.equal(await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Memory',exact:true}).count(),0);
  assert.equal(await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Connections',exact:true}).count(),0);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('navigation',{name:'Settings categories'}).getByRole('button',{name:'Privacy & data',exact:true}).click();
  await page.getByRole('button',{name:'View saved memories',exact:true}).click();
  const rows = page.locator('.memory-note-row'), next = page.getByRole('button', { name: 'Next page of memories' }), prev = page.getByRole('button', { name: 'Previous page of memories' });
  await rows.first().waitFor();
  assert.equal(await rows.count(), 12);
  const order = [];
  while (true) {
    order.push(...await rows.evaluateAll(items => items.map(item => item.dataset.memoryId)));
    if (await next.isDisabled()) break;
    const firstId = await rows.first().getAttribute('data-memory-id'); await next.click();
    await page.waitForFunction(id => document.querySelector('.memory-note-row')?.dataset.memoryId !== id, firstId);
  }
  assert.deepEqual(order, notes.map(note => note.id), 'Every original is accessible exactly once, in its existing order');
  assert.equal(await rows.count(), 1);
  assert.equal(await app.evaluate(() => qa.calls.filter(x => /^memory\.(review|delete|add|clear)$/.test(x.method)).length), 0, 'Reading and paging never change notes');
  report.checks.boundedListAndCompleteCoverage = { visibleAtMost: 12, originalsAccessible: order.length, implicitWrites: 0 };

  await rows.first().getByRole('button', { name: 'Delete memory', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await app.evaluate(() => qa.state.memories.length), 73);
  await rows.first().getByRole('button', { name: 'Delete memory', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete memory', exact: true }).click();
  await page.getByText('Page 6 of 6', { exact: true }).waitFor();
  assert.equal(await rows.count(), 12); assert.equal(await next.isDisabled(), true);
  await page.getByRole('button', { name: 'Add a memory', exact: true }).click();
  await page.getByLabel('What should be saved?').fill('Synthetic newly added note.');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.getByText('Page 6 of 7', { exact: true }).waitFor();
  assert.equal(await app.evaluate(() => qa.state.memories.length), 73);
  report.checks.explicitDeleteAndStablePage = { cancelPreserves: true, lastPageClamps: true, newNoteKeepsReadingPage: true };

  const search = page.getByLabel('Search memories', { exact: true });
  await search.fill('faraway-search-token'); await search.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.memory-note-row').length === 1);
  assert.equal(await rows.first().getAttribute('data-memory-id'), 'note-70');
  assert.equal(await page.locator('.memory-pagination').count(), 0);
  await search.fill('no-matching-synthetic-note'); await search.press('Enter');
  await page.getByRole('heading', { name: 'No notes found', exact: true }).waitFor();
  await search.fill(''); await page.getByText('Page 1 of 7', { exact: true }).waitFor();
  const visibleIds = await rows.evaluateAll(items => items.map(item => item.dataset.memoryId));
  await page.getByRole('button', { name: 'Mark shown as viewed', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.memory-note-row.is-new'));
  assert.deepEqual(await app.evaluate(() => qa.reviews), [visibleIds]);
  assert.equal(await app.evaluate(() => qa.state.memories.filter(x => !x.reviewed).length), 61);
  await page.getByRole('group', { name: 'Filter memories' }).getByRole('button', { name: /^New/ }).click();
  await page.getByText('Page 1 of 6', { exact: true }).waitFor();
  assert.equal(await page.locator('.memory-note-row.is-new').count(), 12);
  await app.evaluate(() => { qa.failReview = true; });
  const failingId = await rows.first().getAttribute('data-memory-id');
  await rows.first().getByRole('button', { name: 'Mark viewed', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic review failure.' }).waitFor();
  assert.equal(await app.evaluate((_electron, id) => qa.state.memories.find(x => x.id === id).reviewed, failingId), false);
  await app.evaluate(() => { qa.failReview = false; });
  await rows.first().getByRole('button', { name: 'Mark viewed', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.memory-note-row')?.dataset.memoryId !== id, failingId);
  assert.equal(await app.evaluate((_electron, id) => qa.state.memories.find(x => x.id === id).reviewed, failingId), true);
  report.checks.searchAndReview = { searchesHiddenPages: true, emptyAndClear: true, filtersResetPage: true, bulkOnlyVisibleIds: visibleIds, failedReviewPreserves: true, explicitRetryWorks: true };

  await page.getByRole('group', { name: 'Filter memories' }).getByRole('button', { name: 'All notes', exact: true }).click();
  await page.getByText('Page 1 of 7', { exact: true }).waitFor();
  const unicode = page.locator('[data-memory-id="note-7"]');
  await unicode.locator('.memory-note-toggle').click();
  assert.equal(await unicode.locator('.memory-note-details>p').textContent(), notes[6].text);
  assert.equal(await page.locator('.memory-note-details').count(), 1);
  await rows.first().locator('.memory-note-toggle').click();
  assert.equal(await unicode.locator('.memory-note-details').count(), 0);
  await rows.first().locator('.memory-note-toggle').focus(); await page.keyboard.press('Space');
  assert.equal(await page.locator('.memory-note-details').count(), 0);
  async function selectOnly(field, shortcut = 'Control+A') {
    await field.click();
    const expected = await field.textContent();
    await page.keyboard.press(shortcut);
    const actual = await field.evaluate(element => {
      const selection = window.getSelection();
      return { text: selection.toString(), anchorInside: element.contains(selection.anchorNode), focusInside: element.contains(selection.focusNode), focused: document.activeElement === element };
    });
    assert.deepEqual(actual, { text: expected, anchorInside: true, focusInside: true, focused: true });
  }
  await rows.first().locator('.memory-note-toggle').click();
  const noteText = rows.first().locator('.memory-note-details>p');
  await selectOnly(noteText);
  await selectOnly(noteText, 'Meta+A');
  await page.getByRole('button', { name: 'View context', exact: true }).click();
  const dialog = page.getByRole('dialog'), context = dialog.getByLabel('Saved memory context text', { exact: true });
  await context.waitFor();
  assert.match(await context.textContent(), /Synthetic context remains unchanged/);
  assert.match(await dialog.textContent(), /original notes stay available/);
  assert.match(await dialog.getByRole('status').textContent(), /1 context page loaded · 73 saved short notes/);
  await selectOnly(context);
  await selectOnly(context, 'Meta+A');
  await app.evaluate(() => { qa.failWake = true; });
  await dialog.getByRole('button', { name: 'Load earlier context', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'Synthetic context read failure.' }).waitFor();
  assert.equal(JSON.parse(await context.textContent()).notes.length, 2);
  await app.evaluate(() => { qa.failWake = false; });
  await dialog.getByRole('button', { name: 'Load earlier context', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: 'All context pages loaded' }).waitFor();
  const loaded = JSON.parse(await context.textContent());
  assert.deepEqual(loaded.notes.map(note => note.id || note.range), ['context-recent', '65-72', '1-64']);
  assert.equal(loaded.total, 73); assert.equal(loaded.nextPart, null);
  assert.equal(await dialog.getByRole('button', { name: 'Load earlier context', exact: true }).count(), 0);
  assert.deepEqual((await app.evaluate(() => qa.calls.filter(call => call.method === 'memory.wake'))).at(-1).p, { part: 2, snapshot: 73, cursor: 65 });
  await selectOnly(context);
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
  await dialog.screenshot({ path: path.join(output, 'context-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'View context', exact: true }).evaluate(element => document.activeElement === element), true);
  await search.fill('Native input selection'); await search.click(); await page.keyboard.press('Control+A');
  assert.deepEqual(await search.evaluate(element => [element.selectionStart, element.selectionEnd]), [0, 22]);
  await search.fill('');
  await page.getByRole('button', { name: 'Add a memory', exact: true }).click();
  const editable = page.getByLabel('What should be saved?'); await editable.fill('Native textarea selection'); await editable.click(); await page.keyboard.press('Control+A');
  assert.deepEqual(await editable.evaluate(element => [element.selectionStart, element.selectionEnd]), [0, 25]);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  report.checks.scopedSelectionAndContextPaging = { memoryText: true, contextText: true, ctrlAndCommandA: true, originalTextPreserved: true, earlierSummaryAccessible: true, stableSnapshotCursor: true, failedLoadPreservesAndRetries: true, nativeEditableSelection: true, mobileLayout: true, closeRestoresFocus: true };
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  report.checks.detailAndExistingActions = { exactUnicodeText: true, oneExpandedRow: true, keyboardToggle: true, viewContext: true, export: true };
  await search.fill('faraway-search-token');await search.press('Enter');await page.waitForFunction(()=>document.querySelectorAll('.memory-note-row').length===1);
  await page.getByRole('button',{name:'Mark all as viewed',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('button[title^="Marks every saved memory"]')?.disabled===true);
  assert.equal(await app.evaluate(()=>qa.state.memories.filter(x=>x.reviewed===false).length),0);
  report.checks.globalViewedFromFilteredSearch=true;
  await search.fill('');await page.getByText('Page 1 of 7',{exact:true}).waitFor();

  report.checks.layouts = [];
  for (const theme of ['erebus-flame', 'ink-wash']) {
    await app.evaluate((_electron, theme) => { qa.state.settings.appearance = { theme, motion: 'reduced' }; }, theme); await emit();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: width === 360 ? 800 : 1000 });
      await page.locator('[data-memory-id="note-11"] .memory-note-toggle').click();
      await page.locator('.memory-notes').scrollIntoViewIfNeeded();
      const layout = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.memory-note-row')], rects = rows.map(x => x.getBoundingClientRect());
        const list = document.querySelector('.memory-note-list').getBoundingClientRect();
        const detail = document.querySelector('.memory-note-details');
        return { viewport: innerWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, clippedRows: rects.some(r => r.left < -1 || r.right > innerWidth + 1), listWidth: list.width, compactRows: rects.filter((r,i) => !rows[i].classList.contains('is-expanded')).map(r => r.height), detailWidth: detail.clientWidth, detailScrollWidth: detail.scrollWidth, detailOverflow: detail.scrollWidth > detail.clientWidth + 1 };
      });
      report.checks.layouts.push({ theme, ...layout });
      await page.screenshot({ path: path.join(output, `memory-${theme}-${width}.png`) });
      assert.equal(layout.horizontalOverflow, false); assert.equal(layout.clippedRows, false); assert.equal(layout.detailOverflow, false);
      assert.ok(layout.compactRows.every(height => height <= (width === 360 ? 90 : 60)));
      await page.locator('[data-memory-id="note-11"] .memory-note-toggle').click();
    }
  }
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).sort()), ['exomina.appearance', 'exomina.unread']);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  assert.deepEqual(errors, []); report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally { await app.close(); await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, ...report }, null, 2)); }
