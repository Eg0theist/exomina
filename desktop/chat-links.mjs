/** Shared link classification; never interpret a chat link as a shell command. */
export function parseChatLink(input) {
  if (typeof input !== 'string' || input.length > 8000 || /[\x00-\x1f]/.test(input)) return null;
  let value = input.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (/^https?:\/\//i.test(value)) {
    try { const url = new URL(value); return url.username || url.password ? null : { kind: 'web', url: url.href }; } catch { return null; }
  }
  if (/^mailto:/i.test(value)) { try { return { kind: 'mail', url: new URL(value).href }; } catch { return null; } }
  if (/^file:\/\//i.test(value)) {
    try { const url = new URL(value); if (url.hostname && url.hostname !== 'localhost') return null; value = decodeURIComponent(url.pathname).replace(/^\/([a-z]:[\/])/i, '$1'); } catch { return null; }
  }
  value=value.replace(/^\/([a-z]:[\\/])/i,'$1');
  if (/^\\\\[?.]\\/.test(value) || (!/^(?:[a-z]:[\\/]|\/(?!\/)|\\\\[^\\]+\\|\.{1,2}[\\/])/i.test(value))) return null;
  const suffix = value.match(/:(\d+)(?::(\d+))?$/);
  const filePath = suffix ? value.slice(0, -suffix[0].length) : value;
  if (filePath.includes(':', /^[a-z]:/i.test(filePath) ? 2 : 0)) return null;
  return { kind: 'file', path: filePath, ...(suffix ? { line: Number(suffix[1]), ...(suffix[2] ? { column: Number(suffix[2]) } : {}) } : {}) };
}
