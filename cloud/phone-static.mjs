import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'none'";
/** The relay's dedicated origin serves only the public phone shell, never source or user data. */
export async function servePhone(req, res, directory) {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  if (pathname === '/') { res.writeHead(303, { location: '/remote', 'cache-control': 'no-store' }); res.end(); return true; }
  const file = ['/remote', '/remote/', '/remote.html'].includes(pathname) ? 'remote.html'
    : /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|png|svg|woff2?|mp3|wav)$/.test(pathname) ? pathname.slice(1)
    : ['/icons/icon.png', '/remote.webmanifest'].includes(pathname) ? pathname.slice(1) : null;
  if (!file) return false;
  if (req.headers['service-worker']) { res.writeHead(403); res.end(); return true; }
  try {
    const root = await realpath(directory), target = await realpath(path.join(root, file));
    if (!target.startsWith(root + path.sep)) throw Error('Invalid asset.');
    let bytes = await readFile(target);
    if (file === 'remote.html') bytes = Buffer.from(bytes.toString('utf8').replaceAll('./assets/', '/assets/'));
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json' };
    res.writeHead(200, { 'content-type': types[path.extname(file)], 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'content-length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404, { 'cache-control': 'no-store' }); res.end('Not found.'); }
  return true;
}
