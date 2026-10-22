import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';
import { extractFile } from '@electron/asar';
import { createGateway } from '../desktop/gateway.mjs';
import { StdioMcpClient } from '../desktop/external-mcp.mjs';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { AssetStore } from '../desktop/assets.mjs';
import { Store } from '../desktop/store.mjs';
import { PROVIDER_CATALOG } from '../desktop/provider-catalog.mjs';
import { subscriptionEnvironment } from '../desktop/providers.mjs';
import { THEMES } from '../desktop/themes.mjs';
import { WindowsVault } from '../desktop/vault.mjs';

// Artwork includes intentionally short panoramic sources. Check exact shipped
// bytes and decoded dimensions instead of imposing an old 16:9 minimum height.
function sourceImageDimensions(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'Theme artwork must be PNG or JPEG.');
  let offset = 2;
  while (offset < bytes.length - 2) {
    assert.equal(bytes[offset++], 255, 'Malformed JPEG marker.');
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
    const length = bytes.readUInt16BE(offset);
    assert.ok(length >= 2 && offset + length <= bytes.length, 'Invalid JPEG segment.');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    offset += length;
  }
  throw Error('Theme JPEG has no frame dimensions.');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = path.resolve(process.env.EXOMINA_QA_EXE || path.join(root, 'release/win-unpacked/Exomina.exe'));
const runtimeRoot = path.join(path.dirname(executable), 'resources/app.asar.unpacked');
const fixture = await createProtectedQaProfile('packaged');
const {output,profile} = fixture;
// Exercise the earlier engine's real directory layout, not only empty profiles.
const legacyCache=path.join(profile,'memory','TREE','synthetic-nested','retained.txt');
await mkdir(path.dirname(legacyCache),{recursive:true});
await writeFile(legacyCache,'Synthetic legacy cache retained without importing.');
await writeFile(path.join(profile,'memory','LOG.txt'),'');
const syntheticPng='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lscAAAAASUVORK5CYII=';
const qaAssets=new AssetStore(profile);await qaAssets.init();const syntheticImage=await qaAssets.put(syntheticPng);
const syntheticVideo=process.env.EXOMINA_QA_VIDEO?await qaAssets.put(await readFile(process.env.EXOMINA_QA_VIDEO),{mimeType:'video/mp4'}):null;
qaAssets.close();
const qaStore=new Store(profile);await qaStore.init();const imageChat=qaStore.create('codex');imageChat.title='Synthetic image preview';imageChat.messages=[{role:'assistant',content:'Synthetic image, no model request.',provider:'codex',attachments:[{...syntheticImage,kind:'image'}],followups:[{id:'packaged-followup',text:'Synthetic question during work.',answer:'Synthetic answer preserved alongside the task.',provider:'codex',model:'synthetic',status:'answered',mode:'parallel'}]}];await qaStore.save();
if(syntheticVideo){imageChat.messages[0].attachments.push({...syntheticVideo,kind:'video'});await qaStore.save();}
const buildStamp = JSON.parse(await readFile(path.join(path.dirname(executable), 'exomina.build.json'), 'utf8'));
const report = { startedAt: new Date().toISOString(), executable, buildStamp, scope: 'Exact packaged Exomina, fresh isolated workspace profile, no account login/model calls/private data/native computer actions.', checks: {} };
const browserFixture = http.createServer((request,response) => {
  if (request.url === '/pending-resource') return;
  response.setHeader('Content-Type','text/html; charset=utf-8');
  response.setHeader('Content-Security-Policy',"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  response.end('<title>Packaged browser fixture</title><body style="background:#10211d;color:#eaf9ef;font:20px system-ui;padding:28px"><main><h1>Packaged browser ready while loading</h1><p>Synthetic text only.</p><img src="/pending-resource"></main></body>');
});
await new Promise(resolve=>browserFixture.listen(0,'127.0.0.1',resolve));
const browserFixtureUrl='http://127.0.0.1:'+browserFixture.address().port+'/fixture';
let app, page, child;
async function connectCdp(endpoint) {
  const socket = new WebSocket(endpoint);
  const pending = new Map(); let id = 0;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  });
  return {
    request(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        // The explicit Windows recovery audit can outlast an ordinary UI read.
        // Keep its helper's bounded wait instead of abandoning it at 10 seconds.
        const timeoutMs = method === 'Runtime.evaluate' && params.expression?.includes('security.auditRecovery') ? 60000 : 10000;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Raw CDP ${method} timed out.`)); }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() { socket.close(); for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP closed.')); } pending.clear(); },
  };
}
async function closeApp() {
  if (page && !page.isClosed()) await page.evaluate(async () => { await window.studio.invoke('settings.save',{closeToTray:false}); window.close(); }).catch(() => {});
  if (app) await Promise.resolve(app.close()).catch(() => {});
  app = null; page = null;
  if (child && child.exitCode === null) {
    await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) {
      const killer = spawn(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      await new Promise(resolve => { killer.once('close', resolve); killer.once('error', resolve); });
    }
  }
  child = null;
}
async function until(read, accepted, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accepted(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for the synthetic package QA condition.');
}
async function runNativeSmoke(id, args) {
  const dataDir = path.join(profile, 'qa-native-runtimes');
  await mkdir(path.join(dataDir, 'runtime-tmp'), { recursive: true });
  await mkdir(path.join(profile, 'workspace'), { recursive: true });
  const env = { ...subscriptionEnvironment(id, dataDir), ELECTRON_RUN_AS_NODE: '1' };
  return new Promise((resolve, reject) => {
    const runtime = spawn(executable, args, { cwd: path.join(profile, 'workspace'), env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { runtime.kill(); reject(new Error(`${id} packaged runtime smoke timed out.`)); }, 30000);
    runtime.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
    runtime.stderr.on('data', chunk => { error = (error + chunk).slice(-8000); });
    runtime.once('error', cause => { clearTimeout(timer); reject(cause); });
    runtime.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(`${id} packaged runtime exited ${code}: ${error.slice(-2000)}`)); });
  });
}
try {
  const paths = [
    'desktop/preload.cjs', 'desktop/mcp-stdio.mjs', 'desktop/read-export.py', 'desktop/windows-control.ps1',
    'desktop/provider-usage.mjs', 'desktop/usage-poller.mjs', 'desktop/usage.mjs',
    'desktop/provider-grok.mjs', 'vendor/grok/grok.exe',
    'desktop/workbench.mjs', 'desktop/model-assist.mjs', 'desktop/chat-memory-search.mjs', 'desktop/chat-memory-search-worker.mjs', 'desktop/github.mjs', 'desktop/request-guard.mjs',
    'desktop/browser.mjs', 'desktop/browser-runtime.mjs',
    'vendor/python/python.exe', 'vendor/python/python313.zip', 'desktop/note-store.mjs', 'desktop/vault-windows.ps1', 'desktop/conversation-tools.mjs',
    'vendor/cua-driver/cua-driver.exe', 'vendor/cua-driver/cua-driver-uia.exe', 'vendor/cua-driver/cua_driver_sdk.dll',
    'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  ];
  paths.push('desktop/local-models.mjs');
  if (PROVIDER_CATALOG.some(provider => provider.id === 'claude' && !provider.optIn)) paths.push('node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe');
  for (const relative of paths) await access(path.join(runtimeRoot, relative));
  report.checks.runtimeFiles = paths.length;
  for (const relative of ['desktop/provider-gemini.mjs', 'node_modules/@google/gemini-cli', 'node_modules/@google/gemini-cli-core']) {
    await assert.rejects(access(path.join(runtimeRoot, relative)), { code: 'ENOENT' });
  }
  assert.equal(PROVIDER_CATALOG.some(item => item.id === 'gemini-cli'), false);
  const shippedPackage = JSON.parse(extractFile(path.join(path.dirname(executable), 'resources/app.asar'), 'package.json').toString('utf8'));
  assert.equal(shippedPackage.dependencies?.['@google/gemini-cli'], undefined);
  report.checks.legacyGeminiRemoved = { catalog: true, adapter: true, cliPackage: true, corePackage: true, dependency: true };
  for (const relative of ['desktop/provider-copilot.mjs', 'desktop/provider-kimi-config.mjs', 'node_modules/@moonshot-ai/kimi-code', 'node_modules/@github/copilot-sdk']) {
    await assert.rejects(access(path.join(runtimeRoot, relative)), { code: 'ENOENT' }, `${relative} must not ship.`);
  }
  for (const id of ['codex', 'claude', 'antigravity', 'grok', 'muse-code', 'openai-api', 'anthropic-api', 'gemini', 'xai']) assert.ok(PROVIDER_CATALOG.some(item => item.id === id));
  for(const relative of ['desktop/api-agent.mjs','desktop/api-connections.mjs','desktop/request-guard.mjs','desktop/github.mjs','desktop/extensions.mjs','desktop/chat-memory-recall.mjs'])await access(path.join(runtimeRoot,relative));
  assert.equal(shippedPackage.dependencies?.['@moonshot-ai/kimi-code'], undefined);
  assert.equal(shippedPackage.dependencies?.['@github/copilot-sdk'], undefined);
  report.checks.removedConnections = { catalog: PROVIDER_CATALOG.map(item => item.id), kimiAndCopilotPackages: false, apiModulesRetained:true,localModules:true };
  // Keep this synthetic test process attached to its runner. The independent
  // Windows relay is tested separately and would detach the debugging pipes.
  const env = { ...process.env, EXOMINA_DATA_DIR: profile, EXOMINA_WINDOWS_INDEPENDENT: randomUUID() };
  report.checks.windowsLifetimeRelay = 'Skipped for the attached synthetic QA process; tested separately.';
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { cwd: path.dirname(executable), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Packaged renderer did not expose its QA debugging endpoint.')), 30000);
    child.stderr.on('data', chunk => {
      buffer = (buffer + chunk.toString()).slice(-16000);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); reject(new Error(`Packaged app exited before renderer connection (${code}).`)); });
  });
  child.stdout.resume();
  app = await connectCdp(endpoint);
  report.checks.debugger = await app.request('Browser.getVersion');
  console.log('Packaged QA: Chromium version read.');
  const target = await until(async () => (await app.request('Target.getTargets')).targetInfos.find(item => item.type === 'page' && item.url.endsWith('/dist/index.html')), Boolean);
  const { sessionId } = await app.request('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await app.request('Runtime.enable', {}, sessionId);
  page = {
    isClosed: () => false,
    async evaluate(fn, argument) {
      const response = await app.request('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(argument) ?? ''})`, awaitPromise: true, returnByValue: true }, sessionId);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result?.value;
    },
  };
  await until(() => page.evaluate(() => Boolean(document.querySelector('[aria-label="Exomina home"]'))), Boolean);
  console.log('Packaged QA: app renderer ready.');
  // Exercise actual file:// artwork URLs and CSS in the exact packaged renderer.
  report.checks.packagedThemeArtwork = {};
  for (const theme of THEMES.filter(theme => theme.artwork)) {
    const sourceBytes = await readFile(path.join(root, 'public', theme.artwork));
    const packageBytes = extractFile(path.join(path.dirname(executable), 'resources/app.asar'), path.join('dist', theme.artwork));
    assert.ok(packageBytes.equals(sourceBytes), `${theme.id}: packaged artwork must exactly match the approved source file.`);
    const expected = sourceImageDimensions(sourceBytes);
    await page.evaluate(() => document.querySelector('.sidebar-bottom > button.nav-item').click());
    await until(() => page.evaluate(() => Boolean(document.querySelector('.theme-group.extravagant'))), Boolean);
    await page.evaluate(name => [...document.querySelectorAll('.theme-card')].find(button => button.querySelector('strong')?.textContent === name).click(), theme.name);
    await until(() => page.evaluate(() => document.documentElement.dataset.theme), value => value === theme.id);
    const asset = await page.evaluate(async artwork => {
      const image = new Image();image.src = new URL(artwork, document.baseURI).href;await image.decode();
      return { url: image.src, width: image.naturalWidth, height: image.naturalHeight, background: getComputedStyle(document.querySelector('.main-shell'), '::before').backgroundImage };
    }, theme.artwork);
    report.checks.packagedThemeArtwork[theme.id] = { ...asset, expected, bytesMatchSource: true };
    assert.ok(asset.url.startsWith('file:'), `${theme.id}: artwork must load from the package.`);
    assert.deepEqual({ width: asset.width, height: asset.height }, expected, `${theme.id}: packaged decoder dimensions must match the exact source.`);
    assert.ok(asset.background.includes(theme.artwork));
    await page.evaluate(() => document.querySelector('[aria-label="Exomina home"]').click());
    const screenshot = await app.request('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    await writeFile(path.join(output, theme.id + '.png'), Buffer.from(screenshot.data, 'base64'));
  }
  console.log('Packaged QA: every theme artwork decodes from packaged file URLs.');
  assert.equal(await readFile(legacyCache,'utf8'),'Synthetic legacy cache retained without importing.');
  report.checks.legacyCacheDirectoryMigration={startupPassed:true,cachePreserved:true};
  const bootstrap = await until(() => page.evaluate(() => window.studio.invoke('bootstrap')), state => state.connections.length === PROVIDER_CATALOG.length && state.connections.every(c=>!c.checking),60000);
  const cloudTools=bootstrap.tools.filter(tool=>tool.name.startsWith('codex_cloud_'));
  assert.equal(cloudTools.length,4);assert.equal(cloudTools.every(tool=>tool.enabled),true);
  const cloudInfo=await page.evaluate(()=>window.studio.invoke('codexCloud.info'));
  assert.equal(cloudInfo.connected,false);assert.deepEqual(cloudInfo.environments,[]);
  const savedCloud=await page.evaluate(()=>window.studio.invoke('codexCloud.configure',{id:'env-synthetic-qa',name:'Synthetic cloud setup'}));
  assert.equal(savedCloud.environments[0].id,'env-synthetic-qa');
  const cloudFailure=await page.evaluate(async()=>{try{await window.studio.invoke('codexCloud.list');return null;}catch(e){return e.message;}});
  assert.match(cloudFailure,/subscription sign-in/);
  report.checks.codexCloudHost={registeredTools:4,enabled:true,signedOutGuard:true,savedSetup:true,realCloudRequests:0};
  assert.equal((await page.evaluate(() => window.studio.invoke('security.status'))).protected,true);
  assert.equal((await page.evaluate(() => window.studio.invoke('security.status'))).recoveryAudit.status,'pending');
  assert.equal(bootstrap.settings.memoryCapture,'automatic');
  assert.ok(bootstrap.tools.some(t=>t.name==='conversation_read'));
  assert.ok(bootstrap.tools.some(t=>t.name==='image_generate'));
  assert.ok(bootstrap.tools.some(t=>t.name==='model_consult'));
  assert.deepEqual(bootstrap.workbench,{projects:[],prompts:[],schedules:[]});
  assert.equal(bootstrap.providers.find(item => item.id === 'grok')?.mode, 'subscription');
  assert.equal(bootstrap.providers.find(item => item.id === 'xai')?.mode, 'api');
  const grokStatus = bootstrap.connections.find(item => item.id === 'grok');
  assert.equal(grokStatus?.installed, true);
  assert.equal(grokStatus.connected, false, 'A fresh QA profile must not claim a Grok account connection.');
  await page.evaluate(() => document.querySelector('.nav-list [aria-label="Connections"]').click());
  await until(() => page.evaluate(() => Boolean(document.querySelector('[data-provider="grok"]'))), Boolean);
  const grokCard = await page.evaluate(() => {
    const account = document.querySelector('[data-provider="grok"]'), api = document.querySelector('[data-provider="xai"]');
    account.scrollIntoView({ block: 'center' });
    return { mode: account.closest('[data-mode]').dataset.mode, text: account.innerText, buttons: [...account.querySelectorAll('button')].map(button => ({ text: button.textContent.trim(), disabled: button.disabled })), passwordFields: account.querySelectorAll('input[type="password"]').length, apiMode: api.closest('[data-mode]').dataset.mode };
  });
  assert.equal(grokCard.mode, 'subscription');
  assert.equal(grokCard.apiMode, 'api');
  assert.ok(grokCard.buttons.some(button => button.text === 'Sign in to Grok' && !button.disabled));
  assert.equal(grokCard.passwordFields, 0);
  report.checks.packagedGrokAccountCard = { ...grokCard, status: grokStatus, realAuthorizationPerformed: false };
  const grokScreenshot = await app.request('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  await writeFile(path.join(output, 'grok-account-card.png'), Buffer.from(grokScreenshot.data, 'base64'));
  await page.evaluate(()=>window.studio.invoke('quick.open'));
  const quickTarget=await until(async()=>(await app.request('Target.getTargets')).targetInfos.find(item=>item.type==='page'&&item.url.endsWith('/dist/index.html#quick')),Boolean);
  const quickSession=(await app.request('Target.attachToTarget',{targetId:quickTarget.targetId,flatten:true})).sessionId;
  const quickEvaluate=async fn=>{const r=await app.request('Runtime.evaluate',{expression:`(${fn.toString()})()`,awaitPromise:true,returnByValue:true},quickSession);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
  await until(()=>quickEvaluate(()=>Boolean(document.querySelector('[aria-label="Quick question"]'))),Boolean);
  assert.equal(await quickEvaluate(()=>document.querySelector('[aria-label="Send quick question"]').disabled),true);
  assert.deepEqual((await quickEvaluate(()=>window.studio.invoke('quick.state'))).connections,[]);
  const rejection=await quickEvaluate(async()=>{try{await window.studio.invoke('bootstrap');return 'unexpected access';}catch(error){return error.message;}});
  assert.match(rejection,/Untrusted app frame/);
  await quickEvaluate(()=>window.studio.invoke('quick.dismiss'));
  report.checks.quickAccess={windowOpened:true,isolatedIpc:true,noProviderSendDisabled:true,modelRequests:0};
  assert.ok(!JSON.stringify(bootstrap).includes(syntheticPng));
  const renderedAsset=await page.evaluate(id=>window.studio.invoke('asset.read',{id}),syntheticImage.id);
  assert.equal(renderedAsset.dataBase64,syntheticPng);
  await page.evaluate(()=>[...document.querySelectorAll('.chat-open')].find(button=>button.textContent.includes('Synthetic image preview')).click());
  await until(()=>page.evaluate(()=>{const img=document.querySelector('.message-image img');return !!img?.complete&&img.naturalWidth===1;}),Boolean);
  report.checks.privateImageStore={read:true,metadataOnlyBootstrap:true,inlineDecodedImage:true};
  if(syntheticVideo){
    const asset=await page.evaluate(id=>window.studio.invoke('asset.read',{id}),syntheticVideo.id);
    assert.equal(asset.mimeType,'video/mp4');assert.equal(asset.sha256,syntheticVideo.sha256);
    try {
      await until(()=>page.evaluate(()=>{const v=document.querySelector('.message-image video');return v?.readyState>=1&&v.videoWidth===320&&v.duration>0;}),Boolean);
    } catch (error) {
      report.checks.videoDiagnostic=await page.evaluate(()=>({
        text:document.querySelector('.message-images')?.innerText,
        videos:[...document.querySelectorAll('.message-image video')].map(v=>({readyState:v.readyState,networkState:v.networkState,width:v.videoWidth,duration:v.duration,error:v.error?.message,src:v.currentSrc})),
        codec:document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')
      }));
      const screenshot=await app.request('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);
      await writeFile(path.join(output,'video-failure.png'),Buffer.from(screenshot.data,'base64'));
      throw error;
    }
    await page.evaluate(()=>document.querySelector('.message-image video').play());
    await until(()=>page.evaluate(()=>document.querySelector('.message-image video').currentTime>0),Boolean);
    await page.evaluate(()=>document.querySelector('.message-image video').pause());
    assert.ok(await page.evaluate(()=>[...document.querySelectorAll('.message-image button')].some(b=>b.textContent==='Save video'&&!b.disabled)));
    report.checks.privateVideoStore={read:true,persistedAttachment:true,decodedPlayback:true,saveControl:true};
  }
  await until(()=>page.evaluate(()=>document.querySelector('.live-followup-answer')?.textContent.includes('Synthetic answer preserved')),Boolean);
  assert.ok(await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.live-followup')).borderTopWidth)>0));
  report.checks.packagedFollowupUi={questionAndAnswerRendered:true,preservedAfterStoreReload:true,modelRequests:0};
  await page.evaluate(()=>document.querySelector('.browser-toggle').click());
  await until(()=>page.evaluate(()=>Boolean(document.querySelector('.browser-host'))),Boolean);
  const browserReady=await page.evaluate(url=>window.studio.invoke('browser.navigate',{url}),browserFixtureUrl);
  assert.equal(browserReady.pageReady,true);
  assert.equal(browserReady.loading,true);
  await until(()=>page.evaluate(()=>Boolean(document.querySelector('[aria-label="Stop loading page"]'))&&document.querySelector('.browser-footer').textContent.includes('Page ready')),Boolean);
  const browserTarget=await until(async()=>(await app.request('Target.getTargets')).targetInfos.find(target=>target.url===browserFixtureUrl),Boolean);
  const browserSession=(await app.request('Target.attachToTarget',{targetId:browserTarget.targetId,flatten:true})).sessionId;
  const browserRead=await app.request('Runtime.evaluate',{expression:'({text:document.body.innerText,hasNode:typeof require!=="undefined",hasAppBridge:typeof window.studio!=="undefined"})',returnByValue:true},browserSession);
  assert.match(browserRead.result.value.text,/Packaged browser ready while loading/);
  assert.equal(browserRead.result.value.hasNode,false);
  assert.equal(browserRead.result.value.hasAppBridge,false);
  await page.evaluate(()=>document.querySelector('[aria-label="Stop loading page"]').click());
  await until(()=>page.evaluate(()=>window.studio.invoke('browser.state')),state=>!state.loading);
  await until(()=>page.evaluate(()=>Boolean(document.querySelector('[aria-label="Reload page"]'))),Boolean);
  await page.evaluate(()=>document.querySelector('.browser-toggle').click());
  report.checks.packagedBrowserLoading={readableBeforeLoadEnds:true,stopButtonEndsLoad:true,isolatedBrowserRenderer:true,modelRequests:0};
  console.log('Packaged QA: embedded browser remains readable during loading and Stop ends the load.');
  assert.equal(bootstrap.connections.filter(connection => !['antigravity','claude'].includes(connection.id)).every(connection => connection.installed), true);
  assert.equal(bootstrap.connections.some(connection => connection.id === 'claude' && connection.installed), false);
  assert.equal(bootstrap.connections.some(connection => connection.id === 'gemini-cli'), false);
  assert.equal(bootstrap.connections.some(connection => connection.id === 'antigravity'), true);
  assert.equal(bootstrap.connections.every(connection => !connection.connected), true);
  report.checks.providers = bootstrap.connections.map(({ id, installed, connected }) => ({ id, installed, connected }));
  assert.equal(path.resolve(bootstrap.settings.workspace), path.join(profile, 'workspace'));
  assert.equal(path.resolve(bootstrap.settings.cuaDriverPath), path.join(runtimeRoot, 'vendor/cua-driver/cua-driver.exe'));
  report.checks.isolatedProfile = true;
  console.log('Packaged QA: bundled providers installed and signed out.');

  const memory = 'Synthetic packaged Exomina verification — ä 中文.';
  await page.evaluate(text => window.studio.invoke('memory.add', { text }), memory);
  const saved = await page.evaluate(() => window.studio.invoke('bootstrap'));
  assert.equal(saved.memories.some(item => item.text === memory), true);
  const wake = await page.evaluate(() => window.studio.invoke('memory.wake'));
  assert.equal(wake.error, false);
  assert.ok(wake.text.includes(memory));
  report.checks.packagedSqliteMemory = { write: true, read: true, wake: true, unicode: true, automaticDefault:true };
  console.log('Packaged QA: independent memory write/read/wake passed.');

  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Tools').click());
  await until(() => page.evaluate(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Set up computer use')), Boolean);
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Set up computer use').click());
  await until(() => page.evaluate(() => Boolean(document.querySelector('[role="alertdialog"]'))), Boolean);
  await page.evaluate(() => [...document.querySelector('[role="alertdialog"]').querySelectorAll('button')].find(button => button.textContent.trim() === 'Allow once').click());
  const connected = await until(() => page.evaluate(() => window.studio.invoke('bootstrap')), state => state.mcpStatus.some(item => item.id === 'cua' && item.connected));
  const status = connected.mcpStatus.find(item => item.id === 'cua');
  assert.equal(status.toolCount, 59);
  assert.equal(connected.tools.filter(tool => tool.name.startsWith('external_cua_')).length, 59);
  report.checks.packagedCua = { productionUiApproved: true, discoveredTools: status.toolCount, nativeActions: 0 };
  console.log('Packaged QA: approved driver exposes 59 tools.');
  await page.evaluate(() => window.studio.invoke('mcp.disconnectDriver'));
  report.checks.driverDisconnected = true;
  const recovery = await page.evaluate(() => window.studio.invoke('security.auditRecovery'));
  assert.equal(recovery.status,'verified');
  assert.ok(Number.isFinite(Date.parse(recovery.checkedAt)));
  report.checks.manualRecoveryAudit={notAutomatic:true,passed:true,checkedAt:recovery.checkedAt};
  await closeApp();
  report.checks.atRestProtection=await fixture.verify();
  report.checks.recoveryAcknowledgement=fixture.report.recoveryAcknowledgement;

  const gateway = await createGateway({ definitions: () => [{ name: 'synthetic_echo', inputSchema: { type: 'object' } }], callTool: async (_name, args) => ({ content: [{ type: 'text', text: args.text }] }), isActive: id => id === 'package-qa' });
  const client = new StdioMcpClient({ id: 'package', command: executable, args: [path.join(runtimeRoot, 'desktop/mcp-stdio.mjs')], env: { ELECTRON_RUN_AS_NODE: '1', EXOMINA_TOOL_GATEWAY: gateway.url, EXOMINA_TOOL_TOKEN: gateway.token, EXOMINA_TOOL_CONVERSATION: 'package-qa' } });
  try {
    await client.connect();
    assert.equal((await client.listTools()).length, 1);
    const result = await client.request('tools/call', { name: 'synthetic_echo', arguments: { text: memory } });
    assert.equal(result.content[0].text, memory);
    report.checks.packagedExeMcpBridge = { initialize: true, list: true, unicodeEcho: true };
  } finally { await client.close(); gateway.close(); }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  // Capture fixed diagnostic categories from this synthetic profile while the
  // QA app is still open. Never inspect a personal account or log file contents.
  if (/vault directory|Runtime\.evaluate timed out/.test(error.message)) {
    const vault = new WindowsVault({ scriptPath: path.join(runtimeRoot, 'desktop/vault-windows.ps1') });
    try {
      const record = JSON.parse(await readFile(profile + '.setup/recovery-backup.json', 'utf8'));
      await vault.request('verify', profile, { recoveryThumbprint: record.thumbprint });
      report.checks.auditDiagnostic = { verified: true };
    } catch (failure) { report.checks.auditDiagnostic = { verified: false, diagnostic: failure.diagnostic }; }
    finally { vault.close(); }
  }
  throw error;
} finally {
  await closeApp();
  browserFixture.closeAllConnections();await new Promise(resolve=>browserFixture.close(resolve));
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
}
