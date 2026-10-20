import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { MAX_ASSET_BYTES, validateImageAsset } from './assets.mjs';

/** Called only after the helper's task, context and image references are approved. */
export async function readHelperImages({ image_ids = [], image_paths = [] }, { assets, canReadAsset, resolvePath }) {
  const images = []; let total = 0;
  const add = image => {
    total += image.bytes;
    if (total > MAX_ASSET_BYTES) throw Error('Helper images must total at most 20 MiB.');
    images.push(image);
  };
  for (const id of image_ids) {
    if (!canReadAsset(id)) throw Error('This image is not available to the current chat.');
    const image = await assets.get(id);
    if (!image) throw Error('This image has not arrived on this device yet.');
    add(image);
  }
  for (const imagePath of image_paths) {
    const file = await resolvePath(imagePath);
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || !info.size || info.size > MAX_ASSET_BYTES - total) throw Error('Helper images must be regular files totaling at most 20 MiB.');
      await resolvePath(imagePath);
      const buffer = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) throw Error('The helper image changed during read.'); offset += bytesRead; }
      const { metadata } = validateImageAsset(buffer);
      add({ ...metadata, dataBase64: buffer.toString('base64') });
    } finally { await handle.close(); }
  }
  return images;
}
