import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Store } from '../desktop/store.mjs';
import { MemoryStore } from '../desktop/note-store.mjs';
import { ArchiveStore } from '../desktop/archive.mjs';
import { SyncStore } from '../cloud/sync-store.mjs';

// Synthetic data only. Reports matched filenames/counts, never file contents.
const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-at-rest-audit-'));
const marker = 'SYNTHETIC_AT_REST_PRIVACY_PROBE_7de36ac8';
const memory = new MemoryStore(dir), archive = new ArchiveStore(dir), sync = new SyncStore({ dataDir: dir });
async function scan(root) {
  const matches = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) matches.push(...await scan(file));
    else if (entry.isFile() && (await readFile(file)).includes(Buffer.from(marker))) matches.push(path.relative(dir, file).replaceAll('\\', '/'));
  }
  return matches;
}
try {
  const store = new Store(dir); await store.init(); const chat = store.create('custom'); chat.messages.push({ role: 'user', content: marker }); await store.save();
  await memory.init(); await memory.note(marker);
  await archive.init(); await archive.importDocuments([{ provider: 'claude', kind: 'conversation', title: 'Synthetic security fixture', sourceId: 'synthetic-source', text: marker, rawJson: JSON.stringify({ synthetic: marker }) }]);
  await sync.init(); sync.apply({ deviceId: 'synthetic-desktop', operationId: 'synthetic-op', type: 'put', entity: { kind: 'note', id: 'synthetic-note', payload: { text: marker } } });
  const whileOpen = await scan(dir); memory.close(); archive.close(); sync.close();
  const afterClose = await scan(dir);
  console.log(JSON.stringify({ syntheticOnly: true, whileOpen, afterClose, plaintextPersistenceConfirmed: afterClose.length > 0 }, null, 2));
} finally {
  memory.close(); archive.close(); sync.close();
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('exomina-at-rest-audit-'));
  await rm(dir, { recursive: true, force: true });
}
