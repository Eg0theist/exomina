import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { imageAttachment, imageBlob, imageFilename, mergeChatAsset, MAX_IMAGE_BYTES } from '../src/image-assets.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=', 'base64');
const attachment = { id: 'synthetic-image', kind: 'image', mimeType: 'image/png', bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };
const response = { id: attachment.id, mimeType: attachment.mimeType, bytes: png.length, dataBase64: png.toString('base64') };

test('image bytes stay outside metadata and must match their size, raster format and SHA-256', async () => {
  const metadata = imageAttachment({ ...attachment, path: 'private-path', dataBase64: response.dataBase64 });
  assert.deepEqual(metadata, attachment);
  const blob = await imageBlob(response, metadata);
  assert.equal(blob.type, 'image/png'); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png);
  await assert.rejects(imageBlob({ ...response, id: 'other-image' }, metadata), /does not match/);
  await assert.rejects(imageBlob(response, { ...metadata, bytes: png.length + 1 }), /size/);
  await assert.rejects(imageBlob(response, { ...metadata, sha256: '0'.repeat(64) }), /integrity/);
  await assert.rejects(imageBlob({ ...response, dataBase64: Buffer.from('<svg onload="alert(1)"/>').toString('base64'), bytes: undefined }), /declared format/);
  await assert.rejects(imageBlob({ ...response, mimeType: 'image/svg+xml' }), /not supported/);
  await assert.rejects(imageBlob({ ...response, dataBase64: 'not base64' }), /invalid/);
  assert.throws(() => imageAttachment({ ...metadata, bytes: MAX_IMAGE_BYTES + 1 }), /20 MB/);
  assert.throws(() => imageAttachment({ ...metadata, mimeType: 'image/gif' }), /not supported/);
  assert.throws(() => imageAttachment({ ...metadata, sha256: '' }), /integrity/);
});

test('asset downloads have a plain filename and an extension matching the raster type', () => {
  assert.equal(imageFilename('../../unsafe.svg', 'image/png'), 'unsafe.png');
  assert.equal(imageFilename('C:\\private\\photo.jpeg', 'image/jpeg'), 'photo.jpg');
  assert.equal(imageFilename('image<script>.html', 'image/webp'), 'image_script_.webp');
  assert.equal(imageFilename('', 'image/png'), 'Exomina-image.png');
  assert.throws(() => imageFilename('script.svg', 'image/svg+xml'), /not supported/);
});

test('streaming asset events preserve assistant text, pending user input and unrelated conversations', () => {
  const event = { type: 'chat.asset', conversationId: 'c1', attachment };
  const original = [{ id: 'other', messages: [{ role: 'assistant', content: 'Other chat' }] }, { id: 'c1', provider: 'codex', messages: [{ role: 'user', content: 'Draw a square' }, { role: 'assistant', content: 'Here is the first part' }] }];
  const merged = mergeChatAsset(original, event);
  assert.equal(merged.find(chat => chat.id === 'c1').messages[1].content, 'Here is the first part');
  assert.deepEqual(merged.find(chat => chat.id === 'c1').messages[1].attachments, [attachment]);
  assert.equal(original[1].messages[1].attachments, undefined);
  assert.equal(merged[0], original[0]);
  assert.deepEqual(mergeChatAsset(merged, event), merged, 'repeated asset events must not duplicate the image');
  const pending = { temporaryId: 'pending-1', text: 'Draw another square', provider: 'codex' };
  const firstImage = mergeChatAsset([{ id: pending.temporaryId, provider: 'codex', messages: [{ role: 'user', content: pending.text }] }], event, pending);
  assert.equal(firstImage.length, 1); assert.equal(firstImage[0].id, 'c1');
  assert.equal(firstImage[0].messages[0].content, pending.text);
  assert.equal(firstImage[0].messages[1].content, '');
  assert.deepEqual(firstImage[0].messages[1].attachments, [attachment]);
  const otherRun = mergeChatAsset([], event, { ...pending, id: 'not-c1' });
  assert.equal(otherRun[0].messages.length, 1, 'another run must not inherit a pending user message');
});
