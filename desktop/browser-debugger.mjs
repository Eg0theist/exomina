import {browserDeadline} from './browser-runtime.mjs';

const owners = new WeakMap();

// A timeout must release the native attachment, not just stop waiting for its
// promise. Never detach a session belonging to DevTools or another caller.
export async function withBrowserDebugger(wc, operation, {signal, milliseconds = 4000} = {}) {
  if (signal?.aborted) throw new Error('The browser action was stopped.');
  if (owners.has(wc)) throw new Error('Another browser operation is still using this page. Wait for it to finish.');
  if (wc.debugger.isAttached()) throw new Error('This page has a debugger attached outside this browser operation. Close its developer tools or debugger connection and try again.');
  const owner = {active: true};
  const detached = () => { owner.active = false; };
  wc.debugger.attach('1.3');
  owners.set(wc, owner);
  wc.debugger.on('detach', detached);
  const assertActive = () => {
    if (!owner.active || owners.get(wc) !== owner || signal?.aborted) throw new Error('The browser operation has ended. Read the page again before acting.');
  };
  const send = async (method, args) => {
    assertActive();
    return wc.debugger.sendCommand(method, args);
  };
  try {
    const result = await browserDeadline(() => operation(send, assertActive), {milliseconds, signal, message: 'Browser inspection or input timed out. Its debugger connection was released; read the page again.'});
    // A completed click may navigate and detach its renderer. Preserve its
    // dispatch receipt; ownership guards still prevent any later input.
    if (signal?.aborted) throw new Error('The browser action was stopped.');
    return result;
  } finally {
    const attachedByUs = owner.active && owners.get(wc) === owner;
    owner.active = false;
    if (owners.get(wc) === owner) owners.delete(wc);
    try { wc.debugger.removeListener('detach', detached); } catch {}
    try { if (attachedByUs && !wc.isDestroyed?.() && wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
  }
}
