// Shared, credential-free endpoint rules for the host and connection form.
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
export function isLocalEndpoint(value) {
  try { return loopback(new URL(value).hostname); } catch { return false; }
}

export function connectionEndpoint(provider, candidate) {
  const raw = String(candidate || provider.baseUrl || '').trim().replace(/\/+$/, '');
  let url; try { url = new URL(raw); } catch { throw Error('Enter a complete server address, including http:// or https://.'); }
  if (url.username || url.password || url.search || url.hash) throw Error('Provider URLs cannot contain credentials, queries, or fragments.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) throw Error('Use HTTPS, or HTTP on localhost for a local model.');
  if (provider.mode === 'local' && !loopback(url.hostname)) throw Error('Local connections must use localhost. Use a custom API connection for a remote server.');
  if (provider.configurableEndpoint) {
    if (/\/(?:chat\/completions|models)$/.test(url.pathname)) throw Error('Enter the API base address, such as /v1, without /models or /chat/completions.');
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
    return url.href.replace(/\/+$/, '');
  }
  if (!['custom', 'ollama'].includes(provider.id)) {
    const normalized = value => String(value).replace(/\/+$/, '');
    const allowed = [provider.baseUrl, ...(provider.allowedBaseUrls || []).map(value => typeof value === 'string' ? value : value.url)].map(normalized);
    if (!allowed.includes(raw)) throw Error('Choose one of this provider’s documented endpoints.');
  }
  return raw;
}
