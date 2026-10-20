import {_electron as electron} from 'playwright';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {extractFile} from '@electron/asar';

// Real production main, renderer and WebContentsView in a fresh encrypted
// synthetic profile. Source's Electron imports the requested app.asar: a
// packaged Exomina executable is never launched and all windows stay hidden.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root);
const fixture=await createProtectedQaProfile('browser-resize'),{profile,output}=fixture;
const workspace=path.join(output,'workspace');await mkdir(workspace);
await mkdir(path.join(profile,'browser-data'),{recursive:true});
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{workspace,autoTitle:false,autoUpdate:false,closeToTray:false,memoryEnabled:false,chatMemorySummaries:false,browserEnabled:true,browserSource:'embedded',desktopEnabled:false,permissionMode:'ask',routing:'tools'});
const first=store.create('codex');first.title='Browser resize QA';first.titleSource='manual';
const second=store.create('codex');second.title='Second resize QA';second.titleSource='manual';await store.save();
const webServer=createServer((request,response)=>{
  response.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'});
  response.end('<!doctype html><html><head><title>Local browser resize fixture</title></head><body style="margin:0;background:#f1f5ef;color:#163020;font:18px sans-serif"><h1>Local resize fixture</h1><output id="size"></output><script>const show=()=>document.getElementById("size").textContent=innerWidth+" x "+innerHeight;addEventListener("resize",show);show();</script></body></html>');
});
await new Promise(resolve=>webServer.listen(0,'127.0.0.1',resolve));
const localOrigin=`http://127.0.0.1:${webServer.address().port}`,localUrl=localOrigin+'/fixture';
const expectedVersion=JSON.parse(runtimeRoot.endsWith('.asar')?extractFile(runtimeRoot,'package.json'):await readFile(path.join(runtimeRoot,'package.json'),'utf8')).version;
const moduleUrl=name=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,name)).href);
const launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const {app,BrowserWindow,session,dialog}=require('electron');
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile,'browser-data'))});
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};
app.commandLine.appendSwitch('mute-audio');dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};app.getVersion=()=>${JSON.stringify(expectedVersion)};
globalThis.qaBrowserResize={pages:new Set(),accountCalls:0,modelCalls:0,bridgeRequests:[],boundsUpdates:0};
(async()=>{await app.whenReady();for(const partition of [session.defaultSession,session.fromPartition('persist:exomina-browser')])partition.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)&&!details.url.startsWith(${JSON.stringify(localOrigin+'/')})}));
const {ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const {PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,installed:true,connected:item.id==='codex',available:true,checking:false,detail:'Synthetic QA connection.'}));for(const row of rows)onStatus?.(row);return rows};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.getCodex=async()=>{globalThis.qaBrowserResize.accountCalls++;throw Error('Native account/runtime access prohibited in browser resize QA')};
ProviderManager.prototype.connect=async()=>{globalThis.qaBrowserResize.accountCalls++;throw Error('Live sign-in prohibited in browser resize QA')};
ProviderManager.prototype.run=async()=>{globalThis.qaBrowserResize.modelCalls++;throw Error('Model calls prohibited in browser resize QA')};
const {BrowserPage}=await import(${moduleUrl('desktop/browser.mjs')});
const setBounds=BrowserPage.prototype.setBounds;BrowserPage.prototype.setBounds=function(bounds){globalThis.qaBrowserResize.pages.add(this);globalThis.qaBrowserResize.boundsUpdates++;return setBounds.call(this,bounds)};
const show=BrowserPage.prototype.show;BrowserPage.prototype.show=function(visible){globalThis.qaBrowserResize.pages.add(this);return show.call(this,visible)};
const {BrowserBridge}=await import(${moduleUrl('desktop/browser-bridge.mjs')});const bridgeStatus=BrowserBridge.prototype.status;
BrowserBridge.prototype.status=function(){return {...bridgeStatus.call(this),connected:true,syntheticQaConnection:true}};
BrowserBridge.prototype.request=async function(action){globalThis.qaBrowserResize.bridgeRequests.push(action);throw Error('Personal connected browser access prohibited in browser resize QA')};
await import(${moduleUrl('desktop/main.mjs')});
})().catch(error=>{console.error(error);app.exit(1)});`);
const env={...process.env,EXOMINA_DATA_DIR:profile,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key))delete env[key];
const reportDir=path.resolve(root,'../Workspace/browser-resize-verification');await mkdir(reportDir,{recursive:true});
const report={runtimeRoot,output,scope:'Actual production main/renderer/native WebContentsView, encrypted synthetic profile and loopback-only fixture. Connected-browser display uses a synthetic status and sends no browser requests. No personal account/profile access, model calls or visible windows.',checks:{},errors:[],geometry:[]};
let app,page;
const pane=()=>page.locator('.browser-panel'),divider=()=>page.getByRole('separator',{name:'Resize browser',exact:true});
const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
async function layout(){return page.evaluate(()=>{
  const rect=selector=>{const bounds=document.querySelector(selector)?.getBoundingClientRect();return bounds?Object.fromEntries(['x','y','width','height','right','bottom'].map(key=>[key,bounds[key]])):null};
  const handle=document.querySelector('[role="separator"][aria-label="Resize browser"]');
  return {viewport:{width:innerWidth,height:innerHeight},panel:rect('.browser-panel'),host:rect('.browser-host'),main:rect('.main-shell'),sidebar:rect('.sidebar'),divider:handle?{min:Number(handle.getAttribute('aria-valuemin')),max:Number(handle.getAttribute('aria-valuemax')),now:Number(handle.getAttribute('aria-valuenow'))}:null,scrollWidth:document.documentElement.scrollWidth};
});}
async function nativeViews(){return app.evaluate(()=>[...globalThis.qaBrowserResize.pages].filter(item=>!item.wc.isDestroyed()).map(item=>({visible:item.visible,attached:item.window.contentView.children.includes(item.view),bounds:item.view.getBounds(),url:item.wc.getURL()})));}
async function localPageRestored(){
  const deadline=Date.now()+15000;let current;
  while(Date.now()<deadline){current=(await nativeViews()).find(item=>item.visible&&item.attached);if(current?.url===localUrl)return current;await page.waitForTimeout(25);}
  assert.equal(current?.url,localUrl,'The saved local browser page did not finish restoring');
}
async function synchronized(label){
  const deadline=Date.now()+10000;let actual,native;
  while(Date.now()<deadline){actual=await layout();native=(await nativeViews()).filter(item=>item.visible&&item.attached);if(actual.host&&native.length===1&&['x','y','width','height'].every(key=>Math.abs(native[0].bounds[key]-Math.round(actual.host[key]))<=1))break;await page.waitForTimeout(30);}
  assert.equal(native.length,1,`${label}: expected one attached native page`);
  for(const key of ['x','y','width','height'])assert.ok(Math.abs(native[0].bounds[key]-Math.round(actual.host[key]))<=1,`${label}: native ${key} ${native[0].bounds[key]} differs from renderer ${actual.host[key]}`);
  report.geometry.push({label,layout:actual,native:native[0]});return actual;
}
async function drag(delta){const bounds=await divider().boundingBox();assert.ok(bounds,'Resize divider has no bounds');await page.mouse.move(bounds.x+bounds.width/2,bounds.y+Math.min(180,bounds.height/2));await page.mouse.down();await page.mouse.move(bounds.x+bounds.width/2+delta,bounds.y+Math.min(180,bounds.height/2),{steps:8});await page.mouse.up();}
async function beginDrag(delta){
  const bounds=await divider().boundingBox();assert.ok(bounds);const start={x:bounds.x+bounds.width/2,y:bounds.y+Math.min(180,bounds.height/2)};
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.locator('.browser-resizing').waitFor();
  const deadline=Date.now()+5000;while(Date.now()<deadline&&(await nativeViews()).some(item=>item.visible||item.attached))await page.waitForTimeout(20);
  assert.equal((await nativeViews()).some(item=>item.visible||item.attached),false,'Native page must detach during active drag so it cannot intercept the divider');
  await page.mouse.move(start.x+delta,start.y,{steps:8});return start;
}
async function reopenIfHidden(){if(await pane().count()===0)await page.locator('.browser-toggle').click();await divider().waitFor();}
async function prohibitions(){return app.evaluate(({BrowserWindow})=>({accountCalls:globalThis.qaBrowserResize.accountCalls,modelCalls:globalThis.qaBrowserResize.modelCalls,bridgeRequests:globalThis.qaBrowserResize.bridgeRequests,visibleWindows:BrowserWindow.getAllWindows().filter(item=>item.isVisible()).length,boundsUpdates:globalThis.qaBrowserResize.boundsUpdates}));}
async function rendererEvidence(){
  const resources=await page.evaluate(()=>({url:location.href,scripts:[...document.querySelectorAll('script[src]')].map(item=>item.getAttribute('src')),styles:[...document.querySelectorAll('link[rel=stylesheet]')].map(item=>item.getAttribute('href'))}));
  const assets=[];for(const reference of [...resources.scripts,...resources.styles]){const file=path.posix.join('dist',reference.replace(/^\.\//,''));const bytes=runtimeRoot.endsWith('.asar')?extractFile(runtimeRoot,path.normalize(file)):await readFile(path.join(runtimeRoot,file));assets.push({file,sha256:createHash('sha256').update(bytes).digest('hex')});}
  return {resources,assets};
}
async function resizeWindow(width){
  const actual=await app.evaluate(({BrowserWindow},width)=>{const main=BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&item.webContents.getURL().includes('index.html'));main.setContentSize(width,900);return {bounds:main.getBounds(),content:main.getContentBounds()};},width);
  await page.waitForFunction(width=>Math.abs(innerWidth-width)<=1,actual.content.width);return actual;
}
try{
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.locator('.chat-open').filter({hasText:first.title}).click();
  await resizeWindow(1440);await page.locator('.browser-toggle').click();await divider().waitFor();
  await invoke('browser.navigate',{conversationId:first.id,url:localUrl});
  let current=await synchronized('initial');assert.ok(current.panel.width>=300);assert.equal(current.divider.now,Math.round(current.panel.width));report.checks.initialPaneHasAccessibleResizeHandle=true;
  const initial=current.panel.width;await drag(-180);current=await synchronized('drag wider');assert.ok(current.panel.width>initial+150,`Leftward drag did not enlarge browser: ${initial} -> ${current.panel.width}`);const enlarged=current.panel.width;report.checks.dragEnlargesRealEmbeddedPage=true;
  const browserViewport=await app.evaluate(async()=>{const item=[...globalThis.qaBrowserResize.pages].find(item=>item.visible);return item.wc.executeJavaScript('({width:innerWidth,height:innerHeight,text:document.querySelector("#size").textContent})')});assert.ok(Math.abs(browserViewport.width-current.host.width)<=1);assert.match(browserViewport.text,new RegExp(`^${browserViewport.width} x `));report.checks.loadedPageReceivesRealResizeEvent=true;
  await drag(95);current=await synchronized('drag narrower');assert.ok(current.panel.width<enlarged-70);report.checks.dragNarrowsRealEmbeddedPage=true;
  await divider().focus();let before=current.panel.width;await divider().press('ArrowLeft');current=await synchronized('keyboard wider');assert.ok(current.panel.width>before);before=current.panel.width;await divider().press('ArrowRight');current=await synchronized('keyboard narrower');assert.ok(current.panel.width<before);report.checks.keyboardResizesAndSynchronizesNativePage=true;
  before=current.panel.width;await beginDrag(-85);assert.ok((await layout()).panel.width>before+60);await page.keyboard.press('Escape');await page.mouse.up();current=await synchronized('Escape cancels drag');assert.ok(Math.abs(current.panel.width-before)<=1);assert.equal((await nativeViews()).filter(item=>item.visible)[0].url,localUrl);report.checks.escapeCancelsDragAndRestoresNativePage=true;
  await beginDrag(-60);const moved=(await layout()).panel.width;await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();current=await synchronized('blur finishes drag');assert.ok(Math.abs(current.panel.width-moved)<=1);report.checks.simulatedWindowBlurFinishesDragAndRestoresNativePage=true;
  const saved=current.panel.width;await page.getByRole('button',{name:'Close embedded browser',exact:true}).click();await pane().waitFor({state:'hidden'});assert.equal((await nativeViews()).some(item=>item.visible||item.attached),false);await page.locator('.browser-toggle').click();current=await synchronized('hide and reopen');assert.ok(Math.abs(current.panel.width-saved)<=1);report.checks.hideAndReopenPreservesWidth=true;
  await page.locator('.chat-open').filter({hasText:second.title}).click();await reopenIfHidden();current=await synchronized('second chat');assert.ok(Math.abs(current.panel.width-saved)<=1);await page.locator('.chat-open').filter({hasText:first.title}).click();await reopenIfHidden();current=await synchronized('first chat restored');assert.ok(Math.abs(current.panel.width-saved)<=1);assert.equal((await nativeViews()).filter(item=>item.visible)[0].url,localUrl);report.checks.chatSwitchPreservesWidthAndOwnPage=true;
  await page.reload();await page.locator('.chat-open').filter({hasText:first.title}).click();if(await pane().count()===0)await page.locator('.browser-toggle').click();current=await synchronized('renderer reload');assert.ok(Math.abs(current.panel.width-saved)<=1);report.checks.widthPersistsAcrossRendererReload=true;
  await resizeWindow(960);current=await synchronized('minimum app width');assert.ok(current.main.width>=359,`Chat too narrow at app minimum: ${current.main.width}`);assert.ok(current.panel.x>=current.main.right-1,'Browser overlaps the chat at the supported app minimum');assert.ok(current.panel.right<=current.viewport.width+1);assert.ok(current.scrollWidth<=current.viewport.width+1);report.checks.minimumWindowClampsBrowserAndKeepsChatUsable=true;
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('index.html')).setMinimumSize(640,680));
  await resizeWindow(740);current=await synchronized('narrow responsive window');assert.ok(current.main.width>=350);assert.ok(current.panel.right<=current.viewport.width+1);assert.ok(current.panel.width<=current.divider.max+1);await page.getByRole('button',{name:'Close embedded browser',exact:true}).click();await pane().waitFor({state:'hidden'});assert.equal((await nativeViews()).some(item=>item.visible||item.attached),false);await reopenIfHidden();await synchronized('narrow browser reopened');report.checks.narrowResponsiveWindowRemainsClosableWithoutOverflow=true;
  await resizeWindow(640);current=await synchronized('small responsive overlay');assert.equal(await page.locator('.app-shell').getAttribute('data-browser-overlay'),'true');assert.ok(current.panel.width<=current.viewport.width-47);assert.ok(current.panel.right<=current.viewport.width+1);await page.getByRole('button',{name:'Close embedded browser',exact:true}).click();await pane().waitFor({state:'hidden'});assert.equal((await nativeViews()).some(item=>item.visible||item.attached),false);await reopenIfHidden();await synchronized('overlay browser reopened');report.checks.smallViewportOverlayRemainsClosableAndWithinWindow=true;
  await resizeWindow(1440);current=await synchronized('wide window restored');assert.ok(Math.abs(current.panel.width-saved)<=1);report.checks.narrowClampDoesNotOverwritePreferredWidth=true;
  await divider().focus();await divider().press('Home');current=await synchronized('keyboard minimum');assert.ok(Math.abs(current.panel.width-current.divider.min)<=1);await divider().press('End');current=await synchronized('keyboard maximum');assert.ok(Math.abs(current.panel.width-current.divider.max)<=1);assert.ok(current.main.width>=350);report.checks.keyboardMinimumMaximumRespectChatSpace=true;
  const header=await page.evaluate(()=>{const bar=document.querySelector('.window-header'),main=(bar||document.querySelector('.main-shell')).getBoundingClientRect();return {main:{x:main.x,right:bar?main.right-138:main.right},controls:[document.querySelector('.topbar-title'),...document.querySelector('.topbar-actions').children].filter(item=>getComputedStyle(item).display!=='none').map(item=>{const bounds=item.getBoundingClientRect();return {label:item.getAttribute('aria-label')||item.textContent.trim(),x:bounds.x,right:bounds.right,width:bounds.width};})};});
  for(const control of header.controls)assert.ok(control.x>=header.main.x-1&&control.right<=header.main.right+1,`Chat header ${control.label} overflows main at maximum browser width`);report.headerAtMaximum=header;report.checks.chatHeaderControlsRemainReachableAtMaximumBrowserWidth=true;
  await divider().press('Enter');current=await synchronized('keyboard reset');assert.ok(Math.abs(current.panel.width-440)<=1);report.checks.keyboardResetRestoresDefault=true;
  await invoke('settings.save',{browserSource:'connected'});await page.locator('.connected-browser-info').waitFor();await page.locator('.browser-panel-heading strong').filter({hasText:'My browser'}).waitFor();const connectedBefore=(await layout()).panel.width;await drag(-100);current=await layout();assert.ok(current.panel.width>connectedBefore+75);assert.equal((await nativeViews()).some(item=>item.visible||item.attached),false);report.checks.connectedBrowserPaneUsesSameResizeControlWithoutNativeOverlay=true;
  await invoke('settings.save',{browserSource:'embedded'});current=await synchronized('built-in browser restored');assert.equal((await nativeViews()).filter(item=>item.visible)[0].url,localUrl);report.checks.browserChoiceRetainsWidthAndLocalPage=true;
  const beforeRestart=current.panel.width;report.beforeRestartProhibitions=await prohibitions();assert.equal((await invoke('bootstrap')).conversations.find(item=>item.id===first.id).browser.url,localUrl);await app.evaluate(({app})=>app.exit(0));await app.close();app=null;
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));await page.locator('.chat-open').filter({hasText:first.title}).click();await resizeWindow(1440);await reopenIfHidden();current=await synchronized('full app restart');assert.ok(Math.abs(current.panel.width-beforeRestart)<=1);await localPageRestored();report.checks.realAppRestartPreservesWidthAndBrowserPage=true;
  report.afterRestartProhibitions=await prohibitions();report.rendererEvidence=await rendererEvidence();
  for(const current of [report.beforeRestartProhibitions,report.afterRestartProhibitions]){assert.equal(current.accountCalls,0);assert.equal(current.modelCalls,0);assert.deepEqual(current.bridgeRequests,[]);assert.equal(current.visibleWindows,0);assert.ok(current.boundsUpdates>0);}report.checks.noPersonalBrowserAccountModelOrVisibleWindow=true;
  assert.deepEqual(report.errors,[]);report.checks.noRendererErrors=true;report.protection=await fixture.verify();
  const nativePixels=await app.evaluate(async()=>{const item=[...globalThis.qaBrowserResize.pages].find(item=>item.visible);return (await item.wc.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64')});
  await writeFile(path.join(reportDir,runtimeRoot===root?'source-native-browser-resize.png':'packaged-native-browser-resize.png'),Buffer.from(nativePixels,'base64'));
  report.screenshotLimit='Renderer screenshot excludes native child-view pixels; native child page is captured separately. Geometry and loaded local page viewport/resize events are verified.';
  await page.screenshot({path:path.join(reportDir,runtimeRoot===root?'source-browser-resize.png':'packaged-browser-resize.png')});report.passed=true;
}catch(error){report.error=error.stack;if(page){report.failureLayout=await layout().catch(()=>null);report.failureWindows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(item=>({url:item.webContents.getURL(),bounds:item.getBounds(),content:item.getContentBounds()}))).catch(()=>null);await page.screenshot({path:path.join(reportDir,'browser-resize-failure.png')}).catch(()=>{});}process.exitCode=1;}
finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}await new Promise(resolve=>webServer.close(resolve));const reportPath=path.join(reportDir,runtimeRoot===root?'source-browser-resize-qa.json':'packaged-browser-resize-qa.json');await writeFile(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:Boolean(report.passed),runtimeRoot,checks:report.checks,reportPath,error:report.error,failureLayout:report.failureLayout}));}
