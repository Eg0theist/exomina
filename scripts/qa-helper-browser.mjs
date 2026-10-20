// Production host and real Electron views, with isolated synthetic data/providers only.
import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { AssetStore } from '../desktop/assets.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root=process.cwd(),fixture=await createProtectedQaProfile('helper-browser'),{output,profile}=fixture;
const workspace=path.join(output,'workspace');await mkdir(workspace,{recursive:true});
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lscAAAAASUVORK5CYII=';
const localFile=path.join(workspace,'concept (review).png');await writeFile(localFile,Buffer.from(png,'base64'));
const assetStore=new AssetStore(profile);await assetStore.init();const image=await assetStore.put(png);assetStore.close();
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<title>Chat page ${req.url}</title><main><h1>Chat page ${req.url}</h1><input id="draft" aria-label="Draft"><p>Independent browser content.</p></main>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const store=new Store(profile,{workspace});await store.init();Object.assign(store.state.settings,{autoUpdate:false,autoTitle:false,closeToTray:false,browserEnabled:true,permissionMode:'full',appearance:{theme:'erebus-flame',motion:'reduced'}});
const a=store.create('codex'),b=store.create('codex');a.title='Exomina Setup synthetic';b.title='Second browser chat';
a.messages=Array.from({length:72},(_,i)=>({role:i%2?'assistant':'user',provider:'codex',content:`Message ${i+1}: `+'Synthetic long chat paragraph with enough text to wrap. '.repeat(i%2?35:3)}));
a.messages.push({role:'assistant',provider:'codex',content:`[Open local image](<${localFile.replaceAll('\\','/')}:12>)\n\n[Open web fixture](${base}/link)\n\nPlain URL: ${base}/plain\n\n[Parentheses URL](${base}/a(b))\n\nLAST MESSAGE MARKER`,attachments:[{...image,kind:'image'}]});
b.messages=[{role:'assistant',provider:'codex',content:'Second chat fixture.'}];await store.save();
const launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,shell,dialog}=require('electron');const{pathToFileURL}=require('node:url');
BrowserWindow.prototype.show=function(){};dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qaHelpers={parents:new Map(),helpers:[],opened:[]};shell.openPath=async file=>{globalThis.qaHelpers.opened.push(file);return ''};
(async()=>{const{ProviderManager}=await import(${JSON.stringify(pathToFileURL(path.join(root,'desktop/providers.mjs')).href)});
 const models={codex:[{id:'gpt-6-sol',efforts:[{id:'low'},{id:'medium'},{id:'high'}],supportsImages:true},{id:'gpt-6-luna',efforts:[{id:'low'},{id:'medium'}],supportsImages:true},{id:'gpt-6-astra',efforts:[{id:'medium'},{id:'high'},{id:'ultra'}],supportsImages:true}],claude:[{id:'sonnet',efforts:[{id:'low'},{id:'medium'},{id:'high'}],supportsImages:true}]};
 ProviderManager.prototype.status=async()=>['codex','claude'].map(id=>({id,installed:true,connected:true,detail:'Synthetic QA connection'}));
 ProviderManager.prototype.subscriptionModels=async()=>models;ProviderManager.prototype.modelsFor=async id=>models[id]||[];
 ProviderManager.prototype.codexUsage=async()=>({rateLimits:{primary:{usedPercent:10,windowDurationMins:300},secondary:{usedPercent:20,windowDurationMins:10080}}});
 ProviderManager.prototype.claudeUsage=async()=>({rate_limits:{five_hour:{utilization:10},seven_day:{utilization:20}}});
 ProviderManager.prototype.run=async function(request){
  if(request.conversationId.startsWith('helper-')){globalThis.qaHelpers.helpers.push({provider:request.provider,model:request.model,effort:request.effort,noTools:request.noTools,toolCount:request.toolDefinitions.length,imageCount:request.images.length,pixelsMatch:request.images.every(image=>image.dataBase64===${JSON.stringify(png)})});return {text:'Synthetic helper inspected the supplied pixels.',selection:{model:request.model}};}
  return new Promise(resolve=>globalThis.qaHelpers.parents.set(request.conversationId,{call:(name,args)=>this.callTool(name,args,request.conversationId),finish:()=>resolve({text:'Synthetic parent completed.'})}));
 };
 await import(${JSON.stringify(pathToFileURL(path.join(root,'desktop/main.mjs')).href)});
})().catch(error=>{console.error(error);app.exit(1)});`);
const report={scope:'Production host and renderer; real per-chat WebContentsViews; fresh protected synthetic profile; synthetic helper inference; no personal data or live subscription calls.',checks:{},errors:[]};let app;
async function waitBrowser(page,id,url){let last;const deadline=Date.now()+15000;do{last=await page.evaluate(id=>window.studio.invoke('browser.state',{conversationId:id}),id);if(last?.url===url&&last?.pageReady)return last;await new Promise(resolve=>setTimeout(resolve,75));}while(Date.now()<deadline);throw Error('Browser did not navigate: '+JSON.stringify({expected:url,state:last}));}
async function bottom(page){return page.locator('.chat-scroll').evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight);}
try{
 const env={...process.env,EXOMINA_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 const openChat=async id=>{await page.locator(`[data-chat-id="${id}"] .chat-open`).click();await page.waitForTimeout(100);};
 await openChat(a.id);await page.waitForFunction(()=>{const el=document.querySelector('.chat-scroll');return el&&el.scrollHeight-el.scrollTop-el.clientHeight<3});assert.ok(await bottom(page)<3);
 for(const section of ['Memory','Connections']){await page.getByRole('button',{name:section,exact:true}).click();await openChat(a.id);assert.ok(await bottom(page)<3,section+' must reopen at latest message');}
 await openChat(b.id);await openChat(a.id);assert.ok(await bottom(page)<3);report.checks.longChatReopensAtLatest=true;
 await page.locator('.chat-scroll').evaluate(el=>{el.dispatchEvent(new WheelEvent('wheel',{deltaY:-1000,bubbles:true}));el.scrollTop-=1000;});await page.waitForTimeout(150);const oldTop=await page.locator('.chat-scroll').evaluate(el=>el.scrollTop);assert.ok(await bottom(page)>100);
 await page.evaluate(()=>{const last=document.querySelector('.message:last-child');last.appendChild(Object.assign(document.createElement('p'),{textContent:'Later content height change '.repeat(100)}));});await page.waitForTimeout(150);
 assert.ok(Math.abs((await page.locator('.chat-scroll').evaluate(el=>el.scrollTop))-oldTop)<3);await openChat(a.id);report.checks.userScrollingStaysPut=true;
 await page.getByRole('button',{name:'Browser',exact:true}).click();await page.getByLabel('Browser address').fill(base+'/a');await page.getByRole('button',{name:'Search or navigate'}).click();
 report.checks.browserReadya=await waitBrowser(page,a.id,base+'/a');
 const setDraft=async(url,value)=>app.evaluate(async({webContents},{url,value})=>{const wc=webContents.getAllWebContents().find(w=>w.getURL()===url);if(!wc)throw Error('Synthetic browser page not found: '+JSON.stringify({expected:url,pages:webContents.getAllWebContents().map(w=>({id:w.id,url:w.getURL()}))}));return wc.mainFrame.executeJavaScript('document.getElementById("draft").value='+JSON.stringify(value));},{url,value});
 await setDraft(base+'/a','Unsubmitted first chat draft');
 await openChat(b.id);assert.equal(await page.locator('.browser-panel').count(),0);await page.getByRole('button',{name:'Browser',exact:true}).click();await page.getByLabel('Browser address').fill(base+'/b');await page.getByRole('button',{name:'Search or navigate'}).click();
 report.checks.browserReadyb=await waitBrowser(page,b.id,base+'/b');await openChat(a.id);
 await page.waitForFunction(url=>document.querySelector('[aria-label="Browser address"]').value===url,base+'/a');
 const draft=await app.evaluate(async({webContents},url)=>webContents.getAllWebContents().find(w=>w.getURL()===url).mainFrame.executeJavaScript('document.getElementById("draft").value'),base+'/a');assert.equal(draft,'Unsubmitted first chat draft');
 report.checks.separateLivePagesAndDrafts=true;
 await page.getByRole('button',{name:'Close embedded browser',exact:true}).click();
 await page.getByRole('link',{name:'Open local image',exact:true}).click();const opened=await app.evaluate(()=>globalThis.qaHelpers.opened);assert.deepEqual(opened,[localFile]);report.checks.nativeFileOpenWithSpacesParenthesesAndLineSuffix=true;
 await page.getByRole('link',{name:'Open web fixture',exact:true}).click();report.checks.browserReadylink=await waitBrowser(page,a.id,base+'/link');assert.equal((await page.evaluate(id=>window.studio.invoke('browser.state',{conversationId:id}),a.id)).url,base+'/link');
 assert.equal((await page.evaluate(id=>window.studio.invoke('browser.state',{conversationId:id}),b.id)).url,base+'/b');report.checks.webLinksOpenInOwningChat=true;
 const parent=await page.evaluate(id=>window.studio.invoke('chat.send',{conversationId:id,provider:'codex',text:'Synthetic helper configuration test'}),a.id);
 await app.evaluate(async(_e,id)=>{while(!globalThis.qaHelpers.parents.has(id))await new Promise(resolve=>setTimeout(resolve,10));},a.id);
 const call=(name,args)=>app.evaluate(async(_e,{id,name,args})=>globalThis.qaHelpers.parents.get(id).call(name,args),{id:a.id,name,args});
 const available=await call('model_available',{});assert.match(available.content[0].text,/supportsImages/);assert.match(available.content[0].text,/ultra/);
 const help=await call('model_consult',{provider:'codex',difficulty:'complex',rationale:'Visual geometry requires careful critique.',task:'Inspect the icon pixels.',image_ids:[image.id],image_paths:['concept (review).png']});assert.equal(help.isError,undefined);assert.equal(JSON.parse(help.content[0].text).imageCount,2);
 const explicit=await call('model_consult',{provider:'codex',model:'gpt-6-sol',effort:'high',difficulty:'simple',task:'Explicit configuration test.'});assert.equal(explicit.isError,undefined);
 const blocked=await call('model_consult',{provider:'codex',task:'Invalid outside image',image_paths:[path.join(output,'outside.png')]});assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/outside the chosen workspace/);
 const helpers=await app.evaluate(()=>globalThis.qaHelpers.helpers);assert.deepEqual(helpers.map(h=>[h.model,h.effort,h.imageCount]),[['gpt-6-astra','high',2],['gpt-6-sol','high',0]]);assert.ok(helpers.every(h=>h.noTools&&h.toolCount===0&&h.pixelsMatch));
 const helperCard=page.locator('.helper-contribution').first();await helperCard.locator('summary').click();await helperCard.getByText('Requested helper',{exact:true}).waitFor();await helperCard.getByText('Task difficulty',{exact:true}).waitFor();await helperCard.getByText('complex',{exact:true}).waitFor();await helperCard.getByText('Images shared',{exact:true}).waitFor();assert.equal(await helperCard.locator('dt').filter({hasText:/^Images shared$/}).locator('xpath=following-sibling::dd').textContent(),'2');report.checks.helperRoutingEffortPixelsAndUi=helpers;
 await app.evaluate((_e,id)=>globalThis.qaHelpers.parents.get(id).finish(),a.id);await page.waitForFunction(()=>!document.querySelector('[aria-label="Stop this reply"]'));
 const closeBrowser=page.getByRole('button',{name:'Close embedded browser',exact:true});if(await closeBrowser.isVisible())await closeBrowser.click({timeout:1000}).catch(()=>{});
 await page.setViewportSize({width:5120,height:1440});await page.waitForFunction(()=>innerWidth===5120&&document.documentElement.dataset.artworkFit==='panorama'&&parseFloat(document.documentElement.style.getPropertyValue('--artwork-width'))>=document.querySelector('.main-shell').getBoundingClientRect().width);
 const wide=await page.evaluate(()=>({viewport:[innerWidth,innerHeight],fit:document.documentElement.dataset.artworkFit,size:getComputedStyle(document.querySelector('.main-shell'),'::before').backgroundSize,repeat:getComputedStyle(document.querySelector('.main-shell'),'::before').backgroundRepeat,image:getComputedStyle(document.querySelector('.main-shell'),'::before').backgroundImage}));assert.match(wide.size,/^100% 100%, [\d.]+px [\d.]+px$/);assert.ok(wide.image.includes('erebus-eclipse'));
 await page.screenshot({path:path.join(output,'ultrawide-5120.png')});report.checks.ultrawide=wide;
 assert.deepEqual(await page.evaluate(()=>['left','right'].map(edge=>!!document.documentElement.style.getPropertyValue('--theme-art-'+edge))),[false,false]);assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.main-shell'),'::before').maskImage),'none');report.checks.fileArtworkWithoutSideBands=true;
 for(const theme of ['neo-babylon','nocturne','dusk']){
  await page.evaluate(theme=>window.studio.invoke('settings.save',{appearance:{theme,motion:'reduced'}}),theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
  assert.match(await page.evaluate(()=>getComputedStyle(document.querySelector('.main-shell'),'::before').backgroundSize),/^cover(?:, cover)*$/);if(theme==='nocturne')assert.match(await page.evaluate(()=>getComputedStyle(document.querySelector('.main-shell'),'::before').filter),/blur\(8px\)/);
 }
 report.checks.ultrawideMaterialAndCalmThemes=true;
 await page.evaluate(()=>window.studio.invoke('settings.save',{appearance:{theme:'erebus-flame',motion:'reduced'}}));await page.waitForFunction(()=>document.documentElement.dataset.theme==='erebus-flame');
 await page.setViewportSize({width:1360,height:900});await page.waitForFunction(()=>innerWidth===1360&&document.documentElement.dataset.artworkFit==='panorama');assert.match(await page.evaluate(()=>getComputedStyle(document.querySelector('.main-shell'),'::before').backgroundSize),/^100% 100%, [\d.]+px [\d.]+px$/);await page.screenshot({path:path.join(output,'normal-1360.png')});report.checks.normalPanoramaWithoutSideBands=true;
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await app?.close().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));}
