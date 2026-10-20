// Synthetic renderer/IPC fixture; does not open account stores or live archives.
import { _electron as electron } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const output = await mkdtemp(path.resolve(root, '../Workspace/export-review/qa-import-ui-'));
const preload = path.join(output, 'preload.cjs');
const entry = path.join(output, 'fixture.cjs');
const state = {
  settings: { provider: 'codex', model: 'auto', memoryEnabled: true, memoryCapture: 'automatic' },
  security: { recoveryAudit: { status: 'pending' } },
  connections: [], providers: [], tools: [], approvals: [], conversations: [], memories: [], version: 'synthetic',
  runtime: { capabilities: { nativeBrowser: false, localFiles: true, desktopControl: false } },
  archive: { documents: 0 }, activeRuns: [], memoryReview: { unreviewedCount: 0 },
};
await writeFile(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('studio',{invoke:(method,payload)=>ipcRenderer.invoke('qa:invoke',method,payload),onEvent:()=>()=>{}});`);
await writeFile(entry, `const{app,BrowserWindow,ipcMain}=require('electron');app.setPath('userData',process.env.QA_PROFILE);
globalThis.qa={state:${JSON.stringify(state)},scenario:'valid',commits:[]};
ipcMain.handle('qa:invoke',(_event,method,payload={})=>{
 const q=globalThis.qa;
 if(method==='bootstrap')return q.state;
 if(method==='security.status')return{protected:true,supported:true,needsRecovery:false};
 if(method==='memory.search')return[];
 if(method==='archive.importNow'){
  if(q.scenario==='broken')throw Error('An export file is not valid JSON. No records were imported.');
  q.commits.push(payload);
  if(q.scenario==='unknown')return{documents:0,conversationCount:0,added:0,duplicates:0,source:'Unknown source',warnings:['Skipped unknown.json: its JSON structure is not supported.']};
  q.state.archive={documents:771,conversationCount:771};
  return{documents:771,conversationCount:771,memoryCount:0,added:771,duplicates:q.commits.length>1?771:0,source:'ChatGPT',warnings:['Skipped 5 unrelated metadata files.']};
 }
 if(method==='archive.preview'){
  if(q.scenario==='broken')throw Error('An export file is not valid JSON. No records were imported.');
  const count=q.scenario==='unknown'?0:771;
  return{token:'synthetic-preview',documents:count,conversationCount:count,memoryCount:0,projectCount:0,artifactCount:0,source:'ChatGPT',bytes:116556915,warnings:count?['Skipped 5 unrelated metadata files.']:['Skipped unknown.json: its JSON structure is not supported. Other recognized files can still be imported.']};
 }
 if(method==='archive.commit'){q.commits.push(payload);q.state.archive={documents:771,conversationCount:771};return{added:771,duplicates:0};}
 throw Error('Unexpected synthetic method: '+method);
});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadFile(${JSON.stringify(path.join(root, 'dist/index.html'))})});app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env, QA_PROFILE: path.join(output, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [entry], env, timeout: 30000 });
const report = { scope: 'Synthetic hidden renderer and IPC only', checks: {} };
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  // One click: the file picker opens in the main process and the import is saved straight away.
  await page.getByRole('button', { name: 'Import chats', exact: true }).click();
  await page.getByText('Imported 771 chats from ChatGPT. Your AIs can now look things up in them.', { exact: true }).waitFor();
  await page.getByText('Details about the last import', { exact: true }).click();
  await page.getByText('Skipped 5 unrelated metadata files.', { exact: true }).waitFor();
  report.checks.oneClickImportWithDetails = true;
  await app.evaluate(() => { globalThis.qa.scenario = 'unknown'; });
  await page.getByRole('button', { name: 'Import chats', exact: true }).click();
  await page.getByText(/^No chats were found in that file/).waitFor();
  report.checks.unrecognisedFileExplained = true;
  await app.evaluate(() => { globalThis.qa.scenario = 'broken'; });
  await page.getByRole('button', { name: 'Import chats', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'not valid JSON' }).first().waitFor();
  report.checks.brokenFileShowsError = true;
  await app.evaluate(() => { globalThis.qa.scenario = 'valid'; });
  await page.getByRole('button', { name: 'Where do I get my chats?', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Bring your chats from other AIs' });
  for (const name of ['ChatGPT', 'Claude', 'Gemini', 'Grok']) await help.getByRole('link', { name: `Open ${name}`, exact: true }).waitFor();
  await help.getByRole('button', { name: 'Choose downloaded file', exact: true }).click();
  await page.getByText(/771 were already here/).waitFor();
  assert.equal(await help.count(), 0);
  assert.equal((await app.evaluate(() => globalThis.qa.commits)).length, 3);
  report.checks.helpListsProvidersAndImports = true;
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; throw error; }
finally { await app.close(); await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, ...report })); }
