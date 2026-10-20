// Real Electron host and production renderer; only encrypted synthetic state.
// No provider account is opened, no model runs, and every HTTP request is denied.
import {_electron as electron} from 'playwright';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {extractFile} from '@electron/asar';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {WORKFLOW_STORAGE_KEY,WORKFLOW_PANEL_LABELS} from '../src/workflow-layout.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packaged=process.argv.includes('--packaged');
const skipEditors=process.argv.includes('--skip-editor-checks');
const usabilityOnly=process.argv.includes('--usability-only');
const floatingOnly=process.argv.includes('--floating-only');
const fromSecurity=process.argv.includes('--from-security')||floatingOnly;
const fromBrowser=process.argv.includes('--from-browser')||fromSecurity;
const fromMenu=process.argv.includes('--from-menu');
const runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||(packaged?path.join(root,'release/win-unpacked/resources/app.asar'):root));
const archived=runtimeRoot.endsWith('.asar'),hostRoot=archived?runtimeRoot+'.unpacked':runtimeRoot;
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,file)).href);
const artifactBytes=file=>archived?extractFile(runtimeRoot,path.normalize(file)):readFile(path.join(runtimeRoot,file));
const artifact={runtimeRoot,hostRoot,version:JSON.parse(await artifactBytes('package.json')).version,files:{}};
for(const file of ['desktop/main.mjs','desktop/workspace-windows.mjs','desktop/workspace-preload.cjs','desktop/browser.mjs','desktop/browser-pages.mjs','desktop/preload.cjs','dist/index.html']){
  const bytes=await artifactBytes(file);if(archived)assert.ok(bytes.equals(await readFile(path.join(root,file))),'Packaged file matches Source: '+file);
  artifact.files[file]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
const html=(await artifactBytes('dist/index.html')).toString('utf8'),entry=/<script\b[^>]*src="\.\/([^" ]+\.js)"[^>]*><\/script>/.exec(html);assert.ok(entry,'Production renderer entry present');
const rendererFile=path.join('dist',entry[1]),rendererBytes=await artifactBytes(rendererFile);
if(archived)assert.ok(rendererBytes.equals(await readFile(path.join(root,rendererFile))),'Packaged renderer matches production build');
artifact.entry=entry[1];artifact.files['dist/'+entry[1]]={bytes:rendererBytes.length,sha256:createHash('sha256').update(rendererBytes).digest('hex')};
if(archived)artifact.build=JSON.parse(await readFile(path.join(path.dirname(runtimeRoot),'..','exomina.build.json'),'utf8'));
const fixture=await createProtectedQaProfile(packaged?'workflow-package':'workflow-workspaces'),{profile,output}=fixture;
const workspace=path.join(profile,'workspace'),accounts=path.join(profile,'accounts');await mkdir(workspace);await mkdir(accounts);
const {Store}=await import(pathToFileURL(path.join(hostRoot,'desktop/store.mjs')).href),store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{workspace,provider:'codex',autoTitle:false,autoUpdate:false,quickAccess:false,closeToTray:false,attentionNotifications:false,memoryEnabled:false,chatMemorySummaries:false,browserEnabled:true,desktopEnabled:false,permissionMode:'ask',appearance:{theme:'ink-wash',motion:'reduced'}});
const chat=store.create('codex');Object.assign(chat,{title:'Workflow workspace QA',titleSource:'manual'});
const question={id:'workspace-question',status:'open',requireAnswer:false,windowOutcome:'continued',createdAt:'2026-10-17T10:00:00Z',questions:[{id:'format',question:'Keep this pending choice?',options:[{label:'Preserve my choice',description:'Synthetic unsent answer.'},{label:'Other choice',description:'Do not select.'}]}]};
chat.messages=[{id:'workspace-user',role:'user',provider:'codex',content:'Synthetic workspace task.'},{id:'workspace-assistant',role:'assistant',provider:'codex',content:'Pending question for state preservation.',questions:[question],finishedAt:'2026-10-17T10:01:00Z'}];
await store.save();
const attachmentPath=path.join(output,'workspace-attachment.txt');await writeFile(attachmentPath,'Synthetic attachment retained through layout changes.','utf8');
const launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session,Notification}=require('electron');
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile,'browser-data'))});app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};app.getVersion=()=>${JSON.stringify(artifact.version)};Notification.prototype.show=function(){};
globalThis.qaWorkspaces={runs:0,signins:0,blockedRequests:0};
(async()=>{await app.whenReady();for(const partition of [session.defaultSession,session.fromPartition('persist:exomina-browser')])partition.webRequest.onBeforeRequest((details,callback)=>{const cancel=/^https?:/.test(details.url);if(cancel)qaWorkspaces.blockedRequests++;callback({cancel})});
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,detail:'Synthetic workspace QA connection'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.getCodex=async()=>{throw Error('QA account access refused')};ProviderManager.prototype.connect=async()=>{qaWorkspaces.signins++;throw Error('QA sign-in refused')};ProviderManager.prototype.run=async()=>{qaWorkspaces.runs++;throw Error('QA model run refused')};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={scope:'Real source or packaged Electron host and production renderer. Protected synthetic profile, canned provider metadata, HTTP blocked and no account access or inference. Native workspace windows and real WebContentsView ownership are exercised.',output,artifact,usabilityOnly,skippedAlreadyVerifiedEditorChecks:usabilityOnly||skipEditors||fromBrowser||fromMenu,skippedAlreadyVerifiedLayoutChecks:usabilityOnly||fromBrowser,skippedAlreadyVerifiedTabMoveResizeChecks:fromMenu,skippedAlreadyVerifiedBrowserChecks:fromSecurity,checks:{},errors:[],limitations:usabilityOnly?['Physical multi-monitor and mixed-DPI behavior is untested.','No live provider or external website is used.']:['Multi-monitor unplug/replug is represented by offscreen bounds recovery; no physical display was disconnected.','Native DWM/DPI window bounds are allowed eight pixels of frame rounding around the reported monitor work area.','No live provider or external website is used.']};let app,page;
const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
async function until(read,accept,label){const end=Date.now()+15000;for(;;){const value=await read();if(accept(value))return value;if(Date.now()>end)throw Error(label+' timed out; last='+JSON.stringify(value));await new Promise(resolve=>setTimeout(resolve,60));}}
async function open(){
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  app.process().stderr.on('data',chunk=>{report.hostLog=((report.hostLog||'')+String(chunk)).slice(-18000);});
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();await page.locator('[data-chat-id="'+chat.id+'"] .chat-open').click();
  await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption('advanced');
  const popup=page.getByRole('dialog',{name:'Your input',exact:true});await popup.waitFor();await popup.getByRole('button',{name:'Later',exact:true}).click();
}
async function close(graceful=false){if(!app)return;const current=app;app=null;await current.evaluate(({app},ordinaryQuit)=>ordinaryQuit?app.quit():app.exit(0),graceful).catch(()=>{});await current.close().catch(()=>{});}
const workspaces=()=>page.getByRole('dialog',{name:'Workflow workspaces',exact:true});
const group=id=>page.locator('[data-workflow-group="'+id+'"]');
const preferences=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),WORKFLOW_STORAGE_KEY);
const current=async()=>(await preferences()).current;
async function sampleMetrics(label){report.processMemorySamples??=[];report.processMemorySamples.push({label,at:new Date().toISOString(),metrics:await app.evaluate(({app})=>app.getAppMetrics().map(({pid,type,memory})=>({pid,type,memory})))});}
async function openSettings(){await page.getByRole('button',{name:'Workspaces',exact:true}).click();await workspaces().waitFor();}
async function dismissSettings(){const dialog=workspaces();if(!await dialog.isVisible())return;await dialog.getByRole('button',{name:'Close workspaces',exact:true}).click().catch(async error=>{if(await dialog.isVisible())throw error;});await dialog.waitFor({state:'hidden'});}
async function arrange(label,action){await page.getByRole('button',{name:'Arrange '+label,exact:true}).click();await page.getByRole('menuitem',{name:action,exact:true}).click();}
async function dockChild(child){await child.getByRole('button',{name:'Dock panel',exact:true}).click().catch(error=>{if(!/Target page, context or browser has been closed/.test(error.message))throw error;});}
async function assertDrafts(){assert.equal(await page.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'Unsent composer survives workspaces');await page.getByLabel('Files to send',{exact:true}).getByText('workspace-attachment.txt',{exact:true}).waitFor();assert.equal(await page.locator('.question-card[data-question-id="workspace-question"]').getByRole('radio',{name:/^Preserve my choice/}).isChecked(),true);}

try{
  await open();
  await sampleMetrics('simple-layout-before-customization');
  // Tests below deliberately use visible controls or the production IPC surface.
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Unsent composer survives workspaces');
  await page.locator('.composer input[type="file"]').setInputFiles(attachmentPath);await page.getByLabel('Files to send',{exact:true}).getByText('workspace-attachment.txt',{exact:true}).waitFor();
  await page.locator('.question-card[data-question-id="workspace-question"]').getByRole('radio',{name:/^Preserve my choice/}).check();
  await openSettings();await workspaces().getByRole('button',{name:'Customize workspace',exact:true}).click();await dismissSettings();
  await group('right').waitFor();report.checks.optionalCustomizationEnabledThroughVisibleControl=true;
  const labels=WORKFLOW_PANEL_LABELS;
  if(usabilityOnly){
    await page.getByText('Beside chat',{exact:true}).waitFor();await page.getByText('Below chat',{exact:true}).waitFor();
    await group('right').getByRole('button',{name:'Open Notes in separate window',exact:true}).waitFor();
    await openSettings();await workspaces().getByRole('button',{name:'Research Browser beside chat, notes below',exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'workspace-starting-layouts.png')});await workspaces().getByRole('button',{name:'Research Browser beside chat, notes below',exact:true}).click();
    await until(current,layout=>layout.groups.right.panels.join()==='browser'&&layout.groups.bottom.panels.join()==='notes','Research starter layout');await assertDrafts();
    report.checks.clearStarterLayoutAndPanelLabelsPreserveTaskState=true;
    await openSettings();await workspaces().getByRole('checkbox',{name:labels.terminal,exact:true}).check();await workspaces().getByRole('checkbox',{name:labels.workbench,exact:true}).check();await dismissSettings();
    await group('bottom').getByRole('tab',{name:labels.notes,exact:true}).dragTo(group('right').locator('.workflow-tabs'));
    await until(current,layout=>layout.groups.right.panels.includes('notes'),'Native drag moves notes beside chat');
    await group('right').getByRole('tab',{name:labels.notes,exact:true}).dragTo(group('bottom').getByRole('tab',{name:labels.workbench,exact:true}),{targetPosition:{x:5,y:12}});
    await until(current,layout=>layout.groups.bottom.panels.join()==='terminal,notes,workbench','Native tab drop before neighbour');
    const endTab=group('bottom').getByRole('tab',{name:labels.workbench,exact:true}),endBounds=await endTab.boundingBox();
    await group('bottom').getByRole('tab',{name:labels.terminal,exact:true}).dragTo(endTab,{targetPosition:{x:endBounds.width-3,y:12}});
    await until(current,layout=>layout.groups.bottom.panels.join()==='notes,workbench,terminal','Native tab drop after neighbour');
    report.checks.realPointerDragMovesGroupsAndReordersBeforeAndAfterNeighbours=true;
    const tokenFor=async locator=>locator.evaluate(element=>{const data=new DataTransfer();element.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data}));return data.getData('application/x-exomina-panel');});
    const dropToken=async(locator,token)=>locator.evaluate((element,token)=>{const data=new DataTransfer();data.setData('application/x-exomina-panel',token);element.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data}));element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));},token);
    await group('right').getByRole('tab',{name:labels.browser,exact:true}).click();await invoke('browser.show',{visible:true,conversationId:chat.id});
    const ownedViews=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().flatMap(window=>window.contentView.children.filter(view=>view.webContents&&view.webContents!==window.webContents).map(view=>view.webContents.id)));
    await until(ownedViews,views=>views.length>0,'Native browser visible before tab drag');const browserBefore=await ownedViews(),beforeCancel=await current();
    await tokenFor(group('bottom').getByRole('tab',{name:labels.notes,exact:true}));
    await page.locator('[data-workflow-drop="right"]').waitFor();await until(ownedViews,views=>views.length===0,'Native browser hidden beneath drag destinations');
    await page.screenshot({path:path.join(output,'workspace-drag-destinations.png')});await page.keyboard.press('Escape');await page.locator('[data-workflow-drop="right"]').waitFor({state:'hidden'});
    assert.deepEqual(await current(),beforeCancel);await until(ownedViews,views=>views.includes(browserBefore[0]),'Cancel restores same native browser');
    report.checks.dragShowsTargetsAndTemporarilyHidesNativeBrowserEscapeCancelsWithoutLayoutChange=true;
    const beforeForeign=await current();await tokenFor(group('bottom').getByRole('tab',{name:labels.notes,exact:true}));await dropToken(group('right'),'untrusted-external-payload');assert.deepEqual(await current(),beforeForeign);await page.keyboard.press('Escape');report.checks.externalDragCannotRearrangePanels=true;
    // Exercise the real separate-window renderer with a shared token. The two
    // windows remain hidden; OS pointer movement across native windows is not
    // represented by this DOM event transfer.
    const floatToken=await tokenFor(group('bottom').getByRole('tab',{name:labels.notes,exact:true}));await dropToken(page.locator('[data-workflow-drop="floating"]'),floatToken);
    const floating=await until(()=>invoke('workspace.window.list'),state=>state.windows.some(item=>item.panel==='notes'),'Drag target creates real detached Notes window');const floatingId=floating.windows.find(item=>item.panel==='notes').id;
    const child=await until(async()=>app.windows().find(candidate=>candidate.url().includes('#workspace-panel='+floatingId))||null,Boolean,'Floating Notes page');
    const header=child.getByRole('button',{name:'Drag Notes back to workspace',exact:true});await header.waitFor();
    const backToken=await tokenFor(header);await page.locator('[data-workflow-drop="bottom"]').waitFor();await dropToken(page.locator('[data-workflow-drop="bottom"]'),backToken);
    await until(()=>invoke('workspace.window.list'),state=>state.windows.length===0,'Dragging detached header back redocks and closes native window');assert.equal((await current()).groups.bottom.active,'notes');
    report.checks.dragToSeparateWindowAndFloatingHeaderRedockUseRealNativeWindowsWithSyntheticCrossDocumentEvents=true;
    // Empty groups must be reachable without first changing the visible grid.
    await openSettings();await workspaces().getByRole('checkbox',{name:labels.browser,exact:true}).uncheck();await dismissSettings();await group('right').waitFor({state:'hidden'});
    const beforeGeometry=await page.locator('.workflow-primary').boundingBox(),emptyToken=await tokenFor(group('bottom').getByRole('tab',{name:labels.notes,exact:true}));
    assert.deepEqual(await page.locator('.workflow-primary').boundingBox(),beforeGeometry);await dropToken(page.locator('[data-workflow-drop="right"]'),emptyToken);await group('right').getByRole('tab',{name:labels.notes,exact:true}).waitFor();
    report.checks.emptyGroupDropTargetDoesNotShiftLayoutAndAcceptsPanel=true;
    await group('right').getByRole('tab',{name:labels.notes,exact:true}).focus();await page.keyboard.press('Home');await arrange(labels.notes,'Move to bottom');await until(current,layout=>layout.groups.bottom.active==='notes','Keyboard menu still moves panel');await group('right').waitFor({state:'hidden'});report.checks.movingLastTabCollapsesOnlyItsEmptySourceGroup=true;
    await page.screenshot({path:path.join(output,'workspace-arranged-panels.png')});await assertDrafts();report.checks.keyboardArrangeControlsRemainAvailableAndDraftsPreserved=true;
    report.limitations.push('Within-main-window drag uses real Playwright pointer input. Cross-window drag is exercised with synthetic DragEvents on real hidden native windows; physical OS pointer delivery across monitors is untested.');
  }else{
  let saved;
  if(!fromBrowser){
  await group('right').getByRole('tab',{name:labels.notes,exact:true}).click();
  if(!skipEditors&&!fromMenu){
  await page.getByRole('button',{name:'New note',exact:true}).click();
  await page.getByRole('textbox',{name:'Note title',exact:true}).fill('Workspace retained note');
  await page.getByRole('textbox',{name:'Note text',exact:true}).fill('Keep this note editor and its live selection through docking.');
  await page.getByRole('textbox',{name:'Note text',exact:true}).evaluate(element=>{element.qaWorkspaceIdentity=719;element.setSelectionRange(5,17);});
  await arrange(labels.notes,'Detach panel');
  const noteWindow=await until(()=>invoke('workspace.window.list'),state=>state.windows.some(window=>window.panel==='notes'),'Detached note editor');
  const noteId=noteWindow.windows.find(window=>window.panel==='notes').id;
  const noteChild=await until(async()=>app.windows().find(candidate=>candidate.url().includes('#workspace-panel='+noteId))||null,Boolean,'Detached notes page');
  const childNote=noteChild.getByRole('textbox',{name:'Note text',exact:true});await childNote.waitFor();assert.equal(await childNote.inputValue(),'Keep this note editor and its live selection through docking.');
  assert.equal(await childNote.evaluate(element=>element.qaWorkspaceIdentity),719);await childNote.fill('Edited while the same note panel was detached.');
  await dockChild(noteChild);
  await until(()=>invoke('workspace.window.list'),state=>state.windows.length===0,'Notes redocked');
  await group('right').getByRole('tab',{name:labels.notes,exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Note text',exact:true}).inputValue(),'Edited while the same note panel was detached.');assert.equal(await page.getByRole('textbox',{name:'Note text',exact:true}).evaluate(element=>element.qaWorkspaceIdentity),719);
  report.checks.noteEditorKeepsSameDOMAndEditableStateAcrossNativeDetachment=true;
  await group('bottom').getByRole('tab',{name:labels.terminal,exact:true}).click();
  await page.getByRole('textbox',{name:'PowerShell command',exact:true}).fill("Write-Output 'Unexecuted command draft'");
  await page.getByRole('textbox',{name:'PowerShell command',exact:true}).evaluate(element=>element.qaWorkspaceIdentity=827);
  await arrange(labels.terminal,'Detach panel');const terminalState=await until(()=>invoke('workspace.window.list'),state=>state.windows.some(window=>window.panel==='terminal'),'Detached terminal editor'),terminalId=terminalState.windows.find(window=>window.panel==='terminal').id;
  const terminalChild=await until(async()=>app.windows().find(candidate=>candidate.url().includes('#workspace-panel='+terminalId))||null,Boolean,'Detached terminal child');
  const terminalInput=terminalChild.getByRole('textbox',{name:'PowerShell command',exact:true});await terminalInput.waitFor();assert.equal(await terminalInput.evaluate(element=>element.qaWorkspaceIdentity),827);await terminalInput.fill("Write-Output 'Typed in detached command editor'");
  // Reload is a renderer-loss event for an opener-owned panel. It must return
  // the same editor to its dock rather than leave an empty native shell.
  await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('#workspace-panel='+id)).webContents.reload(),terminalId);
  await until(()=>invoke('workspace.window.list'),state=>state.windows.length===0,'Reloaded child redocks editor');await group('bottom').getByRole('tab',{name:labels.terminal,exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'PowerShell command',exact:true}).inputValue(),"Write-Output 'Typed in detached command editor'");assert.equal(await page.getByRole('textbox',{name:'PowerShell command',exact:true}).evaluate(element=>element.qaWorkspaceIdentity),827);
  assert.equal((await invoke('terminal.list',{conversationId:chat.id})).entries.length,0);report.checks.detachedTerminalTypingAndChildReloadKeepSameUnexecutedEditor=true;
  }
  await arrange(labels.notes,'Move to bottom');
  if(!fromMenu){
  await group('bottom').getByRole('tab',{name:labels.notes,exact:true}).waitFor();
  assert.deepEqual((await current()).groups.right.panels,['browser']);assert.equal((await current()).groups.bottom.active,'notes');
  const beforeReorder=(await current()).groups.bottom.panels,noteIndex=beforeReorder.indexOf('notes'),movedLeft=[...beforeReorder];movedLeft.splice(noteIndex,1);movedLeft.splice(noteIndex-1,0,'notes');
  await arrange(labels.notes,'Move tab left');assert.deepEqual((await current()).groups.bottom.panels,movedLeft);
  await arrange(labels.notes,'Move tab right');assert.deepEqual((await current()).groups.bottom.panels,beforeReorder);
  report.checks.tabGroupsMoveAndReorderThroughVisibleMenus=true;
  await group('bottom').getByRole('tab',{name:labels.notes,exact:true}).dragTo(group('right').locator('.workflow-tabs'));
  await until(current,layout=>layout.groups.right.panels.includes('notes'),'Drag notes to right group');
  await group('right').getByRole('tab',{name:labels.notes,exact:true}).dragTo(group('bottom').locator('.workflow-tabs'));
  await until(current,layout=>layout.groups.bottom.panels.includes('notes'),'Drag notes to bottom group');report.checks.pointerDragMovesTabBetweenGroups=true;
  const beforeResize=(await current()).sizes;
  await page.getByRole('separator',{name:'Resize right panels',exact:true}).focus();await page.keyboard.press('ArrowLeft');
  await page.getByRole('separator',{name:'Resize bottom panels',exact:true}).focus();await page.keyboard.press('ArrowUp');
  const afterResize=(await current()).sizes;assert.equal(Math.abs(afterResize.right-beforeResize.right),32);assert.equal(Math.abs(afterResize.bottom-beforeResize.bottom),32);
  report.checks.keyboardResizersPersistBoundedPanelSizes=true;
  }
  if(packaged){
    await page.getByRole('separator',{name:'Resize bottom panels',exact:true}).focus();await page.keyboard.press('Home');await group('bottom').getByRole('button',{name:'Arrange '+labels.notes,exact:true}).click();
    const lastItem=page.getByRole('menuitem',{name:'Hide panel',exact:true});await lastItem.scrollIntoViewIfNeeded();const menuBounds=await lastItem.boundingBox(),viewport=page.viewportSize()||await page.evaluate(()=>({width:innerWidth,height:innerHeight}));assert.ok(menuBounds&&menuBounds.y>=0&&menuBounds.y+menuBounds.height<=viewport.height+1,JSON.stringify({menuBounds,viewport}));
    await lastItem.click();await until(current,layout=>!Object.values(layout.groups).some(group=>group.panels.includes('notes')),'Minimum-height menu Hide action');await openSettings();await workspaces().getByRole('checkbox',{name:labels.notes,exact:true}).check();await dismissSettings();await arrange(labels.notes,'Move to bottom');report.checks.minimumBottomGroupKeepsLastArrangeMenuActionReachable=true;
  }
  await openSettings();await workspaces().getByRole('textbox',{name:'Workspace name',exact:true}).fill('Synthetic editing');await workspaces().getByRole('button',{name:'Save workspace',exact:true}).click();
  saved=(await preferences()).saved.find(item=>item.name==='Synthetic editing');assert.ok(saved);await dismissSettings();
  await sampleMetrics('customized-panels-docked');
  await assertDrafts();report.checks.savingLayoutKeepsComposerAttachmentAndUnsentQuestionChoice=true;
  await openSettings();await workspaces().getByRole('button',{name:'Reset layout',exact:true}).click();await dismissSettings();
  await until(current,layout=>!layout.enabled,'Reset to simple default');await assertDrafts();report.checks.resetReturnsToSimpleDefaultWithoutLosingTaskState=true;
  await sampleMetrics('reset-with-panel-portals-hidden');
  await openSettings();await workspaces().getByRole('combobox',{name:'Saved workspace',exact:true}).selectOption({label:'Synthetic editing'});await workspaces().getByRole('button',{name:'Restore workspace',exact:true}).click();await dismissSettings();
  await until(current,layout=>JSON.stringify(layout)===JSON.stringify(saved.layout),'Restore saved layout');await assertDrafts();report.checks.savedWorkspaceRestoresGroupsActiveTabsAndSizes=true;
  }else{
    await openSettings();await workspaces().getByRole('textbox',{name:'Workspace name',exact:true}).fill('Synthetic editing');await workspaces().getByRole('button',{name:'Save workspace',exact:true}).click();saved=(await preferences()).saved.find(item=>item.name==='Synthetic editing');await dismissSettings();
  }
  // Give the actual embedded view a synthetic page entirely in-process. No URL
  // fetch or browser tool is needed to test native ownership and live DOM state.
  if(!fromSecurity){
  await group('right').getByRole('tab',{name:labels.browser,exact:true}).click();await invoke('browser.show',{visible:true,conversationId:chat.id});
  const browserId=await app.evaluate(async({BrowserWindow})=>{
    const main=BrowserWindow.getAllWindows().find(window=>!window.webContents.getURL().includes('#'));
    const browserView=main.contentView.children.find(view=>view.webContents&&view.webContents.id!==main.webContents.id);
    if(!browserView)throw Error('The browser has no real attached WebContentsView');
    await browserView.webContents.loadURL('about:blank');
    await browserView.webContents.executeJavaScript("document.body.innerHTML='<input aria-label=\"Synthetic page field\" value=\"Retained browser input\"><p>Live synthetic browser view</p>';window.syntheticWorkspaceValue=731;");
    return browserView.webContents.id;
  });
  const browserOwnership=()=>app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().map(window=>({id:window.id,url:window.webContents.getURL(),browser:window.contentView.children.some(view=>view.webContents?.id===id)})),browserId);
  const browserState=()=>app.evaluate(async({webContents},id)=>{const wc=webContents.fromId(id);return wc&&!wc.isDestroyed()?{id:wc.id,url:wc.getURL(),state:await wc.executeJavaScript('({counter:window.syntheticWorkspaceValue,text:document.querySelector("input")?.value})')}:null;},browserId);
  await arrange(labels.browser,'Detach panel');
  const detached=await until(()=>invoke('workspace.window.list'),state=>state.windows.some(window=>window.panel==='browser')&&state.browserOwnerId,'Native browser detachment');const satelliteId=detached.windows.find(window=>window.panel==='browser').id;
  const child=await until(async()=>{for(const candidate of app.windows())if(candidate.url().includes('#workspace-panel='+satelliteId))return candidate;return null;},Boolean,'Detached browser page');child.setDefaultTimeout(15000);child.on('pageerror',error=>report.errors.push(error.message));
  await child.getByRole('button',{name:'Dock panel',exact:true}).waitFor();
  await until(browserOwnership,windows=>windows.some(window=>window.url.includes('#workspace-panel='+satelliteId)&&window.browser),'Browser native owner becomes detached window');
  assert.deepEqual((await browserState()).state,{counter:731,text:'Retained browser input'});assert.equal(await child.evaluate(()=>typeof window.studio),'undefined');
  const rejected=await app.evaluate(async({BrowserWindow,ipcMain},id)=>{const child=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('#workspace-panel='+id));try{await ipcMain._invokeHandlers.get('studio:invoke')({sender:child.webContents,senderFrame:child.webContents.mainFrame},'bootstrap',{});return null;}catch(error){return error.message;}},satelliteId);
  assert.match(rejected,/Untrusted app frame/);report.checks.detachedBrowserKeepsSameLiveViewAndChildHasNoHostAuthority=true;
  await page.getByRole('button',{name:'Answer questions',exact:true}).click();const popup=page.getByRole('dialog',{name:'Your input',exact:true});await popup.waitFor();await until(browserOwnership,windows=>windows.every(window=>!window.browser),'Question popup hides native browser in detached owner');
  assert.equal(await popup.getByRole('radio',{name:/^Preserve my choice/}).isChecked(),true);await popup.getByRole('button',{name:'Later',exact:true}).click();await until(browserOwnership,windows=>windows.some(window=>window.url.includes('#workspace-panel='+satelliteId)&&window.browser),'Question dismissal restores detached browser');report.checks.questionOverlayHidesDetachedNativeBrowserAndKeepsUnsentAnswer=true;
  const approvalCommand=await invoke('terminal.start',{conversationId:chat.id,command:"Write-Output 'THIS_MUST_NEVER_RUN'"});await until(()=>invoke('bootstrap'),state=>state.approvals.length===1,'Synthetic pending terminal permission');
  await page.locator('.sidebar-bottom .nav-item').filter({hasText:'Settings'}).click();await page.locator('.approval-backdrop').waitFor();await until(browserOwnership,windows=>windows.every(window=>!window.browser),'Floating approval hides detached native browser');await page.locator('.approval-backdrop').getByRole('button',{name:'Deny',exact:true}).click();
  await until(()=>invoke('terminal.list',{conversationId:chat.id}),state=>state.entries.find(entry=>entry.id===approvalCommand.id)?.status==='denied','Synthetic command denied before execution');await page.locator('[data-chat-id="'+chat.id+'"] .chat-open').click();await until(browserOwnership,windows=>windows.some(window=>window.url.includes('#workspace-panel='+satelliteId)&&window.browser),'Return to chat restores detached browser');report.checks.approvalOverlayHidesDetachedBrowserAndDenialNeverExecutesCommand=true;
  await child.getByRole('combobox',{name:'Dock panel position',exact:true}).selectOption('right');await dockChild(child);
  await until(()=>invoke('workspace.window.list'),state=>state.windows.length===0&&state.browserOwnerId===null,'Redock browser');await until(browserOwnership,windows=>windows.some(window=>!window.url.includes('#')&&window.browser),'Browser native owner returns main');
  assert.deepEqual((await browserState()).state,{counter:731,text:'Retained browser input'});await assertDrafts();report.checks.redockingKeepsSameWebContentsAndTaskState=true;
  await arrange(labels.browser,'Detach panel');const second=await until(()=>invoke('workspace.window.list'),state=>state.windows.some(window=>window.panel==='browser')&&state.browserOwnerId,'Second native detachment'),secondId=second.windows.find(window=>window.panel==='browser').id;
  await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('#workspace-panel='+id)).close(),secondId);
  await until(()=>invoke('workspace.window.list'),state=>state.windows.length===0&&state.browserOwnerId===null,'Native close restores browser owner');await group('right').getByRole('tab',{name:labels.browser,exact:true}).waitFor();await group('right').getByRole('tab',{name:labels.browser,exact:true}).click();
  await until(browserOwnership,windows=>windows.some(window=>!window.url.includes('#')&&window.browser),'Native close retains browser main view');assert.deepEqual((await browserState()).state,{counter:731,text:'Retained browser input'});await assertDrafts();report.checks.nativeCloseRedocksWithoutDestroyingLiveBrowserOrTaskState=true;
  await arrange(labels.browser,'Detach panel');await until(()=>invoke('workspace.window.list'),state=>state.windows.some(window=>window.panel==='browser')&&state.browserOwnerId,'Detach before temporary chat');
  await page.getByRole('button',{name:'Start temporary chat',exact:true}).click();await page.getByText('Temporary chat · text only',{exact:true}).waitFor();await until(()=>invoke('workspace.window.list'),state=>state.windows.length===0&&state.browserOwnerId===null,'Temporary chat closes shared panel windows');await until(browserOwnership,windows=>windows.every(window=>!window.browser),'Temporary chat hides shared browser');
  await page.locator('[data-chat-id="'+chat.id+'"] .chat-open').click();const resumed=await until(()=>invoke('workspace.window.list'),state=>state.windows.some(window=>window.panel==='browser')&&state.browserOwnerId,'Saved chat resumes prior floating workspace'),resumedId=resumed.windows.find(window=>window.panel==='browser').id;
  const resumedChild=await until(async()=>app.windows().find(candidate=>candidate.url().includes('#workspace-panel='+resumedId))||null,Boolean,'Resumed child');await dockChild(resumedChild);await until(()=>invoke('workspace.window.list'),state=>state.windows.length===0,'Redock resumed shared browser');assert.deepEqual((await browserState()).state,{counter:731,text:'Retained browser input'});await assertDrafts();report.checks.temporaryChatSuspendsDetachedSharedPanelsAndResumesSavedState=true;
  }
  // Register a raw synthetic satellite to check the host's exact URL capability
  // and monitor recovery independently from the UI's layout bookkeeping.
  if(!floatingOnly){
  await assert.rejects(invoke('workspace.window.prepare',{id:'bad',panel:'unknown'}),/valid workspace panel/);
  await assert.rejects(invoke('workspace.window.prepare',{id:'../bad',panel:'notes'}),/valid workspace panel/);
  await assert.rejects(invoke('workspace.browser.owner',{id:'not-open'}),/no longer open/);
  const raw=await invoke('workspace.window.prepare',{id:'qa-bounds',panel:'terminal',title:'Synthetic bounds recovery',bounds:{x:100000,y:100000,width:9000,height:9000}});
  await page.evaluate(url=>window.open(url,'qa-bounds'),raw.url);
  const rawState=await until(()=>invoke('workspace.window.list'),state=>state.windows.some(window=>window.id==='qa-bounds'),'Bounded native satellite');
  const rawWindow=rawState.windows.find(window=>window.id==='qa-bounds');
  const screen=await app.evaluate(({screen})=>screen.getAllDisplays().map(display=>display.workArea));assert.ok(screen.some(area=>rawWindow.bounds.x>=area.x-8&&rawWindow.bounds.y>=area.y-8&&rawWindow.bounds.x+rawWindow.bounds.width<=area.x+area.width+8&&rawWindow.bounds.y+rawWindow.bounds.height<=area.y+area.height+8),JSON.stringify({rawWindow,screen}));
  const count=rawState.windows.length;await page.evaluate(url=>{window.open(url,'qa-duplicate');window.open(url+'-unregistered','qa-unknown');},raw.url);
  await page.waitForTimeout(180);assert.equal((await invoke('workspace.window.list')).windows.length,count);await invoke('workspace.window.close',{id:'qa-bounds'});report.checks.hostRejectsUnknownPanelsOwnersAndUnregisteredOrReusedWindowUrls=true;report.checks.offscreenOversizedNativeWindowRecoversWithinCurrentMonitor=true;
  await page.screenshot({path:path.join(output,'workflow-workspace.png')});
  // Restart the entire host with the same protected synthetic profile. Drafts
  // are intentionally tested only within a renderer lifetime; layout survives.
  const shutdownChild=await invoke('workspace.window.prepare',{id:'qa-shutdown',panel:'workbench',title:'Synthetic shutdown cleanup'});await page.evaluate(url=>window.open(url,'qa-shutdown'),shutdownChild.url);await until(()=>invoke('workspace.window.list'),state=>state.windows.some(window=>window.id==='qa-shutdown'),'Satellite alive during main shutdown');
  const beforeRestart=await preferences();await close();assert.doesNotMatch(report.hostLog||'',/Uncaught Exception|A JavaScript error occurred in the main process/);report.checks.mainShutdownWithOpenSatelliteDoesNotTouchDestroyedWebContents=true;
  await open();await group('right').waitFor();assert.deepEqual(await preferences(),beforeRestart);
  await openSettings();await workspaces().getByRole('combobox',{name:'Saved workspace',exact:true}).selectOption({label:'Synthetic editing'});await workspaces().getByRole('button',{name:'Restore workspace',exact:true}).click();await dismissSettings();assert.deepEqual(await current(),saved.layout);report.checks.currentAndNamedLayoutsSurviveRealHostRestart=true;
  }
  if(packaged){
    const noteGroup=Object.keys((await current()).groups).find(name=>(saved.layout.groups[name].panels).includes('notes'));await group(noteGroup).getByRole('tab',{name:labels.notes,exact:true}).click();
    if(await page.getByRole('button',{name:'New note',exact:true}).count()&&await page.getByRole('textbox',{name:'Note text',exact:true}).count()===0)await page.getByRole('button',{name:'New note',exact:true}).click();
    await page.getByRole('textbox',{name:'Note text',exact:true}).fill('Persist this editable floating Notes arrangement.');await arrange(labels.notes,'Detach panel');
    const floating=await until(()=>invoke('workspace.window.list'),state=>state.windows.some(window=>window.panel==='notes'),'Floating layout to save');const floatingId=floating.windows.find(window=>window.panel==='notes').id;
    await openSettings();await workspaces().getByRole('textbox',{name:'Workspace name',exact:true}).fill('Synthetic floating');await workspaces().getByRole('button',{name:'Save workspace',exact:true}).click();await dismissSettings();
    const floatingSaved=(await preferences()).saved.find(item=>item.name==='Synthetic floating');assert.equal(floatingSaved.layout.floating[0].panel,'notes');
    const floatingChild=await until(async()=>app.windows().find(candidate=>candidate.url().includes('#workspace-panel='+floatingId))||null,Boolean,'Floating Notes to redock');await dockChild(floatingChild);await until(()=>invoke('workspace.window.list'),state=>state.windows.length===0,'Dock before restoring named floating layout');
    await openSettings();await workspaces().getByRole('combobox',{name:'Saved workspace',exact:true}).selectOption({label:'Synthetic floating'});await workspaces().getByRole('button',{name:'Restore workspace',exact:true}).click();await dismissSettings();
    const restoredFloating=await until(()=>invoke('workspace.window.list'),state=>state.windows.some(window=>window.panel==='notes'),'Named floating layout opens native satellite');const restoredId=restoredFloating.windows.find(window=>window.panel==='notes').id;
    const restoredChild=await until(async()=>app.windows().find(candidate=>candidate.url().includes('#workspace-panel='+restoredId))||null,Boolean,'Restored Notes child');assert.equal(await restoredChild.getByRole('textbox',{name:'Note text',exact:true}).inputValue(),'Persist this editable floating Notes arrangement.');await restoredChild.getByRole('textbox',{name:'Note text',exact:true}).fill('Named floating layout remains editable after restore.');
    await until(()=>invoke('notes.view'),state=>state.notes.some(note=>note.text==='Named floating layout remains editable after restore.'),'Floating note saved before clean exit');
    const beforeFloatingRestart=await preferences();report.floatingBeforeOrdinaryQuit=beforeFloatingRestart.current;await close(true);await open();report.floatingAfterOrdinaryRestart=await current();
    const reopened=await until(()=>invoke('workspace.window.list'),state=>state.windows.some(window=>window.panel==='notes'),'Current floating arrangement automatically reopens after host restart'),reopenedId=reopened.windows.find(window=>window.panel==='notes').id;
    const reopenedChild=await until(async()=>app.windows().find(candidate=>candidate.url().includes('#workspace-panel='+reopenedId))||null,Boolean,'Automatically reopened Notes child');assert.equal(await reopenedChild.getByRole('textbox',{name:'Note text',exact:true}).inputValue(),'Named floating layout remains editable after restore.');await reopenedChild.getByRole('textbox',{name:'Note text',exact:true}).fill('Floating panel is editable after automatic restart recovery.');await reopenedChild.screenshot({path:path.join(output,'restored-floating-notes.png')});
    assert.equal((await current()).floating[0].panel,'notes');assert.deepEqual((await preferences()).saved,beforeFloatingRestart.saved);await dockChild(reopenedChild);await until(()=>invoke('workspace.window.list'),state=>state.windows.length===0,'Redock after floating restart recovery');report.checks.namedFloatingLayoutRestoresEditableNativePanelAndCurrentFloatingLayoutReopensAfterOrdinaryQuitAndRestart=true;
  }
  if(!floatingOnly){
  await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Synthetic storage unavailable','SecurityError');}}));
  await page.reload();await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();await page.locator('[data-chat-id="'+chat.id+'"] .chat-open').click();const unavailablePopup=page.getByRole('dialog',{name:'Your input',exact:true});await unavailablePopup.waitFor();await unavailablePopup.getByRole('button',{name:'Later',exact:true}).click();
  await openSettings();await workspaces().getByRole('button',{name:'Customize workspace',exact:true}).click();await dismissSettings();await group('right').waitFor();await page.getByText('This layout is available for this session, but could not be saved on this device.',{exact:true}).waitFor();report.checks.unavailableLocalStorageKeepsAppAndSessionWorkspaceUsable=true;
  }
  }
  assert.deepEqual(report.errors,[]);assert.equal(await app.evaluate(()=>qaWorkspaces.runs),0);assert.equal(await app.evaluate(()=>qaWorkspaces.signins),0);
  report.protection=await fixture.verify();await close();assert.doesNotMatch(report.hostLog||'',/Uncaught Exception|A JavaScript error occurred in the main process|preload script must have absolute path/);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{await close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report,null,2));}
