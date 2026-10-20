// Production host and renderer with real per-tab WebContentsViews; synthetic profile, pages and provider only.
import { _electron as electron } from 'playwright';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root=process.cwd(),fixture=await createProtectedQaProfile('browser-tabs'),{output,profile}=fixture;
const workspace=path.join(output,'workspace');await mkdir(workspace,{recursive:true});
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<title>Tab ${req.url.slice(1)}</title><main><h1>Page ${req.url}</h1><a id="next" href="/linked">Linked page</a></main>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const store=new Store(profile,{workspace});await store.init();Object.assign(store.state.settings,{autoUpdate:false,autoTitle:false,closeToTray:false,browserEnabled:true,permissionMode:'full',appearance:{theme:'erebus-flame',motion:'reduced'}});
const a=store.create('codex'),b=store.create('codex');a.title='Tabs chat';b.title='Other chat';
a.messages=Array.from({length:40},(_,i)=>({role:i%2?'assistant':'user',provider:'codex',content:`Message ${i+1}: `+'Synthetic paragraph text that wraps. '.repeat(i%2?30:3)}));b.messages=[{role:'assistant',provider:'codex',content:'Other chat.'}];await store.save();
const launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog}=require('electron');const{pathToFileURL}=require('node:url');
BrowserWindow.prototype.show=function(){};dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};globalThis.qa={parents:new Map()};
(async()=>{const{ProviderManager}=await import(${JSON.stringify(pathToFileURL(path.join(root,'desktop/providers.mjs')).href)});
 const models={codex:[{id:'gpt-6-sol',efforts:[{id:'medium'}]}]};
 ProviderManager.prototype.status=async()=>[{id:'codex',installed:true,connected:true,detail:'Synthetic QA connection'}];
 ProviderManager.prototype.subscriptionModels=async()=>models;ProviderManager.prototype.modelsFor=async id=>models[id]||[];
 ProviderManager.prototype.codexUsage=async()=>({rateLimits:{primary:{usedPercent:10,windowDurationMins:300}}});
 ProviderManager.prototype.run=async function(request){return new Promise(resolve=>globalThis.qa.parents.set(request.conversationId,{call:(name,args)=>this.callTool(name,args,request.conversationId),finish:()=>resolve({text:'Synthetic parent completed.'})}));};
 await import(${JSON.stringify(pathToFileURL(path.join(root,'desktop/main.mjs')).href)});
})().catch(error=>{console.error(error);app.exit(1)});`);
const report={scope:'Production host+renderer, real per-tab Electron views, synthetic profile/pages/provider; no personal data or model calls.',checks:{},errors:[]};let app;
const views=()=>app.evaluate(({webContents})=>webContents.getAllWebContents().map(w=>w.getURL()).filter(u=>u.startsWith('http://127.0.0.1')).sort());
try{
 const env={...process.env,EXOMINA_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 const openChat=async id=>{await page.locator(`[data-chat-id="${id}"] .chat-open`).click();await page.waitForTimeout(150);};
 const address=()=>page.getByLabel('Browser address').inputValue();
 const go=async url=>{await page.getByLabel('Browser address').fill(url);await page.getByRole('button',{name:'Search or navigate'}).click();await page.waitForFunction(u=>document.querySelector('[aria-label="Browser address"]').value===u,url);};
 await openChat(a.id);await page.getByRole('button',{name:'Browser',exact:true}).click();await go(base+'/one');
 await page.getByRole('tab',{name:'Tab one'}).waitFor();
 await page.getByRole('button',{name:'New tab',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.browser-tab').length===2);
 assert.equal(await address(),'');await go(base+'/two');await page.getByRole('tab',{name:'Tab two'}).waitFor();
 assert.deepEqual(await views(),[base+'/one',base+'/two']);report.checks.twoLiveTabs=await page.locator('.browser-tab').allInnerTexts();
 await page.getByRole('tab',{name:'Tab one'}).click();await page.waitForFunction(u=>document.querySelector('[aria-label="Browser address"]').value===u,base+'/one');
 assert.equal(await page.getByRole('tab',{name:'Tab one'}).getAttribute('aria-selected'),'true');report.checks.switchTab=true;
 const attached=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return w.contentView.children.map(v=>v.webContents?.getURL?.()).filter(Boolean);});
 assert.deepEqual(attached.filter(u=>u.startsWith('http')),[base+'/one']);report.checks.onlyActiveTabAttached=attached;
 await openChat(b.id);await openChat(a.id);await page.getByRole('tab',{name:'Tab two'}).waitFor();assert.equal(await address(),base+'/one');report.checks.tabsSurviveChatSwitch=true;
 // Agent tab tools through the real host tool dispatcher.
 await page.evaluate(id=>window.studio.invoke('chat.send',{conversationId:id,provider:'codex',text:'Synthetic tab tool test'}),a.id);
 await app.evaluate(async(_e,id)=>{while(!globalThis.qa.parents.has(id))await new Promise(r=>setTimeout(r,10));
  const lean=globalThis.qa.parents.get(id);await lean.call('request_tools',{reason:'Synthetic browser tab test'}).catch(()=>{});lean.finish();
  const deadline=Date.now()+15000;while(globalThis.qa.parents.get(id)===lean&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));},a.id);
 const call=async(name,args)=>{const result=await app.evaluate(async(_e,{id,name,args})=>globalThis.qa.parents.get(id).call(name,args),{id:a.id,name,args});if(result.isError)throw Error(result.content[0].text);return JSON.parse(result.content[0].text);};
 let list=await call('browser_tabs',{});assert.equal(list.tabs.length,2);
 const made=await call('browser_tab_new',{url:base+'/three'});assert.equal(made.tabs.length,3);assert.equal(made.activeTabId,made.tabId);
 await page.getByRole('tab',{name:'Tab three'}).waitFor();assert.equal(await page.getByRole('tab',{name:'Tab three'}).getAttribute('aria-selected'),'true');
 const snap=await app.evaluate(async(_e,id)=>globalThis.qa.parents.get(id).call('browser_snapshot',{include_screenshot:false}),a.id);assert.match(snap.content[0].text,/Page \/three/);
 list=await call('browser_tab_select',{tab_id:list.tabs[1].id});await page.waitForFunction(u=>document.querySelector('[aria-label="Browser address"]').value===u,base+'/two');
 list=await call('browser_tab_close',{tab_id:made.tabId});assert.equal(list.tabs.length,2);await page.waitForFunction(()=>document.querySelectorAll('.browser-tab').length===2);
 assert.deepEqual(await views(),[base+'/one',base+'/two']);report.checks.agentTabTools=true;
 await app.evaluate((_e,id)=>globalThis.qa.parents.get(id).finish(),a.id);await page.waitForFunction(()=>!document.querySelector('[aria-label="Stop this reply"]'));
 // The user closes a tab with its close button.
 await page.getByRole('button',{name:'Close tab Tab two'}).click();await page.waitForFunction(()=>document.querySelectorAll('.browser-tab').length===1);assert.deepEqual(await views(),[base+'/one']);report.checks.userCloseTab=true;
 await page.getByRole('button',{name:'New tab',exact:true}).click();await go(base+'/four');
 await page.waitForTimeout(400);
 const savedStore=new Store(profile,{workspace});await savedStore.init();const saved=savedStore.state.conversations.find(c=>c.id===a.id).browser;
 assert.deepEqual(saved.tabs.map(t=>t.url),[base+'/one',base+'/four']);assert.equal(saved.activeTab,1);report.checks.savedTabs=saved;
 await page.screenshot({path:path.join(output,'tabs.png')});
 // Scroll recorder: a normal open records nothing; a forced jump without upward input is recorded.
 await page.getByRole('button',{name:'Close embedded browser',exact:true}).click();
 const incidents=async()=>{try{return JSON.parse(await readFile(path.join(profile,'runtime-tmp','chat-scroll-incidents.json'),'utf8'));}catch{return [];}};
 await openChat(b.id);await openChat(a.id);await page.waitForTimeout(8600);assert.equal((await incidents()).length,0);report.checks.normalOpenSilent=true;
 await openChat(b.id);await openChat(a.id);
 await page.locator('.chat-scroll').evaluate(el=>{el.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true}));el.scrollTop-=3000;});
 await page.waitForTimeout(8600);const recorded=await incidents();assert.equal(recorded.length,1);
 const kinds=recorded[0].entries.map(e=>e.kind);assert.ok(kinds.includes('open')&&kinds.includes('unpinned-by-scroll')&&kinds.at(-1)==='end',JSON.stringify(kinds));assert.equal(recorded[0].conversationId,a.id);
 assert.ok(!JSON.stringify(recorded).includes('Synthetic paragraph'));report.checks.forcedJumpRecorded={entries:recorded[0].entries.length,kinds:[...new Set(kinds)]};
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await app?.close().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));}
