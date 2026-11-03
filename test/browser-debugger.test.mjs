import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {withBrowserDebugger} from '../desktop/browser-debugger.mjs';
import {BrowserRuntime} from '../desktop/browser-runtime.mjs';
import {trustedInput, trustedKey} from '../desktop/browser-extension/trusted-input.js';

const never = () => new Promise(() => {});
function fixture() {
  const debuggerClient = new EventEmitter();
  let attached = false;
  debuggerClient.detaches = 0;
  debuggerClient.commands = [];
  debuggerClient.isAttached = () => attached;
  debuggerClient.attach = () => { attached = true; };
  debuggerClient.detach = () => { attached = false; debuggerClient.detaches++; debuggerClient.emit('detach'); };
  debuggerClient.sendCommand = async method => { debuggerClient.commands.push(method); return {ok: true}; };
  return {debugger: debuggerClient};
}

test('timed-out document fallback releases its own debugger and a later read succeeds', async () => {
  const wc = Object.assign(new EventEmitter(), fixture());
  const runtime = new BrowserRuntime({wc, readState: () => ({}), timeouts: {read: 20}, readDocument: signal => withBrowserDebugger(wc, never, {signal, milliseconds: 1000})});
  assert.equal(await runtime.readPlain({offset: 0, limit: 50}), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wc.debugger.isAttached(), false);
  assert.deepEqual(await withBrowserDebugger(wc, send => send('Page.getResourceTree')), {ok: true});
  assert.equal(wc.debugger.detaches, 2);
  runtime.close();
});

test('deadline and cancellation detach and prevent a late operation from sending more commands', async () => {
  for (const cancel of [false, true]) {
    const wc = fixture(), controller = new AbortController();
    let sendLate;
    const task = withBrowserDebugger(wc, send => { sendLate = send; return never(); }, {signal: controller.signal, milliseconds: 20});
    const check = assert.rejects(task, cancel ? /stopped/ : /timed out/);
    await new Promise(resolve => setImmediate(resolve));
    if (cancel) controller.abort();
    await check;
    assert.equal(wc.debugger.isAttached(), false);
    await assert.rejects(sendLate('Input.insertText'), /ended/);
    assert.deepEqual(wc.debugger.commands, []);
  }
});

test('foreign attachments are refused and left attached', async () => {
  const wc = fixture();
  wc.debugger.attach();
  await assert.rejects(withBrowserDebugger(wc, () => assert.fail()), /outside this browser operation/);
  assert.equal(wc.debugger.isAttached(), true);
  assert.equal(wc.debugger.detaches, 0);
});

test('overlapping owned operations are identified correctly and only the owner detaches', async () => {
  const wc = fixture();
  let resolve;
  const first = withBrowserDebugger(wc, () => new Promise(done => { resolve = done; }));
  await new Promise(done => setImmediate(done));
  await assert.rejects(withBrowserDebugger(wc, () => assert.fail()), /Another browser operation/);
  assert.equal(wc.debugger.detaches, 0);
  resolve(); await first;
  assert.equal(wc.debugger.detaches, 1);
});

test('a detached owner cannot send into or detach a replacement debugger connection', async () => {
  const wc = fixture();
  let release, sendLate;
  const task = withBrowserDebugger(wc, send => { sendLate = send; return new Promise(resolve => { release = resolve; }); });
  await new Promise(resolve => setImmediate(resolve));
  wc.debugger.detach(); wc.debugger.attach();
  await assert.rejects(sendLate('Input.insertText'), /ended/);
  release(); await task;
  assert.equal(wc.debugger.isAttached(), true);
  assert.equal(wc.debugger.detaches, 1);
});

test('completed input keeps its dispatch receipt when navigation detaches the debugger', async () => {
  const wc = fixture();
  const result = await withBrowserDebugger(wc, async () => {
    wc.debugger.detach();
    return {dispatched: true, notice: 'Inspect the page to verify the intended effect.'};
  });
  assert.equal(result.dispatched, true);
  assert.equal(wc.debugger.detaches, 1);
});

test('destroyed page cleanup does not mask the original operation error', async () => {
  const wc = fixture(); let destroyed = false;
  wc.isDestroyed = () => destroyed;
  const attached = wc.debugger.isAttached;
  wc.debugger.isAttached = () => { if (destroyed) throw Error('Object destroyed'); return attached(); };
  await assert.rejects(withBrowserDebugger(wc, async () => { destroyed = true; throw Error('Original page error'); }), /Original page error/);
  assert.equal(wc.debugger.detaches, 0);
});

test('native input callbacks also reject a detached lease before dispatch', async () => {
  const wc = fixture();
  let resume, dispatched = false;
  const task = withBrowserDebugger(wc, async (_send, assertActive) => {
    await new Promise(resolve => { resume = resolve; });
    assertActive();
    dispatched = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  wc.debugger.detach();
  const rejected = assert.rejects(task, /ended/);
  resume(); await rejected;
  assert.equal(dispatched, false);
});

test('trusted key and pointer callbacks reject ownership lost during an awaited native command', async () => {
  for (const route of ['key', 'pointer']) {
    const wc = fixture();
    let release, dispatched = 0;
    wc.debugger.sendCommand = async (method, params) => {
      if (route === 'key' && method === 'Emulation.setFocusEmulationEnabled') return new Promise(resolve => { release = resolve; });
      if (method === 'Runtime.evaluate') return {result: {objectId: 'fixture-target'}};
      if (method === 'Runtime.callFunctionOn' && params.returnByValue===false) return {result:{objectId:'fixture-element'}};
      if (method === 'Runtime.callFunctionOn') return new Promise(resolve => { release = () => resolve({result: {value: {x: 10, y: 20}}}); });
      return {};
    };
    const pending = withBrowserDebugger(wc, (send, assertActive) => {
      const nativeDispatch = () => { assertActive(); dispatched++; };
      const expiresAt = Date.now() + 1000;
      return route === 'key'
        ? trustedKey(send, {input: {key: 'Enter'}, expiresAt}, undefined, nativeDispatch)
        : trustedInput(send, {action: 'click', input: {selector: '#fixture'}, expiresAt}, undefined, nativeDispatch);
    });
    const rejected = assert.rejects(pending, /ended/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function', route + ' reached the pending native command');
    wc.debugger.detach();
    wc.debugger.attach();
    release();
    await rejected;
    assert.equal(dispatched, 0, route + ' must not reach native input');
    assert.equal(wc.debugger.isAttached(), true, route + ' must preserve the replacement debugger');
    assert.equal(wc.debugger.detaches, 1);
  }
});

test('trusted browser selectors travel only as CDP argument data',async()=>{
  const selector='#field\");globalThis.untrustedCode=true;//',calls=[];
  const send=async(method,params)=>{calls.push({method,params});if(method==='Runtime.evaluate')return {result:{objectId:'document'}};if(method==='Runtime.callFunctionOn')return params.returnByValue===false?{result:{objectId:'element'}}:{result:{value:{x:10,y:20}}};return {};};
  await trustedInput(send,{action:'click',input:{selector},expiresAt:Date.now()+5000},undefined,async()=>{});
  assert.equal(calls.find(c=>c.method==='Runtime.evaluate').params.expression,'document');
  const lookup=calls.find(c=>c.method==='Runtime.callFunctionOn'&&c.params.returnByValue===false);
  assert.equal(lookup.params.arguments[0].value,selector);assert.equal(lookup.params.functionDeclaration.includes(selector),false);
  assert.deepEqual(calls.filter(c=>c.method==='Runtime.releaseObject').map(c=>c.params.objectId).sort(),['document','element']);
});
