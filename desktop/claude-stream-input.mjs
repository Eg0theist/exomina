import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 128;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** One process owns one input lane. A write is not a delivery acknowledgment. */
export class ClaudeStreamInput {
  constructor({ stream, isActive, sessionId = () => undefined, onError = () => {}, timeoutMs = 10000,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { stream, isActive, sessionId, onError, timeoutMs, setTimer, clearTimer });
    this.accepting = true; this.closed = false; this.messages = new Map(); this.byUuid = new Map();
  }

  content(prompt, images, initial = false) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > (initial ? 8 * 1024 * 1024 : 200000)) throw Error('Provide a valid follow-up.');
    if (!Array.isArray(images) || images.length > 10) throw Error('Provide up to ten follow-up images.');
    let bytes = 0;
    const content = [{ type: 'text', text: prompt }];
    for (const image of images) {
      if (!image || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType) || typeof image.dataBase64 !== 'string'
        || !image.dataBase64 || image.dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || image.dataBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(image.dataBase64)) throw Error('Invalid follow-up image.');
      const imageBytes = Buffer.from(image.dataBase64, 'base64');
      if (!imageBytes.length || imageBytes.toString('base64') !== image.dataBase64) throw Error('Invalid follow-up image.');
      bytes += imageBytes.length;
      if (bytes > MAX_IMAGE_BYTES) throw Error('Follow-up images exceed the size limit.');
      content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 } });
    }
    return content;
  }

  send({ prompt, images = [], messageId, initial = false }) {
    if (!this.accepting || this.closed || !this.isActive() || this.stream.destroyed || this.stream.writableEnded) return Promise.resolve(false);
    if (messageId !== undefined && (typeof messageId !== 'string' || !messageId || messageId.length > 300)) throw Error('Invalid follow-up message ID.');
    const content = this.content(prompt, images, initial), signature = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const key = messageId || randomUUID(), previous = this.messages.get(key);
    if (previous) {
      if (previous.signature !== signature) throw Error('This follow-up ID was already used for different input.');
      return previous.promise;
    }
    if (this.messages.size >= MAX_MESSAGES) throw Error('Too many follow-ups were sent to this native turn.');
    const uuid = UUID.test(key) ? key : randomUUID();
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    promise.catch(() => {});
    const entry = { uuid, signature, promise, resolve, reject, settled: false, initial };
    this.messages.set(key, entry); this.byUuid.set(uuid, entry);
    if (!initial) entry.timer = this.setTimer(() => {
      if (entry.settled) return;
      entry.settled = true;
      reject(Error('Claude has not acknowledged this follow-up yet. It remains tracked for the main task to handle before finishing.'));
    }, this.timeoutMs);
    // The pinned Claude runtime accepts UUID-bearing user frames. Text and
    // image input follow the same lane; no input switches permission scope.
    const frame = { type: 'user', uuid, session_id: this.sessionId() || '', parent_tool_use_id: null, message: { role: 'user', content } };
    try {
      this.stream.write(JSON.stringify(frame) + '\n', error => { if (error && !this.closed) this.onError(error); });
    } catch (error) { this.onError(error); }
    return initial ? Promise.resolve(true) : promise;
  }

  observe(event) {
    if (this.closed || !this.isActive() || event?.parent_tool_use_id != null) return;
    const expectedSession = this.sessionId();
    if (expectedSession && event.session_id && event.session_id !== expectedSession) return;
    const receipts = event.type === 'user' && event.isReplay === true ? [event.uuid] : [];
    // Newer runtimes also prove consumption on top-level reply/result frames.
    // These are stronger than echoes; neither proves that requested work passed.
    if (['assistant', 'stream_event', 'result'].includes(event.type)) {
      if (typeof event.user_message_uuid === 'string') receipts.push(event.user_message_uuid);
      if (Array.isArray(event.user_message_uuids)) receipts.push(...event.user_message_uuids.slice(0, 64));
    }
    for (const uuid of receipts) {
      const entry = this.byUuid.get(uuid);
      if (!entry || entry.settled) continue;
      entry.settled = true; this.clearTimer(entry.timer); entry.resolve(true);
    }
  }

  end() {
    if (!this.accepting || this.closed) return;
    this.accepting = false;
    // EOF closes admission and lets already queued native prompts drain. Their
    // echoed receipts and later result frames remain readable until close.
    try { this.stream.end(); } catch (error) { this.onError(error); }
  }

  close(error) {
    if (this.closed) return;
    this.closed = true; this.accepting = false;
    for (const entry of this.messages.values()) {
      this.clearTimer(entry.timer);
      if (entry.settled) continue;
      entry.settled = true;
      if (error) entry.reject(error); else entry.resolve(false);
    }
    this.messages.clear(); this.byUuid.clear();
  }
}
