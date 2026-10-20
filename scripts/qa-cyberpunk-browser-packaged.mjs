// Exact packaged theme selection and persistence, using only a fresh synthetic profile.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { extractFile } from '@electron/asar';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { THEMES } from '../desktop/themes.mjs';

const root = process.cwd(), build = path.join(root, 'release/win-unpacked');
const executable = path.join(build, 'Exomina.exe');
const fixture = await createProtectedQaProfile('cyberpunk-browser-package');
const { output, profile } = fixture, workspace = path.join(output, 'workspace');
await mkdir(workspace);
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Hidden browser QA</title><h1>Local synthetic page '+req.url+'</h1>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const store = new Store(profile, { workspace }); await store.init();
Object.assign(store.state.settings, { autoUpdate: false, autoTitle: false, closeToTray: false, memoryEnabled: false, browserEnabled:true, permissionMode:'full', appearance: { theme: 'erebus-flame', motion: 'reduced' } });
const chat = store.create('codex'); chat.title = 'Cyberpunk theme trial';chat.browser={url:base+'/initial'};
chat.messages = [
  { role: 'user', content: 'Night City, Judy and Johnny are the three selected themes.' },
  { role: 'assistant', provider: 'codex', content: `The selected Cyberpunk images frame the conversation.

This is synthetic text for checking readable surfaces and character positions.

[Open local page](${base}/hidden-link)` },
];
await store.save();
const ids = ['cyberpunk-night-city', 'cyberpunk-judy', 'cyberpunk-johnny'];
const themes = ids.map(id => THEMES.find(theme => theme.id === id));
assert.ok(themes.every(Boolean));
const report = { build: JSON.parse(await readFile(path.join(build, 'exomina.build.json'), 'utf8')), scope: 'Exact packaged app, new encrypted synthetic profile, actual theme picker and settings persistence. No personal account/profile access, model turns, or live installation.', themes: [], checks:{}, errors: [] };
let child, connection, sessionId;
async function until(read, accept, timeout = 15000) {
  const deadline = Date.now() + timeout; let last;
  do { last = await read(); if (accept(last)) return last; await new Promise(resolve => setTimeout(resolve, 75)); } while (Date.now() < deadline);
  throw Error('Theme QA timed out: ' + JSON.stringify(last));
}
async function connect(endpoint) {
  const socket = new WebSocket(endpoint), pending = new Map(); let next = 0;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const value = JSON.parse(String(event.data)), request = pending.get(value.id);
    if (request) { pending.delete(value.id); clearTimeout(request.timer); value.error ? request.reject(Error(value.error.message)) : request.resolve(value.result); }
  });
  return {
    request(method, params = {}, targetSession) { return new Promise((resolve, reject) => { const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) })); }); },
    close() { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('QA connection closed')); } pending.clear(); socket.close(); },
  };
}
async function evaluate(fn, arg) {
  const result = await connection.request('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function launch() {
  const env = { ...process.env, EXOMINA_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, cwd: build, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.resume();
  const endpoint = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(Error('Packaged QA app did not start')), 30000);
    child.stderr.on('data', chunk => { text = (text + chunk).slice(-16000); const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(text); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); reject(Error('Packaged QA app exited: ' + code)); });
  });
  connection = await connect(endpoint);
  const target = await until(async () => (await connection.request('Target.getTargets')).targetInfos.find(target => target.type === 'page' && target.url.endsWith('/dist/index.html')), Boolean, 30000);
  ({ sessionId } = await connection.request('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
  await connection.request('Runtime.enable', {}, sessionId);
  await until(() => evaluate(() => !!document.querySelector('[aria-label="Exomina home"]')), Boolean, 30000);
}
async function close() {
  if (connection) { await evaluate(() => { window.studio.invoke('settings.save', { closeToTray: false }).then(() => window.close()); }).catch(() => {}); connection.close(); connection = null; }
  if (child && child.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]); if (child.exitCode === null) child.kill(); }
  child = null;
}
async function appearance() {
  await evaluate(() => [...document.querySelectorAll('.sidebar-bottom button')].find(button => button.textContent.startsWith('Settings')).click());
  await until(() => evaluate(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Appearance')), Boolean);
  await evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Appearance').click());
  await until(() => evaluate(() => !!document.querySelector('#settings-appearance [role="radio"]')), Boolean);
}
async function chooseChat() {
  await evaluate(id => document.querySelector(`[data-chat-id="${id}"] .chat-open`).click(), chat.id);
  await until(() => evaluate(() => !!document.querySelector('.message.assistant') && !!document.querySelector('.composer')), Boolean);
}

async function setSize(width,height,scale){
  await connection.request('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:scale,mobile:false},sessionId);
  await until(()=>evaluate(({width,height})=>innerWidth===width&&innerHeight===height&&Math.abs(document.querySelector('.app-frame').getBoundingClientRect().bottom-height)<1&&Number.parseFloat(document.documentElement.style.getPropertyValue('--artwork-width'))>0,{width,height}),Boolean);
}
async function shot(name){const result=await connection.request('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);await writeFile(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));}
async function browserReady(url){await until(()=>evaluate(id=>window.studio.invoke('browser.state',{conversationId:id}),chat.id),state=>state.pageReady&&state.url===url);}
async function hidden(){await until(()=>evaluate(()=>!document.querySelector('.browser-panel')&&document.querySelector('.browser-toggle')?.getAttribute('aria-pressed')==='false'),Boolean);}
async function layout(){return evaluate(()=>{
  const root=document.documentElement,canvas=document.querySelector('.main-shell'),bounds=canvas.getBoundingClientRect(),composer=document.querySelector('.composer').getBoundingClientRect(),backdrop=getComputedStyle(canvas,'::before');
  const surfaces=[...canvas.querySelectorAll('.assistant,.user-bubble,.composer')],readingRight=Math.max(...surfaces.map(element=>element.getBoundingClientRect().right-bounds.left));
  const number=name=>parseFloat(root.style.getPropertyValue(name));
  return {viewport:[innerWidth,innerHeight],fit:root.dataset.artworkFit,frame:[bounds.width,bounds.height],readingRight,artWidth:number('--artwork-width'),artHeight:number('--artwork-height'),left:number('--cp-left'),image:backdrop.backgroundImage,size:backdrop.backgroundSize,filter:backdrop.filter,repeat:backdrop.backgroundRepeat,accent:root.style.getPropertyValue('--t-accent'),composer:{left:composer.left,right:composer.right,bottom:composer.bottom},overflow:root.scrollWidth>innerWidth+1};
});}
try{
  const asar=path.join(build,'resources/app.asar'),runtime=path.join(build,'resources/app.asar.unpacked');
  for(const file of ['desktop/themes.mjs','desktop/main.mjs','desktop/realtime-voice.mjs','desktop/browser.mjs'])assert.ok((await readFile(path.join(runtime,file))).equals(await readFile(path.join(root,file))),file);
  assert.ok(extractFile(asar,'dist/index.html').equals(await readFile(path.join(root,'dist/index.html'))));
  for(const theme of themes){const original=await readFile(path.resolve(root,'../Workspace/cyberpunk-options/assets',theme.id.replace('cyberpunk-','')+'.jpg'));assert.ok(extractFile(asar,path.join('dist',theme.artwork)).equals(original));}
  report.checks.packagedSourceAndOriginalArtworkMatch=true;
  assert.ok(!THEMES.some(theme=>['cyberpunk-v','cyberpunk-badlands','cyberpunk-panam'].includes(theme.id)));report.checks.onlySelectedCyberpunkThemes=true;
  await launch();
  for(const theme of themes){
    await setSize(1440,1000,1);await appearance();await evaluate(name=>[...document.querySelectorAll('#settings-appearance [role="radio"]')].find(button=>button.textContent.startsWith(name)).click(),theme.name);
    await until(()=>evaluate(()=>document.documentElement.dataset.theme),id=>id===theme.id);assert.equal((await evaluate(()=>window.studio.invoke('bootstrap'))).settings.appearance.theme,theme.id);
    const image=await evaluate(async artwork=>{const image=new Image();image.src=new URL(artwork,document.baseURI).href;await image.decode();return [image.naturalWidth,image.naturalHeight];},theme.artwork);assert.deepEqual(image,[3840,2160]);
    await chooseChat();const layouts=[];
    for(const [name,width,height,scale] of [['regular',1440,1000,1],['3440-175-percent',Math.round(3440/1.75),Math.round(1440/1.75),1.75],['5120-175-percent',Math.round(5120/1.75),Math.round(1440/1.75),1.75]]){
      await setSize(width,height,scale);await new Promise(resolve=>setTimeout(resolve,120));const current=await layout();assert.equal(current.fit,theme.artworkFrame.kind);assert.equal(current.overflow,false);assert.ok(current.image.includes(theme.artwork));assert.equal(current.accent,theme.colors.accent);assert.equal(current.filter,'none');assert.ok(current.repeat.split(',').every(value=>value.trim()==='no-repeat'));assert.ok(Math.abs(current.artWidth/current.artHeight-16/9)<.0001);assert.ok(current.composer.right<=width+1&&current.composer.bottom<=height+1);
      if(theme.artworkFrame.kind==='character'){const face=theme.artworkFrame.face,left=current.left+face[0]*current.artWidth,right=current.left+face[2]*current.artWidth;assert.ok(left>=current.readingRight+15.9,theme.id+' face stays beside reading surface');assert.ok(right<=current.frame[0]-15.9,theme.id+' face stays in canvas');current.face=[left,right];}
      await shot(theme.id+'-'+name);layouts.push({name,...current});
    }
    await evaluate(()=>document.querySelector('.browser-toggle').click());await browserReady(base+'/initial');await new Promise(resolve=>setTimeout(resolve,100));const split=await layout();assert.equal(split.overflow,false);assert.ok(Number.isFinite(split.artWidth)&&Math.abs(split.artWidth/split.artHeight-16/9)<.0001);await shot(theme.id+'-browser-split');layouts.push({name:'browser-split',...split});await evaluate(()=>document.querySelector('[aria-label="Close embedded browser"]').click());await hidden();
    await evaluate(()=>window.studio.invoke('settings.save',{appearance:{chatWidth:'full'}}));await new Promise(resolve=>setTimeout(resolve,120));const full=await layout();assert.equal(full.overflow,false);assert.ok(Number.isFinite(full.artWidth));await shot(theme.id+'-full-width');layouts.push({name:'full-width',...full});await evaluate(()=>window.studio.invoke('settings.save',{appearance:{chatWidth:'default'}}));
    await close();await launch();assert.equal((await evaluate(()=>window.studio.invoke('bootstrap'))).settings.appearance.theme,theme.id);await until(()=>evaluate(()=>document.documentElement.dataset.theme),id=>id===theme.id);
    report.themes.push({id:theme.id,packagedImage:image,layouts,persistedAfterRestart:true});
  }
  await chooseChat();await evaluate(()=>document.querySelector('.browser-toggle').click());await browserReady(base+'/initial');await evaluate(()=>document.querySelector('[aria-label="Close embedded browser"]').click());await hidden();
  await evaluate(()=>[...document.querySelectorAll('.message a')].find(link=>link.textContent==='Open local page').click());await browserReady(base+'/hidden-link');await hidden();report.checks.hiddenWebLinkNavigatesWithoutOpening=true;
  await evaluate(({id,url})=>window.studio.invoke('browser.navigate',{conversationId:id,url}),{id:chat.id,url:base+'/next-site'});await browserReady(base+'/next-site');await hidden();report.checks.hiddenNextSiteNavigatesWithoutOpening=true;
  await close();await launch();await chooseChat();assert.equal(await evaluate(()=>localStorage.getItem('exomina.browser.auto-reveal')),'false');await evaluate(()=>[...document.querySelectorAll('.message a')].find(link=>link.textContent==='Open local page').click());await browserReady(base+'/hidden-link');await hidden();report.checks.hiddenChoiceSurvivesFullRestart=true;
  await evaluate(()=>document.querySelector('.browser-toggle').click());await until(()=>evaluate(()=>!!document.querySelector('.browser-panel')),Boolean);await browserReady(base+'/hidden-link');report.checks.browserButtonReopensLatestPage=true;
  await evaluate(()=>document.querySelector('[aria-label="Close embedded browser"]').click());await hidden();await shot('hidden-browser');
  await appearance();await evaluate(()=>[...document.querySelectorAll('#settings-appearance [role="radio"]')].find(button=>button.textContent.startsWith('Erebus Underworld')).click());await until(()=>evaluate(()=>document.documentElement.dataset.theme),id=>id==='erebus-underworld');await chooseChat();await until(()=>evaluate(()=>document.documentElement.dataset.artworkFit),fit=>fit==='panorama');report.checks.erebusFramingRetained=true;
  await evaluate(()=>document.querySelector('[aria-label="Voice options"]').click());const menu=await evaluate(()=>({selector:!!document.querySelector('.voice-menu .realtime-voice-picker'),buttons:[...document.querySelectorAll('.voice-menu button')].map(button=>button.textContent),top:document.querySelector('.voice-menu').getBoundingClientRect().top}));assert.equal(menu.selector,true);assert.ok(menu.buttons.includes('Preview realtime voice'));assert.ok(menu.top>=0);report.checks.packagedChatPreviewControl=true;await evaluate(()=>document.querySelector('[aria-label="Voice options"]').click());
  await evaluate(()=>[...document.querySelectorAll('.sidebar-bottom button')].find(button=>button.textContent.startsWith('Settings')).click());await until(()=>evaluate(()=>!!document.querySelector('#settings-voice .realtime-voice-picker')),Boolean);report.checks.packagedSettingsPreviewControl=true;
  await close();report.profileProtection=await fixture.verify();report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,build:report.build,passed:report.passed,checks:report.checks,themes:report.themes.map(theme=>({id:theme.id,layouts:theme.layouts.length,persistedAfterRestart:theme.persistedAfterRestart})),error:report.error},null,2));}
