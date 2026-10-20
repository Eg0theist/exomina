// Production renderer and IPC in an isolated synthetic profile; no personal data or network.
import {_electron as electron} from 'playwright';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {compareChats} from '../desktop/chat-management.mjs';
import {extractFile} from '@electron/asar';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const packaged=process.argv.includes('--packaged')||process.env.EXOMINA_QA_PACKAGED==='1';
// Use the archive's logical paths: Electron resolves desktop files from .unpacked.
// Importing main directly from .unpacked would duplicate its preload path suffix.
const runtimeRoot=packaged?path.join(root,'release/win-unpacked/resources/app.asar'):root;
let runtime={mode:packaged?'packaged':'source',root:runtimeRoot};
if(packaged){
  await access(runtimeRoot);await access(runtimeRoot+'.unpacked/desktop/main.mjs');
  const manifest=JSON.parse(extractFile(runtimeRoot,'package.json'));
  const build=JSON.parse(await readFile(path.resolve(path.dirname(runtimeRoot),'../exomina.build.json'),'utf8'));
  assert.equal(build.version,manifest.version,'Packaged version and build stamp disagree');
  if(process.env.EXOMINA_QA_EXPECT_VERSION)assert.equal(manifest.version,process.env.EXOMINA_QA_EXPECT_VERSION,'Unexpected packaged version');
  runtime={...runtime,version:manifest.version,build,desktopRoot:runtimeRoot+'.unpacked/desktop'};
}
const{output,profile}=await createProtectedQaProfile(packaged?'pinned-drag-packaged':'pinned-drag'),workspace=path.join(profile,'workspace');
await mkdir(workspace);
const seed=new Store(profile,{workspace});await seed.init();
Object.assign(seed.state.settings,{autoUpdate:false,quickAccess:false,autoTitle:false,appearance:{theme:'ink-wash',motion:'reduced'}});
for(const [id,title,pinnedOrder,archived] of [['a','Writing project',0,false],['archived-a','Archived first',1,true],['b','Software project',2,false],['c','Theatre project',3,false],['archived-b','Archived second',4,true]]){
  seed.state.conversations.push({id,title,pinned:true,pinnedOrder,archived,provider:'codex',updatedAt:'2026-10-15T12:00:00Z',sessions:{},messages:[]});
}
for(const [id,updatedAt] of [['recent','2026-10-17T12:00:00Z'],['older','2026-10-16T12:00:00Z']])seed.state.conversations.push({id,title:id,pinned:false,provider:'codex',updatedAt,sessions:{},messages:[]});
await seed.save();
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session}=require('electron');(async()=>{
app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)}));
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});
ProviderManager.prototype.status=async()=>[];ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];
ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.connect=async()=>{throw Error('QA sign-in refused')};ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};
ProviderManager.prototype.run=async()=>{throw Error('QA provider run refused')};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:profile,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={scope:'Production host and renderer in hidden Electron harness, synthetic encrypted profile, no account access, external network or model requests.',runtime,checks:{},errors:[]};
let app;
try{
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  report.runtime.rendererUrl=page.url();
  if(packaged)assert.equal(fileURLToPath(page.url()),path.join(runtimeRoot,'dist/index.html'),'Renderer did not load from the requested package');
  const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
  const pins=()=>page.getByRole('region',{name:'Pinned chats'}).locator('.chat-list-entry').evaluateAll(rows=>rows.map(row=>row.dataset.chatId));
  const waitPins=expected=>page.waitForFunction(expected=>[...document.querySelectorAll('.chat-pinned-list .chat-list-entry')].map(row=>row.dataset.chatId).join(',')===expected,expected.join(','));
  const row=id=>page.locator('.chat-pinned-list [data-chat-id="'+id+'"]');
  async function drag(id,targetId,placement){
    const target=await row(targetId).boundingBox();assert.ok(target);
    await row(id).locator('.chat-drag-handle').dragTo(row(targetId),{targetPosition:{x:target.width/2,y:placement==='before'?2:target.height-2}});
  }
  assert.deepEqual(await pins(),['a','b','c']);
  await page.getByRole('button',{name:'Writing project',exact:true}).click();
  await drag('c','a','before');await waitPins(['c','a','b']);
  assert.equal(await row('a').evaluate(element=>element.classList.contains('selected')),true);
  await drag('c','b','after');await waitPins(['a','b','c']);
  assert.equal(await page.getByRole('status').filter({hasText:'Moved Theatre project after Software project.'}).count(),1);
  report.checks.nativeDragBothDirectionsAndSelection=true;
  await row('a').locator('.chat-drag-handle').focus();await page.keyboard.press('Alt+ArrowDown');await waitPins(['b','a','c']);
  assert.equal(await row('a').locator('.chat-drag-handle').evaluate(element=>element===document.activeElement),true);
  const reorderHandle=row('a').locator('.chat-drag-handle');
  assert.equal(await reorderHandle.getAttribute('aria-haspopup'),'menu');assert.equal(await reorderHandle.getAttribute('aria-expanded'),'false');
  await reorderHandle.press('Enter');assert.equal(await reorderHandle.getAttribute('aria-expanded'),'true');assert.equal(await reorderHandle.getAttribute('aria-controls'),'chat-menu-a');assert.equal(await page.locator('#chat-menu-a').getAttribute('role'),'menu');
  await page.getByRole('menuitem',{name:'Move up',exact:true}).click();await waitPins(['a','b','c']);assert.equal(await reorderHandle.getAttribute('aria-expanded'),'false');assert.equal(await reorderHandle.getAttribute('aria-controls'),null);
  await reorderHandle.press('Enter');assert.equal(await page.getByRole('menuitem',{name:'Move up',exact:true}).isDisabled(),true);await page.keyboard.press('Escape');assert.equal(await reorderHandle.getAttribute('aria-expanded'),'false');
  report.checks.keyboardFocusMenuAndBoundary=true;
  const beforeCancel=await pins();
  // A source drag ending outside the list must not write an order.
  const handleBox=await row('a').locator('.chat-drag-handle').boundingBox();assert.ok(handleBox);
  await page.mouse.move(handleBox.x+handleBox.width/2,handleBox.y+handleBox.height/2);await page.mouse.down();await page.mouse.move(handleBox.x+handleBox.width/2+12,handleBox.y+handleBox.height/2+12,{steps:4});await page.keyboard.press('Escape');await page.mouse.up();
  assert.deepEqual(await pins(),beforeCancel);assert.equal(await page.locator('.is-dragging,.drop-before,.drop-after').count(),0);report.checks.cancelledDragClearsState=true;
  await page.getByRole('searchbox',{name:'Search chats',exact:true}).fill('project');assert.equal(await page.locator('.chat-drag-handle').count(),0);await page.getByRole('button',{name:'Clear chat search',exact:true}).click();
  await page.getByRole('button',{name:'Show archived chats',exact:true}).click();assert.deepEqual(await pins(),['archived-a','archived-b']);
  await drag('archived-b','archived-a','before');await waitPins(['archived-b','archived-a']);
  await page.getByRole('button',{name:'Show archived chats',exact:true}).click();assert.deepEqual(await pins(),['a','b','c']);
  report.checks.archivedIsolationAndSearch=true;
  // External drag data cannot move an internal pin without an active source drag.
  const external=await page.evaluateHandle(()=>{const data=new DataTransfer();data.setData('application/x-exomina-pinned-chat','c');return data});
  await row('a').dispatchEvent('dragover',{dataTransfer:external,clientY:0});await row('a').dispatchEvent('drop',{dataTransfer:external,clientY:0});assert.deepEqual(await pins(),['a','b','c']);report.checks.externalDragIgnored=true;
  const data=await invoke('bootstrap');assert.deepEqual(data.conversations.filter(chat=>!chat.pinned).sort(compareChats).map(chat=>chat.id),['recent','older']);
  await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption('standard');await drag('a','c','after');await waitPins(['b','c','a']);report.checks.standardViewAndRecency=true;
  await page.screenshot({path:path.join(output,'pinned-drag.png')});assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(output,'failure.png')});}}
finally{await app?.close();}
if(report.passed){const restored=new Store(profile,{workspace});await restored.init();assert.deepEqual(restored.state.conversations.filter(chat=>chat.pinned&&!chat.archived).sort(compareChats).map(chat=>chat.id),['b','c','a']);assert.deepEqual(restored.state.conversations.filter(chat=>chat.pinned&&chat.archived).sort(compareChats).map(chat=>chat.id),['archived-b','archived-a']);report.checks.persistedAfterHostExit=true;}
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report},null,2));
