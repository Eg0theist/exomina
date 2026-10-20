// Cache the public application shell only. Never cache sessions, API responses,
// event streams, user uploads, provider requests, or conversation content.
const CACHE = 'exomina-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.png', '/icons/icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    const response = await fetch('/shell-assets.json', { cache: 'no-store' });
    if (response.ok) {
      const paths = await response.json();
      await cache.addAll(paths.filter(path => /^\/assets\/[A-Za-z0-9_.-]+$/.test(path)));
    }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('exomina-shell-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  if (request.mode === 'navigate' && ['/', '/index.html'].includes(url.pathname)) {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }
  if (SHELL.includes(url.pathname) || /^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname)) event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
