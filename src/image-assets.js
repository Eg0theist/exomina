export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const imageTypes = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
const fail = message => { throw new Error(message); };

export function imageAttachment(value) {
  if (!value || value.kind !== 'image' || typeof value.id !== 'string' || !value.id || value.id.length > 200 || /[\x00-\x1f]/.test(value.id)) fail('This image has invalid attachment information.');
  if (!imageTypes.has(value.mimeType)) fail('This image format is not supported. Use PNG, JPEG, or WebP.');
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_IMAGE_BYTES) fail('This image exceeds the 20 MB display limit or has an invalid size.');
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) fail('This image is missing its integrity information.');
  return { id: value.id, kind: 'image', mimeType: value.mimeType, bytes: value.bytes, sha256: value.sha256.toLowerCase() };
}

export function mediaAttachment(value){
  if(value?.kind!=='video')return imageAttachment(value);
  if(typeof value.id!=='string'||!value.id||value.id.length>200||/[\x00-\x1f]/.test(value.id)||value.mimeType!=='video/mp4'||!Number.isSafeInteger(value.bytes)||value.bytes<24||value.bytes>MAX_IMAGE_BYTES||!/^[a-f0-9]{64}$/i.test(value.sha256||''))fail('This video has invalid attachment information or exceeds the 20 MB limit.');
  return {id:value.id,kind:'video',mimeType:value.mimeType,bytes:value.bytes,sha256:value.sha256.toLowerCase()};
}

export async function mediaBlob(result,expected){
  const attachment=mediaAttachment(expected);if(attachment.kind==='image')return imageBlob(result,attachment);
  if(result?.id!==attachment.id||result.mimeType!==attachment.mimeType)fail('The returned video does not match this attachment.');
  const data=result.dataBase64;if(typeof data!=='string'||data.length>4*Math.ceil(MAX_IMAGE_BYTES/3)||data.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))fail('Invalid video data.');
  const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));if(bytes.length!==attachment.bytes||String.fromCharCode(...bytes.slice(4,8))!=='ftyp')fail('The video size or format is invalid.');
  const digest=await crypto.subtle.digest('SHA-256',bytes),hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==attachment.sha256)fail('The video failed its integrity check.');
  return new Blob([bytes],{type:attachment.mimeType});
}

export async function imageBlob(result, expected) {
  const attachment = expected ? imageAttachment(expected) : null;
  if (!imageTypes.has(result?.mimeType)) fail('This image format is not supported. Use PNG, JPEG, or WebP.');
  if (attachment && (result.id !== attachment.id || result.mimeType !== attachment.mimeType)) fail('The returned image does not match this attachment.');
  const encoded = result.dataBase64;
  if (typeof encoded !== 'string' || !encoded || encoded.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('The image data is invalid or exceeds the 20 MB limit.');
  let raw; try { raw = atob(encoded); } catch { fail('The image data could not be decoded.'); }
  if (raw.length < 1 || raw.length > MAX_IMAGE_BYTES || (attachment && raw.length !== attachment.bytes) || (result.bytes !== undefined && raw.length !== result.bytes)) fail('The image size does not match its attachment information.');
  const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  const prefix = (...values) => values.every((value, index) => bytes[index] === value);
  const signatureMatches = result.mimeType === 'image/png' ? prefix(137, 80, 78, 71, 13, 10, 26, 10)
    : result.mimeType === 'image/jpeg' ? prefix(255, 216, 255)
      : prefix(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
  if (!signatureMatches) fail('The image contents do not match the declared format.');
  if (attachment) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== attachment.sha256) fail('The image failed its integrity check. Try loading it again.');
  }
  return new Blob([bytes], { type: result.mimeType });
}

export function imageFilename(value, mimeType) {
  const extension = mimeType === 'video/mp4' ? 'mp4' : imageTypes.get(mimeType);
  if (!extension) fail('This image format is not supported.');
  const base = String(value || 'Exomina-image').split(/[\\/]/).at(-1).replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/\.[^.]*$/, '').replace(/[. ]+$/, '').slice(0, 160);
  return `${base || 'Exomina-image'}.${extension}`;
}

/** An asset event changes only attachment metadata; streamed text stays intact. */
export function mergeChatAsset(conversations, event, provisional) {
  const attachment = mediaAttachment(event.attachment);
  const pending = provisional && (!provisional.id || provisional.id === event.conversationId) ? provisional : null;
  let conversation = conversations.find(item => item.id === event.conversationId);
  if (!conversation && pending) conversation = conversations.find(item => item.id === pending.temporaryId);
  conversation ||= { title: pending?.text?.slice(0, 54) || 'New conversation', provider: pending?.provider || 'codex', messages: pending ? [{ role: 'user', content: pending.text }] : [] };
  const messages = [...(conversation.messages || [])];
  const last = messages.at(-1);
  const assistant = last?.role === 'assistant' ? last : { role: 'assistant', provider: pending?.provider || conversation.provider, content: '' };
  if (!assistant.attachments?.some(item => item.id === attachment.id)) {
    const updated = { ...assistant, attachments: [...(assistant.attachments || []), attachment] };
    if (last?.role === 'assistant') messages[messages.length - 1] = updated; else messages.push(updated);
  }
  return [...conversations.filter(item => item.id !== event.conversationId && item.id !== pending?.temporaryId), { ...conversation, id: event.conversationId, messages }];
}
