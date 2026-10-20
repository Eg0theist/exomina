// Production host, gateway, permissions, persistence and renderer. Synthetic native providers only.
import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), runtimeRoot = path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT || root);
const fixture = await createProtectedQaProfile('followup-continuity'), { output, profile } = fixture;
const workspace = path.join(output, 'workspace'); await mkdir(workspace);
await writeFile(path.join(workspace, 'fixture.txt'), 'Verified read-only fixture.\n', 'utf8');
await writeFile(path.join(workspace, 'blocked.txt'), 'Do not share this fixture.\n', 'utf8');
const store = new Store(profile, { workspace }); await store.init();
Object.assign(store.state.settings, { workspace, autoTitle: false, autoUpdate: false, closeToTray: false, memoryEnabled: false, chatMemorySummaries: false, browserEnabled: false, desktopEnabled: false, permissionMode: 'full', routing: 'tools',
  permissionRules: [{ id: 'qa-deny', effect: 'deny', tool: 'workspace_read', match: 'blocked.txt' }],
  modelPreferences: { fallback: { enabled: true, mode: 'ordered', targets: [{ provider: 'codex', model: 'gpt-qa', effort: 'high' }] } } });
const chat = store.create('claude'); chat.title = 'Follow-up continuity QA'; chat.titleSource = 'manual'; await store.save();
const url = name => JSON.stringify(pathToFileURL(path.join(runtimeRoot, name)).href);
const launcher = path.join(output, 'launcher.cjs');
await writeFile(launcher, String.raw`const {app,BrowserWindow,session,dialog}=require('electron');
const assert=require('node:assert/strict');BrowserWindow.prototype.show=function(){};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};app.commandLine.appendSwitch('mute-audio');
globalThis.qaContinuity={calls:[],steers:[],used:20,writes:0};
(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
const {ProviderManager}=await import(${url('desktop/providers.mjs')});const {PROVIDER_CATALOG}=await import(${url('desktop/provider-catalog.mjs')});
const future=new Date(Date.now()+3600000).toISOString();
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(p=>p.mode==='subscription').map(p=>({id:p.id,installed:true,connected:['codex','claude'].includes(p.id),available:true,checking:false,detail:'Synthetic QA provider.'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.modelsFor=async id=>id==='codex'?[{id:'gpt-qa',label:'QA GPT',isDefault:true,efforts:[{id:'high'}]}]:[{id:'opus',label:'QA Opus',isDefault:true,efforts:[]}];
ProviderManager.prototype.subscriptionModels=async function(){return {codex:await this.modelsFor('codex'),claude:await this.modelsFor('claude')}};
ProviderManager.prototype.codexUsage=async()=>({rateLimits:{primary:{usedPercent:10,resetsAt:future}}});
ProviderManager.prototype.claudeUsage=async()=>({rate_limits:{five_hour:{utilization:qaContinuity.used,resets_at:future}}});
ProviderManager.prototype.getCodex=async()=>{throw Error('Personal native runtime access prohibited in QA')};
ProviderManager.prototype.steer=async function(id,request){qaContinuity.steers.push(request.prompt);if(request.prompt.includes('handoff_save')){
 const result=await this.callTool('handoff_save',{goal:'Finish the original QA task',verified:'completed.txt written exactly once; fixture check: 1 passed',inProgress:'Answer pending follow-up',nextSteps:'Finish with Codex',openDecisions:'None',files:'completed.txt',checks:'Live subscriptions not tested'},id);
 assert.equal(JSON.parse(result.content[0].text).saved,true);return true;}return true;};
ProviderManager.prototype.run=async function(request){const qa=qaContinuity;qa.calls.push({provider:request.provider,id:request.conversationId,model:request.model,effort:request.effort,prompt:request.prompt,noTools:request.noTools,hostToolsOnly:request.hostToolsOnly,noPersistence:request.noPersistence,toolNames:request.toolDefinitions?.map(t=>t.name)});
 if(request.conversationId!==${JSON.stringify(chat.id)}){
  assert.equal(request.noTools,false);assert.equal(request.hostToolsOnly,true);assert.equal(request.noPersistence,true);assert.ok(request.toolDefinitions.some(t=>t.name==='workspace_read'));
  assert.ok(!request.toolDefinitions.some(t=>['workspace_write','workspace_shell','browser_open','request_permission','model_consult'].includes(t.name)));
  const read=await this.callTool('workspace_read',{path:'fixture.txt'},request.conversationId);assert.match(read.content[0].text,/Verified read-only fixture/);
  const blocked=await this.callTool('workspace_read',{path:'blocked.txt'},request.conversationId);assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/Blocked by your rule/);
  const write=await this.callTool('workspace_write',{path:'forbidden.txt',text:'Never write'},request.conversationId);assert.equal(write.isError,true);assert.match(write.content[0].text,/read-only/);
  const navigate=await this.callTool('browser_open',{url:'https:\/\/example.com'},request.conversationId);assert.equal(navigate.isError,true);assert.match(navigate.content[0].text,/read-only/);
  const browser=await this.callTool('browser_snapshot',{},request.conversationId);assert.equal(browser.isError,true);assert.match(browser.content[0].text,/off/);
  return {text:'The checked file contains: Verified read-only fixture. The blocked read stayed blocked.',sessionId:'qa-side'};
 }
 if(qa.manual){assert.match(request.prompt,/Saved handoff from earlier work/);return {text:'The saved briefing is available after a manual provider change.',sessionId:'qa-manual'};}
 if(request.provider==='claude'){
  qa.used=85;this.emit({type:'usage',provider:'claude',info:await this.claudeUsage()});
  await this.callTool('workspace_write',{path:'completed.txt',text:'Created exactly once.\n'},request.conversationId);qa.writes++;
  this.emit({type:'chat.tool',conversationId:request.conversationId,id:'completed-write',name:'workspace_write',status:'done',input:{path:'completed.txt'},output:'completed.txt written exactly once'});
  this.emit({type:'chat.delta',conversationId:request.conversationId,text:'Original work preserved.',block:'progress'});
  await new Promise(resolve=>qa.release=resolve);qa.used=100;throw Object.assign(Error("You've hit your limit · resets 9pm"),{usageLimited:true});
 }
 assert.equal(request.provider,'codex');assert.equal(request.model,'gpt-qa');assert.equal(request.effort,'high');assert.equal(qa.writes,1);
 assert.match(request.prompt,/Handoff checkpoint/);assert.match(request.prompt,/fixture check: 1 passed/);assert.match(request.prompt,/completed.txt written exactly once/);
 const snapshot=JSON.parse(request.prompt.split('Handoff checkpoint:\n')[1].split('\nCurrent user request:')[0].trim());
 for(const item of snapshot.followups){const result=await this.callTool('followup_update',{id:item.id,status:'handled',summary:'Answered from an actual file read; all requested changes preserved.'},request.conversationId);assert.equal(JSON.parse(result.content[0].text).status,'handled');}
 return {text:'Codex continued automatically and finished the same task. Completed work was preserved.',sessionId:'qa-codex'};
};await import(${url('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`, 'utf8');
const env = { ...process.env, EXOMINA_DATA_DIR: profile, TEMP: output, TMP: output, TMPDIR: output }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/(?:token|secret|password|api_?key|credential|authorization)/i.test(key)) delete env[key];
const report = { output, runtimeRoot, scope: 'Production Electron host, real read/write permission gateway and encrypted QA persistence, synthetic native model transport. No personal accounts or subscription requests.', checks: {}, errors: [] };
let app;
async function until(read, accept, timeout = 25000) { const deadline = Date.now() + timeout; for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() > deadline) throw Error('Continuity QA timed out'); await new Promise(resolve => setTimeout(resolve, 50)); } }
try {
  app = await electron.launch({ args: [launcher], cwd: root, env, timeout: 30000 }); const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
  await until(() => page.evaluate(() => window.studio.invoke('bootstrap')), state => state.connections.some(c => c.id === 'codex' && c.connected));
  await page.evaluate(() => { window.qaEvents = []; window.studio.onEvent(event => window.qaEvents.push(event)); });
  await page.evaluate(id => window.studio.invoke('chat.send', { conversationId: id, provider: 'claude', model: 'opus', text: 'Finish the original QA task and preserve completed.txt.', mode: 'tools' }), chat.id);
  await until(() => app.evaluate(() => !!globalThis.qaContinuity.release), Boolean);
  await until(() => page.evaluate(id => window.studio.invoke('conversations.get', { id }), chat.id), c => c.messages.at(-1).handoffBriefings?.length);
  report.checks.proactiveBriefingSavedAt85Percent = true;
  const sent = await page.evaluate(id => window.studio.invoke('chat.send', { conversationId: id, provider: 'codex', model: 'gpt-qa', text: 'What does fixture.txt actually contain? Check the blocked read as well.' }), chat.id);
  await until(() => page.evaluate(id => window.studio.invoke('conversations.get', { id }), chat.id), c => c.messages.at(-1).followups?.some(f => f.id === sent.followup && f.status === 'answered'));
  const side = (await page.evaluate(id => window.studio.invoke('conversations.get', { id }), chat.id)).messages.at(-1).followups[0];
  assert.match(side.answer, /Verified read-only fixture/); assert.deepEqual(side.reads.map(read => read.status), ['done', 'error', 'error']);
  assert.equal((await page.evaluate(() => window.studio.invoke('bootstrap'))).approvals.length, 0);
  await page.locator('.chat-open').filter({ hasText: chat.title }).click();
  await page.locator('.live-followup-earlier summary').filter({ hasText: 'Sources checked' }).waitFor();
  await page.screenshot({ path: path.join(output, 'read-only-answer.png') });
  report.checks.actualReadParentDenyAndBrowserOffEnforced = true; report.checks.writeAndNavigationRefusedWithoutApproval = true;
  await app.evaluate(() => globalThis.qaContinuity.release());
  await until(() => page.evaluate(() => window.qaEvents), events => events.some(e => e.type === 'chat.complete' || e.type === 'chat.error'));
  const events = await page.evaluate(() => window.qaEvents); assert.equal(events.find(e => e.type === 'chat.error'), undefined, JSON.stringify(events.filter(e => e.type === 'chat.error')));
  const saved = await page.evaluate(id => window.studio.invoke('conversations.get', { id }), chat.id), message = saved.messages.at(-1);
  assert.match(message.content, /continued automatically/); assert.equal(message.followups[0].taskStatus, 'handled');
  assert.ok(events.some(e => e.type === 'chat.handoff' && e.provider === 'codex'));
  assert.equal((await app.evaluate(() => globalThis.qaContinuity.calls)).filter(call => call.id === chat.id && call.provider === 'codex').length, 1);
  assert.equal(await readFile(path.join(workspace, 'completed.txt'), 'utf8'), 'Created exactly once.\n');
  await assert.rejects(readFile(path.join(workspace, 'forbidden.txt'), 'utf8'), { code: 'ENOENT' });
  report.checks.claudeLimitAutomaticallyContinuesWithConfiguredCodexAndEffort = true; report.checks.completedWriteNotRepeatedAndFollowupHandled = true;
  await app.evaluate(() => { globalThis.qaContinuity.manual = true; globalThis.qaContinuity.used = 20; });
  await page.evaluate(() => window.studio.invoke('usage.refresh'));
  await page.evaluate(id => window.studio.invoke('chat.send', { conversationId: id, provider: 'claude', model: 'opus', text: 'Continue from the saved handoff.', mode: 'tools' }), chat.id);
  await until(() => page.evaluate(id => window.studio.invoke('conversations.get', { id }), chat.id), c => c.messages.at(-1).content.includes('after a manual provider change'));
  await page.reload(); await page.getByRole('button', { name: 'Exomina home', exact: true }).waitFor();
  const restored = await page.evaluate(id => window.studio.invoke('conversations.get', { id }), chat.id);
  assert.equal(restored.messages.filter(m => m.handoffBriefings?.length).length, 1);
  report.checks.manualProviderSwitchAndReloadRetainBriefing = true;
  assert.deepEqual(report.errors, []); report.protection = await fixture.verify(); report.passed = true;
} catch (error) { report.error = error.stack; if(app)report.diagnostics=await app.evaluate(()=>({calls:globalThis.qaContinuity.calls,steers:globalThis.qaContinuity.steers})).catch(()=>null); process.exitCode = 1; }
finally { await app?.close().catch(() => {}); await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report, null, 2)); }
