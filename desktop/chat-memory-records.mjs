import { createHash } from 'node:crypto';

const secretField = /^(?:authorization|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?(?:token|cookie)|login[_-]?code|device[_-]?code|user[_-]?code|recovery[_-]?(?:key|password)|client[_-]?secret)$/i;
export const fingerprint = value => createHash('sha256').update(String(value)).digest('hex');

/** Text history excludes credentials and binary payloads; hidden reasoning is never an input. */
export function historyText(value) {
  return String(value ?? '')
    .replace(/data:(?:image|audio|application)\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '[binary content omitted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[credential redacted]')
    .replace(/(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?(?:token|cookie)|password|passwd|client[_-]?secret|recovery[_-]?(?:key|password)|login[_-]?code|device[_-]?code|user[_-]?code)\b["'\t ]*[:=][\t ]*)("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,}\]]+)/gi, (match, label, value) => value.startsWith('[credential redacted') ? match : label + '[credential redacted]');
}
export function historyObject(value, depth = 0) {
  if (depth > 20) return '[deep metadata omitted]';
  if (typeof value === 'string') return historyText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => historyObject(item, depth + 1));
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (secretField.test(key)) result[key] = '[credential redacted]';
    else if (/^(?:dataBase64|base64|blob|reasoning|thinking|thought_signature|reasoning_details)$/i.test(key)) continue;
    else result[key] = historyObject(item, depth + 1);
  }
  return result;
}
export function clipToolHistory(value, limit = 30000) {
  const text = historyText(value);
  if (text.length <= limit) return text;
  const marker = '\n[tool output clipped: middle omitted]\n';
  let head = Math.floor((limit - marker.length) / 2), tail = text.length - (limit - marker.length - head);
  if (/[\uD800-\uDBFF]/.test(text[head - 1] || '')) head--;
  if (/[\uDC00-\uDFFF]/.test(text[tail] || '')) tail++;
  return text.slice(0, head) + marker + text.slice(tail);
}
export function toolResultHistory(result) {
  const parts = [];
  for (const block of result?.content || []) {
    if (block.type === 'text') parts.push(String(block.text || ''));
    else if (block.type === 'resource_link') parts.push(JSON.stringify(historyObject({ name: block.name, uri: block.uri })));
    else parts.push(`[${String(block.type || 'binary')} content omitted]`);
  }
  if (result?.structuredContent) parts.push(JSON.stringify(historyObject(result.structuredContent)));
  return clipToolHistory((result?.isError ? 'Tool error: ' : '') + parts.join('\n'));
}
export const recordableTool = name => !/(?:^|[_:/.-])(?:auth|login|signin|security|recovery|request_permission)(?:[_:/.-]|$)/i.test(String(name));

/** Large prose is split without discarding any non-secret text or cutting surrogate pairs. */
export function splitHistory(value, limit = 30000) {
  const text = historyText(value), chunks = [];
  if (!text.length) return [''];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + limit);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks;
}
export function attachmentReferences(message) {
  return (message.attachments || []).map(({ id, name, kind, mimeType }) => ({ id, name, kind, mimeType }));
}
