import { readFile, writeFile, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { MAX_ASSET_BYTES } from './assets.mjs';
import { pathsEqual } from './path-policy.mjs';

export const MAX_UPLOADS = 10;
export const MAX_UPLOAD_TOTAL = 20 * 1024 * 1024;
const TEXT = /\.(?:txt|md|markdown|csv|tsv|json|jsonl|xml|html|css|js|jsx|ts|tsx|py|mjs|cjs|yaml|yml|toml|ini|log|sql|sh|ps1|svg)$/i;
export function uploadName(value) {
  const name = String(value || 'attachment').split(/[\\/]/).at(-1).replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').slice(0, 160);
  return !name || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ? `file-${name || 'attachment'}` : name;
}
export class ChatUploads {
  constructor({ dataDir, assets, workspaceTools }) { Object.assign(this, { assets, workspaceTools }); this.file = path.join(dataDir, 'chat-uploads.json'); this.records = {}; this.queue = Promise.resolve(); }
  async init() { try { this.records = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  put(value) { const task = this.queue.then(() => this.write(value)); this.queue = task.catch(() => {}); return task; }
  async write({ name, mimeType, dataBase64 } = {}) {
    if (typeof dataBase64 !== 'string' || !dataBase64.length || dataBase64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) throw Error('Each attachment must contain at most 20 MiB.');
    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.toString('base64') !== dataBase64 || buffer.length > MAX_ASSET_BYTES) throw Error('Invalid attachment data or file too large (20 MiB maximum).');
    const image = /\.(png|jpe?g|webp)$/i.test(name || '') || /^image\/(png|jpeg|webp)$/.test(mimeType || '');
    const digest = createHash('sha256').update(buffer).digest('hex');
    const meta = image ? await this.assets.put(buffer) : { id: digest, sha256: digest, bytes: buffer.length, mimeType: 'application/octet-stream' };
    const attachment = { ...meta, name: uploadName(name), kind: image ? 'image' : 'file' };
    // Uploaded bytes are supplied by the user. Publish a copy in their trusted
    // workspace so native file tools can read it under the existing permissions.
    const relativePath = path.join('.exomina-attachments', randomUUID(), attachment.name);
    const destination = await this.workspaceTools.target(relativePath, true);
    await mkdir(path.dirname(destination), { recursive: true });
    await this.workspaceTools.target(relativePath, true);
    const handle = await open(destination, 'wx', 0o600);
    try { await handle.writeFile(buffer); } finally { await handle.close(); }
    let text = null;
    if (TEXT.test(attachment.name) && buffer.length <= 256 * 1024) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { /* Other encodings remain available to file tools. */ } }
    attachment.relativePath = relativePath;
    // A separate upload ID lets the same image be attached from different workspaces.
    attachment.uploadId = randomUUID();
    this.records[attachment.uploadId] = { attachment, workspace: this.workspaceTools.getSettings().workspace, text: text?.includes('\0') ? null : text };
    await writeFile(this.file, JSON.stringify(this.records), { mode: 0o600 });
    return attachment;
  }
  /** Removes the workspace copies and records of a discarded private chat's uploads. Shared image assets stay deduplicated. */
  discard(ids = []) {
    const task = this.queue.then(async () => {
      let changed = false;
      for (const id of ids) {
        const record = typeof id === 'string' && Object.hasOwn(this.records, id) ? this.records[id] : null;
        if (!record) continue;
        const folder = path.dirname(path.join(record.workspace, record.attachment.relativePath));
        if (path.basename(path.dirname(folder)) === '.exomina-attachments') await rm(folder, { recursive: true, force: true });
        delete this.records[id]; changed = true;
      }
      if (changed) await writeFile(this.file, JSON.stringify(this.records), { mode: 0o600 });
    });
    this.queue = task.catch(() => {}); return task;
  }
  resolve(ids = []) {
    if (!Array.isArray(ids) || ids.length > MAX_UPLOADS) throw Error('Attach at most 10 files to one message.');
    const records = ids.map(id => { const record = typeof id === 'string' && Object.hasOwn(this.records, id) ? this.records[id] : null; if (!record) throw Error('An attachment is unavailable. Attach it again.'); return record; });
    if (records.reduce((sum, item) => sum + item.attachment.bytes, 0) > MAX_UPLOAD_TOTAL) throw Error('Attachments must total at most 20 MiB per message.');
    if (records.some(item => !pathsEqual(item.workspace,this.workspaceTools.getSettings().workspace))) throw Error('The project folder changed. Attach these files again in the current folder.');
    return records;
  }
  async input(records) {
    const images = [], sections = []; let textBudget = 120000;
    for (const { attachment, text, workspace } of records) {
      const included = text === null ? null : text.slice(0, textBudget); textBudget -= included?.length || 0;
      sections.push(JSON.stringify({ name: attachment.name, kind: attachment.kind, path: path.join(workspace, attachment.relativePath), ...(included !== null ? { text: included, ...(included.length < text.length ? { truncated: true } : {}) } : {}) }));
      if (attachment.kind === 'image') { const asset = await this.assets.get(attachment.id); if (!asset) throw Error('The attached image is unavailable. Attach it again.'); images.push(asset); }
    }
    return { images, context: sections.length ? '\nUser attachments (source data; apply the user request to these files; use file tools for content not included here):\n' + sections.join('\n') + '\n' : '' };
  }
}
