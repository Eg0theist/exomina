// Renderer/transport QA only. Backend responses, profile and image are synthetic.
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), output = await mkdtemp(path.resolve(root, '../qa-images-'));
// Build a valid colored PNG from synthetic pixels; no user image is involved.
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function chunk(name, bytes) { const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes]))); return Buffer.concat([size, type, bytes, crc]); }
const width = 240, height = 160, header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
const pixels = Buffer.alloc(height * (width * 3 + 1));
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (width * 3 + 1) + x * 3 + 1; pixels[offset] = 25 + Math.floor(x / 2); pixels[offset + 1] = 80 + Math.floor(y / 2); pixels[offset + 2] = 65; }
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const attachment = { id: 'synthetic-image-1', kind: 'image', mimeType: 'image/png', bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };
await writeFile(path.join(output, 'fixture.png'), png);
const report = { syntheticOnly: true, scope: 'Image renderer, native IPC result handling and authenticated web transport with synthetic backend; no model inference, personal profile, or production vault bypass.', modes: {} };
const seed = mode => ({ settings: { provider: 'codex', model: 'auto', memoryEnabled: true, memoryCapture: 'automatic' }, connections: [{ id: 'codex', installed: true, available: true, connected: true }], conversations: [{ id: 'synthetic-chat', provider: 'codex', title: 'Synthetic image chat', messages: [{ role: 'user', content: 'Show the synthetic image.' }, { role: 'assistant', content: 'Initial image.', attachments: [attachment] }] }], memories: [], tools: [], version: 'image-qa', activeRuns: [], approvals: [], archive: { documents: 0 }, runtime: { mode, capabilities: { nativeBrowser: false, desktopControl: false, localFiles: false, archiveUpload: false }, executor: { label: 'Synthetic host', online: true } } });

for (const mode of ['desktop', 'web']) {
  const folder = path.join(output, mode); await mkdir(folder);
  const state = seed(mode), controls = { denyRead: true, denySave: true, authenticated: true, reads: 0, saves: 0, bootstraps: 0 };
  const streams = new Set(); let server, app;
  const entry = path.join(folder, 'host.cjs'), preload = path.join(folder, 'preload.cjs'), fixture = path.join(folder, 'fixture.json'), savedImage = path.join(folder, 'synthetic-image.png');
  await writeFile(fixture, JSON.stringify({ state, controls, attachment }));
  let pageUrl;
  if (mode === 'web') {
    server = createServer(async (request, response) => {
      const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
      try {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/api/auth/status') return json({ authenticated: controls.authenticated, displayName: 'Synthetic owner', csrf: 'synthetic-csrf', loginUrl: '/auth/login' });
        if (pathname === '/api/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); response.write(': connected\n\n'); streams.add(response); request.on('close', () => streams.delete(response)); return; }
        if (pathname === '/api/invoke') {
          assert.equal(request.headers['x-csrf-token'], 'synthetic-csrf');
          let text = ''; for await (const bytes of request) text += bytes;
          const { method, payload } = JSON.parse(text);
          if (!controls.authenticated) return json({ error: 'Image access is no longer authorized.' }, 401);
          if (method === 'bootstrap') { controls.bootstraps++; return json(state); }
          if (method === 'conversations.get') return json(state.conversations[0]);
          if (method === 'asset.read') { controls.reads++; if (controls.denyRead) return json({ error: 'You do not have access to this image.' }, 403); return json({ id: payload.id, mimeType: 'image/png', bytes: png.length, dataBase64: png.toString('base64') }); }
          if (method === 'asset.save') { controls.saves++; if (controls.denySave) return json({ error: 'Image download is not authorized.' }, 403); return json({ filename: 'synthetic-image.png', mimeType: 'image/png', dataBase64: png.toString('base64') }); }
          return json({ error: `Unexpected synthetic request: ${method}` }, 400);
        }
        const relative = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.slice(1));
        const filename = path.resolve(root, 'dist', relative);
        assert.ok(filename.startsWith(path.resolve(root, 'dist') + path.sep));
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
        response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' }); response.end(await readFile(filename));
      } catch (error) { if (!response.headersSent) json({ error: error.message }, 500); else response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    pageUrl = `http://127.0.0.1:${server.address().port}`;
  }
  await writeFile(preload, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('studio',{invoke:(method,payload)=>ipcRenderer.invoke('image-qa:invoke',method,payload),onEvent:callback=>{const listener=(_event,event)=>callback(event);ipcRenderer.on('image-qa:event',listener);return()=>ipcRenderer.removeListener('image-qa:event',listener)}});");
  await writeFile(entry, `const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs');const path=require('node:path');
    globalThis.qa=JSON.parse(fs.readFileSync(process.env.IMAGE_QA_FIXTURE,'utf8'));const png=fs.readFileSync(process.env.IMAGE_QA_PNG);
    app.setPath('userData',process.env.IMAGE_QA_PROFILE);app.whenReady().then(()=>{
      if(process.env.IMAGE_QA_MODE==='desktop')ipcMain.handle('image-qa:invoke',async(_event,method,payload={})=>{
        const {state,controls}=globalThis.qa;
        if(method==='security.status')return {protected:true,supported:true,needsRecovery:false,message:'Synthetic renderer fixture only.'};
        if(method==='bootstrap'){controls.bootstraps++;return state;}if(method==='conversations.get')return state.conversations[0];
        if(method==='asset.read'){controls.reads++;if(controls.denyRead)throw Error('You do not have access to this image.');return {id:payload.id,mimeType:'image/png',bytes:png.length,dataBase64:png.toString('base64')};}
        if(method==='asset.save'){controls.saves++;if(controls.denySave)throw Error('Image download is not authorized.');fs.writeFileSync(process.env.IMAGE_QA_SAVE,png);return {path:process.env.IMAGE_QA_SAVE};}
        throw Error('Unexpected synthetic request: '+method);
      });
      const w=new BrowserWindow({width:1280,height:920,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,...(process.env.IMAGE_QA_MODE==='desktop'?{preload:process.env.IMAGE_QA_PRELOAD}:{})}});
      w.webContents.session.on('will-download',(_event,item)=>{item.setSavePath(process.env.IMAGE_QA_SAVE);item.once('done',(_event,status)=>{globalThis.qa.download={status,bytes:item.getReceivedBytes(),filename:item.getFilename()}})});
      if(process.env.IMAGE_QA_URL)w.loadURL(process.env.IMAGE_QA_URL);else w.loadFile(process.env.IMAGE_QA_INDEX);
    });app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env, IMAGE_QA_MODE: mode, IMAGE_QA_PROFILE: path.join(folder, 'profile'), IMAGE_QA_FIXTURE: fixture, IMAGE_QA_PNG: path.join(output, 'fixture.png'), IMAGE_QA_SAVE: savedImage, IMAGE_QA_PRELOAD: preload, IMAGE_QA_INDEX: path.join(root, 'dist', 'index.html'), ...(pageUrl ? { IMAGE_QA_URL: pageUrl } : {}) }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    app = await electron.launch({ args: [entry], env, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (mode === 'web') await page.setViewportSize({ width: 360, height: 800 });
    const control = async patch => { if (mode === 'desktop') await app.evaluate((_electron, value) => Object.assign(globalThis.qa.controls, value), patch); else Object.assign(controls, patch); };
    const counts = () => mode === 'desktop' ? app.evaluate(() => globalThis.qa.controls) : Promise.resolve({ ...controls });
    const emit = async event => { if (mode === 'desktop') await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('image-qa:event', value), event); else for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`); };
    await page.getByRole('heading', { name: /^(Good (morning|afternoon|evening)|Up late).$/ }).waitFor();
    const capability = { supported: true, enabled: true, available: true, requiresImageModel: true, detail: 'Synthetic image capability: requires an image-capable model and account access.' };
    if (mode === 'desktop') await app.evaluate((_electron, value) => { globalThis.qa.state.connections[0].imageGeneration = value; }, capability);
    else state.connections[0].imageGeneration = capability;
    const connection = { ...state.connections[0], imageGeneration: capability };
    await emit({ type: 'connections', connections: [connection] });
    if (mode === 'web') await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.locator('[data-provider="codex"] .image-capability-note').waitFor();
    assert.ok((await page.locator('[data-provider="codex"] .image-capability-note').innerText()).includes(capability.detail));
    assert.equal(await page.locator('[data-provider="claude"] .image-capability-note').count(), 0);
    assert.equal((await counts()).reads, 0, 'bootstrap image metadata must not fetch binaries until its chat mounts');
    if (mode === 'web') await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: 'Synthetic image chat', exact: true }).click();
    await page.getByText('You do not have access to this image.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save image', exact: true }).isDisabled(), true);
    await control({ denyRead: false });
    await page.getByRole('button', { name: 'Retry image', exact: true }).click();
    await page.waitForFunction(() => { const image = document.querySelector('.message-image img'); return image?.complete && image.naturalWidth === 240; });
    assert.ok((await page.locator('.message-image img').getAttribute('src')).startsWith('blob:'));
    await page.getByRole('button', { name: 'Save image', exact: true }).click();
    await page.getByText('Image download is not authorized.', { exact: true }).waitFor();
    await control({ denySave: false });
    await page.getByRole('button', { name: 'Save image', exact: true }).click();
    await page.getByText(mode === 'desktop' ? `Saved to ${savedImage}` : 'Downloaded synthetic-image.png', { exact: true }).waitFor();
    if (mode === 'web') {
      for (let attempt = 0; attempt < 100 && !(await app.evaluate(() => globalThis.qa.download)); attempt++) await page.waitForTimeout(20);
      assert.equal((await app.evaluate(() => globalThis.qa.download)).status, 'completed');
    }
    assert.deepEqual(await readFile(savedImage), png, 'downloaded bytes must match the synthetic image exactly');
    const before = (await counts()).bootstraps;
    await emit({ type: 'chat.delta', conversationId: 'synthetic-chat', text: ' More streamed text.' });
    const second = { ...attachment, id: 'synthetic-image-2' };
    await emit({ type: 'chat.asset', conversationId: 'synthetic-chat', attachment: second });
    await emit({ type: 'chat.asset', conversationId: 'synthetic-chat', attachment: second });
    await page.waitForFunction(() => { const images = [...document.querySelectorAll('.message-image img')]; return images.length === 2 && images.every(image => image.complete && image.naturalWidth === 240); });
    await page.getByText('Initial image. More streamed text.', { exact: true }).waitFor();
    assert.equal((await counts()).bootstraps, before, 'an asset event must not reload the conversation while text is streaming');
    assert.equal(await page.locator('.message-image').count(), 2, 'duplicate asset events must not duplicate images');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, `${mode}-images.png`) });
    if (mode === 'web') {
      await control({ authenticated: false });
      await emit({ type: 'chat.asset', conversationId: 'synthetic-chat', attachment: { ...attachment, id: 'synthetic-expired-image' } });
      await page.getByRole('heading', { name: 'Your private workspace', exact: true }).waitFor();
      assert.equal(await page.locator('.message-image').count(), 0, '401 image response must unmount private chat content');
      const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(item => new URL(item.url).pathname)))).flat());
      assert.ok(cached.every(value => !value.startsWith('/api/')), 'private image API responses must not enter the app-shell cache');
    }
    assert.deepEqual(errors, []);
    report.modes[mode] = { passed: true, reportedImageCapability: true, lazyRead: true, deniedReadRetry: true, deniedSaveRetry: true, savedBytesMatch: true, rasterBlobDisplay: true, streamingTextPreserved: true, eventDeduplicated: true, noAssetTriggeredBootstrap: true, ...(mode === 'web' ? { expiredSessionGatesPrivateContent: true, privateApiNotCached: true, width: 360 } : {}) };
  } finally {
    if (app) await app.close(); for (const stream of streams) stream.end();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
report.passed = true;
await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, ...report }));
