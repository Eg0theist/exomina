// Exact packaged theme selection and persistence, using only a fresh synthetic profile.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { extractFile } from '@electron/asar';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { Store } from '../desktop/store.mjs';
import { THEMES } from '../desktop/themes.mjs';

const root = process.cwd(), build = path.join(root, 'release/win-unpacked');
const executable = path.join(build, 'Exomina.exe');
const fixture = await createProtectedQaProfile('erebus-themes-package');
const { output, profile } = fixture, workspace = path.join(output, 'workspace');
await mkdir(workspace);
const store = new Store(profile, { workspace }); await store.init();
Object.assign(store.state.settings, { autoUpdate: false, autoTitle: false, closeToTray: false, memoryEnabled: false, appearance: { theme: 'erebus-flame', motion: 'reduced' } });
const chat = store.create('codex'); chat.title = 'Erebus theme trial';
chat.messages = [
  { role: 'user', content: 'Let us get back to Erebus. I want an atmosphere that feels like the book.' },
  { role: 'assistant', provider: 'codex', content: 'Purple-black Khaos light, monumental shadows, and room for the words.\n\nThis is synthetic conversation text for checking the four selectable Erebus themes. The reading area stays calm while the world remains visible around it.' },
];
await store.save();
const ids = ['erebus-obsidian', 'erebus-underworld', 'erebus-nebula', 'erebus-sanctum'];
const themes = ids.map(id => THEMES.find(theme => theme.id === id));
assert.ok(themes.every(Boolean));
const report = { build: JSON.parse(await readFile(path.join(build, 'exomina.build.json'), 'utf8')), scope: 'Exact packaged app, new encrypted synthetic profile, actual theme picker and settings persistence. No personal account/profile access, model turns, or live installation.', themes: [], errors: [] };
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
async function setSize(width, height, scale) {
  await connection.request('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
  await until(() => evaluate(({ width, height }) => {
    const root = document.documentElement, frame = document.querySelector('.main-shell').getBoundingClientRect(), artWidth = parseFloat(root.style.getPropertyValue('--artwork-width'));
    return innerWidth === width && innerHeight === height && Math.abs(document.querySelector('.app-frame').getBoundingClientRect().bottom - height) < 1 && Math.abs(artWidth - Math.max(frame.width, frame.height * 32 / 9)) < .01;
  }, { width, height }), Boolean);
}
try {
  const asar = path.join(build, 'resources/app.asar'), runtime = path.join(build, 'resources/app.asar.unpacked');
  assert.ok((await readFile(path.join(runtime, 'desktop/themes.mjs'))).equals(await readFile(path.join(root, 'desktop/themes.mjs'))));
  for (const theme of themes) assert.ok(extractFile(asar, path.join('dist', theme.artwork)).equals(await readFile(path.join(root, 'public', theme.artwork))), theme.id + ' packaged artwork matches');
  report.packagedCatalogAndArtworkMatch = true;
  await launch();
  for (const theme of themes) {
    await appearance();
    const cards = await evaluate(() => [...document.querySelectorAll('#settings-appearance [role="radio"]')].map(button => button.textContent));
    for (const candidate of themes) assert.ok(cards.some(text => text.startsWith(candidate.name)), candidate.name + ' is selectable');
    await evaluate(name => [...document.querySelectorAll('#settings-appearance [role="radio"]')].find(button => button.textContent.startsWith(name)).click(), theme.name);
    await until(() => evaluate(() => document.documentElement.dataset.theme), id => id === theme.id);
    assert.equal((await evaluate(() => window.studio.invoke('bootstrap'))).settings.appearance.theme, theme.id);
    const image = await evaluate(async artwork => { const image = new Image(); image.src = new URL(artwork, document.baseURI).href; await image.decode(); return [image.naturalWidth, image.naturalHeight]; }, theme.artwork);
    assert.deepEqual(image, [2172, 724]);
    await chooseChat();
    const layouts = [];
    for (const [name, width, height, scale] of [['regular', 1360, 900, 1], ['3440-175-percent', Math.round(3440 / 1.75), Math.round(1440 / 1.75), 1.75], ['5120-175-percent', Math.round(5120 / 1.75), Math.round(1440 / 1.75), 1.75]]) {
      await setSize(width, height, scale);
      const layout = await evaluate(() => {
        const root = document.documentElement, frame = document.querySelector('.main-shell').getBoundingClientRect(), composer = document.querySelector('.composer').getBoundingClientRect(), backdrop = getComputedStyle(document.querySelector('.main-shell'), '::before');
        return { viewport: [innerWidth, innerHeight], scale: devicePixelRatio, fit: root.dataset.artworkFit, frame: [frame.width, frame.height], artWidth: parseFloat(root.style.getPropertyValue('--artwork-width')), artHeight: parseFloat(root.style.getPropertyValue('--artwork-height')), size: backdrop.backgroundSize, image: backdrop.backgroundImage, sidebar: getComputedStyle(document.querySelector('.sidebar')).backgroundImage, accent: root.style.getPropertyValue('--t-accent'), filter: backdrop.filter, mask: backdrop.maskImage, repeat: backdrop.backgroundRepeat, composer: { left: composer.left, right: composer.right, bottom: composer.bottom }, overflow: root.scrollWidth > innerWidth + 1 };
      });
      assert.equal(layout.fit, 'panorama'); assert.equal(layout.overflow, false);
      assert.ok(layout.image.includes(theme.artwork) && layout.sidebar.includes(theme.artwork));
      assert.equal(layout.accent, theme.colors.accent); assert.equal(layout.mask, 'none'); assert.equal(layout.filter, 'none');
      assert.match(layout.size, /^100% 100%, [\d.]+px [\d.]+px$/);
      assert.ok(layout.repeat.split(',').every(value => value.trim() === 'no-repeat'));
      assert.ok(Math.abs(layout.artWidth / layout.artHeight - 3) < .0001);
      assert.ok(layout.artWidth >= layout.frame[0] - .01 && layout.artHeight >= layout.frame[1] - .01);
      assert.ok(layout.composer.left >= 0 && layout.composer.right <= width + 1 && layout.composer.bottom <= height + 1);
      const shot = await connection.request('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      await writeFile(path.join(output, `${theme.id}-${name}.png`), Buffer.from(shot.data, 'base64'));
      layouts.push({ name, ...layout });
    }
    assert.ok(Math.abs(layouts[1].artHeight - layouts[2].artHeight) < .01, 'Subject scale stays stable across the two screens');
    await close(); await launch();
    const persisted = await evaluate(() => window.studio.invoke('bootstrap'));
    assert.equal(persisted.settings.appearance.theme, theme.id);
    await until(() => evaluate(() => document.documentElement.dataset.theme), id => id === theme.id);
    report.themes.push({ id: theme.id, picker: true, packagedImage: image, layouts, persistedAfterRestart: true });
  }
  // Verify the existing Eclipse remains selectable after all four trials.
  await appearance();
  await evaluate(() => [...document.querySelectorAll('#settings-appearance [role="radio"]')].find(button => button.textContent.startsWith('Erebus Eclipse')).click());
  await until(() => evaluate(() => document.documentElement.dataset.theme), id => id === 'erebus-flame');
  report.eclipseStillSelectable = true;
  await close(); report.profileProtection = await fixture.verify(); report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally { await close(); await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, build: report.build, passed: report.passed, themes: report.themes.map(theme => ({ id: theme.id, layouts: theme.layouts.length, persistedAfterRestart: theme.persistedAfterRestart })), error: report.error }, null, 2)); }
