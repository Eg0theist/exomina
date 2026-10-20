import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserRuntime, browserDeadline } from '../desktop/browser-runtime.mjs';

const never = () => new Promise(() => {});
const image = { isEmpty: () => false, toPNG: () => Buffer.from('synthetic PNG') };
function fixture() {
  const wc = new EventEmitter();
  wc.url = 'https://example.com/'; wc.loading = false; wc.stops = 0; wc.nativeReads = 0; wc.frameReads = 0;
  wc.isDestroyed = () => false;
  wc.stop = () => { wc.stops++; wc.loading = false; };
  wc.executeJavaScript = () => { wc.nativeReads++; return never(); };
  wc.mainFrame = { executeJavaScript: async () => { wc.frameReads++; return { url: wc.url, title: 'Fixture', text: 'Readable text', elements: [{ selector: '[data-exomina-node="fixture"]' }], readyState: 'interactive' }; } };
  wc.capturePage = async () => image;
  wc.loadURL = url => {
    wc.emit('did-start-navigation', {}, url, false, true);
    wc.url = url; wc.loading = true; wc.emit('did-navigate', {}, url);
    queueMicrotask(() => wc.emit('dom-ready'));
    return never();
  };
  const runtime = new BrowserRuntime({ wc, readState: () => ({ url: wc.url, title: 'Fixture', loading: wc.loading }), timeouts: { navigation: 50, read: 30, capture: 20, action: 30 } });
  return { wc, runtime };
}
const data = result => JSON.parse(result.content.find(item => item.type === 'text').text);

test('navigation returns at DOM readiness while resource loading remains pending', async () => {
  const { wc, runtime } = fixture();
  const result = await runtime.navigate('https://example.com/loading');
  assert.equal(result.pageReady, true);
  assert.equal(result.loading, true);
  assert.match(result.notice, /read it now/);
  assert.equal(wc.listenerCount('dom-ready'), 1, 'Only the persistent readiness observer remains.');
  assert.equal(wc.listenerCount('did-fail-load'), 0);
  runtime.close();
});

test('a navigation that never becomes readable has a deadline and stops its own load', async () => {
  const { wc, runtime } = fixture();
  wc.loadURL = () => never();
  await assert.rejects(runtime.navigate('https://example.com/stalled'), /did not become ready/);
  assert.equal(wc.stops, 1);
  assert.equal(wc.listenerCount('dom-ready'), 1);
  assert.equal(wc.listenerCount('destroyed'), 0);
  runtime.close();
});

test('a previous document becoming ready does not finish an uncommitted navigation', async () => {
  const { wc, runtime } = fixture();
  wc.loadURL = url => { wc.emit('did-start-navigation', {}, url, false, true); wc.emit('dom-ready'); return never(); };
  let finished = false;
  const pending = runtime.navigate('https://example.com/new').then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(runtime.pageReady, false);
  wc.url = 'https://example.com/new'; wc.emit('did-navigate', {}, wc.url); wc.emit('dom-ready');
  assert.equal((await pending).url, wc.url);
  runtime.close();
});

test('canceling an older navigation does not stop a newer shared-browser navigation', async () => {
  const { wc, runtime } = fixture();
  wc.loadURL = url => { wc.url = url; wc.emit('did-start-navigation', {}, url, false, true); wc.emit('did-navigate', {}, url); return never(); };
  const controller = new AbortController();
  const older = runtime.navigate('https://example.com/older', controller.signal);
  const rejected = assert.rejects(older, /stopped/);
  await new Promise(resolve => setImmediate(resolve));
  const newer = runtime.navigate('https://example.com/newer');
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  wc.emit('dom-ready');
  await rejected;
  assert.equal((await newer).url, 'https://example.com/newer');
  assert.equal(wc.stops, 0);
  runtime.close();
});

test('snapshots read the current main frame instead of waiting for full page loading', async () => {
  const { wc, runtime } = fixture();
  wc.loading = true; wc.emit('dom-ready');
  const result = await runtime.snapshot();
  assert.equal(result.isError, undefined);
  assert.equal(data(result).text, 'Readable text');
  assert.equal(data(result).untrusted, true);
  assert.equal(data(result).loading, true);
  assert.equal(data(result).screenshot.available, true);
  assert.equal(wc.nativeReads, 0);
  assert.equal(wc.frameReads, 1);
  runtime.close();
});

test('text-only snapshot does not start native screenshot capture', async () => {
  const {wc,runtime}=fixture(); let captured=0;
  wc.capturePage=()=>{captured++;return never();};
  const result=await runtime.snapshot(undefined,{include_screenshot:false});
  assert.equal(captured,0);
  assert.equal(data(result).pageRead.available,true);
  assert.equal(data(result).screenshot.reason,'Screenshot omitted by request.');
  assert.equal(result.content.some(item=>item.type==='image'),false);
  runtime.close();
});

test('a capture that never settles still returns successful text and selectors', async () => {
  const { wc, runtime } = fixture(); wc.capturePage = never;
  const result = await runtime.snapshot();
  assert.equal(result.isError, undefined);
  assert.equal(data(result).pageRead.available, true);
  assert.equal(data(result).elements.length, 1);
  assert.equal(data(result).screenshot.available, false);
  assert.match(data(result).screenshot.reason, /timed out/);
  runtime.close();
});

test('repeated reads do not accumulate native captures while one is still stalled', async () => {
  const { wc, runtime } = fixture(); let attempts = 0;
  wc.capturePage = () => { attempts++; return never(); };
  await runtime.snapshot();
  const again = await runtime.snapshot();
  assert.equal(attempts, 1);
  assert.equal(data(again).pageRead.available, true);
  assert.match(data(again).screenshot.reason, /previous screenshot capture/);
  runtime.close();
});

test('a stalled text read can still supply a current screenshot without invented text', async () => {
  const { wc, runtime } = fixture(); wc.mainFrame.executeJavaScript = never;
  const result = await runtime.snapshot();
  assert.equal(result.isError, undefined);
  assert.equal(data(result).text, '');
  assert.deepEqual(data(result).elements, []);
  assert.equal(data(result).pageRead.available, false);
  assert.equal(data(result).screenshot.available, true);
  assert.equal(result.content.filter(item => item.type === 'image').length, 1);
  runtime.close();
});

test('a stalled renderer and capture produce a bounded, explicit tool error', async () => {
  const { wc, runtime } = fixture(); wc.mainFrame.executeJavaScript = never; wc.capturePage = never;
  const result = await runtime.snapshot();
  assert.equal(result.isError, true);
  assert.equal(data(result).pageRead.available, false);
  assert.equal(data(result).screenshot.available, false);
  assert.match(data(result).notice, /stopped waiting/);
  runtime.close();
});

test('stopping a snapshot cancels both waits without publishing a late result', async () => {
  const { wc, runtime } = fixture(); wc.mainFrame.executeJavaScript = never; wc.capturePage = never;
  const controller = new AbortController();
  const result = runtime.snapshot(controller.signal);
  const rejected = assert.rejects(result, /stopped/);
  controller.abort();
  await rejected;
  runtime.close();
});

test('navigation during capture cannot mix a new screenshot with old page selectors', async () => {
  const { wc, runtime } = fixture();
  wc.capturePage = async () => { await new Promise(resolve => setImmediate(resolve)); wc.url = 'https://example.com/new'; wc.emit('did-start-navigation', {}, wc.url, false, true); return image; };
  const result = await runtime.snapshot();
  assert.equal(result.isError, true);
  assert.equal(data(result).pageChanged, true);
  assert.equal(data(result).currentUrl, 'https://example.com/new');
  assert.deepEqual(data(result).elements, []);
  assert.equal(result.content.some(item => item.type === 'image'), false);
  runtime.close();
});

test('browser deadlines handle late rejection and do not execute after prior cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  let called = false;
  await assert.rejects(browserDeadline(() => { called = true; }, { milliseconds: 20, message: 'Deadline', signal: controller.signal }), /stopped/);
  assert.equal(called, false);
  let rejectLate;
  await assert.rejects(browserDeadline(() => new Promise((_resolve, reject) => { rejectLate = reject; }), { milliseconds: 10, message: 'Deadline' }), /Deadline/);
  rejectLate(new Error('Late native rejection'));
  await new Promise(resolve => setImmediate(resolve));
});

test('a stable Chromium error page reports its network failure rather than claiming repeated navigation', async () => {
  const {wc,runtime}=fixture();
  runtime.readState=()=>({url:wc.url,title:'Failed page',loading:false,error:'Network access was denied.',errorCode:'ERR_NETWORK_ACCESS_DENIED'});
  wc.mainFrame.executeJavaScript=async()=>({url:'chrome-error://chromewebdata/',title:'',text:'',elements:[]});
  const result=await runtime.snapshot(undefined,{include_screenshot:false}),page=data(result);
  assert.equal(result.isError,true);assert.equal(page.pageChanged,undefined);assert.equal(page.pageReady,false);
  assert.equal(page.navigationError.code,'ERR_NETWORK_ACCESS_DENIED');assert.equal(page.url,wc.url);assert.deepEqual(page.elements,[]);
  runtime.close();
});

test('a QUIC navigation failure gives a recovery explanation and cleans up listeners', async()=>{
  const {wc,runtime}=fixture();
  wc.loadURL=url=>{wc.emit('did-start-navigation',{},url,false,true);queueMicrotask(()=>wc.emit('did-fail-load',{},-356,'ERR_QUIC_PROTOCOL_ERROR',url,true));return new Promise(()=>{});};
  await assert.rejects(runtime.navigate('https://example.com/'),/QUIC.*waiting browser update/);
  assert.equal(wc.listenerCount('did-fail-load'),0);runtime.close();
});
