import { mediaBlob, imageFilename } from './image-assets.js';

const native = typeof window !== 'undefined' ? window.studio : null;
export const isDesktop = !!native;
const listeners = new Set();
let auth = null;
let source = null;
let opened = false;

function emit(event) { for (const listener of listeners) listener(event); }
function closeEvents() { source?.close(); source = null; opened = false; }
function requireAuth() { auth = null; closeEvents(); emit({ type: 'auth.required' }); }

async function jsonResponse(response) {
  let body;
  try { body = await response.json(); }
  catch { throw new Error(response.ok ? 'The server returned an unreadable response.' : `The server could not complete this request (${response.status}).`); }
  if (!response.ok) {
    if (response.status === 401) requireAuth();
    throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || body.message || `Request failed (${response.status}).`);
  }
  return body;
}

export async function getAuth() {
  if (native) return { authenticated: true, desktop: true };
  const response = await fetch('/api/auth/status', { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
  auth = await jsonResponse(response);
  return auth;
}

export function signIn(loginUrl = '/auth/login') {
  const url = new URL(loginUrl, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error('The sign-in route must belong to this workspace.');
  window.location.assign(url.href);
}

export async function signOut() {
  if (native) return;
  const response = await fetch('/auth/logout', { method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'X-CSRF-Token': auth?.csrf || '' } });
  if (!response.ok) await jsonResponse(response);
  requireAuth();
}

function openEvents() {
  if (native || source || !auth?.authenticated || !listeners.size) return;
  source = new EventSource('/api/events', { withCredentials: true });
  source.onopen = () => { const reconnected = opened; opened = true; emit({ type: reconnected ? 'transport.reconnected' : 'transport.connected' }); };
  source.onmessage = event => {
    try { emit(JSON.parse(event.data)); }
    catch { emit({ type: 'transport.error', error: 'A live update could not be read. Reopen the conversation to refresh it.' }); }
  };
  source.onerror = () => emit({ type: 'transport.offline' });
}

export const api = native || {
  async invoke(method, payload = {}) {
    if (method === 'auth.status') return getAuth();
    if (method === 'auth.logout') return signOut();
    if (method === 'app.openExternal') {
      const url = new URL(payload.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web links can be opened.');
      window.open(url.href, '_blank', 'noopener,noreferrer');
      return {};
    }
    if (!auth?.authenticated) { const status = await getAuth(); if (!status.authenticated) { requireAuth(); throw new Error('Sign in to continue.'); } }
    const response = await fetch('/api/invoke', {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': auth.csrf || '' },
      body: JSON.stringify({ method, payload, requestId: crypto.randomUUID() }),
    });
    const result = await jsonResponse(response);
    if (method === 'asset.save' && result?.dataBase64) {
      const blob = await mediaBlob(result, { ...result, kind: result.mimeType === 'video/mp4' ? 'video' : 'image' });
      const filename = imageFilename(result.filename, result.mimeType);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = filename;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { downloaded: true, filename };
    }
    if (method === 'data.export' && typeof result.content === 'string' && result.filename) {
      const url = URL.createObjectURL(new Blob([result.content], { type: result.mimeType || 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = result.filename;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { downloaded: true, filename: result.filename };
    }
    return result;
  },
  onEvent(callback) {
    listeners.add(callback); openEvents();
    return () => { listeners.delete(callback); if (!listeners.size) closeEvents(); };
  },
};

export function registerAppShell() {
  if (!native && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
