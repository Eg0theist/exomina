/** User-entered address bar text. Agent browser tools still require web addresses. */
export function browserAddressUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw Error('Enter a website address or search terms.');
  const text = input.trim();
  if (text.length > 8000) throw Error('Use an address or search of at most 8,000 characters.');
  const webUrl = value => {
    let url; try { url = new URL(value); } catch { throw Error('That website address is incomplete.'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error('Use an http or https address without embedded credentials.');
    return url.href;
  };
  if (/^https?:/i.test(text)) return webUrl(text);
  // Recognise a host before the scheme check: localhost:3000 is a host + port.
  const host = text.split(/[/?#]/, 1)[0];
  const local = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(?::\d{1,5})?$/i.test(host);
  const domain = /^(?:[^\s.:@\\]+\.)+[^\s.:@\\]+(?::\d{1,5})?$/.test(host);
  if (!/\s/.test(text) && (local || domain)) return webUrl((local ? 'http://' : 'https://') + text);
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) throw Error('Use an http or https address, or enter search terms.');
  return 'https://www.google.com/search?q=' + encodeURIComponent(text);
}
