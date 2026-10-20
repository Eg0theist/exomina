// Saved source remains unchanged; only desktop and phone presentation is projected.
import {_electron as electron} from 'playwright';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {extractFile} from '@electron/asar';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const packaged=process.argv.includes('--packaged')||process.env.EXOMINA_QA_PACKAGED==='1';
const runtimeRoot=packaged?path.join(root,'release/win-unpacked/resources/app.asar'):root;
const version=JSON.parse(packaged?extractFile(runtimeRoot,'package.json'):await readFile(path.join(root,'package.json'),'utf8')).version;
if(process.env.EXOMINA_QA_EXPECT_VERSION)assert.equal(version,process.env.EXOMINA_QA_EXPECT_VERSION);
const {profile,output}=await createProtectedQaProfile('question-answer-display');
const workspace=path.join(profile,'workspace'),accounts=path.join(profile,'accounts');await mkdir(workspace);await mkdir(accounts);
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{autoUpdate:false,autoTitle:false,quickAccess:false,attentionNotifications:false,memoryEnabled:false,chatMemoryEnabled:false,chatMemorySummaries:false,appearance:{theme:'ink-wash',motion:'reduced'}});
const chat=store.create('codex');chat.title='Saved answer display QA';
const group={id:'legacy-card-uuid-123',status:'answered',deliveryState:'delivered',questions:[{id:'choice',question:'Which format should I use?'}],answers:{choice:{answers:['A concise report']}},createdAt:'2026-10-17T10:00:00Z'};
const legacy='Answer to the question card '+group.id+':\nWhich format should I use?\nUser answer: A concise report\nUse these answers for the current task if relevant. They do not grant tool permissions. If work was already completed, explain what this answer changes before making any changes.';
chat.messages=[{id:'question',role:'assistant',provider:'codex',content:'The original question was answered.',questions:[group],followups:[{id:'legacy-followup',questionId:group.id,text:legacy,status:'answered',taskStatus:'handled',summary:'Applied to the task.'}],finishedAt:'2026-10-17T10:01:00Z'},
  {id:'generated-answer',role:'user',questionId:group.id,content:legacy},
  {id:'user-authored',role:'user',content:'I copied this technical receipt:\n'+legacy}];
await store.save();
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session,Notification}=require('electron');(async()=>{
BrowserWindow.prototype.show=function(){};Notification.prototype.show=function(){throw Error('Unexpected QA notification')};app.commandLine.appendSwitch('mute-audio');dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});ProviderManager.prototype.status=async()=>[];ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};ProviderManager.prototype.run=async()=>{throw Error('QA model run refused')};
const{RemoteAccess}=await import(${moduleUrl('desktop/remote-access.mjs')});const originalInit=RemoteAccess.prototype.init;RemoteAccess.prototype.init=async function(){const result=await originalInit.call(this);globalThis.qaRemote=this;return result};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={output,runtimeRoot,version,packaged,scope:'Production host and built renderer with protected synthetic data; no network, OS toasts, account access or model runs. Phone facade tested in-process; relay and physical phone untested.',checks:{},errors:[]};let app;
try{
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  if(packaged)assert.equal(fileURLToPath(page.url()),path.join(runtimeRoot,'dist/index.html'),'Renderer must come from the requested package');
  await page.locator('.chat-open').filter({hasText:chat.title}).click();
  const generated=page.locator('.message.user').nth(0).locator('.message-content'),authored=page.locator('.message.user').nth(1).locator('.message-content');
  assert.match(await generated.textContent(),/^Your answer to:/);assert.equal((await generated.textContent()).includes(group.id),false);
  assert.match(await page.locator('.live-followup-question').textContent(),/^Your answer to:/);assert.equal((await page.locator('.live-followup-question').textContent()).includes(group.id),false);report.checks.legacyMessageAndFollowupUseHumanContext=true;
  assert.match(await authored.textContent(),/^I copied this technical receipt:/);assert.equal((await authored.textContent()).includes(group.id),true);report.checks.userAuthoredReceiptRetained=true;
  for(const view of ['advanced','standard']){await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption(view);assert.match(await generated.textContent(),/^Your answer to:/);}report.checks.bothInterfaceViews=true;
  const raw=await page.evaluate(id=>window.studio.invoke('conversations.get',{id}),chat.id);assert.equal(raw.messages[1].content,legacy);assert.equal(raw.messages[1].questionId,group.id);assert.equal(raw.messages[0].followups[0].text,legacy);report.checks.sourceTextAndIdsUnchanged=true;
  const phone=await app.evaluate(async(_electron,id)=>globalThis.qaRemote.invoke('conversations.get',{id}),chat.id);assert.match(phone.messages[1].content,/^Your answer to:/);assert.equal(phone.messages[1].content.includes(group.id),false);assert.equal(phone.messages[2].content.includes(group.id),true);assert.equal(phone.messages[0].questions[0].id,group.id);report.checks.phoneFacadeUsesSamePresentation=true;
  await page.reload();await page.locator('.chat-open').filter({hasText:chat.title}).click();assert.match(await generated.textContent(),/^Your answer to:/);report.checks.reopenProjectsWithoutMigration=true;
  await generated.scrollIntoViewIfNeeded();await generated.screenshot({path:path.join(output,'legacy-generated-answer.png')});
  await page.locator('.live-followup-question').screenshot({path:path.join(output,'legacy-generated-followup.png')});
  await page.screenshot({path:path.join(output,'legacy-answer-display.png')});assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(app)await(await app.firstWindow()).screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}}
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report,null,2));
