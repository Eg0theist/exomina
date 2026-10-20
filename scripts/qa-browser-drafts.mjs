import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { chromium } from 'playwright';
import { Store } from '../desktop/store.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root);
const fixture=await createProtectedQaProfile('browser-drafts');
const {profile,output}=fixture;const workspace=path.join(output,'workspace');await mkdir(workspace);
const reportDir=path.resolve(root,'../Workspace/drafts-browser-verification');await mkdir(reportDir,{recursive:true});
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{workspace,autoUpdate:false,autoTitle:false,closeToTray:false,memoryEnabled:false,chatMemorySummaries:false,browserEnabled:false});
const a=store.create('codex'),b=store.create('codex');a.title='Draft A';b.title='Draft B';
for(const chat of [a,b])chat.messages=[{role:'user',content:'Synthetic fixture message',provider:'codex'},{role:'assistant',content:'Synthetic fixture answer',provider:'codex'}];await store.save();
const server=http.createServer((request,response)=>{
  response.setHeader('Content-Type','text/html; charset=utf-8');
  if(request.url==='/browser-login'){response.setHeader('Set-Cookie','signed=synthetic; Path=/; HttpOnly; SameSite=Lax');response.end('<title>Synthetic browser session</title><main>Signed in on the test website</main>');return;}
  if(request.url==='/login')response.end('<title>Synthetic login popup</title><button id="complete" onclick="document.cookie=\'signed=synthetic; Path=/; SameSite=Lax\';window.opener.postMessage(\'signed\',location.origin);window.close()">Complete synthetic sign-in</button>');
  else response.end(`<title>Synthetic browser login</title><main><h1 id="status">${request.headers.cookie?.includes('signed=synthetic')?'Session retained':'Signed out'}</h1><button id="login" onclick="window.open('/login','sign-in','width=500,height=500')">Sign in using popup</button><script>window.addEventListener('message',event=>{if(event.origin===location.origin&&event.data==='signed')document.querySelector('#status').textContent='Signed in through popup'})</script></main>`);
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/fixture`;
const moduleUrl=name=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,name)).href);
const launcher=path.join(output,'launcher.cjs');await writeFile(launcher,`const {app,BrowserWindow,dialog,session}=require('electron');
BrowserWindow.prototype.show=function(){};app.commandLine.appendSwitch('mute-audio');
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qaDrafts={runs:[],connects:[]};
(async()=>{await app.whenReady();for(const target of [session.defaultSession,session.fromPartition('persist:exomina-browser')])target.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)&&!details.url.startsWith(${JSON.stringify(new URL('/',url).href)})}));
const {ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const {PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,installed:true,connected:true,available:true,checking:false,detail:'Synthetic test connection.'}));for(const row of rows)onStatus?.(row);return rows};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.run=async request=>{globalThis.qaDrafts.runs.push(request.provider);throw Error('QA model requests prohibited')};ProviderManager.prototype.connect=async id=>{globalThis.qaDrafts.connects.push(id);throw Error('QA sign-in prohibited')};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`);
const env={...process.env,EXOMINA_DATA_DIR:profile,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key))delete env[key];
const report={runtimeRoot,output,scope:'Production renderer and browser with protected synthetic profile. Draft navigation, delayed failed sends, real OAuth-style popup/opener, shared browser session and paired real Edge extension; no personal accounts or provider model calls.',checks:{},errors:[]};let app,page,context;
async function open(title){await page.locator('.chat-open').filter({hasText:title}).click();}
async function browserRead(source){return app.evaluate(async({webContents},{url,source})=>{const wc=webContents.getAllWebContents().find(wc=>wc.getURL()===url);if(!wc)return null;return wc.mainFrame.executeJavaScript(source,true);},{url,source});}
try{
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.locator('.chat-open').filter({hasText:'Draft A'}).waitFor();await open('Draft A');const composer=page.getByRole('textbox',{name:'Message',exact:true});await composer.fill('Unsent text in A');
  await open('Draft B');assert.equal(await composer.inputValue(),'');await composer.fill('Unsent text in B');await open('Draft A');assert.equal(await composer.inputValue(),'Unsent text in A');
  await page.locator('.new-chat-button').click();assert.equal(await composer.inputValue(),'');await composer.fill('Unsent new-chat text');await open('Draft B');assert.equal(await composer.inputValue(),'Unsent text in B');await page.locator('.new-chat-button').click();assert.equal(await composer.inputValue(),'Unsent new-chat text');report.checks.chatAndNewChatDraftsRemainSeparate=true;
  await open('Draft A');await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('heading',{name:'Website sign-ins',exact:true}).waitFor();await open('Draft A');assert.equal(await composer.inputValue(),'Unsent text in A');report.checks.draftSurvivesOtherAppPages=true;
  await app.evaluate(({ipcMain})=>{const original=ipcMain._invokeHandlers.get('studio:invoke');ipcMain.removeHandler('studio:invoke');ipcMain.handle('studio:invoke',(event,method,payload)=>{if(method==='chat.send'){globalThis.qaDrafts.failedSends=(globalThis.qaDrafts.failedSends||0)+1;return new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('Synthetic delayed transport failure')),1500))}return original(event,method,payload)});});
  await page.getByRole('button',{name:'Send message',exact:true}).click();await open('Draft B');assert.equal(await composer.inputValue(),'Unsent text in B');await open('Draft A');await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Message"]')?.value==='Unsent text in A');assert.equal(await composer.inputValue(),'Unsent text in A');report.checks.failedSendReturnsToOriginatingChat=true;
  await page.getByRole('button',{name:'Browser',exact:true}).click();await page.evaluate(url=>window.studio.invoke('browser.navigate',{url}),url);
  await browserRead("document.querySelector('#login').click()");
  let popup;for(let tries=0;tries<50;tries++){popup=await app.evaluate(({webContents},url)=>webContents.getAllWebContents().some(wc=>wc.getURL()===new URL('/login',url).href),url);if(popup)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(popup,true);
  const relationship=await app.evaluate(async({webContents},url)=>{const wc=webContents.getAllWebContents().find(wc=>wc.getURL()===new URL('/login',url).href);return {opener:await wc.mainFrame.executeJavaScript('!!window.opener'),sandbox:wc.getLastWebPreferences().sandbox,nodeIntegration:wc.getLastWebPreferences().nodeIntegration};},url);assert.deepEqual(relationship,{opener:true,sandbox:true,nodeIntegration:false});
  await app.evaluate(async({webContents},url)=>{const wc=webContents.getAllWebContents().find(wc=>wc.getURL()===new URL('/login',url).href);await wc.mainFrame.executeJavaScript("document.querySelector('#complete').click()",true);},url);
  for(let tries=0;tries<50;tries++){if(await browserRead("document.querySelector('#status')?.textContent")==='Signed in through popup')break;await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(await browserRead("document.querySelector('#status')?.textContent"),'Signed in through popup');report.checks.realPopupKeepsOpenerAndReturnsSignIn=true;
  await open('Draft B');await page.getByRole('button',{name:'Browser',exact:true}).click();await page.evaluate(({url,id})=>window.studio.invoke('browser.navigate',{url,conversationId:id}),{url,id:b.id});
  // Both chats own distinct web contents; the saved website sign-in belongs to the shared browser profile.
  const signedIn=await app.evaluate(async({webContents},url)=>{const pages=webContents.getAllWebContents().filter(wc=>wc.getURL()===url);return {count:pages.length,texts:await Promise.all(pages.map(wc=>wc.mainFrame.executeJavaScript("document.querySelector('#status')?.textContent")))};},url);assert.equal(signedIn.count,2);assert.ok(signedIn.texts.includes('Session retained'));report.checks.websiteSessionSharedAcrossChatPages=true;
  await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('button',{name:'Connect Chrome or Edge',exact:true}).click();
  const code=await page.getByRole('textbox',{name:'Browser connection code',exact:true}).inputValue();
  const extension=path.join(runtimeRoot.replace('app.asar','app.asar.unpacked'),'desktop/browser-extension');
  context=await chromium.launchPersistentContext(path.join(output,'isolated-edge'),{executablePath:process.env.EXOMINA_QA_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-background-networking','--disable-sync','--no-first-run']});
  await context.route('**/*',route=>/^https?:/.test(route.request().url())&&!route.request().url().startsWith('http://127.0.0.1:')?route.abort():route.continue());
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:10000});const options=await context.newPage();await options.goto(`chrome-extension://${new URL(worker.url()).host}/connect.html`);
  await options.getByLabel('Connection code from Exomina → Tools').fill(code);await options.getByRole('button',{name:'Connect',exact:true}).click();await options.getByRole('status').filter({hasText:'Connected.'}).waitFor();
  const useBrowser=page.getByRole('button',{name:'Use my browser',exact:true});await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Use my browser'&&!button.disabled));await useBrowser.click();await open('Draft B');
  await page.getByText('Working in your browser',{exact:true}).waitFor();await page.evaluate(({url,id})=>window.studio.invoke('browser.navigate',{url,conversationId:id}),{url:new URL('/browser-login',url).href,id:b.id});await page.evaluate(({url,id})=>window.studio.invoke('browser.navigate',{url,conversationId:id}),{url,id:b.id});
  const linkedPage=context.pages().find(value=>value.url()===url);assert.ok(linkedPage);assert.equal(await linkedPage.locator('#status').innerText(),'Session retained');assert.equal(await composer.inputValue(),'Unsent text in B');report.checks.productionBrowserChoiceUsesPairedProfile=true;
  await open('Draft A');await page.evaluate(({url,id})=>window.studio.invoke('browser.navigate',{url,conversationId:id}),{url,id:a.id});assert.equal(context.pages().filter(value=>value.url()===url).length,2);assert.equal(await composer.inputValue(),'Unsent text in A');report.checks.externalTabsAndComposerDraftsMatchTheirChat=true;
  await page.screenshot({path:path.join(reportDir,'source-draft-browser.png')});const calls=await app.evaluate(()=>globalThis.qaDrafts);assert.deepEqual(calls.runs,[]);assert.deepEqual(calls.connects,[]);assert.equal(calls.failedSends,1);assert.deepEqual(report.errors,[]);report.checks.noPersonalAccountsOrModelCalls=true;report.protection=await fixture.verify();report.passed=true;
}catch(error){report.failure=error.stack;process.exitCode=1;if(page&&!page.isClosed()){await page.locator('[aria-label="Browser connection code"]').evaluateAll(elements=>elements.forEach(element=>element.style.visibility='hidden')).catch(()=>{});await page.screenshot({path:path.join(reportDir,'draft-browser-failure.png')}).catch(()=>{});}}
finally{await context?.close().catch(()=>{});await app?.close().catch(()=>{});await new Promise(resolve=>server.close(resolve));await writeFile(path.join(reportDir,process.env.EXOMINA_QA_REPORT||'source-ui-qa.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({passed:report.passed||false,checks:report.checks,errors:report.errors,failure:report.failure,output}));
