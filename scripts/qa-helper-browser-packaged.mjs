// Exact packaged app, localhost pages and fresh synthetic chats; no model requests or personal profile.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {extractFile} from '@electron/asar';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { MemoryStore } from '../desktop/memory.mjs';

const root=process.cwd(),executable=path.join(root,'release/win-unpacked/Exomina.exe'),runtime=path.join(path.dirname(executable),'resources/app.asar.unpacked');
const fixture=await createProtectedQaProfile('helper-browser-package'),{output,profile}=fixture,workspace=path.join(output,'workspace');await mkdir(workspace,{recursive:true});
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<title>Packaged chat ${req.url}</title><main><h1>Packaged chat ${req.url}</h1><input id="draft"><p>Local synthetic page.</p></main>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const store=new Store(profile,{workspace});await store.init();Object.assign(store.state.settings,{autoUpdate:false,autoTitle:false,closeToTray:false,browserEnabled:true,permissionMode:'full',appearance:{theme:'erebus-flame',motion:'reduced'}});
const a=store.create('codex'),b=store.create('codex');a.title='Packaged Exomina Setup';b.title='Packaged second chat';a.browser={url:base+'/a'};b.browser={url:base+'/b'};
const fixtureMemory=new MemoryStore(profile);await fixtureMemory.init();
for(let n=1;n<=25;n++)await fixtureMemory.note(`Packaged synthetic note ${String(n).padStart(2,'0')}: retain the existing text and shared context.`,{createdAt:'2026-10-07T10:00:00.000Z'});
const originalNotes=await fixtureMemory.list();fixtureMemory.close();
a.messages=Array.from({length:86},(_,i)=>({role:'assistant',provider:'codex',content:`Synthetic message ${i}: ${i===17?'Packaged Exomina Setup historical answer. ':''}`+'Long packaged chat text. '.repeat(35)}));
a.messages.push({role:'assistant',provider:'codex',content:`[Local file](<${workspace.replaceAll('\\','/')}/local image.png>)\n\n[Web link](${base}/link)\n\nPACKAGED LAST MESSAGE`,helpers:[{id:'synthetic-helper',provider:'codex',model:'gpt-6-astra',effort:'high',effortSource:'explicit',difficulty:'complex',rationale:'Synthetic visual review',images:[{path:'local image.png'}],task:'Synthetic contribution display',text:'Synthetic contribution; no model was called.',status:'complete'}]});b.messages=[{role:'assistant',provider:'codex',content:'Second packaged chat.'}];await store.save();
const stamp=JSON.parse(await readFile(path.join(path.dirname(executable),'exomina.build.json'),'utf8'));
const report={build:stamp,scope:'Exact packaged host/renderer; isolated synthetic profile and localhost pages. No live helper inference, personal account stores or native file launches.',checks:{}};
let child,connection,sessionId;
async function until(read,accept,timeout=15000){const deadline=Date.now()+timeout;let last;do{last=await read();if(accept(last))return last;await new Promise(resolve=>setTimeout(resolve,75));}while(Date.now()<deadline);throw Error('Packaged QA timed out: '+JSON.stringify(last));}
async function connect(endpoint){const socket=new WebSocket(endpoint),pending=new Map();let next=0;await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.addEventListener('message',event=>{const value=JSON.parse(String(event.data)),request=pending.get(value.id);if(request){pending.delete(value.id);clearTimeout(request.timer);value.error?request.reject(Error(value.error.message)):request.resolve(value.result);}});return {request(method,params={},targetSession){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(targetSession?{sessionId:targetSession}:{})}));});},close(){for(const r of pending.values()){clearTimeout(r.timer);r.reject(Error('QA connection closed'));}pending.clear();socket.close();}};}
async function evaluate(fn,arg,target=sessionId){const result=await connection.request('Runtime.evaluate',{expression:`(${fn.toString()})(${JSON.stringify(arg)??''})`,awaitPromise:true,returnByValue:true},target);if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;}
async function launch(){
 const env={...process.env,EXOMINA_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;child=spawn(executable,['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'],{env,cwd:path.dirname(executable),windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.resume();
 const endpoint=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Packaged app did not start its isolated QA endpoint')),30000);child.stderr.on('data',chunk=>{text=(text+chunk).slice(-16000);const match=/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(text);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('close',code=>{clearTimeout(timer);reject(Error('Packaged app exited: '+code));});});
 connection=await connect(endpoint);const target=await until(async()=> (await connection.request('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url.endsWith('/dist/index.html')),Boolean,30000);({sessionId}=await connection.request('Target.attachToTarget',{targetId:target.targetId,flatten:true}));await connection.request('Runtime.enable',{},sessionId);await until(()=>evaluate(()=>!!document.querySelector('[aria-label="Exomina home"]')),Boolean,30000);
}
async function close(){if(connection){await evaluate(()=>{window.studio.invoke('settings.save',{closeToTray:false}).then(()=>window.close())}).catch(()=>{});connection.close();connection=null;}if(child&&child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);if(child.exitCode===null)child.kill();}child=null;}
const chooseChat=async id=>{await until(()=>evaluate(id=>!!document.querySelector(`[data-chat-id="${id}"] .chat-open`),id),Boolean);await evaluate(id=>document.querySelector(`[data-chat-id="${id}"] .chat-open`).click(),id);await until(()=>evaluate(()=>document.querySelector('[data-chat-id].selected')?.dataset.chatId),value=>value===id);};
const browserReady=async(id,url)=>until(()=>evaluate(id=>window.studio.invoke('browser.state',{conversationId:id}),id),state=>state.url===url&&state.pageReady);
try{
 report.checks.packagedSourceMatches=[];for(const file of ['desktop/main.mjs','desktop/windows-taskbar.mjs','desktop/note-store.mjs','desktop/memory.mjs','desktop/shared-context.mjs','desktop/context.mjs','desktop/model-assist.mjs','desktop/helper-selection.mjs','desktop/helper-images.mjs','desktop/providers.mjs','desktop/browser.mjs','desktop/browser-pages.mjs','desktop/chat-links.mjs','desktop/updates.mjs','desktop/public-updates.mjs','desktop/extract-update.ps1']){assert.ok((await readFile(path.join(runtime,file))).equals(await readFile(path.join(root,file))),file);report.checks.packagedSourceMatches.push(file);}
 await launch();const bootstrap=await evaluate(()=>window.studio.invoke('bootstrap'));const consult=bootstrap.tools.find(tool=>tool.name==='model_consult');assert.ok(consult.inputSchema.properties.image_ids&&consult.inputSchema.properties.image_paths&&consult.inputSchema.properties.effort&&consult.inputSchema.properties.difficulty);report.checks.newHelperSchema=true;
 await evaluate(()=>document.querySelector('.nav-list [aria-label="Memory"]').click());
 const readNoteRows=()=>evaluate(()=>[...document.querySelectorAll('.memory-note-row')].map(row=>({id:row.dataset.memoryId,isNew:row.classList.contains('is-new')})));
 await until(readNoteRows,rows=>rows.length===12);
 await evaluate(()=>document.querySelector('.memory-note-toggle').click());
 assert.equal(await until(()=>evaluate(()=>document.querySelector('.memory-note-details>p')?.textContent),Boolean),originalNotes[0].text);
 await evaluate(()=>document.querySelector('.memory-note-toggle').click());
 const seenNotes=[...(await readNoteRows()).map(row=>row.id)];
 for(let n=0;n<2;n++){
  const firstId=(await readNoteRows())[0].id;
  await evaluate(()=>document.querySelector('[aria-label="Next page of memories"]').click());
  const rows=await until(readNoteRows,rows=>rows[0]?.id!==firstId);seenNotes.push(...rows.map(row=>row.id));
 }
 assert.deepEqual(seenNotes,originalNotes.map(note=>note.id));
 const afterReading=await evaluate(()=>window.studio.invoke('bootstrap'));assert.deepEqual(afterReading.memories,originalNotes);assert.equal(afterReading.memoryReview.unreviewedCount,25);
 const setMemoryQuery=async query=>{await evaluate(query=>{const input=document.querySelector('[aria-label="Search memories"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,query);input.dispatchEvent(new Event('input',{bubbles:true}));},query);};
 await setMemoryQuery('Packaged synthetic note 09');await evaluate(()=>document.querySelector('.memory-page .search-field').requestSubmit());
 const resultRow=await until(readNoteRows,rows=>rows.length===1&&rows[0].id===originalNotes.find(note=>note.text.includes('note 09:')).id);
 assert.equal(await evaluate(()=>!!document.querySelector('.memory-pagination')),false);
 await setMemoryQuery('');await until(readNoteRows,rows=>rows.length===12);
 await evaluate(()=>document.querySelector('.memory-review-all').click());await until(readNoteRows,rows=>rows.every(row=>!row.isNew));
 const afterReview=await evaluate(()=>window.studio.invoke('bootstrap'));assert.equal(afterReview.memoryReview.unreviewedCount,13);assert.deepEqual(afterReview.memories.filter(note=>note.reviewed).map(note=>note.id),originalNotes.slice(0,12).map(note=>note.id));assert.deepEqual(afterReview.memories.map(note=>note.text),originalNotes.map(note=>note.text));
 await evaluate(()=>[...document.querySelectorAll('.memory-filters button')].find(button=>button.textContent.startsWith('New')).click());await until(readNoteRows,rows=>rows.length===12&&rows.every(row=>row.isNew));
 await evaluate(()=>document.querySelector('[aria-label="Next page of memories"]').click());const lastRow=await until(readNoteRows,rows=>rows.length===1);
 await evaluate(()=>document.querySelector('.memory-delete').click());await until(()=>evaluate(()=>!!document.querySelector('[role="alertdialog"]')),Boolean);
 await evaluate(()=>[...document.querySelectorAll('[role="alertdialog"] button')].find(button=>button.textContent==='Cancel').click());assert.equal((await evaluate(()=>window.studio.invoke('bootstrap'))).memories.length,25);
 await evaluate(()=>document.querySelector('.memory-delete').click());await until(()=>evaluate(()=>!!document.querySelector('[role="alertdialog"]')),Boolean);
 await evaluate(()=>document.querySelector('[role="alertdialog"] .danger-button').click());await until(readNoteRows,rows=>rows.length===12);
 const afterDelete=await evaluate(()=>window.studio.invoke('bootstrap'));assert.equal(afterDelete.memories.length,24);assert.equal(afterDelete.memories.some(note=>note.id===lastRow[0].id),false);assert.deepEqual(afterDelete.memories.map(note=>note.text),originalNotes.filter(note=>note.id!==lastRow[0].id).map(note=>note.text));
 assert.equal(await evaluate(()=>!!document.querySelector('.memory-pagination')),false);
 report.checks.memoryNotes={originals:25,visibleAtMost:12,completeOrderedCoverage:true,noImplicitWrites:true,exactExpandedText:true,hiddenPageSearch:resultRow[0].id,visibleReviewOnly:12,newFilter:true,cancelPreserves:true,lastPageDeletionClamps:true,remainingOriginalTextPreserved:true};
 await evaluate(()=>[...document.querySelectorAll('.memory-filters button')].find(button=>button.textContent==='All notes').click());await until(readNoteRows,rows=>rows.length===12);
 await evaluate(()=>document.querySelector('.memory-notes').scrollIntoView({block:'start'}));
 const memoryShot=await connection.request('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},sessionId);await writeFile(path.join(output,'packaged-memory-notes.png'),Buffer.from(memoryShot.data,'base64'));
 await chooseChat(a.id);const gap=await until(()=>evaluate(()=>{const el=document.querySelector('.chat-scroll');return el?.scrollHeight-el?.scrollTop-el?.clientHeight;}),gap=>gap<3);report.checks.latestMessageGap=gap;
 report.checks.reopenSections=[];
 for(const section of ['Memory','Connections','Projects & prompts']){
  await evaluate(section=>[...document.querySelectorAll('.nav-list button')].find(button=>button.getAttribute('aria-label')===section).click(),section);await chooseChat(a.id);
  const gap=await until(()=>evaluate(()=>{const el=document.querySelector('.chat-scroll');return el?.scrollHeight-el?.scrollTop-el?.clientHeight;}),gap=>gap<3);report.checks.reopenSections.push({section,gap});
 }
 await evaluate(()=>{const input=document.querySelector('[aria-label="Search chats"]'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'Packaged Exomina Setup');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await until(()=>evaluate(()=>!!document.querySelector('.chat-search-results [data-chat-id]')),Boolean);await chooseChat(a.id);
 report.checks.titleSearchOpensLatest=await until(()=>evaluate(()=>{const el=document.querySelector('.chat-scroll');return !document.querySelector('.chat-find-bar')&&el&&el.scrollHeight-el.scrollTop-el.clientHeight<3;}),Boolean);
 await evaluate(()=>document.querySelector('[aria-label="Clear chat search"]').click());
 await evaluate(()=>{const el=document.createElement('div');el.style.height='40px';document.querySelector('.message:last-child').append(el);setTimeout(()=>{el.style.height='800px';},250);});
 await until(()=>evaluate(()=>{const el=document.querySelector('.chat-scroll'),last=document.querySelector('.message:last-child>div:last-child');return last?.getBoundingClientRect().height>=800&&el.scrollHeight-el.scrollTop-el.clientHeight<3;}),Boolean);report.checks.delayedLayoutFollowsBottom=true;
 const emptyShortcuts=path.join(output,'no-user-shortcuts.json');await writeFile(emptyShortcuts,'[]');
 const {stdout}=await promisify(execFile)('powershell',['-NoProfile','-File',path.join(root,'scripts/qa-taskbar-icons.ps1'),'-Output',path.join(output,'taskbar-icons'),'-ExePath',executable,'-WindowProcessId',String(child.pid),'-ShortcutList',emptyShortcuts],{windowsHide:true,maxBuffer:1024*1024});
 const nativeIcons=JSON.parse(stdout),nativeWindow=nativeIcons.find(item=>item.kind==='window'),manifest=JSON.parse(extractFile(path.join(path.dirname(executable),'resources/app.asar'),'build/taskbar-icon.json').toString());
 assert.equal(nativeWindow.properties.appId,'local.exomina.desktop');assert.equal(nativeWindow.properties.relaunchIcon,path.join(runtime,'build/shell-icons',manifest.file)+',0');assert.equal(nativeWindow.palette.mint,0);assert.ok(nativeWindow.palette.purple>100);report.checks.packagedTaskbarIdentityAndPurpleIcon=nativeIcons;
 const links=await evaluate(()=>[...document.querySelectorAll('.message a')].map(link=>({label:link.textContent,href:link.getAttribute('href')})));assert.ok(links.some(link=>link.label==='Local file'&&link.href.includes('local image.png')));assert.ok(links.some(link=>link.label==='Web link'&&link.href===base+'/link'));report.checks.localAndWebAnchors=true;
 await evaluate(()=>document.querySelector('.browser-toggle').click());await browserReady(a.id,base+'/a');await chooseChat(b.id);await evaluate(()=>document.querySelector('.browser-toggle').click());await browserReady(b.id,base+'/b');await chooseChat(a.id);await browserReady(a.id,base+'/a');report.checks.separateBrowserPages=true;
 await evaluate(()=>[...document.querySelectorAll('.message a')].find(link=>link.textContent==='Web link').click());await browserReady(a.id,base+'/link');assert.equal((await evaluate(id=>window.studio.invoke('browser.state',{conversationId:id}),b.id)).url,base+'/b');report.checks.webLinkTargetsOwnChat=true;
 await evaluate(()=>document.querySelector('[aria-label="Go back"]').click());await browserReady(a.id,base+'/a');report.checks.independentNavigationHistory=true;
 await evaluate(()=>document.querySelector('[aria-label="Close embedded browser"]').click());report.checks.screenLayouts=[];
 for(const physicalWidth of [3440,5120]){
  const width=Math.round(physicalWidth/1.75),height=Math.round(1440/1.75);
  await connection.request('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1.75,mobile:false},sessionId);
  await until(()=>evaluate(({width,height})=>{const r=document.querySelector('.main-shell').getBoundingClientRect(),w=parseFloat(document.documentElement.style.getPropertyValue('--artwork-width'));return innerWidth===width&&innerHeight===height&&Math.abs(document.querySelector('.app-frame').getBoundingClientRect().bottom-height)<1&&Math.abs(w-Math.max(r.width,r.height*32/9))<.01&&document.documentElement.dataset.artworkFit==='panorama';},{width,height}),Boolean);
  const layout=await evaluate(()=>{const root=document.documentElement,frame=document.querySelector('.main-shell').getBoundingClientRect(),height=parseFloat(root.style.getPropertyValue('--artwork-height')),width=parseFloat(root.style.getPropertyValue('--artwork-width')),positions=root.style.getPropertyValue('--artwork-position').match(/[\d.]+/g).map(Number),cropY=(height-frame.height)*positions[1]/100;return{size:getComputedStyle(document.querySelector('.main-shell'),'::before').backgroundSize,image:getComputedStyle(document.querySelector('.main-shell'),'::before').backgroundImage,mask:getComputedStyle(document.querySelector('.main-shell'),'::before').maskImage,height,width,frame:frame.toJSON(),header:document.querySelector('.topbar').getBoundingClientRect().height,sunTop:.148*height-cropY,edges:['left','right'].map(edge=>!!root.style.getPropertyValue('--theme-art-'+edge)),viewport:[innerWidth,innerHeight],scale:devicePixelRatio};});
  assert.match(layout.size,/^100% 100%, [\d.]+px [\d.]+px$/);assert.equal(layout.mask,'none');assert.deepEqual(layout.edges,[false,false]);assert.ok(layout.height>=layout.frame.height&&layout.width>=layout.frame.width);assert.ok(layout.sunTop>layout.header+5);assert.ok(layout.image.includes('erebus-eclipse-panorama-v2.png'));report.checks.screenLayouts.push(layout);
  const shot=await connection.request('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},sessionId);await writeFile(path.join(output,`packaged-${physicalWidth}-175-percent.png`),Buffer.from(shot.data,'base64'));
 }
 assert.ok(Math.abs(report.checks.screenLayouts[0].height-report.checks.screenLayouts[1].height)<.01);
 const asar=path.join(path.dirname(executable),'resources/app.asar');
 assert.ok(extractFile(asar,path.join('build','icon.png')).equals(await readFile(path.join(root,'build/icon.png'))));assert.ok(extractFile(asar,path.join('dist','theme-art','erebus-eclipse-panorama-v2.png')).equals(await readFile(path.join(root,'public/theme-art/erebus-eclipse-panorama-v2.png'))));report.checks.packagedPurpleIconAndPanorama=true;
 await evaluate(()=>document.querySelector('[aria-label="Exomina updates"]').click());
 await until(()=>evaluate(()=>!!document.querySelector('#settings-updates .update-actions')),Boolean);
 const controls=await evaluate(()=>({section:!!document.getElementById('settings-updates'),buttons:[...document.querySelectorAll('#settings-updates button')].map(button=>({label:button.textContent,disabled:button.disabled})),text:document.getElementById('settings-updates').textContent}));assert.ok(controls.buttons.some(button=>button.label==='Check for updates'));assert.ok(controls.buttons.some(button=>button.label==='Apply update'&&button.disabled));assert.ok(controls.text.includes('Download updates automatically'));report.checks.updateButtonAndControls=true;
 await close();await launch();await chooseChat(a.id);await evaluate(()=>document.querySelector('.browser-toggle').click());await browserReady(a.id,base+'/a');await chooseChat(b.id);await evaluate(()=>document.querySelector('.browser-toggle').click());await browserReady(b.id,base+'/b');report.checks.savedPagesRestoreAfterRestart=true;
 await close();report.checks.profileProtection=await fixture.verify();report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));}
